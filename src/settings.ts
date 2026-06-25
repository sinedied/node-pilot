// Per-project UI settings (pinned tasks + theme preference), persisted to
// ~/.cockpit/settings.json. We persist server-side rather than in the iframe's
// localStorage because the loopback server gets a fresh ephemeral port on every
// canvas open, which changes the page origin and wipes localStorage.
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { LaneId, PinnedTask, Settings, SettingsPatch } from "./types.ts";

const DIR_NAME = ".cockpit";
const FILE_NAME = "settings.json";

// Resolve the settings paths lazily so a changed HOME (e.g. in tests) is honored
// rather than being frozen at module load.
function settingsDir(): string {
  return path.join(os.homedir(), DIR_NAME);
}
function settingsFile(): string {
  return path.join(settingsDir(), FILE_NAME);
}

// Canonical tab ids (must match data-tab values in public/index.html). Used to
// sanitize persisted tabOrder/hiddenTabs so stale/unknown ids can't leak in.
export const KNOWN_TABS = [
  "info",
  "preview",
  "rayfin",
  "tests",
  "problems",
  "deps",
  "debugger",
  "console",
] as const;
const KNOWN_TAB_SET = new Set<string>(KNOWN_TABS);

const DEFAULTS: Settings = {
  pinnedTasks: null,
  theme: "auto",
  tabOrder: null,
  hiddenTabs: [],
  autoProblems: true,
  autoTest: true,
  autoDeps: true,
};

const LANE_IDS = new Set<LaneId>(["build", "typecheck", "lint", "format", "test"]);

// Validate a persisted tab id list: keep only known ids, de-duplicate, preserve order.
function sanitizeTabs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of value) {
    if (typeof t === "string" && KNOWN_TAB_SET.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function sanitizeTasks(value: unknown): PinnedTask[] | null {
  if (!Array.isArray(value)) return null;
  const out: PinnedTask[] = [];
  for (const t of value) {
    if (!t || typeof t !== "object") continue;
    const task = t as Record<string, unknown>;
    if (task.type === "lane" && LANE_IDS.has(task.id as LaneId)) {
      out.push({ type: "lane", id: task.id as LaneId });
    } else if (task.type === "script" && typeof task.name === "string") {
      out.push({ type: "script", name: task.name });
    }
  }
  return out;
}

// Bring an on-disk record up to the current schema. New `pinnedTasks` wins; an
// older `pinnedScripts` array is migrated to script tasks (an explicit empty list
// stays empty — the user intentionally pinned nothing); bare names are NEVER
// reinterpreted as lanes. Absent/invalid → null (fall back to defaults).
export function migrate(raw: Partial<Settings> | undefined): Settings {
  const theme = typeof raw?.theme === "string" ? raw.theme : "auto";
  const tabOrder = raw && "tabOrder" in raw ? sanitizeTabs(raw.tabOrder) : null;
  const extras = {
    theme,
    // A persisted-but-empty tabOrder is meaningless (it would hide every tab) →
    // treat it as "no order set" and fall back to the default.
    tabOrder: tabOrder?.length ? tabOrder : null,
    hiddenTabs: sanitizeTabs(raw?.hiddenTabs),
    // The on-load auto-runs default ON; only an explicit persisted `false`
    // disables them (so a brand-new project pre-populates its tabs). `autoProblems`
    // was formerly `autoLint` — honor the legacy key when the new one is absent.
    autoProblems: (raw?.autoProblems ?? raw?.autoLint) !== false,
    autoTest: raw?.autoTest !== false,
    autoDeps: raw?.autoDeps !== false,
    activeProject: typeof raw?.activeProject === "string" ? raw.activeProject : null,
  };
  if (raw && "pinnedTasks" in raw) {
    return { pinnedTasks: sanitizeTasks(raw.pinnedTasks), ...extras };
  }
  if (raw && Array.isArray(raw.pinnedScripts)) {
    const tasks: PinnedTask[] = raw.pinnedScripts
      .filter((n): n is string => typeof n === "string")
      .map((name) => ({ type: "script", name }));
    return { pinnedTasks: tasks, ...extras };
  }
  return { pinnedTasks: null, ...extras };
}

async function readAll(): Promise<Record<string, Partial<Settings>>> {
  try {
    return JSON.parse(await readFile(settingsFile(), "utf8")) || {};
  } catch {
    return {};
  }
}

async function writeAll(obj: Record<string, Partial<Settings>>): Promise<void> {
  await mkdir(settingsDir(), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(obj, null, 2));
}

export async function loadSettings(projectKey: string): Promise<Settings> {
  const all = await readAll();
  return migrate(all[projectKey]);
}

export async function saveSettings(projectKey: string, patch: SettingsPatch): Promise<Settings> {
  // Serialize writes so concurrent patches (e.g. a tab reorder and an auto-run
  // toggle fired in quick succession) can't read-modify-write over each other
  // and drop one of the changes — the file write is not atomic on its own.
  const run = writeQueue.then(() => doSaveSettings(projectKey, patch));
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let writeQueue: Promise<unknown> = Promise.resolve();

async function doSaveSettings(projectKey: string, patch: SettingsPatch): Promise<Settings> {
  const all = await readAll();
  const current = migrate(all[projectKey]);
  const next: Settings = { ...current };
  if (Array.isArray(patch.pinnedTasks)) next.pinnedTasks = sanitizeTasks(patch.pinnedTasks);
  if (typeof patch.theme === "string") next.theme = patch.theme;
  if (Array.isArray(patch.tabOrder)) {
    const order = sanitizeTabs(patch.tabOrder);
    next.tabOrder = order.length ? order : null;
  }
  if (Array.isArray(patch.hiddenTabs)) next.hiddenTabs = sanitizeTabs(patch.hiddenTabs);
  if (typeof patch.autoProblems === "boolean") next.autoProblems = patch.autoProblems;
  if (typeof patch.autoTest === "boolean") next.autoTest = patch.autoTest;
  if (typeof patch.autoDeps === "boolean") next.autoDeps = patch.autoDeps;
  if (typeof patch.activeProject === "string" || patch.activeProject === null)
    next.activeProject = patch.activeProject;
  // Persist the new schema only; drop the legacy `pinnedScripts`/`autoLint` keys.
  all[projectKey] = {
    pinnedTasks: next.pinnedTasks,
    theme: next.theme,
    tabOrder: next.tabOrder,
    hiddenTabs: next.hiddenTabs,
    autoProblems: next.autoProblems,
    autoTest: next.autoTest,
    autoDeps: next.autoDeps,
    activeProject: next.activeProject,
  };
  await writeAll(all);
  return next;
}

export { DEFAULTS };

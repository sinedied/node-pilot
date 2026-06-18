// Per-project UI settings (pinned tasks + theme preference), persisted to
// ~/.cockpit/settings.json. We persist server-side rather than in the iframe's
// localStorage because the loopback server gets a fresh ephemeral port on every
// canvas open, which changes the page origin and wipes localStorage.
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { LaneId, PinnedTask, Settings, SettingsPatch } from "./types.ts";

const DIR = path.join(os.homedir(), ".cockpit");
const FILE = path.join(DIR, "settings.json");

const DEFAULTS: Settings = { pinnedTasks: null, theme: "auto" };

const LANE_IDS = new Set<LaneId>(["build", "typecheck", "lint", "format", "test"]);

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
  if (raw && "pinnedTasks" in raw) {
    return { pinnedTasks: sanitizeTasks(raw.pinnedTasks), theme };
  }
  if (raw && Array.isArray(raw.pinnedScripts)) {
    const tasks: PinnedTask[] = raw.pinnedScripts
      .filter((n): n is string => typeof n === "string")
      .map((name) => ({ type: "script", name }));
    return { pinnedTasks: tasks, theme };
  }
  return { pinnedTasks: null, theme };
}

async function readAll(): Promise<Record<string, Partial<Settings>>> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

async function writeAll(obj: Record<string, Partial<Settings>>): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(obj, null, 2));
}

export async function loadSettings(projectKey: string): Promise<Settings> {
  const all = await readAll();
  return migrate(all[projectKey]);
}

export async function saveSettings(projectKey: string, patch: SettingsPatch): Promise<Settings> {
  const all = await readAll();
  const current = migrate(all[projectKey]);
  const next: Settings = { ...current };
  if (Array.isArray(patch.pinnedTasks)) next.pinnedTasks = sanitizeTasks(patch.pinnedTasks);
  if (typeof patch.theme === "string") next.theme = patch.theme;
  // Persist the new schema only; drop the legacy `pinnedScripts` key.
  all[projectKey] = { pinnedTasks: next.pinnedTasks, theme: next.theme };
  await writeAll(all);
  return next;
}

export { DEFAULTS };

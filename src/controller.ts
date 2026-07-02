// Central controller: the single source of truth for project state, lanes, the
// dev server and dependency operations. Emits events that the SSE layer relays
// to the UI; both the HTTP API and the agent actions call its methods.
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import { watch as fsWatch, statSync, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { detect } from "./detect.ts";
import { run, start } from "./process-runner.ts";
import { runScript as pmRunScript, supportsAuditFix } from "./pm.ts";
import {
  resolveLane,
  resolveDev,
  resolveTest,
  resolveLintJson,
  laneAvailability,
  defaultPinnedTasks,
} from "./lanes.ts";
import { parseJestLike, parseTap, parseTextCounts } from "./test-report.ts";
import { parseLint, sortDiagnostics } from "./lint-report.ts";
import { pushCapped, extractUrl, isPortInUse } from "./util.ts";
import {
  buildFixPrompt,
  buildTestFixPrompt,
  buildDiagnosticFixPrompt,
  buildDepsUpdatePrompt,
  buildDepsAuditFixPrompt,
  type UpdatePromptTarget,
} from "./fix.ts";
import { TsServerClient, resolveTsserverPath } from "./ts-server.ts";
import {
  DebugSession,
  type DebugActionResult,
  type DebugAttachOptions,
  type DebugStartOptions,
} from "./debug.ts";
import { loadSettings, saveSettings, KNOWN_TABS } from "./settings.ts";
import { computeStats } from "./info.ts";
import {
  readRayfinState,
  validateRayfinArgs,
  rayfinArgv,
  rayfinWorkspaceFlag,
  rayfinLoginStatusArgv,
  hasLocalRayfinBin,
  interpretLoginStatus,
  resolveFunctionInvokeUrl,
  resolveFunctionPathSegment,
  resolveFunctionsHostOrigin,
  rayfinDevFunctionsArgv,
  hasFuncBin,
} from "./rayfin.ts";
import {
  checkRayfinUpdate,
  buildRayfinUpdatePrompt,
  type RayfinUpdateInfo,
} from "./rayfin-update.ts";
import { enumerateProjects } from "./projects.ts";
import * as deps from "./deps.ts";
import type { SafeUpdateOptions, SafeUpdateResult } from "./deps.ts";
import { DEFAULT_REPO_SLUG, EXTENSION_DIR, checkForUpdate, type UpdateInfo } from "./update.ts";
import { applyRelease, buildReloadPrompt } from "./self-update.ts";
import type { TestOptions } from "./lanes.ts";
import type {
  AppEvent,
  Detection,
  DepsState,
  DevState,
  Diagnostic,
  FixContextEntry,
  FunctionsHostState,
  FunctionsHostStatus,
  LaneState,
  LintState,
  ProcessHandle,
  ProjectStats,
  ResolvedSettings,
  RayfinState,
  ProjectInfo,
  ProjectsState,
  SettingsPatch,
  TestReport,
  TsLsState,
} from "./types.ts";

const ONE_SHOT_LANES = ["build", "lint", "format", "typecheck", "test", "e2e"];

// Source dirs we recursively watch for diagnostics refresh (avoids registering
// OS watchers over node_modules). The project root is always watched shallowly
// for top-level source + tsconfig changes.
const TS_WATCH_DIRS = [
  "src",
  "lib",
  "app",
  "pages",
  "components",
  "routes",
  "server",
  "packages",
  "test",
  "tests",
];
const TS_WATCH_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".vue",
  ".svelte",
  ".astro",
]);
const TS_IDLE_MS = 10 * 60 * 1000;

// Default local Azure Functions host base URL for the Rayfin function invoker.
const DEFAULT_FN_BASE_URL = "http://127.0.0.1:7071/api";
// Console lane the managed local functions host (`rayfin dev functions apply`) streams to.
const FN_HOST_LANE = "rayfin:dev:functions";

export interface ControllerOptions {
  sendToChat?: (prompt: string) => Promise<void> | void;
  sendImageToChat?: (prompt: string, dataBase64: string, mimeType: string) => Promise<void> | void;
  // Run the user's configured on-load tasks after the first detection. Defaults
  // to true; tests/hosts can disable it for deterministic, race-free runs.
  autoRun?: boolean;
  // The running extension's own version + distribution repo, read from the root
  // package.json by extension.ts. Used by the self-update check. Defaults keep the
  // controller usable in tests without a package.json.
  version?: string;
  repoSlug?: string;
  // Test seam: override the fetch used by the update check.
  fetchImpl?: typeof globalThis.fetch;
}

interface LaneRunResult {
  ok: boolean;
  reason?: string;
  exitCode?: number;
}

// Outcome of the Security "Fix with Copilot" flow: whether the package manager's
// own `audit fix` ran, whether it had to be rolled back, how many groups it
// resolved, how many remain, and whether the remainder was handed to Copilot.
export interface AuditFixResult {
  ok: boolean;
  reason?: string;
  ran?: boolean;
  rolledBack?: boolean;
  fixed?: number;
  remaining?: number;
  escalated?: boolean;
}

// Live test-watch session. For file-based runners (vitest/jest) the JSON report
// is read from `outputFile` whenever the temp dir changes; for streaming runners
// (node --test) the report is re-parsed from the lane output buffer on settle.
interface TestWatchSession {
  handle: ProcessHandle;
  parser: string;
  label: string;
  outputFile: string | null;
  tmpDir: string | null;
  fileWatcher: FSWatcher | null;
  debounce: NodeJS.Timeout | null;
  retries: number;
}

export class Controller {
  cwd: string;
  // The host-provided session working directory. `cwd` (the active project) may
  // be a sub-project of this root in a monorepo / multi-root workspace.
  root: string;
  sendToChat: (prompt: string) => Promise<void> | void;
  sendImageToChat: (prompt: string, dataBase64: string, mimeType: string) => Promise<void> | void;
  autoRun: boolean;
  events: EventEmitter;
  detection: Detection | null;
  lanes: Record<string, LaneState>;
  test: { report: TestReport | null; watch: boolean };
  dev: DevState;
  fnHost: FunctionsHostState;
  deps: DepsState;
  debug: DebugSession;
  fixContext: Record<string, FixContextEntry>;
  projectStats: ProjectStats | null;
  _statsPromise: Promise<ProjectStats> | null;
  _rayfin: RayfinState | null;
  _projects: ProjectInfo[] | null;
  // In-flight project/root transition; concurrent actions await it so they never
  // read a half-applied cwd/detection during a switch.
  _transition: Promise<void> | null;
  tsLs: TsLsState;
  lint: LintState;
  _tsClient: TsServerClient | null;
  _tsWatchers: FSWatcher[];
  _tsRefreshTimer: NodeJS.Timeout | null;
  _tsRestartTimer: NodeJS.Timeout | null;
  _tsIdleTimer: NodeJS.Timeout | null;
  _lintRefreshTimer: NodeJS.Timeout | null;
  _lintRunning: Promise<void> | null;
  _lintDirty: boolean;
  _lintGen: number;
  _testWatch: TestWatchSession | null;
  _autoRanFor: Set<string>;
  _autoRunning: boolean;
  // Bumped on every project switch (in resetProjectState). Auto-task / refresh
  // methods capture it and discard their results if it changed mid-run, so a slow
  // run started for the previous project can't publish stale deps/test/diagnostics
  // into the newly-focused one (the deps/test/TS analogue of `_lintGen`).
  _projectGen: number;
  // Self-update: the running version + distribution repo, plus a cached check
  // result (the process is long-lived, so we throttle network checks).
  version: string;
  repoSlug: string;
  _fetchImpl: typeof globalThis.fetch;
  _update: UpdateInfo | null;
  _updatePromise: Promise<UpdateInfo> | null;
  // Single-flight guard for the in-process self-update: an apply downloads + swaps
  // files, so a second concurrent apply (double-click / Settings + popup) must be
  // rejected rather than racing the directory rename.
  _selfUpdating: boolean;
  // Rayfin CLI/SDK update check (project-scoped). Same throttle model as the
  // self-update above, but the "latest" comes from the npm registry.
  _rayfinUpdate: RayfinUpdateInfo | null;
  _rayfinUpdatePromise: Promise<RayfinUpdateInfo> | null;
  // The installed version the in-flight check was started for, so a stale
  // promise is never reused after a project switch / in-place upgrade.
  _rayfinUpdatePromiseFor: string | null;
  // Sign-in probe cache. `probeRayfinSignedIn` spawns the CLI (`rayfin login
  // status`, up to 5s), so we never block the dashboard render on it: the cached
  // value (or null = "Unknown") is shown immediately and the probe runs in the
  // background, broadcasting `rayfin:state` when it resolves. Keyed by cwd +
  // throttled so revisits / post-lane refreshes don't re-spawn the CLI.
  _rayfinSignedIn: { cwd: string; value: boolean | null; checkedAt: number } | null;
  // The in-flight probe, keyed by the project + generation it was started for, so
  // coalescing only applies to the *same* live project (a switch never blocks the
  // new project's probe, and a stale resolve self-discards via the `gen` guard).
  _rayfinSignInProbe: { cwd: string; gen: number; promise: Promise<void> } | null;
  // A forced re-check (e.g. after a login/logout lane) requested while a probe was
  // already running — run a fresh probe once the current one settles.
  _rayfinSignInRecheck: boolean;

  constructor(
    cwd: string,
    { sendToChat, sendImageToChat, autoRun, version, repoSlug, fetchImpl }: ControllerOptions = {},
  ) {
    this.cwd = cwd;
    this.root = cwd;
    this.sendToChat = sendToChat || (async () => {});
    this.sendImageToChat = sendImageToChat || (async () => {});
    this.autoRun = autoRun !== false;
    this.version = version || "0.0.0";
    this.repoSlug = repoSlug || DEFAULT_REPO_SLUG;
    this._fetchImpl = fetchImpl || globalThis.fetch;
    this._update = null;
    this._updatePromise = null;
    this._selfUpdating = false;
    this._rayfinUpdate = null;
    this._rayfinUpdatePromise = null;
    this._rayfinUpdatePromiseFor = null;
    this._rayfinSignedIn = null;
    this._rayfinSignInProbe = null;
    this._rayfinSignInRecheck = false;
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.detection = null;
    this.lanes = {};
    for (const id of ONE_SHOT_LANES) this.lanes[id] = this.freshLane(id);
    // Dependency updates stream through the standard lane/Console mechanism.
    this.lanes.update = this.freshLane("update");
    this.test = { report: null, watch: false };
    this.dev = { status: "stopped", url: null, port: null, output: [], pid: null, _handle: null };
    this.fnHost = this.freshFnHost();
    this.deps = { outdated: null, audit: null, update: null };
    // Agent-facing debugger (CDP over Node's inspector). Events flow through
    // this controller's broadcast()/log() like every other subsystem.
    this.debug = new DebugSession({
      broadcast: (evt) => this.broadcast(evt),
      log: (message, level) => this.log(message, level),
    });
    this.fixContext = {}; // lane -> last failure { command, output, exitCode, report }
    this.projectStats = null;
    this._statsPromise = null;
    this._rayfin = null;
    this._projects = null;
    this._transition = null;
    this.tsLs = this.freshTsLs();
    this.lint = this.freshLint();
    this._tsClient = null;
    this._tsWatchers = [];
    this._tsRefreshTimer = null;
    this._tsRestartTimer = null;
    this._tsIdleTimer = null;
    this._lintRefreshTimer = null;
    this._lintRunning = null;
    this._lintDirty = false;
    this._lintGen = 0;
    this._testWatch = null;
    this._autoRanFor = new Set();
    this._autoRunning = false;
    this._projectGen = 0;
  }

  freshTsLs(): TsLsState {
    return {
      status: "stopped",
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      lastUpdated: null,
      reason: null,
    };
  }

  freshFnHost(): FunctionsHostState {
    return {
      status: "stopped",
      pid: null,
      reachable: null,
      funcAvailable: false,
      baseUrl: null,
      _handle: null,
    };
  }

  freshLint(): LintState {
    return {
      status: "idle",
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      lastUpdated: null,
      reason: null,
    };
  }

  freshLane(id: string): LaneState {
    return {
      id,
      label: null,
      status: "idle",
      exitCode: null,
      output: [],
      startedAt: null,
      endedAt: null,
    };
  }

  broadcast(evt: AppEvent): void {
    this.events.emit("event", evt);
  }

  log(message: string, level = "info"): void {
    this.broadcast({ type: "log", level, message });
  }

  // `force` re-primes the on-load tasks even for an already-seen cwd. The callers
  // that wipe per-project state (`setActiveProject`, and the root-change branch of
  // `ensureProjectDir`) must pass it: they just cleared this.deps/lint/tsLs/test via
  // `resetProjectState`, so the Problems/Deps pills would otherwise stay empty on a
  // revisit. The default-`false` path keeps the `_autoRanFor` guard, which dedups
  // redundant re-detection of the *same* project (e.g. concurrent canvas opens).
  async init(force = false): Promise<Detection> {
    this.detection = await detect(this.cwd);
    this.invalidateStats();
    this._rayfin = null;
    if (this.detection.hasProject) this.detection.availability = laneAvailability(this.detection);
    this.broadcast({ type: "detection", detection: this.detection });
    this.broadcast({ type: "projects", projects: await this.getProjects() });
    // Fire the configured on-load tasks, once per project path unless forced, after
    // a successful project detection (a shared process can serve several projects).
    if (this.autoRun && (force || !this._autoRanFor.has(this.cwd)) && this.detection.hasProject) {
      this._autoRanFor.add(this.cwd);
      this.runAutoTasks().catch((e) => this.log(String(e), "error"));
    }
    return this.detection;
  }

  // Anchor the controller to the session's real working directory. The extension
  // process cwd is not the project root, so the host supplies the session path on
  // every canvas open / action via `ctx.session.workingDirectory`.
  //
  // We track the host session `root` separately from the active project `cwd`:
  // in a monorepo the user may have focused a sub-project, and that selection
  // must survive subsequent open/action calls (which re-pass the same root).
  // On the first init for a root — or when the host genuinely switches roots — we
  // restore the persisted focus for that root (default: the root itself).
  async ensureProjectDir(dir?: string): Promise<Detection | null> {
    // Don't read cwd/detection mid-switch: wait for any in-flight project
    // transition to settle so a concurrent action never observes a half-applied
    // switch.
    if (this._transition) await this._transition.catch(() => {});
    const rootChanged = !!dir && dir !== this.root;
    if (rootChanged) {
      // A genuine host session-dir change: tear down everything bound to the old
      // project and reset transient state before re-anchoring (mirrors the
      // discipline in setActiveProject so nothing leaks across roots).
      await this.stopDev().catch(() => {});
      await this.stopFunctionsHost().catch(() => {});
      await this.stopTestWatch().catch(() => {});
      this.stopTsServer();
      await this.debugStop().catch(() => {});
      this.resetProjectState();
      this.root = dir;
      this._projects = null;
    }
    if (rootChanged || !this.detection) {
      this.cwd = await this.resolveActiveDir();
      // A genuine root change just tore down + reset the old project, so force the
      // on-load tasks to re-prime; first-ever detection keeps the dedup guard.
      await this.init(rootChanged);
    }
    return this.detection;
  }

  // Pick the project to focus for the current root: the persisted selection if it
  // still exists, else the root itself when it's a project, else the first
  // discovered project (handles a container root with no package.json), else the
  // root as a last resort.
  private async resolveActiveDir(): Promise<string> {
    const saved = (await loadSettings(this.root)).activeProject;
    const list = await this.listProjectDirs();
    if (saved && list.includes(saved)) return saved;
    if (list.includes(this.root)) return this.root;
    return list[0] ?? this.root;
  }

  async refresh(): Promise<Detection> {
    this.detection = await detect(this.cwd);
    this.invalidateStats();
    this._rayfin = null;
    this._projects = null;
    if (this.detection.hasProject) this.detection.availability = laneAvailability(this.detection);
    this.broadcast({ type: "detection", detection: this.detection });
    this.broadcast({ type: "projects", projects: await this.getProjects() });
    return this.detection;
  }

  // ---- Monorepo / multi-project selection ---------------------------------

  // Discover (and cache) the selectable projects under the current session root.
  private async listProjects(): Promise<ProjectInfo[]> {
    if (!this._projects) this._projects = await enumerateProjects(this.root);
    return this._projects;
  }

  private async listProjectDirs(): Promise<string[]> {
    return (await this.listProjects()).map((p) => p.dir);
  }

  async getProjects(): Promise<ProjectsState> {
    const projects = await this.listProjects();
    return {
      root: this.root,
      active: this.cwd,
      multi: projects.length > 1,
      projects,
    };
  }

  // Focus Cockpit on a different project. Validates the target against the
  // discovered list, tears down the previous project's cwd-bound subsystems,
  // re-points `cwd`, re-detects, persists the choice per session root, and
  // re-broadcasts a fresh snapshot + projects so the whole UI re-anchors.
  async setActiveProject(dir?: string): Promise<{ ok: boolean; reason?: string }> {
    // Serialize against any in-flight switch (rapid double-clicks, or an action's
    // ensureProjectDir) so transitions can't interleave.
    if (this._transition) await this._transition.catch(() => {});
    if (!dir || typeof dir !== "string") return { ok: false, reason: "No project specified." };
    const list = await this.listProjectDirs();
    if (!list.includes(dir)) return { ok: false, reason: "Unknown project." };
    if (dir === this.cwd) return { ok: true };
    const run = (async () => {
      // Stop everything bound to the previous project's directory.
      await this.stopDev().catch(() => {});
      await this.stopFunctionsHost().catch(() => {});
      await this.stopTestWatch().catch(() => {});
      this.stopTsServer();
      await this.debugStop().catch(() => {});
      // Reset the per-project transient state so stale lanes / reports / deps from
      // the previous project don't bleed into the newly-focused one.
      this.resetProjectState();
      this.cwd = dir;
      await saveSettings(this.root, { activeProject: dir });
      // State was just wiped, so force the on-load tasks to re-prime — otherwise a
      // switch back to an already-visited project would leave the pills empty.
      await this.init(true);
      // A snapshot re-syncs every tab on the client in one shot.
      this.broadcast({ type: "snapshot", state: this.getState() });
    })();
    this._transition = run.then(
      () => {},
      () => {},
    );
    try {
      await run;
      return { ok: true };
    } finally {
      this._transition = null;
    }
  }

  // Clear lanes / test report / deps / dev output / fix context so a project
  // switch starts from a clean slate (mirrors the constructor's fresh state).
  private resetProjectState(): void {
    // Invalidate any in-flight auto-task / refresh so it can't publish stale
    // deps/test/diagnostics into the project we're about to switch to.
    this._projectGen++;
    this.lanes = {};
    for (const id of ONE_SHOT_LANES) this.lanes[id] = this.freshLane(id);
    this.lanes.update = this.freshLane("update");
    this.test = { report: null, watch: false };
    this.dev = { status: "stopped", url: null, port: null, output: [], pid: null, _handle: null };
    this.fnHost = this.freshFnHost();
    this.deps = { outdated: null, audit: null, update: null };
    this.fixContext = {};
    this.tsLs = this.freshTsLs();
    this.lint = this.freshLint();
    // The Rayfin update check is keyed to the previous project's installed
    // version; drop the cached result and invalidate any in-flight check so a
    // stale result can't leak into the new project. The pending promise self-
    // cleans via its identity guard in `getRayfinUpdateInfo`.
    this._rayfinUpdate = null;
    this._rayfinUpdatePromiseFor = null;
    // Drop the per-project sign-in probe cache too (a still-in-flight probe self-
    // discards via its captured `gen`, so just clearing the cache + any queued
    // recheck is enough).
    this._rayfinSignedIn = null;
    this._rayfinSignInRecheck = false;
  }

  // ---- Lazy project stats (transitive deps + sizes) -----------------------

  invalidateStats(): void {
    this.projectStats = null;
    this._statsPromise = null;
  }

  // Compute (once) and cache the expensive Info-tab metrics. The npm-pack step
  // is gated to publishable packages so it isn't run on private apps.
  getProjectStats(): Promise<ProjectStats | { hasProject: false }> {
    const d = this.detection;
    if (!d?.hasProject) return Promise.resolve({ hasProject: false });
    if (this.projectStats) return Promise.resolve(this.projectStats);
    if (!this._statsPromise) {
      this._statsPromise = computeStats(this.cwd, !d.private).then((stats) => {
        this.projectStats = stats;
        this._statsPromise = null;
        return stats;
      });
    }
    return this._statsPromise;
  }

  // ---- UI settings (pinned tasks + theme), persisted per project ------------

  async getSettings(): Promise<ResolvedSettings> {
    const s = await loadSettings(this.cwd);
    // `null` = no saved config: materialize the default tasks in-memory only.
    // We never write on a read, so the project stays on "defaults" (and picks up
    // newly-available lanes after re-detection) until the user pins/unpins.
    const pinnedTasks = s.pinnedTasks ?? defaultPinnedTasks(this.detection);
    return {
      theme: s.theme || "auto",
      pinnedTasks,
      tabOrder: s.tabOrder ?? [...KNOWN_TABS],
      hiddenTabs: s.hiddenTabs,
      autoProblems: s.autoProblems,
      autoTest: s.autoTest,
      autoDeps: s.autoDeps,
      checkUpdatesOnLaunch: s.checkUpdatesOnLaunch,
      dismissedUpdateVersion: s.dismissedUpdateVersion ?? null,
    };
  }

  async setSettings(patch: SettingsPatch = {}): Promise<ResolvedSettings> {
    const clean: SettingsPatch = {};
    if (typeof patch.theme === "string") clean.theme = patch.theme;
    if (Array.isArray(patch.pinnedTasks)) clean.pinnedTasks = patch.pinnedTasks;
    if (Array.isArray(patch.tabOrder)) clean.tabOrder = patch.tabOrder;
    if (Array.isArray(patch.hiddenTabs)) clean.hiddenTabs = patch.hiddenTabs;
    if (typeof patch.autoProblems === "boolean") clean.autoProblems = patch.autoProblems;
    if (typeof patch.autoTest === "boolean") clean.autoTest = patch.autoTest;
    if (typeof patch.autoDeps === "boolean") clean.autoDeps = patch.autoDeps;
    if (typeof patch.checkUpdatesOnLaunch === "boolean")
      clean.checkUpdatesOnLaunch = patch.checkUpdatesOnLaunch;
    if (typeof patch.dismissedUpdateVersion === "string" || patch.dismissedUpdateVersion === null)
      clean.dismissedUpdateVersion = patch.dismissedUpdateVersion;
    const s = await saveSettings(this.cwd, clean);
    const pinnedTasks = s.pinnedTasks ?? defaultPinnedTasks(this.detection);
    return {
      theme: s.theme || "auto",
      pinnedTasks,
      tabOrder: s.tabOrder ?? [...KNOWN_TABS],
      hiddenTabs: s.hiddenTabs,
      autoProblems: s.autoProblems,
      autoTest: s.autoTest,
      autoDeps: s.autoDeps,
      checkUpdatesOnLaunch: s.checkUpdatesOnLaunch,
      dismissedUpdateVersion: s.dismissedUpdateVersion ?? null,
    };
  }

  getState() {
    return {
      cwd: this.cwd,
      version: this.version,
      detection: this.detection,
      lanes: Object.fromEntries(
        Object.entries(this.lanes).map(([id, l]) => [id, { ...l, output: l.output.join("") }]),
      ),
      test: this.test,
      dev: { ...this.dev, output: this.dev.output.join(""), _handle: undefined },
      fnHost: { ...this.fnHost, _handle: undefined },
      deps: this.deps,
      debug: this.debug.serialize(),
      tsLs: this.tsLs,
      lint: this.lint,
    };
  }

  // ---- One-shot lanes (build / lint / format / typecheck) -----------------

  async runLane(id: string, opts: { fix?: boolean; check?: boolean } = {}): Promise<LaneRunResult> {
    const d = this.detection;
    if (!d?.hasProject) return { ok: false, reason: "No Node.js project detected." };
    const lane = this.lanes[id];
    if (!lane) return { ok: false, reason: `Unknown lane: ${id}` };
    if (lane.status === "running") return { ok: false, reason: `${id} is already running.` };

    const cmd = resolveLane(d, id, opts);
    if (cmd.unavailable) {
      this.log(`${id}: ${cmd.reason}`, "warning");
      return { ok: false, reason: cmd.reason };
    }

    lane.status = "running";
    lane.label = cmd.label;
    lane.exitCode = null;
    lane.output = [];
    lane.startedAt = Date.now();
    lane.endedAt = null;
    this.broadcast({ type: "lane:start", lane: id, label: cmd.label, auto: this._autoRunning });

    const res = await run(cmd.argv, {
      cwd: this.cwd,
      onData: (chunk) => {
        pushCapped(lane.output, chunk);
        this.broadcast({ type: "lane:data", lane: id, chunk });
      },
    });

    lane.exitCode = res.code;
    lane.endedAt = Date.now();
    lane.status = res.code === 0 ? "passed" : "failed";
    if (res.code !== 0) {
      this.fixContext[id] = {
        command: cmd.label,
        output: lane.output.join(""),
        exitCode: res.code,
      };
    }
    this.broadcast({ type: "lane:end", lane: id, exitCode: res.code, status: lane.status });
    return { ok: res.code === 0, exitCode: res.code };
  }

  // ---- Test lane with graphical report ------------------------------------

  async runTests(
    opts: TestOptions = {},
  ): Promise<{ ok: boolean; reason?: string; report?: TestReport | null }> {
    const d = this.detection;
    if (!d?.hasProject) return { ok: false, reason: "No Node.js project detected." };
    if (this._testWatch) return { ok: false, reason: "Watch mode is active." };
    const lane = this.lanes.test;
    if (lane.status === "running") return { ok: false, reason: "Tests are already running." };

    let tmpDir: string | null = null;
    let outputFile: string | undefined;
    const spec = resolveTest(d, opts);
    if (spec.unavailable) {
      this.log(`test: ${spec.reason}`, "warning");
      return { ok: false, reason: spec.reason };
    }
    if (spec.outputFile === undefined && spec.parser === "jest") {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "cockpit-"));
      outputFile = path.join(tmpDir, "results.json");
    }
    const resolved = outputFile ? resolveTest(d, { ...opts, outputFile }) : spec;
    if (resolved.unavailable) {
      this.log(`test: ${resolved.reason}`, "warning");
      return { ok: false, reason: resolved.reason };
    }

    lane.status = "running";
    lane.label = resolved.label;
    lane.output = [];
    lane.startedAt = Date.now();
    lane.endedAt = null;
    this.test.report = null;
    this.broadcast({
      type: "lane:start",
      lane: "test",
      label: resolved.label,
      auto: this._autoRunning,
    });

    const gen = this._projectGen;
    const res = await run(resolved.argv, {
      cwd: this.cwd,
      onData: (chunk) => {
        pushCapped(lane.output, chunk);
        this.broadcast({ type: "lane:data", lane: "test", chunk });
      },
    });

    let report: TestReport | null = null;
    try {
      if (resolved.parser === "jest" && outputFile) {
        const json = JSON.parse(await readFile(outputFile, "utf8"));
        report = parseJestLike(json);
      } else if (resolved.parser === "tap") {
        report = parseTap(lane.output.join(""));
      } else {
        report = parseTextCounts(lane.output.join(""));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Could not parse test results: ${message}`, "warning");
      report = parseTextCounts(lane.output.join(""));
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    // A project switch happened mid-run — discard so the previous project's report
    // doesn't surface under the newly-focused one.
    if (gen !== this._projectGen) return { ok: false, reason: "Project changed.", report };

    this.test.report = report;
    lane.exitCode = res.code;
    lane.endedAt = Date.now();
    const passed = report ? report.ok && res.code === 0 : res.code === 0;
    lane.status = passed ? "passed" : "failed";
    if (!passed) {
      this.fixContext.test = {
        command: resolved.label,
        output: lane.output.join(""),
        exitCode: res.code,
        report,
      };
    }
    this.broadcast({ type: "test:report", report });
    this.broadcast({ type: "lane:end", lane: "test", exitCode: res.code, status: lane.status });
    return { ok: passed, report };
  }

  // ---- Native test watch mode ---------------------------------------------

  // Toggle the persistent watch process on/off (POST /api/test/watch).
  async setTestWatch(on: boolean): Promise<{ ok: boolean; reason?: string }> {
    return on ? this.startTestWatch() : this.stopTestWatch();
  }

  // Start the runner's native watch process. vitest/jest stream a JSON report to
  // a temp file (read via fs.watch); node --test reprints TAP (parsed on settle).
  async startTestWatch(opts: TestOptions = {}): Promise<{ ok: boolean; reason?: string }> {
    const d = this.detection;
    if (!d?.hasProject) return { ok: false, reason: "No Node.js project detected." };
    if (this._testWatch) return { ok: true };
    const lane = this.lanes.test;
    if (lane.status === "running") return { ok: false, reason: "Tests are already running." };

    const probe = resolveTest(d, { ...opts, watch: true });
    if (probe.unavailable) {
      this.log(`watch: ${probe.reason}`, "warning");
      return { ok: false, reason: probe.reason };
    }
    let tmpDir: string | null = null;
    let outputFile: string | null = null;
    if (probe.parser === "jest") {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "cockpit-watch-"));
      outputFile = path.join(tmpDir, "results.json");
    }
    const resolved = outputFile ? resolveTest(d, { ...opts, watch: true, outputFile }) : probe;
    if (resolved.unavailable || !resolved.argv) {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: resolved.reason || "Watch mode unavailable." };
    }

    lane.status = "running";
    lane.label = resolved.label;
    lane.output = [];
    lane.startedAt = Date.now();
    lane.endedAt = null;
    this.test.report = null;
    this.test.watch = true;
    this.broadcast({ type: "lane:start", lane: "test", label: resolved.label });
    this.broadcast({ type: "test:watch", on: true });

    const handle = start(resolved.argv, {
      cwd: this.cwd,
      onData: (chunk) => {
        pushCapped(lane.output, chunk);
        this.broadcast({ type: "lane:data", lane: "test", chunk });
        if (!outputFile) this.scheduleWatchReparse();
      },
    });

    let fileWatcher: FSWatcher | null = null;
    if (tmpDir) {
      // The report file may not exist until the first run finishes; watch the
      // dedicated temp dir and read the file tolerantly on each change.
      try {
        fileWatcher = fsWatch(tmpDir, () => this.scheduleWatchFileRead());
      } catch {
        fileWatcher = null;
      }
    }

    this._testWatch = {
      handle,
      parser: resolved.parser || "text",
      label: resolved.label || "tests",
      outputFile,
      tmpDir,
      fileWatcher,
      debounce: null,
      retries: 0,
    };

    handle.child.on("close", () => this.finalizeWatchStopped());
    return { ok: true };
  }

  async stopTestWatch(): Promise<{ ok: boolean }> {
    const w = this._testWatch;
    if (!w) {
      if (this.test.watch) {
        this.test.watch = false;
        this.broadcast({ type: "test:watch", on: false });
      }
      return { ok: true };
    }
    this._testWatch = null;
    if (w.debounce) clearTimeout(w.debounce);
    if (w.fileWatcher) {
      try {
        w.fileWatcher.close();
      } catch {}
    }
    await w.handle.stop();
    if (w.tmpDir) await rm(w.tmpDir, { recursive: true, force: true }).catch(() => {});
    this.settleWatchLane();
    this.test.watch = false;
    this.broadcast({ type: "test:watch", on: false });
    return { ok: true };
  }

  // The watch process exited on its own (crash / external stop): tear down state.
  private finalizeWatchStopped(): void {
    const w = this._testWatch;
    if (!w) return;
    this._testWatch = null;
    if (w.debounce) clearTimeout(w.debounce);
    if (w.fileWatcher) {
      try {
        w.fileWatcher.close();
      } catch {}
    }
    if (w.tmpDir) rm(w.tmpDir, { recursive: true, force: true }).catch(() => {});
    this.settleWatchLane();
    this.test.watch = false;
    this.broadcast({ type: "test:watch", on: false });
  }

  // Move the test lane out of the perpetual "running" state once watch ends.
  private settleWatchLane(): void {
    const lane = this.lanes.test;
    if (lane.status !== "running") return;
    lane.status = this.test.report
      ? this.test.report.ok && this.test.report.failed === 0
        ? "passed"
        : "failed"
      : "idle";
    lane.endedAt = Date.now();
    this.broadcast({
      type: "lane:end",
      lane: "test",
      exitCode: lane.status === "failed" ? 1 : 0,
      status: lane.status,
    });
  }

  private scheduleWatchFileRead(): void {
    const w = this._testWatch;
    if (!w?.outputFile) return;
    if (w.debounce) clearTimeout(w.debounce);
    w.retries = 0;
    w.debounce = setTimeout(() => this.readWatchReport(), 250);
  }

  private async readWatchReport(): Promise<void> {
    const w = this._testWatch;
    if (!w?.outputFile) return;
    try {
      const json = JSON.parse(await readFile(w.outputFile, "utf8"));
      w.retries = 0;
      this.applyWatchReport(parseJestLike(json));
    } catch {
      // Partial write or report not ready. fs.watch may not fire again for this
      // run (the change event can arrive mid-truncation), so retry a few times
      // instead of relying solely on a later event, which could leave a stale badge.
      if (w.retries < 8) {
        w.retries++;
        if (w.debounce) clearTimeout(w.debounce);
        w.debounce = setTimeout(() => this.readWatchReport(), 150);
      }
    }
  }

  private scheduleWatchReparse(): void {
    const w = this._testWatch;
    if (!w || w.outputFile) return;
    if (w.debounce) clearTimeout(w.debounce);
    w.debounce = setTimeout(() => {
      const buf = this.lanes.test.output.join("");
      // node --test --watch reprints a full TAP document per run; parse the last.
      const idx = buf.lastIndexOf("TAP version");
      const slice = idx >= 0 ? buf.slice(idx) : buf;
      // Only apply once the run's TAP plan line (`1..N`) is present, so a
      // truncated/partial reprint can't under-count and flip the badge falsely.
      if (!/^\s*\d+\.\.\d+/m.test(slice)) return;
      const report = w.parser === "tap" ? parseTap(slice) : parseTextCounts(slice);
      if (report.total > 0 || report.failed > 0) this.applyWatchReport(report);
    }, 500);
  }

  private applyWatchReport(report: TestReport): void {
    const lane = this.lanes.test;
    this.test.report = report;
    lane.endedAt = Date.now();
    const passed = report.ok && report.failed === 0;
    lane.status = passed ? "passed" : "failed";
    if (!passed) {
      this.fixContext.test = {
        command: lane.label || "tests",
        output: lane.output.join(""),
        exitCode: 1,
        report,
      };
    }
    this.broadcast({ type: "test:report", report });
    this.broadcast({
      type: "lane:end",
      lane: "test",
      exitCode: passed ? 0 : 1,
      status: lane.status,
    });
  }

  // ---- Auto-run on load ----------------------------------------------------

  // Run the user's configured on-load tasks once, for available lanes only.
  // The three groups (Problems, Tests, Deps) are independent — they spawn
  // different tools and write distinct state slices — so they run concurrently
  // instead of one after another (each method keeps its own `_projectGen` guard).
  private async runAutoTasks(): Promise<void> {
    const d = this.detection;
    if (!d?.hasProject) return;
    const s = await loadSettings(this.cwd);
    const a = d.availability;
    this._autoRunning = true;
    try {
      const groups: Promise<unknown>[] = [];
      // Prime the Problems tab (live lint + TS diagnostics) so its pill populates
      // on load — this fills this.lint/this.tsLs (carried in the boot snapshot)
      // and broadcasts lint:/ts: diagnostics to connected clients. Lint then TS
      // stay sequential within the group (they share the TS fs-watchers/idle setup).
      if (s.autoProblems) {
        groups.push(
          (async () => {
            if (a?.lint !== false) await this.getLintDiagnostics().catch(() => {});
            if (a?.diagnostics !== false) await this.getDiagnostics().catch(() => {});
          })(),
        );
      }
      if (s.autoTest && a?.test !== false) groups.push(this.runTests().catch(() => {}));
      if (s.autoDeps) {
        groups.push(
          Promise.all([this.listOutdated().catch(() => {}), this.runAudit().catch(() => {})]),
        );
      }
      await Promise.all(groups);
    } finally {
      this._autoRunning = false;
    }
  }

  // ---- Arbitrary package.json script --------------------------------------

  async runScriptByName(name: string): Promise<LaneRunResult> {
    const d = this.detection;
    if (!d?.hasProject) return { ok: false, reason: "No Node.js project detected." };
    if (!d.scripts[name]) return { ok: false, reason: `No "${name}" script in package.json.` };
    const id = `script:${name}`;
    this.lanes[id] = this.lanes[id] || this.freshLane(id);
    const lane = this.lanes[id];
    if (lane.status === "running")
      return { ok: false, reason: `Script ${name} is already running.` };
    const argv = pmRunScript(d.pm, name);
    lane.status = "running";
    lane.label = `${d.pm} run ${name}`;
    lane.output = [];
    lane.startedAt = Date.now();
    this.broadcast({ type: "lane:start", lane: id, label: lane.label });
    const res = await run(argv, {
      cwd: this.cwd,
      onData: (chunk) => {
        pushCapped(lane.output, chunk);
        this.broadcast({ type: "lane:data", lane: id, chunk });
      },
    });
    lane.exitCode = res.code;
    lane.endedAt = Date.now();
    lane.status = res.code === 0 ? "passed" : "failed";
    if (res.code !== 0)
      this.fixContext[id] = {
        command: lane.label,
        output: lane.output.join(""),
        exitCode: res.code,
      };
    this.broadcast({ type: "lane:end", lane: id, exitCode: res.code, status: lane.status });
    return { ok: res.code === 0, exitCode: res.code };
  }

  // ---- Dev server ---------------------------------------------------------

  async startDev(): Promise<{ ok: boolean; reason?: string; url?: string | null; label?: string }> {
    const d = this.detection;
    if (!d?.hasProject) return { ok: false, reason: "No Node.js project detected." };
    if (this.dev.status === "running")
      return { ok: false, reason: "Dev server already running.", url: this.dev.url };
    const cmd = resolveDev(d);
    if (cmd.unavailable) {
      this.log(`dev: ${cmd.reason}`, "warning");
      return { ok: false, reason: cmd.reason };
    }
    this.dev = {
      status: "running",
      url: null,
      port: null,
      output: [],
      pid: null,
      label: cmd.label,
      _handle: null,
    };
    this.broadcast({ type: "dev:start", label: cmd.label });

    const handle = start(cmd.argv, {
      cwd: this.cwd,
      onData: (chunk) => {
        pushCapped(this.dev.output, chunk);
        this.broadcast({ type: "dev:data", chunk });
        if (!this.dev.url) {
          const url = extractUrl(chunk);
          if (url) {
            this.dev.url = url;
            try {
              this.dev.port = Number(new URL(url).port) || null;
            } catch {}
            this.broadcast({ type: "dev:url", url });
          }
        }
        if (isPortInUse(chunk)) {
          this.broadcast({ type: "dev:port-in-use" });
          this.log("Dev server reported the port is already in use.", "warning");
        }
      },
    });
    this.dev._handle = handle;
    this.dev.pid = handle.child.pid ?? null;
    handle.child.on("close", (code) => {
      this.dev.status = "stopped";
      this.dev.pid = null;
      this.dev._handle = null;
      if (code && code !== 0 && code !== null) {
        this.fixContext.dev = {
          command: cmd.label,
          output: this.dev.output.join(""),
          exitCode: code,
        };
      }
      this.broadcast({ type: "dev:exit", exitCode: code });
    });
    return { ok: true, label: cmd.label };
  }

  async stopDev(): Promise<{ ok: boolean; reason?: string }> {
    if (this.dev.status !== "running" || !this.dev._handle)
      return { ok: false, reason: "Dev server is not running." };
    await this.dev._handle.stop();
    this.dev.status = "stopped";
    this.dev.pid = null;
    this.dev._handle = null;
    this.broadcast({ type: "dev:exit", exitCode: null });
    return { ok: true };
  }

  // ---- Rayfin local functions host ----------------------------------------
  // Managed persistent process (`rayfin dev functions apply` → Azure Functions
  // Core Tools `func start`) — the local host the Rayfin function invoker targets.
  // Modeled on the dev server: long-lived, streamed to a Console lane, torn down
  // on project switch / extension close. Gated by `func` + local-`rayfin`
  // preflights so it never trips the CLI's interactive Core-Tools-install consent
  // prompt (which would hang a non-interactive lane).

  serializeFnHost(): FunctionsHostStatus {
    return { ...this.fnHost, _handle: undefined };
  }

  async startFunctionsHost(): Promise<{ ok: boolean; reason?: string }> {
    const d = this.detection;
    if (!d?.hasProject || !d.rayfin) return { ok: false, reason: "Not a Rayfin project." };
    if (this.fnHost.status === "running")
      return { ok: false, reason: "Functions host already running." };
    if (!hasLocalRayfinBin(this.cwd))
      return { ok: false, reason: "The local rayfin CLI isn't installed." };
    if (!hasFuncBin(this.cwd)) {
      this.fnHost.funcAvailable = false;
      return {
        ok: false,
        reason:
          "Azure Functions Core Tools (func) isn't installed — install it to run the local functions host.",
      };
    }
    const laneId = FN_HOST_LANE;
    const label = "rayfin dev functions apply";
    this.lanes[laneId] = this.freshLane(laneId);
    const lane = this.lanes[laneId];
    lane.status = "running";
    lane.label = label;
    lane.output = [];
    lane.startedAt = Date.now();
    lane.endedAt = null;
    this.broadcast({ type: "lane:start", lane: laneId, label });

    const handle = start(rayfinDevFunctionsArgv(d.pm), {
      cwd: this.cwd,
      onData: (chunk) => {
        pushCapped(lane.output, chunk);
        this.broadcast({ type: "lane:data", lane: laneId, chunk });
      },
    });
    this.fnHost.status = "running";
    this.fnHost.funcAvailable = true;
    this.fnHost.pid = handle.child.pid ?? null;
    this.fnHost._handle = handle;
    handle.child.on("close", (code) => {
      lane.exitCode = code;
      lane.endedAt = Date.now();
      lane.status = code === 0 || code === null ? "passed" : "failed";
      this.broadcast({ type: "lane:end", lane: laneId, exitCode: code, status: lane.status });
      // Only clear host state if *this* process is still the active one — a since-
      // superseded host (project switch, or a stop→start race) must not reset the
      // newer handle/pid.
      if (this.fnHost._handle !== handle) return;
      this.fnHost.status = "stopped";
      this.fnHost.pid = null;
      this.fnHost._handle = null;
      this.broadcast({ type: "rayfin:fnhost", fnHost: this.serializeFnHost() });
    });
    this.broadcast({ type: "rayfin:fnhost", fnHost: this.serializeFnHost() });
    return { ok: true };
  }

  async stopFunctionsHost(): Promise<{ ok: boolean; reason?: string }> {
    const handle = this.fnHost._handle;
    if (this.fnHost.status !== "running" || !handle)
      return { ok: false, reason: "Functions host is not running." };
    await handle.stop();
    // Guard against a concurrent switch/start having already repointed fnHost to a
    // different process while stop() awaited.
    if (this.fnHost._handle === handle) {
      this.fnHost.status = "stopped";
      this.fnHost.pid = null;
      this.fnHost._handle = null;
      this.broadcast({ type: "rayfin:fnhost", fnHost: this.serializeFnHost() });
    }
    return { ok: true };
  }

  // Passive, timeout-bounded reachability probe of the configured base URL's
  // localhost origin. Any HTTP response (even a 404) => reachable; a thrown
  // connection error => unreachable; a non-localhost / invalid base => unknown
  // (null). Never follows redirects, never throws.
  async probeFunctionsHost(baseUrl?: unknown): Promise<boolean | null> {
    const base =
      typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : DEFAULT_FN_BASE_URL;
    const origin = resolveFunctionsHostOrigin(base);
    if (!origin) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    try {
      await this._fetchImpl(origin, { method: "GET", redirect: "manual", signal: ctl.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // Refresh + return the serialized host status (reachability + `func`/CLI
  // availability for the current base URL). Broadcasts `rayfin:fnhost`. Guarded by
  // `_projectGen`/cwd so a slow probe from a since-switched project can't publish.
  async getFunctionsHostStatus(baseUrl?: unknown): Promise<FunctionsHostStatus> {
    const gen = this._projectGen;
    const cwd = this.cwd;
    const base =
      typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : DEFAULT_FN_BASE_URL;
    const funcAvailable = hasFuncBin(this.cwd) && hasLocalRayfinBin(this.cwd);
    const reachable = await this.probeFunctionsHost(base);
    if (this._projectGen !== gen || this.cwd !== cwd) return this.serializeFnHost();
    this.fnHost.reachable = reachable;
    this.fnHost.funcAvailable = funcAvailable;
    this.fnHost.baseUrl = base;
    const out = this.serializeFnHost();
    this.broadcast({ type: "rayfin:fnhost", fnHost: out });
    return out;
  }

  // ---- Debugger (CDP) -----------------------------------------------------
  // Thin delegators so the HTTP API and the agent actions drive the same
  // session. The session resolves relative paths against the project cwd.

  debugStart(opts: Omit<DebugStartOptions, "cwd"> & { cwd?: string }): Promise<DebugActionResult> {
    return this.debug.start({ ...opts, cwd: opts.cwd || this.cwd });
  }

  debugAttach(opts: DebugAttachOptions): Promise<DebugActionResult> {
    return this.debug.attach(opts);
  }

  debugStop(): Promise<DebugActionResult> {
    return this.debug.stop();
  }

  debugSetBreakpoint(input: {
    file: string;
    line: number;
    column?: number;
    condition?: string;
  }): Promise<DebugActionResult> {
    return this.debug.setBreakpoint({ ...input, cwd: this.cwd });
  }

  debugRemoveBreakpoint(input: {
    id?: string;
    file?: string;
    line?: number;
  }): Promise<DebugActionResult> {
    return this.debug.removeBreakpoint({ ...input, cwd: this.cwd });
  }

  debugListBreakpoints(): DebugActionResult {
    return this.debug.listBreakpoints();
  }

  debugContinue(): Promise<DebugActionResult> {
    return this.debug.resume();
  }
  debugPause(): Promise<DebugActionResult> {
    return this.debug.pause();
  }
  debugStepOver(): Promise<DebugActionResult> {
    return this.debug.stepOver();
  }
  debugStepInto(): Promise<DebugActionResult> {
    return this.debug.stepInto();
  }
  debugStepOut(): Promise<DebugActionResult> {
    return this.debug.stepOut();
  }

  debugWaitForPause(timeoutMs?: number): Promise<DebugActionResult> {
    return this.debug.waitForPause(timeoutMs);
  }

  debugGetStack(): DebugActionResult {
    return this.debug.getStack();
  }

  debugGetVariables(input: {
    frameId?: string;
    includeGlobal?: boolean;
  }): Promise<DebugActionResult> {
    return this.debug.getVariables(input);
  }

  debugGetProperties(objectId: string): Promise<DebugActionResult> {
    return this.debug.getProperties(objectId);
  }

  debugEvaluate(input: { expression: string; frameId?: string }): Promise<DebugActionResult> {
    return this.debug.evaluate(input);
  }

  debugGetState(): DebugActionResult {
    return this.debug.getStatus();
  }

  // ---- TypeScript language server (live diagnostics) ----------------------

  // Lazy entry point: ensure the server + watchers are up and return a fresh
  // project-wide diagnostics snapshot. Called when the Problems tab opens or via
  // the get_diagnostics action.
  async getDiagnostics(): Promise<TsLsState> {
    await this.refreshDiagnostics({ reload: false });
    return this.tsLs;
  }

  private ensureTsClient(): TsServerClient | null {
    const d = this.detection;
    if (!d?.hasProject) return null;
    if (this._tsClient && this._tsClient.cwd !== this.cwd) {
      this._tsClient.stop();
      this._tsClient = null;
    }
    if (!this._tsClient) {
      const tsserverPath = resolveTsserverPath(this.cwd);
      if (!tsserverPath) return null;
      this._tsClient = new TsServerClient(this.cwd, tsserverPath);
    }
    return this._tsClient;
  }

  private async refreshDiagnostics({ reload = false } = {}): Promise<void> {
    const d = this.detection;
    if (!d?.hasProject || !d.availability?.diagnostics) {
      this.setTsState({
        ...this.freshTsLs(),
        reason: "TypeScript not detected in this project.",
      });
      return;
    }
    const client = this.ensureTsClient();
    if (!client) {
      this.setTsState({
        ...this.tsLs,
        status: "error",
        reason: "Could not resolve the project's TypeScript (tsserver).",
      });
      return;
    }
    this.setupTsWatchers();
    this.resetTsIdle();
    this.tsLs.status = client.running ? "analyzing" : "starting";
    this.tsLs.reason = null;
    this.emitTsStatus();
    if (reload) client.reload();
    const gen = this._projectGen;
    try {
      const diagnostics = await client.getProjectDiagnostics();
      // A project switch happened mid-analysis — discard so the previous project's
      // diagnostics don't surface under the newly-focused one.
      if (gen !== this._projectGen) return;
      const errorCount = diagnostics.filter((x) => x.category === "error").length;
      const warningCount = diagnostics.filter((x) => x.category === "warning").length;
      this.setTsState({
        status: "ready",
        diagnostics,
        errorCount,
        warningCount,
        lastUpdated: Date.now(),
        reason: null,
      });
    } catch (err) {
      if (gen !== this._projectGen) return;
      this.setTsState({
        ...this.tsLs,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private setTsState(next: TsLsState): void {
    this.tsLs = next;
    this.emitTsDiagnostics();
  }

  private emitTsStatus(): void {
    this.broadcast({
      type: "ts:status",
      status: this.tsLs.status,
      errorCount: this.tsLs.errorCount,
      warningCount: this.tsLs.warningCount,
    });
  }

  private emitTsDiagnostics(): void {
    this.broadcast({ type: "ts:diagnostics", tsLs: this.tsLs });
  }

  // ---- Linter (live diagnostics via JSON reporter) ------------------------

  // Lazy entry point: ensure watchers are up and return a fresh lint snapshot.
  // Called when the Problems tab opens or via the get_diagnostics action.
  async getLintDiagnostics(): Promise<LintState> {
    await this.refreshLint();
    return this.lint;
  }

  private async refreshLint(): Promise<void> {
    const d = this.detection;
    if (!d?.hasProject || !d.availability?.lint) {
      this.setLintState({
        ...this.freshLint(),
        status: "unavailable",
        reason: "No linter (eslint / biome / oxlint) detected in this project.",
      });
      return;
    }
    // Share the TS pipeline's watchers + idle timer so saves re-lint live even in
    // a lint-only (no TypeScript) project.
    this.setupTsWatchers();
    this.resetTsIdle();
    // Coalesce overlapping runs: if a loop is already active, mark it dirty so it
    // re-lints once more, and await that same loop so callers see the final result.
    if (this._lintRunning) {
      this._lintDirty = true;
      return this._lintRunning;
    }
    const loop = this.runLintLoop();
    this._lintRunning = loop;
    // Only clear the handle if it's still ours — a project switch may have replaced
    // it with a newer loop while this one was draining.
    void loop.finally(() => {
      if (this._lintRunning === loop) this._lintRunning = null;
    });
    return loop;
  }

  // Run the linter, re-running while changes land mid-run (_lintDirty). A
  // generation token (bumped on project change / teardown) prevents a run that
  // started before a switch from publishing stale results into the new project.
  private async runLintLoop(): Promise<void> {
    do {
      this._lintDirty = false;
      const gen = this._lintGen;
      const d = this.detection;
      const cwd = this.cwd;
      if (!d?.hasProject || !d.availability?.lint) return;
      const resolved = resolveLintJson(d);
      if (resolved.unavailable) {
        if (gen === this._lintGen) {
          this.setLintState({
            ...this.freshLint(),
            status: "unavailable",
            reason: resolved.reason,
          });
        }
        return;
      }
      if (gen === this._lintGen) {
        this.lint = { ...this.lint, status: "linting", reason: null };
        this.broadcast({
          type: "lint:status",
          status: "linting",
          errorCount: this.lint.errorCount,
          warningCount: this.lint.warningCount,
        });
      }
      const res = await run(resolved.argv, { cwd });
      // A project switch (or teardown) happened mid-run — discard stale output.
      if (gen !== this._lintGen) return;
      const raw = (res.stdout ?? res.output ?? "").trim();
      let diagnostics: Diagnostic[];
      try {
        diagnostics = sortDiagnostics(parseLint(resolved.parser, raw, cwd));
      } catch {
        // Non-JSON output usually means the linter itself errored (bad config,
        // missing plugin) rather than reporting findings.
        const reason =
          (res.stderr || res.output || "").trim().split(/\r?\n/).slice(0, 3).join(" ") ||
          "Linter produced no parseable output.";
        this.setLintState({ ...this.freshLint(), status: "error", reason });
        continue;
      }
      const errorCount = diagnostics.filter((x) => x.category === "error").length;
      const warningCount = diagnostics.filter((x) => x.category === "warning").length;
      this.setLintState({
        status: "ready",
        diagnostics,
        errorCount,
        warningCount,
        infoCount: diagnostics.length - errorCount - warningCount,
        lastUpdated: Date.now(),
        reason: null,
      });
    } while (this._lintDirty);
  }

  private setLintState(next: LintState): void {
    this.lint = next;
    this.broadcast({ type: "lint:diagnostics", lint: this.lint });
  }

  private scheduleLintRefresh(): void {
    const d = this.detection;
    if (!d?.hasProject || !d.availability?.lint) return;
    if (this._lintRefreshTimer) clearTimeout(this._lintRefreshTimer);
    this._lintRefreshTimer = setTimeout(() => {
      this._lintRefreshTimer = null;
      void this.refreshLint();
    }, 500);
  }

  // ---- File watching → debounced refresh / restart ------------------------

  private setupTsWatchers(): void {
    if (this._tsWatchers.length) return;
    const onChange = (_event: string, filename: string | Buffer | null) =>
      this.onTsFsEvent(filename);
    const watch = (target: string, recursive: boolean) => {
      try {
        this._tsWatchers.push(fsWatch(target, { recursive }, onChange));
      } catch {}
    };
    watch(this.cwd, false);
    let watched = 0;
    for (const name of TS_WATCH_DIRS) {
      const dir = path.join(this.cwd, name);
      try {
        if (statSync(dir).isDirectory()) {
          watch(dir, true);
          watched++;
        }
      } catch {}
    }
    // No curated source dirs → fall back to a filtered recursive watch.
    if (!watched) watch(this.cwd, true);
  }

  private teardownTsWatchers(): void {
    for (const w of this._tsWatchers) {
      try {
        w.close();
      } catch {}
    }
    this._tsWatchers = [];
  }

  private onTsFsEvent(filename: string | Buffer | null): void {
    const d = this.detection;
    const a = d?.hasProject ? d.availability : undefined;
    if (filename == null) {
      if (a?.diagnostics) this.scheduleTsRefresh();
      if (a?.lint) this.scheduleLintRefresh();
      return;
    }
    const name = filename.toString();
    if (name.includes("node_modules") || name.includes(`.git${path.sep}`)) return;
    const base = path.basename(name);
    if (/^tsconfig.*\.json$/i.test(base)) {
      if (a?.diagnostics) this.scheduleTsRestart();
      // tsconfig include/exclude/paths can change type-aware lint results too.
      this.scheduleLintRefresh();
      return;
    }
    if (!TS_WATCH_EXT.has(path.extname(base))) return;
    if (a?.diagnostics) this.scheduleTsRefresh();
    this.scheduleLintRefresh();
  }

  private scheduleTsRefresh(): void {
    this.resetTsIdle();
    if (this._tsRefreshTimer) clearTimeout(this._tsRefreshTimer);
    this._tsRefreshTimer = setTimeout(() => {
      this._tsRefreshTimer = null;
      void this.refreshDiagnostics({ reload: true });
    }, 400);
  }

  private scheduleTsRestart(): void {
    this.resetTsIdle();
    if (this._tsRestartTimer) clearTimeout(this._tsRestartTimer);
    this._tsRestartTimer = setTimeout(() => {
      this._tsRestartTimer = null;
      // Recreate the client so it picks up the new tsconfig/project layout.
      if (this._tsClient) {
        this._tsClient.stop();
        this._tsClient = null;
      }
      void this.refreshDiagnostics({ reload: false });
    }, 600);
  }

  private resetTsIdle(): void {
    if (this._tsIdleTimer) clearTimeout(this._tsIdleTimer);
    this._tsIdleTimer = setTimeout(() => this.idleStopTsServer(), TS_IDLE_MS);
  }

  // Idle: stop the (memory-heavy) server + watchers but keep the last results on
  // screen. The next getDiagnostics() lazily restarts everything.
  private idleStopTsServer(): void {
    if (this._tsIdleTimer) {
      clearTimeout(this._tsIdleTimer);
      this._tsIdleTimer = null;
    }
    this.teardownTsWatchers();
    if (this._tsClient) this._tsClient.stop();
    this.tsLs = { ...this.tsLs, status: "stopped" };
    this.emitTsStatus();
  }

  // Full teardown (project change / canvas close): drop the client and results.
  stopTsServer(): void {
    for (const t of [
      this._tsRefreshTimer,
      this._tsRestartTimer,
      this._tsIdleTimer,
      this._lintRefreshTimer,
    ]) {
      if (t) clearTimeout(t);
    }
    this._tsRefreshTimer = null;
    this._tsRestartTimer = null;
    this._tsIdleTimer = null;
    this._lintRefreshTimer = null;
    this._lintDirty = false;
    // Invalidate any in-flight lint run so it can't publish stale results into the
    // next project, and release the handle so the next refresh starts fresh.
    this._lintGen++;
    this._lintRunning = null;
    this.teardownTsWatchers();
    if (this._tsClient) {
      this._tsClient.stop();
      this._tsClient = null;
    }
    this.tsLs = this.freshTsLs();
    this.lint = this.freshLint();
  }

  // ---- Dependencies (delegated to deps.ts) --------------------------------

  listOutdated() {
    return deps.listOutdated(this);
  }
  runAudit() {
    return deps.runAudit(this);
  }
  safeUpdate(opts?: SafeUpdateOptions): Promise<SafeUpdateResult> {
    return deps.safeUpdate(this, opts);
  }
  rollbackLastUpdate() {
    return deps.rollbackLast(this);
  }

  // "Update with Copilot": resolve targets from the user's per-package selection
  // and hand the update off to the agent (which drives update_dependencies /
  // audit / rollback). The selected packages target their in-range `wanted`
  // version in "default" mode, or `latest` in "latest" mode.
  async sendCopilotUpdate(opts: {
    mode: "default" | "latest";
    packages?: string[] | null;
  }): Promise<{ ok: boolean; reason?: string }> {
    const mode = opts.mode === "latest" ? "latest" : "default";
    if (!this.deps.outdated) await this.listOutdated().catch(() => {});
    const list = this.deps.outdated?.list || [];
    const picked = new Set(opts.packages || []);
    const targets: UpdatePromptTarget[] = [];
    for (const o of list) {
      if (!picked.has(o.name)) continue;
      const to = mode === "latest" ? o.latest || o.wanted : o.wanted || o.latest;
      if (to && to !== o.current) targets.push({ name: o.name, from: o.current, to });
    }
    if (!targets.length) return { ok: false, reason: "No packages to update." };
    // Establish a real audit baseline so the agent can tell genuinely new
    // high/critical advisories from pre-existing ones (count-only is unreliable).
    if (!this.deps.audit) await this.runAudit().catch(() => {});
    const baselineSevere = (this.deps.audit?.vulnerabilities || [])
      .filter((v) => v.severity === "high" || v.severity === "critical")
      .map((v) => v.name);
    const prompt = buildDepsUpdatePrompt({
      mode,
      targets,
      baselineAudit: this.deps.audit?.metadata || null,
      baselineSevere,
    });
    await this.sendToChat(prompt);
    this.log(`Asked Copilot to update ${targets.length} package(s).`);
    return { ok: true };
  }

  // ---- Self-update (the extension's own version) --------------------------

  // Cached GitHub Releases check. The process is long-lived, so auto-checks reuse
  // the last result for ~6h; `force` (manual "Check for updates") bypasses it.
  // Network/rate-limit/404 failures are non-fatal: we keep the last good data and
  // surface `error` so the UI can show a quiet "couldn't check" instead of nagging.
  async getUpdateInfo(force = false): Promise<UpdateInfo> {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    if (!force && this._update && Date.now() - this._update.checkedAt < SIX_HOURS) {
      return this._update;
    }
    if (this._updatePromise) return this._updatePromise;
    this._updatePromise = checkForUpdate(this.version, this.repoSlug, {
      fetchImpl: this._fetchImpl,
    })
      .then((info) => {
        // On a failed re-check keep the last successful result but refresh the error.
        if (info.error && this._update && !this._update.error) {
          this._update = { ...this._update, error: info.error, checkedAt: info.checkedAt };
        } else {
          this._update = info;
        }
        return this._update;
      })
      .finally(() => {
        this._updatePromise = null;
      });
    return this._updatePromise;
  }

  // "Update Cockpit.js": download the latest release and swap it over the install
  // dir in-process — no Copilot, no `npm install` (the extension has no runtime
  // deps). The extension can't reload itself, so the ONE remaining Copilot step is
  // a tiny reload prompt after a successful swap. Git checkouts are refused by
  // `applyRelease` (it won't clobber a working tree).
  async applySelfUpdate(): Promise<{ ok: boolean; reason?: string; installedVersion?: string }> {
    if (this._selfUpdating) return { ok: false, reason: "An update is already in progress." };
    this._selfUpdating = true;
    try {
      // Force a fresh release check so we install the actual latest tag, not a
      // possibly-stale ~6h cached one.
      const info = await this.getUpdateInfo(true);
      if (!info.updateAvailable || !info.latestVersion || !info.latestTag) {
        return { ok: false, reason: "Cockpit.js is up to date." };
      }
      const result = await applyRelease({
        dir: EXTENSION_DIR,
        slug: this.repoSlug,
        tag: info.latestTag,
        version: info.latestVersion,
        fetchImpl: this._fetchImpl,
      });
      if (!result.ok) {
        this.log(`Self-update failed: ${result.reason}`, "error");
        return result;
      }
      this.log(`Cockpit.js updated to v${info.latestVersion}; asking Copilot to reload.`);
      await this.sendToChat(buildReloadPrompt(info.latestVersion));
      return result;
    } finally {
      this._selfUpdating = false;
    }
  }
  async sendCopilotAuditFix(): Promise<AuditFixResult> {
    // Establish an audit baseline so we know what was fixable to begin with.
    if (!this.deps.audit) await this.runAudit().catch(() => {});
    let vulnerabilities = this.deps.audit?.vulnerabilities || [];
    if (!vulnerabilities.length) return { ok: false, reason: "No known vulnerabilities." };

    const d = this.detection;
    const fixableBefore = vulnerabilities.filter((v) => v.fixAvailable).length;

    // Step 1 — try the package manager's own `audit fix` first, verify-gated with
    // auto-rollback (npm/pnpm/yarn; bun has none). Only worth running if there's
    // something it could fix in place.
    let ran = false;
    let rolledBack = false;
    if (d?.hasProject && supportsAuditFix(d.pm) && fixableBefore > 0) {
      const r = await deps.safeAuditFix(this);
      ran = !!r.ran;
      rolledBack = !!r.rolledBack;
      // safeAuditFix refreshed this.deps.audit (or restored the baseline on rollback).
      vulnerabilities = this.deps.audit?.vulnerabilities || [];
    }

    const remaining = vulnerabilities;
    const remainingFixable = remaining.filter((v) => v.fixAvailable).length;
    const fixed = Math.max(0, fixableBefore - remainingFixable);

    // Step 2 — if `audit fix` cleared everything actionable, we're done. Anything
    // left has no automatic fix, so a Copilot bump can't help it either.
    if (ran && !rolledBack && remainingFixable === 0) {
      this.log(
        `Audit fix resolved ${fixed} vulnerability group(s); ${remaining.length} remain with no automatic fix.`,
      );
      return { ok: true, ran, rolledBack, fixed, remaining: remaining.length, escalated: false };
    }

    // Step 3 — escalate what remains (or the full set, if audit fix rolled back or
    // wasn't available) to Copilot.
    const prompt = buildDepsAuditFixPrompt({ vulnerabilities: remaining });
    await this.sendToChat(prompt);
    const lead = !ran
      ? "Asked"
      : rolledBack
        ? "Audit fix broke the app and was rolled back; asked"
        : `Audit fix resolved ${fixed}; asked`;
    this.log(`${lead} Copilot to fix ${remaining.length} vulnerability group(s).`);
    return { ok: true, ran, rolledBack, fixed, remaining: remaining.length, escalated: true };
  }

  // ---- Rayfin (Microsoft Rayfin BaaS dashboard) ---------------------------

  // Build (and cache) the read-only Rayfin dashboard model. The cache is cleared
  // on (re)detection and after every CLI command that can change state. The
  // sign-in chip is resolved by a CLI probe that we never block the render on —
  // see `ensureSignInProbe`.
  async getRayfinState(force = false): Promise<RayfinState | { detected: false }> {
    const d = this.detection;
    if (!d?.hasProject || !d.rayfin) return { detected: false };
    if (this._rayfin && !force) return this._rayfin;
    // Capture cwd so a project switch during the async read can't poison the
    // cache with another project's state.
    const cwd = this.cwd;
    const next = await readRayfinState(cwd);
    if (this.cwd !== cwd) return next; // switched mid-read; leave sign-in unknown
    // Show the last-known sign-in (or null = "Unknown") immediately, then resolve
    // it in the background — the CLI probe is slow (~up to 5s) and must not stall
    // the whole tab render the way it used to.
    next.auth.signedIn = this.cachedSignIn(cwd);
    this.overlayRayfinUpdate(next);
    this._rayfin = next;
    this.ensureSignInProbe(cwd, force);
    return next;
  }

  // Re-read the dashboard model and broadcast it (e.g. after a deploy / switch).
  // Defaults to re-checking sign-in (a CLI lane may have just logged in/out), but
  // the probe still runs in the background so the broadcast isn't delayed.
  async refreshRayfin(forceSignIn = true): Promise<void> {
    const d = this.detection;
    if (!d?.hasProject || !d.rayfin) {
      this._rayfin = null;
      return;
    }
    const cwd = this.cwd;
    const next = await readRayfinState(cwd);
    if (this.cwd !== cwd) return; // project switched mid-read; a fresh detection drives the UI
    next.auth.signedIn = this.cachedSignIn(cwd);
    this.overlayRayfinUpdate(next);
    this._rayfin = next;
    this.broadcast({ type: "rayfin:state", rayfin: next });
    this.ensureSignInProbe(cwd, forceSignIn);
  }

  // Last-known sign-in value for `cwd` (null = unknown / never probed).
  private cachedSignIn(cwd: string): boolean | null {
    const c = this._rayfinSignedIn;
    return c && c.cwd === cwd ? c.value : null;
  }

  // Background the sign-in probe so the dashboard render never waits on it. On
  // resolution it patches the cached model's auth chip and re-broadcasts, flipping
  // the UI from "Unknown"/last-known to the real state. Coalesces concurrent calls
  // for the same live project, is throttled so revisits don't re-spawn the CLI, and
  // discards stale results across project switches via the `_projectGen` guard.
  private ensureSignInProbe(cwd: string, force = false): void {
    const SIGNIN_TTL = 60_000;
    const gen = this._projectGen;
    const inflight = this._rayfinSignInProbe;
    // A probe for this exact project + generation is already running. Coalesce —
    // but if this is a forced re-check (auth may have just changed), queue a fresh
    // probe to run as soon as the current one settles so we never serve a value
    // captured before the change.
    if (inflight && inflight.cwd === cwd && inflight.gen === gen) {
      if (force) this._rayfinSignInRecheck = true;
      return;
    }
    // A non-forced call with a fresh cached value: nothing to do.
    if (!force) {
      const c = this._rayfinSignedIn;
      if (c && c.cwd === cwd && Date.now() - c.checkedAt < SIGNIN_TTL) return;
    }
    // (An in-flight probe for a *different* project/generation is left to self-
    // discard; we start ours alongside it and overwrite the descriptor.)
    const promise = this.probeRayfinSignedIn(cwd)
      .then((value) => {
        if (this.cwd !== cwd || this._projectGen !== gen) return; // stale; discard
        this._rayfinSignedIn = { cwd, value, checkedAt: Date.now() };
        if (this._rayfin && this._rayfin.auth.signedIn !== value) {
          this._rayfin.auth.signedIn = value;
          this.broadcast({ type: "rayfin:state", rayfin: this._rayfin });
        }
      })
      .catch(() => {})
      .finally(() => {
        // Only clear if this is still the current in-flight probe (a project switch
        // may have started a newer one that must not be wiped).
        if (this._rayfinSignInProbe?.promise !== promise) return;
        this._rayfinSignInProbe = null;
        // Honor a forced re-check queued while this probe was running.
        if (this._rayfinSignInRecheck && this.cwd === cwd && this._projectGen === gen) {
          this._rayfinSignInRecheck = false;
          this.ensureSignInProbe(cwd, true);
        }
      });
    this._rayfinSignInProbe = { cwd, gen, promise };
  }

  // Overlay the cached (network) Rayfin update result onto a freshly-read state.
  // `readRayfinState` fills `cli.installed` synchronously; the latest/update
  // fields come from the throttled `getRayfinUpdateInfo` check (or stay
  // unknown). Only applies when the cached check is for the same installed
  // version, so a stale result is never shown after an in-place upgrade.
  private overlayRayfinUpdate(next: RayfinState): void {
    const u = this._rayfinUpdate;
    if (u && u.installedVersion === next.cli.installed) {
      next.cli.latest = u.latestVersion;
      next.cli.updateAvailable = u.updateAvailable;
      next.cli.checkedAt = u.checkedAt;
      next.cli.error = u.error;
    }
  }

  // Ask the CLI whether the user is signed in (`rayfin login status`). The CLI is
  // the source of truth — credentials may live in a global store, not the project
  // — so a file check is unreliable. Only runs when the `rayfin` bin is installed
  // locally (so it never fetches/prompts), is bounded by a timeout, and any
  // failure / missing CLI resolves to `null` (unknown) — never a false "signed out".
  private async probeRayfinSignedIn(cwd: string): Promise<boolean | null> {
    const d = this.detection;
    if (!d?.hasProject) return null;
    // No locally-installed CLI -> we can't tell; don't spawn (would hit the
    // registry and/or exit non-zero, misreading as "signed out").
    if (!hasLocalRayfinBin(cwd)) return null;
    const argv = rayfinLoginStatusArgv(d.pm);
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        try {
          child?.kill();
        } catch {}
        resolve(null);
      }, 5000);
    });
    const probe = run(argv, { cwd, onStart: (c) => (child = c) }).then((res) =>
      interpretLoginStatus(res),
    );
    const result = await Promise.race([probe, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  // Shared lane runner for the Rayfin CLI buttons. Streams to the Console like
  // build/lint, then refreshes the dashboard model. Distinct `laneId`s per
  // command keep e.g. `up status` runnable while `up db apply`'s lane is busy.
  private async runRayfinLane(
    laneId: string,
    label: string,
    argv: string[],
  ): Promise<{ ok: boolean; reason?: string }> {
    this.lanes[laneId] = this.lanes[laneId] || this.freshLane(laneId);
    const lane = this.lanes[laneId];
    if (lane.status === "running") return { ok: false, reason: `${label} is already running.` };
    lane.status = "running";
    lane.label = label;
    lane.output = [];
    lane.startedAt = Date.now();
    lane.endedAt = null;
    this.broadcast({ type: "lane:start", lane: laneId, label });
    const res = await run(argv, {
      cwd: this.cwd,
      onData: (chunk) => {
        pushCapped(lane.output, chunk);
        this.broadcast({ type: "lane:data", lane: laneId, chunk });
      },
    });
    lane.exitCode = res.code;
    lane.endedAt = Date.now();
    lane.status = res.code === 0 ? "passed" : "failed";
    this.broadcast({ type: "lane:end", lane: laneId, exitCode: res.code, status: lane.status });
    // Any command may change auth / deployments / functions — refresh the model.
    await this.refreshRayfin().catch(() => {});
    return { ok: res.code === 0, reason: res.code === 0 ? undefined : `exit ${res.code}` };
  }

  // Run an allow-listed `rayfin` CLI command as a Console lane. We intentionally
  // do NOT expose these as agent actions — Rayfin ships its own MCP/CLI/skills
  // the agent already uses.
  async runRayfinCli(args: unknown): Promise<{ ok: boolean; reason?: string }> {
    const d = this.detection;
    if (!d?.hasProject || !d.rayfin) return { ok: false, reason: "Not a Rayfin project." };
    const valid = validateRayfinArgs(args);
    if (!valid) return { ok: false, reason: "Unsupported rayfin command." };
    return this.runRayfinLane(
      `rayfin:${valid.join(":")}`,
      `rayfin ${valid.join(" ")}`,
      rayfinArgv(d.pm, valid),
    );
  }

  // Quick workspace switch. The target is validated against the known deployment
  // list (not the generic SAFE_ARG regex) so names with spaces still switch; it
  // is spawned as a single argv element, so it cannot inject.
  async switchRayfinWorkspace(name: string): Promise<{ ok: boolean; reason?: string }> {
    const d = this.detection;
    if (!d?.hasProject || !d.rayfin) return { ok: false, reason: "Not a Rayfin project." };
    const target = (name || "").trim();
    if (!target) return { ok: false, reason: "No workspace name." };
    const st = await this.getRayfinState();
    const known = "deployments" in st && st.deployments.list.some((dpl) => dpl.name === target);
    if (!known) return { ok: false, reason: `Unknown workspace "${target}".` };
    return this.runRayfinLane(
      "rayfin:up:switch",
      `rayfin up switch ${target}`,
      rayfinArgv(d.pm, ["up", "switch", target]),
    );
  }

  // Deploy to Fabric (`rayfin up`). When `workspace` is given (the "not deployed
  // yet" flow) it targets a specific Fabric workspace by name / GUID / portal URL
  // — the value is passed as a single argv element (no shell, can't inject), so
  // it bypasses the generic SAFE_ARG allow-list, like the `up switch` path. `-y`
  // auto-accepts confirmations since the Console lane is non-interactive.
  async deployRayfinWorkspace(workspace: unknown): Promise<{ ok: boolean; reason?: string }> {
    const d = this.detection;
    if (!d?.hasProject || !d.rayfin) return { ok: false, reason: "Not a Rayfin project." };
    const value = (typeof workspace === "string" ? workspace : "").trim();
    const argv = ["up"];
    if (value) argv.push(rayfinWorkspaceFlag(value), value);
    argv.push("-y");
    return this.runRayfinLane(
      "rayfin:up",
      value ? `rayfin up (${value})` : "rayfin up",
      rayfinArgv(d.pm, argv),
    );
  }

  // Invoke a backend function against the **local** dev backend (the Azure
  // Functions host, default 127.0.0.1:7071/api). Server-side POST so the WebKit
  // webview isn't blocked by CORS / mixed-content, and so the localhost guard in
  // `resolveFunctionInvokeUrl` is enforced (the endpoint is reachable from the
  // same-origin preview proxy — it must not become an SSRF vector). The function
  // name is validated against the current schema; deployed/auth'd invocation is
  // out of scope. Never throws — connection errors come back as `{ ok:false }`.
  async invokeRayfinFunction(
    name: unknown,
    input: unknown,
    baseUrl: unknown,
  ): Promise<{
    ok: boolean;
    status?: number;
    body?: unknown;
    ms?: number;
    error?: string;
    url?: string;
    method?: string;
  }> {
    const d = this.detection;
    if (!d?.hasProject || !d.rayfin) return { ok: false, error: "Not a Rayfin project." };
    const fname = typeof name === "string" ? name : "";
    // Capture the project identity up front: `getRayfinState()` + the network POST
    // both await, and a concurrent project switch must not let this result land
    // against a different project's schema.
    const gen = this._projectGen;
    const cwd = this.cwd;
    const st = await this.getRayfinState();
    if (this._projectGen !== gen || this.cwd !== cwd) {
      return { ok: false, error: "Project changed during invoke." };
    }
    if (!("functions" in st)) return { ok: false, error: "No Rayfin schema." };
    // The invokable set is recomputed server-side as schema functions ∪ orphan
    // handlers — never trust the webview-posted name. Orphans (an `app.http`
    // registration with no matching schema entry) are still real endpoints.
    const invokable = new Set<string>([...st.functions.map((f) => f.name), ...st.orphanHandlers]);
    if (!invokable.has(fname)) return { ok: false, error: `Unknown function "${fname}".` };
    // Route lookup from the parsed handlers (single source of truth). A custom
    // static route overrides the default `/api/<name>` segment; dynamic/param
    // routes fall back to the name (the UI labels those "verify").
    const handler = st.handlers.find((h) => h.name === fname) ?? null;
    const route = handler && !handler.routeDynamic ? handler.route : null;
    const base =
      typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : DEFAULT_FN_BASE_URL;
    const url = resolveFunctionInvokeUrl(base, fname, route);
    if (!url) return { ok: false, error: "Base URL must be a localhost http(s) URL." };
    const method = "POST";
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await this._fetchImpl(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? {}),
        signal: ctl.signal,
        // Never follow redirects: an allowed localhost host that 30x-redirects
        // could otherwise bounce the POST to a non-local URL, defeating the
        // localhost guard in `resolveFunctionInvokeUrl`.
        redirect: "manual",
      });
      const ms = Date.now() - started;
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        return {
          ok: false,
          status: res.status || undefined,
          ms,
          url,
          method,
          error: "Function host returned a redirect — refusing to follow it.",
        };
      }
      const text = await res.text();
      let bodyOut: unknown = text;
      try {
        bodyOut = text ? JSON.parse(text) : "";
      } catch {
        // Non-JSON response: keep the raw text.
      }
      return { ok: res.ok, status: res.status, body: bodyOut, ms, url, method };
    } catch (e) {
      const ms = Date.now() - started;
      const err = e as { name?: string; message?: string };
      const error =
        err?.name === "AbortError"
          ? "Request timed out — is the functions host running?"
          : `${err?.message || err || "Request failed"} (is the functions host running?)`;
      return { ok: false, ms, url, method, error };
    } finally {
      clearTimeout(timer);
    }
  }

  // Check whether a newer Rayfin release is published (npm registry). Throttled
  // like the self-update check; `force` bypasses the cache. Non-fatal: any
  // failure keeps the last good result and surfaces `error`. Returns null when
  // no Rayfin CLI/SDK is installed (nothing to compare against). On a fresh
  // result it overlays the cached state + broadcasts so the header refreshes.
  async getRayfinUpdateInfo(force = false): Promise<RayfinUpdateInfo | null> {
    const installed = this._rayfin?.cli.installed ?? null;
    if (!installed) return null;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    if (
      !force &&
      this._rayfinUpdate &&
      this._rayfinUpdate.installedVersion === installed &&
      Date.now() - this._rayfinUpdate.checkedAt < SIX_HOURS
    ) {
      return this._rayfinUpdate;
    }
    // Reuse an in-flight check only when it was started for the *same* installed
    // version; a project switch / in-place upgrade clears `_rayfinUpdatePromiseFor`
    // (see resetProjectState) so a stale check is never reused or awaited.
    if (this._rayfinUpdatePromise && this._rayfinUpdatePromiseFor === installed) {
      return this._rayfinUpdatePromise;
    }
    const gen = this._projectGen;
    this._rayfinUpdatePromiseFor = installed;
    const p: Promise<RayfinUpdateInfo> = checkRayfinUpdate(installed, {
      fetchImpl: this._fetchImpl,
    })
      .then((info) => {
        // Discard the result if the project switched or the installed version
        // changed mid-check, so a stale check can't poison the cache or UI.
        if (this._projectGen !== gen || this._rayfin?.cli.installed !== installed) {
          return info;
        }
        // On a failed re-check keep the last good result (for this same version)
        // but refresh the error timestamp.
        if (
          info.error &&
          this._rayfinUpdate &&
          !this._rayfinUpdate.error &&
          this._rayfinUpdate.installedVersion === installed
        ) {
          this._rayfinUpdate = {
            ...this._rayfinUpdate,
            error: info.error,
            checkedAt: info.checkedAt,
          };
        } else {
          this._rayfinUpdate = info;
        }
        if (this._rayfin) {
          this.overlayRayfinUpdate(this._rayfin);
          this.broadcast({ type: "rayfin:state", rayfin: this._rayfin });
        }
        return this._rayfinUpdate;
      })
      .finally(() => {
        // Only clear the slot if we still own it (a reset + new check may have
        // replaced it while this one was in flight).
        if (this._rayfinUpdatePromise === p) {
          this._rayfinUpdatePromise = null;
          this._rayfinUpdatePromiseFor = null;
        }
      });
    this._rayfinUpdatePromise = p;
    return p;
  }

  // "Update Rayfin": hand the version-locked `@microsoft/rayfin-*` bump (verify +
  // rollback) to Copilot chat. Unlike the extension self-update (which the
  // extension applies itself), the Rayfin SDK bump runs in the user's project and
  // needs the agent's build/lint/test verification, so it stays Copilot-driven.
  async sendCopilotRayfinUpdate(): Promise<{ ok: boolean; reason?: string }> {
    const info = await this.getRayfinUpdateInfo();
    if (!info?.updateAvailable || !info.latestVersion) {
      return { ok: false, reason: "Rayfin is up to date." };
    }
    const prompt = buildRayfinUpdatePrompt({
      installedVersion: info.installedVersion,
      latestVersion: info.latestVersion,
    });
    await this.sendToChat(prompt);
    this.log(`Asked Copilot to update Rayfin to v${info.latestVersion}.`);
    return { ok: true };
  }

  // ---- Fix with Copilot ---------------------------------------------------

  async fixIssue(lane: string): Promise<{ ok: boolean; reason?: string }> {
    const ctx = this.fixContext[lane];
    if (!ctx) return { ok: false, reason: `No recorded failure for "${lane}".` };
    let prompt: string;
    if (lane === "test" && ctx.report) {
      prompt = buildTestFixPrompt({
        command: ctx.command ?? "",
        report: ctx.report,
        output: ctx.output,
      });
    } else {
      prompt = buildFixPrompt({
        lane,
        command: ctx.command,
        exitCode: ctx.exitCode,
        output: ctx.output,
      });
    }
    await this.sendToChat(prompt);
    this.log(`Sent "${lane}" failure to Copilot.`);
    return { ok: true };
  }

  async sendPromptToChat(prompt: string): Promise<void> {
    await this.sendToChat(prompt);
  }

  // Kick off a brand-new Rayfin project by handing the canonical setup prompt to
  // Copilot chat. Available even when no Rayfin (or Node) project is detected.
  async startRayfinProject({
    requireNoProject = false,
  }: {
    requireNoProject?: boolean;
  } = {}): Promise<{ ok: boolean; reason?: string }> {
    // The HTTP route (`POST /api/rayfin/start`) is reachable from proxied
    // dev-server content via the same-origin preview proxy, so an untrusted page
    // could POST it to inject a chat prompt. The UI only exposes this in the
    // no-project intro state — and with no project there is no dev server to
    // proxy — so HTTP callers are rejected when a project exists. The agent tool
    // calls this directly (requireNoProject=false) and is unaffected.
    if (requireNoProject && this.detection?.hasProject) {
      return {
        ok: false,
        reason: "A project already exists here — create a new Rayfin app in an empty folder.",
      };
    }
    let prompt: string;
    try {
      prompt = await readFile(new URL("./prompts/rayfin-start.md", import.meta.url), "utf8");
    } catch {
      return { ok: false, reason: "New-project prompt is unavailable." };
    }
    await this.sendToChat(prompt);
    this.log("Asked Copilot to scaffold a new Rayfin project.");
    return { ok: true };
  }

  // Send a captured screenshot of the running app to the chat, with an optional
  // user prompt. Falls back to a sensible default prompt when none is given.
  async sendScreenshotToChat(
    prompt: string | undefined,
    dataBase64: string,
    mimeType = "image/png",
  ): Promise<{ ok: boolean; reason?: string }> {
    const text = prompt?.trim()
      ? prompt.trim()
      : "Here's a screenshot of my running app. Help me find and fix the UI issue shown.";
    try {
      await this.sendImageToChat(text, dataBase64, mimeType);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`Couldn't send screenshot: ${reason}`, "error");
      return { ok: false, reason };
    }
    this.log("Sent a screenshot to Copilot.");
    return { ok: true };
  }

  // Push a single diagnostic (or all current ones) to the chat as a Fix prompt.
  async fixDiagnostic(diagnostic: Diagnostic | null): Promise<{ ok: boolean; reason?: string }> {
    if (!diagnostic?.file) return { ok: false, reason: "No diagnostic to fix." };
    const prompt = buildDiagnosticFixPrompt({ cwd: this.cwd, diagnostics: [diagnostic] });
    await this.sendToChat(prompt);
    const what =
      diagnostic.source === "lint"
        ? diagnostic.rule || "lint problem"
        : diagnostic.code
          ? `TS${diagnostic.code}`
          : "diagnostic";
    this.log(`Sent ${what} to Copilot.`);
    return { ok: true };
  }

  async fixAllDiagnostics(): Promise<{ ok: boolean; reason?: string }> {
    const diagnostics = [...this.tsLs.diagnostics, ...this.lint.diagnostics];
    if (!diagnostics.length) return { ok: false, reason: "No diagnostics to fix." };
    const prompt = buildDiagnosticFixPrompt({ cwd: this.cwd, diagnostics });
    await this.sendToChat(prompt);
    this.log(`Sent ${diagnostics.length} problem(s) to Copilot.`);
    return { ok: true };
  }
}

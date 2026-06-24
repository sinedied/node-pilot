// Central controller: the single source of truth for project state, lanes, the
// dev server and dependency operations. Emits events that the SSE layer relays
// to the UI; both the HTTP API and the agent actions call its methods.
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import { watch as fsWatch, statSync, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { detect } from "./detect.ts";
import { run, start } from "./process-runner.ts";
import { runScript as pmRunScript } from "./pm.ts";
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
import * as deps from "./deps.ts";
import type { SafeUpdateOptions, SafeUpdateResult } from "./deps.ts";
import type { TestOptions } from "./lanes.ts";
import type {
  AppEvent,
  Detection,
  DepsState,
  DevState,
  Diagnostic,
  FixContextEntry,
  LaneState,
  LintState,
  ProcessHandle,
  ProjectStats,
  ResolvedSettings,
  SettingsPatch,
  TestReport,
  TsLsState,
} from "./types.ts";

const ONE_SHOT_LANES = ["build", "lint", "format", "typecheck", "test"];

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

export interface ControllerOptions {
  sendToChat?: (prompt: string) => Promise<void> | void;
  sendImageToChat?: (prompt: string, dataBase64: string, mimeType: string) => Promise<void> | void;
  // Run the user's configured on-load tasks after the first detection. Defaults
  // to true; tests/hosts can disable it for deterministic, race-free runs.
  autoRun?: boolean;
}

interface LaneRunResult {
  ok: boolean;
  reason?: string;
  exitCode?: number;
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
  sendToChat: (prompt: string) => Promise<void> | void;
  sendImageToChat: (prompt: string, dataBase64: string, mimeType: string) => Promise<void> | void;
  autoRun: boolean;
  events: EventEmitter;
  detection: Detection | null;
  lanes: Record<string, LaneState>;
  test: { report: TestReport | null; watch: boolean };
  dev: DevState;
  deps: DepsState;
  debug: DebugSession;
  fixContext: Record<string, FixContextEntry>;
  projectStats: ProjectStats | null;
  _statsPromise: Promise<ProjectStats> | null;
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

  constructor(cwd: string, { sendToChat, sendImageToChat, autoRun }: ControllerOptions = {}) {
    this.cwd = cwd;
    this.sendToChat = sendToChat || (async () => {});
    this.sendImageToChat = sendImageToChat || (async () => {});
    this.autoRun = autoRun !== false;
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.detection = null;
    this.lanes = {};
    for (const id of ONE_SHOT_LANES) this.lanes[id] = this.freshLane(id);
    // Dependency updates stream through the standard lane/Console mechanism.
    this.lanes.update = this.freshLane("update");
    this.test = { report: null, watch: false };
    this.dev = { status: "stopped", url: null, port: null, output: [], pid: null, _handle: null };
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

  async init(): Promise<Detection> {
    this.detection = await detect(this.cwd);
    this.invalidateStats();
    if (this.detection.hasProject) this.detection.availability = laneAvailability(this.detection);
    this.broadcast({ type: "detection", detection: this.detection });
    // Fire the configured on-load tasks once per project path, after the first
    // successful project detection (a shared process can serve several projects).
    if (this.autoRun && !this._autoRanFor.has(this.cwd) && this.detection.hasProject) {
      this._autoRanFor.add(this.cwd);
      this.runAutoTasks().catch((e) => this.log(String(e), "error"));
    }
    return this.detection;
  }

  // Anchor the controller to the session's real working directory. The extension
  // process cwd is not the project root, so the host supplies the project path on
  // every canvas open / action via `ctx.session.workingDirectory`.
  async ensureProjectDir(dir?: string): Promise<Detection | null> {
    if (dir && dir !== this.cwd) {
      this.stopTsServer();
      this.cwd = dir;
      await this.init();
    } else if (!this.detection) {
      await this.init();
    }
    return this.detection;
  }

  async refresh(): Promise<Detection> {
    this.detection = await detect(this.cwd);
    this.invalidateStats();
    if (this.detection.hasProject) this.detection.availability = laneAvailability(this.detection);
    this.broadcast({ type: "detection", detection: this.detection });
    return this.detection;
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
    };
  }

  getState() {
    return {
      cwd: this.cwd,
      detection: this.detection,
      lanes: Object.fromEntries(
        Object.entries(this.lanes).map(([id, l]) => [id, { ...l, output: l.output.join("") }]),
      ),
      test: this.test,
      dev: { ...this.dev, output: this.dev.output.join(""), _handle: undefined },
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
  private async runAutoTasks(): Promise<void> {
    const d = this.detection;
    if (!d?.hasProject) return;
    const s = await loadSettings(this.cwd);
    const a = d.availability;
    this._autoRunning = true;
    try {
      // Prime the Problems tab (live lint + TS diagnostics) so its pill populates
      // on load — this fills this.lint/this.tsLs (carried in the boot snapshot)
      // and broadcasts lint:/ts: diagnostics to connected clients.
      if (s.autoProblems) {
        if (a?.lint !== false) await this.getLintDiagnostics().catch(() => {});
        if (a?.diagnostics !== false) await this.getDiagnostics().catch(() => {});
      }
      if (s.autoTest && a?.test !== false) await this.runTests().catch(() => {});
      if (s.autoDeps) {
        await this.listOutdated().catch(() => {});
        await this.runAudit().catch(() => {});
      }
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
    try {
      const diagnostics = await client.getProjectDiagnostics();
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

  // "Fix with Copilot" for the Security section: remediate known vulnerabilities.
  async sendCopilotAuditFix(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.deps.audit) await this.runAudit().catch(() => {});
    const vulnerabilities = this.deps.audit?.vulnerabilities || [];
    if (!vulnerabilities.length) return { ok: false, reason: "No known vulnerabilities." };
    const prompt = buildDepsAuditFixPrompt({ vulnerabilities });
    await this.sendToChat(prompt);
    this.log(`Asked Copilot to fix ${vulnerabilities.length} vulnerability group(s).`);
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

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
  laneAvailability,
  defaultPinnedTasks,
} from "./lanes.ts";
import { parseJestLike, parseTap, parseTextCounts } from "./test-report.ts";
import { pushCapped, extractUrl, isPortInUse } from "./util.ts";
import { buildFixPrompt, buildTestFixPrompt, buildDiagnosticFixPrompt } from "./fix.ts";
import { TsServerClient, resolveTsserverPath } from "./ts-server.ts";
import { loadSettings, saveSettings } from "./settings.ts";
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
}

interface LaneRunResult {
  ok: boolean;
  reason?: string;
  exitCode?: number;
}

export class Controller {
  cwd: string;
  sendToChat: (prompt: string) => Promise<void> | void;
  sendImageToChat: (prompt: string, dataBase64: string, mimeType: string) => Promise<void> | void;
  events: EventEmitter;
  detection: Detection | null;
  lanes: Record<string, LaneState>;
  test: { report: TestReport | null };
  dev: DevState;
  deps: DepsState;
  fixContext: Record<string, FixContextEntry>;
  projectStats: ProjectStats | null;
  _statsPromise: Promise<ProjectStats> | null;
  tsLs: TsLsState;
  _tsClient: TsServerClient | null;
  _tsWatchers: FSWatcher[];
  _tsRefreshTimer: NodeJS.Timeout | null;
  _tsRestartTimer: NodeJS.Timeout | null;
  _tsIdleTimer: NodeJS.Timeout | null;

  constructor(cwd: string, { sendToChat, sendImageToChat }: ControllerOptions = {}) {
    this.cwd = cwd;
    this.sendToChat = sendToChat || (async () => {});
    this.sendImageToChat = sendImageToChat || (async () => {});
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.detection = null;
    this.lanes = {};
    for (const id of ONE_SHOT_LANES) this.lanes[id] = this.freshLane(id);
    this.test = { report: null };
    this.dev = { status: "stopped", url: null, port: null, output: [], pid: null, _handle: null };
    this.deps = { outdated: null, audit: null, update: null };
    this.fixContext = {}; // lane -> last failure { command, output, exitCode, report }
    this.projectStats = null;
    this._statsPromise = null;
    this.tsLs = this.freshTsLs();
    this._tsClient = null;
    this._tsWatchers = [];
    this._tsRefreshTimer = null;
    this._tsRestartTimer = null;
    this._tsIdleTimer = null;
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
    return { theme: s.theme || "auto", pinnedTasks };
  }

  async setSettings(patch: SettingsPatch = {}): Promise<ResolvedSettings> {
    const clean: SettingsPatch = {};
    if (typeof patch.theme === "string") clean.theme = patch.theme;
    if (Array.isArray(patch.pinnedTasks)) clean.pinnedTasks = patch.pinnedTasks;
    const s = await saveSettings(this.cwd, clean);
    const pinnedTasks = s.pinnedTasks ?? defaultPinnedTasks(this.detection);
    return { theme: s.theme || "auto", pinnedTasks };
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
      tsLs: this.tsLs,
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
    this.broadcast({ type: "lane:start", lane: id, label: cmd.label });

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
    this.broadcast({ type: "lane:start", lane: "test", label: resolved.label });

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
    if (filename == null) {
      this.scheduleTsRefresh();
      return;
    }
    const name = filename.toString();
    if (name.includes("node_modules") || name.includes(`.git${path.sep}`)) return;
    const base = path.basename(name);
    if (/^tsconfig.*\.json$/i.test(base)) {
      this.scheduleTsRestart();
      return;
    }
    if (!TS_WATCH_EXT.has(path.extname(base))) return;
    this.scheduleTsRefresh();
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
    for (const t of [this._tsRefreshTimer, this._tsRestartTimer, this._tsIdleTimer]) {
      if (t) clearTimeout(t);
    }
    this._tsRefreshTimer = null;
    this._tsRestartTimer = null;
    this._tsIdleTimer = null;
    this.teardownTsWatchers();
    if (this._tsClient) {
      this._tsClient.stop();
      this._tsClient = null;
    }
    this.tsLs = this.freshTsLs();
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
    this.log(`Sent ${diagnostic.code ? `TS${diagnostic.code}` : "diagnostic"} to Copilot.`);
    return { ok: true };
  }

  async fixAllDiagnostics(): Promise<{ ok: boolean; reason?: string }> {
    const diagnostics = this.tsLs.diagnostics;
    if (!diagnostics.length) return { ok: false, reason: "No diagnostics to fix." };
    const prompt = buildDiagnosticFixPrompt({ cwd: this.cwd, diagnostics });
    await this.sendToChat(prompt);
    this.log(`Sent ${diagnostics.length} diagnostic(s) to Copilot.`);
    return { ok: true };
  }
}

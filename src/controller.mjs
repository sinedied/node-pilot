// Central controller: the single source of truth for project state, lanes, the
// dev server and dependency operations. Emits events that the SSE layer relays
// to the UI; both the HTTP API and the agent actions call its methods.
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { detect } from "./detect.mjs";
import { run, start } from "./process-runner.mjs";
import { runScript as pmRunScript } from "./pm.mjs";
import { resolveLane, resolveDev, resolveTest } from "./lanes.mjs";
import { parseJestLike, parseTap, parseTextCounts } from "./test-report.mjs";
import { pushCapped, extractUrl, isPortInUse } from "./util.mjs";
import { buildFixPrompt, buildTestFixPrompt } from "./fix.mjs";
import * as deps from "./deps.mjs";

const ONE_SHOT_LANES = ["build", "lint", "format", "typecheck", "test"];

export class Controller {
  constructor(cwd, { sendToChat } = {}) {
    this.cwd = cwd;
    this.sendToChat = sendToChat || (async () => {});
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.detection = null;
    this.lanes = {};
    for (const id of ONE_SHOT_LANES) this.lanes[id] = this.freshLane(id);
    this.test = { report: null };
    this.dev = { status: "stopped", url: null, port: null, output: [], pid: null, _handle: null };
    this.deps = { outdated: null, audit: null, update: null };
    this.fixContext = {}; // lane -> last failure { command, output, exitCode, report }
  }

  freshLane(id) {
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

  broadcast(evt) {
    this.events.emit("event", evt);
  }

  log(message, level = "info") {
    this.broadcast({ type: "log", level, message });
  }

  async init() {
    this.detection = await detect(this.cwd);
    this.broadcast({ type: "detection", detection: this.detection });
    return this.detection;
  }

  // Anchor the controller to the session's real working directory. The extension
  // process cwd is not the project root, so the host supplies the project path on
  // every canvas open / action via `ctx.session.workingDirectory`.
  async ensureProjectDir(dir) {
    if (dir && dir !== this.cwd) {
      this.cwd = dir;
      await this.init();
    } else if (!this.detection) {
      await this.init();
    }
    return this.detection;
  }

  async refresh() {
    this.detection = await detect(this.cwd);
    this.broadcast({ type: "detection", detection: this.detection });
    return this.detection;
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
    };
  }

  // ---- One-shot lanes (build / lint / format / typecheck) -----------------

  async runLane(id, opts = {}) {
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

  async runTests(opts = {}) {
    const d = this.detection;
    if (!d?.hasProject) return { ok: false, reason: "No Node.js project detected." };
    const lane = this.lanes.test;
    if (lane.status === "running") return { ok: false, reason: "Tests are already running." };

    let tmpDir = null;
    let outputFile;
    const spec = resolveTest(d, opts);
    if (spec.unavailable) {
      this.log(`test: ${spec.reason}`, "warning");
      return { ok: false, reason: spec.reason };
    }
    if (spec.outputFile === undefined && spec.parser === "jest") {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "node-pilot-"));
      outputFile = path.join(tmpDir, "results.json");
    }
    const resolved = outputFile ? resolveTest(d, { ...opts, outputFile }) : spec;

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

    let report = null;
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
      this.log(`Could not parse test results: ${err.message}`, "warning");
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

  async runScriptByName(name) {
    const d = this.detection;
    if (!d?.hasProject) return { ok: false, reason: "No Node.js project detected." };
    if (!d.scripts[name]) return { ok: false, reason: `No "${name}" script in package.json.` };
    const id = `script:${name}`;
    const lane = (this.lanes[id] = this.lanes[id] || this.freshLane(id));
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

  async startDev() {
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
    this.dev.pid = handle.child.pid;
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

  async stopDev() {
    if (this.dev.status !== "running" || !this.dev._handle)
      return { ok: false, reason: "Dev server is not running." };
    await this.dev._handle.stop();
    this.dev.status = "stopped";
    this.dev.pid = null;
    this.dev._handle = null;
    this.broadcast({ type: "dev:exit", exitCode: null });
    return { ok: true };
  }

  // ---- Dependencies (delegated to deps.mjs) -------------------------------

  listOutdated() {
    return deps.listOutdated(this);
  }
  runAudit() {
    return deps.runAudit(this);
  }
  safeUpdate(opts) {
    return deps.safeUpdate(this, opts);
  }
  rollbackLastUpdate() {
    return deps.rollbackLast(this);
  }

  // ---- Fix with Copilot ---------------------------------------------------

  async fixIssue(lane) {
    const ctx = this.fixContext[lane];
    if (!ctx) return { ok: false, reason: `No recorded failure for "${lane}".` };
    let prompt;
    if (lane === "test" && ctx.report) {
      prompt = buildTestFixPrompt({ command: ctx.command, report: ctx.report, output: ctx.output });
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

  async sendPromptToChat(prompt) {
    await this.sendToChat(prompt);
  }
}

// CDP-backed debug session manager. Owns at most one live target at a time
// (a Node process launched under `--inspect-brk`, or an attached running
// inspector) and exposes a small, structured, agent-friendly API: breakpoints,
// stepping, call stack, variable inspection, expression evaluation and a
// "wait for the next pause" primitive. All UI updates flow through `host`
// (the Controller) as SSE events; the agent actions call these methods directly.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { start } from "./process-runner.ts";
import { pushCapped } from "./util.ts";
import { CdpClient, type CdpParams } from "./cdp.ts";
import type {
  AppEvent,
  DebugBreakpoint,
  DebugFrame,
  DebugPaused,
  DebugScope,
  DebugState,
  DebugStatus,
  DebugTarget,
  ProcessHandle,
} from "./types.ts";

export interface DebugHost {
  broadcast(evt: AppEvent): void;
  log(message: string, level?: string): void;
}

export type PauseOnExceptions = "none" | "uncaught" | "all";

export interface DebugStartOptions {
  program?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stopOnEntry?: boolean;
  pauseOnExceptions?: PauseOnExceptions;
}

export interface DebugAttachOptions {
  host?: string;
  port?: number;
  url?: string;
  pauseOnExceptions?: PauseOnExceptions;
}

export interface DebugActionResult {
  ok: boolean;
  reason?: string | null;
  [key: string]: unknown;
}

// ---- Narrow CDP payload shapes we actually read ---------------------------

interface CdpLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber?: number;
}
interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}
interface CdpScope {
  type: string;
  name?: string;
  object: RemoteObject;
}
interface CdpCallFrame {
  callFrameId: string;
  functionName: string;
  location: CdpLocation;
  url: string;
  scopeChain: CdpScope[];
  this?: RemoteObject;
}
interface PausedEvent {
  reason: string;
  data?: Record<string, unknown>;
  callFrames: CdpCallFrame[];
  hitBreakpoints?: string[];
}
interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
  get?: RemoteObject;
}
interface ExceptionDetails {
  text?: string;
  exception?: RemoteObject;
  lineNumber?: number;
  columnNumber?: number;
  url?: string;
}

const WS_URL_RE = /Debugger listening on (ws:\/\/[^\s]+)/i;
const DEFAULT_WAIT_MS = 30000;
const MAX_WAIT_MS = 120000;
const MAX_VARS_PER_SCOPE = 200;

export class DebugSession {
  private hostApi: DebugHost;
  private client: CdpClient | null;
  private handle: ProcessHandle | null;
  private status: DebugStatus;
  private target: DebugTarget | null;
  private paused: DebugPaused | null;
  private breakpoints: DebugBreakpoint[];
  private reason: string | null;
  private outputBuf: string[];
  private consoleBuf: string[];
  private entryResumePending: boolean;
  private pauseWaiters: Array<(value: DebugPaused | null) => void>;
  // Node sends an empty CallFrame.url, so resolve files from scriptId instead.
  private scripts: Map<string, string>;
  // Monotonic session token: bumped on every start/attach/stop so a slow,
  // superseded start() can detect it lost the session and bow out cleanly.
  private gen: number;

  constructor(host: DebugHost) {
    this.hostApi = host;
    this.client = null;
    this.handle = null;
    this.status = "stopped";
    this.target = null;
    this.paused = null;
    this.breakpoints = [];
    this.reason = null;
    this.outputBuf = [];
    this.consoleBuf = [];
    this.entryResumePending = false;
    this.pauseWaiters = [];
    this.scripts = new Map();
    this.gen = 0;
  }

  // ---- Serialization ------------------------------------------------------

  serialize(): DebugState {
    return {
      status: this.status,
      target: this.target,
      paused: this.paused,
      breakpoints: this.breakpoints.map((b) => ({ ...b })),
      reason: this.reason,
      output: this.outputBuf.join(""),
      console: this.consoleBuf.join(""),
    };
  }

  private emitState(): void {
    this.hostApi.broadcast({
      type: "debug:state",
      status: this.status,
      target: this.target,
      paused: this.paused,
      breakpoints: this.breakpoints.map((b) => ({ ...b })),
      reason: this.reason,
    });
  }

  private setStatus(status: DebugStatus, reason: string | null = this.reason): void {
    this.status = status;
    this.reason = reason;
    this.emitState();
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(opts: DebugStartOptions): Promise<DebugActionResult> {
    const program = (opts.program || "").trim();
    if (!program) return { ok: false, reason: "A program/script path is required." };
    if (this.status !== "stopped") await this.stop();
    const gen = ++this.gen;

    const stopOnEntry = opts.stopOnEntry !== false; // default true for deterministic control
    const absProgram = path.isAbsolute(program) ? program : path.join(opts.cwd, program);
    const argv = ["node", "--inspect-brk=127.0.0.1:0", absProgram, ...(opts.args || [])];

    this.target = {
      mode: "launch",
      program: absProgram,
      args: opts.args || [],
      host: "127.0.0.1",
      port: null,
      url: null,
      pid: null,
    };
    this.outputBuf = [];
    this.consoleBuf = [];
    this.paused = null;
    this.setStatus("starting", null);

    let resolveWs: (url: string) => void;
    let rejectWs: (err: Error) => void;
    const wsUrlPromise = new Promise<string>((resolve, reject) => {
      resolveWs = resolve;
      rejectWs = reject;
    });
    let wsResolved = false;

    const handle = start(argv, {
      cwd: opts.cwd,
      env: opts.env,
      onData: (chunk) => {
        pushCapped(this.outputBuf, chunk);
        this.hostApi.broadcast({ type: "debug:data", chunk });
        if (!wsResolved) {
          const m = WS_URL_RE.exec(chunk);
          if (m) {
            wsResolved = true;
            resolveWs(m[1]);
          }
        }
      },
    });
    this.handle = handle;
    if (this.target) this.target.pid = handle.child.pid ?? null;
    handle.child.on("close", (code) => {
      if (gen === this.gen) this.onProcessExit(code);
    });
    handle.child.on("error", (err) => {
      if (!wsResolved) {
        wsResolved = true;
        rejectWs(err instanceof Error ? err : new Error(String(err)));
      }
    });

    const timeout = setTimeout(() => {
      if (!wsResolved) {
        wsResolved = true;
        rejectWs(new Error("Timed out waiting for the inspector to start."));
      }
    }, 15000);

    let wsUrl: string;
    try {
      wsUrl = await wsUrlPromise;
    } catch (err) {
      clearTimeout(timeout);
      if (gen === this.gen) await this.stop();
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    clearTimeout(timeout);
    // A newer start()/stop() superseded this launch while we waited; bow out
    // without disturbing the session that now owns the state.
    if (gen !== this.gen) {
      try {
        await handle.stop();
      } catch {}
      return { ok: false, reason: "Debug session was superseded." };
    }

    try {
      this.entryResumePending = !stopOnEntry;
      await this.connectAndPrepare(wsUrl, opts.pauseOnExceptions ?? "none");
    } catch (err) {
      if (gen === this.gen) await this.stop();
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (gen !== this.gen) return { ok: false, reason: "Debug session was superseded." };

    // connectAndPrepare already ran the target; with stopOnEntry the entry pause
    // may have already landed, so don't clobber a "paused" status back to running.
    if (this.status !== "paused") this.setStatus("running", null);
    return {
      ok: true,
      mode: "launch",
      program: absProgram,
      pid: this.target?.pid ?? null,
      stopOnEntry,
    };
  }

  async attach(opts: DebugAttachOptions): Promise<DebugActionResult> {
    if (this.status !== "stopped") await this.stop();
    const gen = ++this.gen;
    const host = opts.host || "127.0.0.1";
    const port = opts.port || 9229;
    let wsUrl = opts.url || "";
    if (!wsUrl) {
      try {
        const targets = await CdpClient.fetchTargets(host, port);
        const node = targets.find((t) => t.webSocketDebuggerUrl && t.type !== "page") || targets[0];
        if (!node?.webSocketDebuggerUrl) {
          return { ok: false, reason: `No inspector target found at ${host}:${port}.` };
        }
        wsUrl = node.webSocketDebuggerUrl;
      } catch (err) {
        return {
          ok: false,
          reason: `Could not reach inspector at ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    this.target = { mode: "attach", program: null, args: [], host, port, url: wsUrl, pid: null };
    this.outputBuf = [];
    this.consoleBuf = [];
    this.paused = null;
    this.entryResumePending = false;
    this.setStatus("starting", null);

    try {
      await this.connectAndPrepare(wsUrl, opts.pauseOnExceptions ?? "none");
    } catch (err) {
      if (gen === this.gen) await this.stop();
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (gen !== this.gen) return { ok: false, reason: "Debug session was superseded." };
    // connectAndPrepare runs the target if it was waiting on --inspect-brk.
    if (this.status !== "paused") this.setStatus("running", null);
    return { ok: true, mode: "attach", url: wsUrl };
  }

  private async connectAndPrepare(wsUrl: string, pauseOn: PauseOnExceptions): Promise<void> {
    const client = await CdpClient.connect(wsUrl);
    this.client = client;
    this.scripts = new Map();
    client.on("Debugger.scriptParsed", (p) => this.onScriptParsed(p));
    client.on("Debugger.breakpointResolved", (p) => this.onBreakpointResolved(p));
    client.on("Debugger.paused", (p) => this.onPaused(p));
    client.on("Debugger.resumed", () => this.onResumed());
    client.on("Runtime.consoleAPICalled", (p) => this.onConsoleApi(p));
    client.on("Runtime.exceptionThrown", (p) => this.onExceptionThrown(p));
    client.on("disconnected", () => this.onDisconnected());

    await client.send("Runtime.enable");
    await client.send("Debugger.enable");
    if (pauseOn !== "none") {
      await client.send("Debugger.setPauseOnExceptions", { state: pauseOn });
    }
    await this.applyBreakpoints();
    await client.send("Runtime.runIfWaitingForDebugger");
  }

  async stop(): Promise<DebugActionResult> {
    this.gen++;
    const wasActive = this.status !== "stopped" || this.client || this.handle;
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    if (this.handle) {
      try {
        await this.handle.stop();
      } catch {}
      this.handle = null;
    }
    // Drop the live CDP ids; keep the user's breakpoint list for the next run.
    for (const b of this.breakpoints) {
      b.cdpId = undefined;
      b.verified = false;
    }
    this.paused = null;
    this.target = null;
    this.entryResumePending = false;
    this.resolveWaiters(null);
    this.status = "stopped";
    this.reason = null;
    this.emitState();
    this.hostApi.broadcast({ type: "debug:exit" });
    return { ok: true, wasActive: !!wasActive };
  }

  private onProcessExit(code: number | null): void {
    if (this.status === "stopped") return;
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.handle = null;
    for (const b of this.breakpoints) {
      b.cdpId = undefined;
      b.verified = false;
    }
    this.paused = null;
    this.target = null;
    this.entryResumePending = false;
    this.resolveWaiters(null);
    this.status = "stopped";
    this.reason = code && code !== 0 ? `Process exited with code ${code}` : null;
    this.emitState();
    this.hostApi.broadcast({ type: "debug:exit", exitCode: code });
  }

  private onDisconnected(): void {
    // Inspector socket dropped (e.g. attached target went away).
    if (this.status === "stopped" || this.handle) return;
    this.client = null;
    for (const b of this.breakpoints) {
      b.cdpId = undefined;
      b.verified = false;
    }
    this.paused = null;
    this.target = null;
    this.resolveWaiters(null);
    this.status = "stopped";
    this.reason = "Debugger disconnected.";
    this.emitState();
    this.hostApi.broadcast({ type: "debug:exit" });
  }

  // ---- Pause / resume handling -------------------------------------------

  private async onPaused(raw: CdpParams): Promise<void> {
    const evt = raw as unknown as PausedEvent;
    // The very first pause from `--inspect-brk` is the entry break; when the
    // caller didn't ask to stop on entry, transparently resume past it — unless
    // a user breakpoint resolved to the entry location, in which case honor it.
    if (this.entryResumePending) {
      this.entryResumePending = false;
      if (!evt.hitBreakpoints?.length) {
        try {
          await this.client?.send("Debugger.resume");
        } catch {}
        return;
      }
    }
    const frames: DebugFrame[] = (evt.callFrames || []).map((f) => this.toFrame(f));
    let text: string | null = null;
    if (evt.reason === "exception" || evt.reason === "promiseRejection") {
      const ex = evt.data as { description?: string; value?: unknown } | undefined;
      text = (ex?.description as string) || (ex?.value ? String(ex.value) : null);
    }
    this.paused = {
      reason: evt.reason || "paused",
      text,
      frames,
      topFrameId: frames[0]?.id ?? null,
    };
    this.setStatus("paused", this.reason);
    this.hostApi.broadcast({ type: "debug:paused", paused: this.paused });
    this.resolveWaiters(this.paused);
  }

  private onResumed(): void {
    this.paused = null;
    if (this.status !== "stopped") this.setStatus("running", this.reason);
    this.hostApi.broadcast({ type: "debug:resumed" });
  }

  private onScriptParsed(raw: CdpParams): void {
    const evt = raw as unknown as { scriptId?: string; url?: string };
    if (evt.scriptId && evt.url) this.scripts.set(evt.scriptId, evt.url);
  }

  private onBreakpointResolved(raw: CdpParams): void {
    const evt = raw as unknown as { breakpointId?: string };
    if (!evt.breakpointId) return;
    const bp = this.breakpoints.find((b) => b.cdpId === evt.breakpointId);
    if (bp && !bp.verified) {
      bp.verified = true;
      this.emitState();
    }
  }

  private toFrame(f: CdpCallFrame): DebugFrame {
    // Node leaves CallFrame.url empty; fall back to the scriptParsed map.
    const url = f.url || this.scripts.get(f.location?.scriptId) || "";
    let file: string | null = null;
    if (url.startsWith("file://")) {
      try {
        file = fileURLToPath(url);
      } catch {
        file = null;
      }
    }
    const scopes: DebugScope[] = (f.scopeChain || []).map((s) => ({
      type: s.type,
      name: s.name,
      objectId: s.object?.objectId,
    }));
    return {
      id: f.callFrameId,
      functionName: f.functionName || "(anonymous)",
      file,
      url: url || null,
      line: (f.location?.lineNumber ?? 0) + 1,
      column: (f.location?.columnNumber ?? 0) + 1,
      scopes,
    };
  }

  private resolveWaiters(value: DebugPaused | null): void {
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const w of waiters) w(value);
  }

  // ---- Console / exceptions ----------------------------------------------

  private onConsoleApi(raw: CdpParams): void {
    const evt = raw as unknown as { type: string; args: RemoteObject[] };
    const text = (evt.args || []).map((a) => this.previewValue(a)).join(" ");
    const line = `[${evt.type || "log"}] ${text}\n`;
    pushCapped(this.consoleBuf, line);
    this.hostApi.broadcast({ type: "debug:console", level: evt.type || "log", text: line });
  }

  private onExceptionThrown(raw: CdpParams): void {
    const evt = raw as unknown as { exceptionDetails: ExceptionDetails };
    const d = evt.exceptionDetails || {};
    const text = d.exception ? this.previewValue(d.exception) : d.text || "Uncaught exception";
    const line = `[exception] ${text}\n`;
    pushCapped(this.consoleBuf, line);
    this.hostApi.broadcast({ type: "debug:console", level: "error", text: line });
  }

  // ---- Breakpoints --------------------------------------------------------

  async setBreakpoint(input: {
    file: string;
    line: number;
    column?: number;
    condition?: string;
    cwd?: string;
  }): Promise<DebugActionResult> {
    if (!input.file || !Number.isFinite(input.line) || input.line < 1) {
      return { ok: false, reason: "A file path and a 1-based line are required." };
    }
    const file = path.isAbsolute(input.file)
      ? input.file
      : path.join(input.cwd || process.cwd(), input.file);
    const line = Math.floor(input.line);
    const column = input.column && input.column > 0 ? Math.floor(input.column) : undefined;
    const id = `${file}:${line}:${column ?? 0}`;
    const bp: DebugBreakpoint = {
      id,
      file,
      line,
      column,
      condition: input.condition || undefined,
      verified: false,
    };
    // Replace any existing breakpoint with the same id.
    const existing = this.breakpoints.find((b) => b.id === id);
    if (existing?.cdpId && this.client) {
      try {
        await this.client.send("Debugger.removeBreakpoint", { breakpointId: existing.cdpId });
      } catch {}
    }
    this.breakpoints = this.breakpoints.filter((b) => b.id !== id);
    this.breakpoints.push(bp);

    if (this.client) await this.applyOne(bp);
    this.emitState();
    return { ok: true, breakpoint: { ...bp } };
  }

  private async applyOne(bp: DebugBreakpoint): Promise<void> {
    if (!this.client) return;
    try {
      const res = (await this.client.send("Debugger.setBreakpointByUrl", {
        url: pathToFileURL(bp.file).href,
        lineNumber: bp.line - 1,
        columnNumber: bp.column ? bp.column - 1 : 0,
        condition: bp.condition || undefined,
      })) as { breakpointId?: string; locations?: CdpLocation[] };
      bp.cdpId = res.breakpointId;
      bp.verified = Array.isArray(res.locations) && res.locations.length > 0;
    } catch (err) {
      bp.verified = false;
      this.hostApi.log(
        `Failed to set breakpoint at ${bp.file}:${bp.line}: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
    }
  }

  private async applyBreakpoints(): Promise<void> {
    for (const bp of this.breakpoints) await this.applyOne(bp);
  }

  async removeBreakpoint(input: {
    id?: string;
    file?: string;
    line?: number;
    cwd?: string;
  }): Promise<DebugActionResult> {
    let target: DebugBreakpoint | undefined;
    if (input.id) {
      target = this.breakpoints.find((b) => b.id === input.id);
    } else if (input.file && input.line) {
      const line = Math.floor(input.line);
      const file = path.isAbsolute(input.file)
        ? input.file
        : path.join(input.cwd || process.cwd(), input.file);
      target = this.breakpoints.find((b) => b.file === file && b.line === line);
    }
    if (!target) return { ok: false, reason: "Breakpoint not found." };
    if (target.cdpId && this.client) {
      try {
        await this.client.send("Debugger.removeBreakpoint", { breakpointId: target.cdpId });
      } catch {}
    }
    this.breakpoints = this.breakpoints.filter((b) => b.id !== target.id);
    this.emitState();
    return { ok: true, removed: target.id };
  }

  listBreakpoints(): DebugActionResult {
    return { ok: true, breakpoints: this.breakpoints.map((b) => ({ ...b })) };
  }

  // ---- Execution control --------------------------------------------------

  private async exec(
    method: string,
    requirePaused: boolean,
    resumes: boolean,
  ): Promise<DebugActionResult> {
    if (!this.client) return { ok: false, reason: "No debug session is active." };
    if (requirePaused && this.status !== "paused") {
      return { ok: false, reason: "The target is not paused." };
    }
    try {
      await this.client.send(method);
      // Resuming commands clear the paused snapshot synchronously so a follow-up
      // evaluate/get_stack doesn't reuse now-invalid call-frame ids while we wait
      // for the async Debugger.resumed event.
      if (resumes && this.status !== "stopped") {
        this.paused = null;
        this.setStatus("running", this.reason);
      }
      return { ok: true, status: this.status };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  resume(): Promise<DebugActionResult> {
    return this.exec("Debugger.resume", true, true);
  }
  pause(): Promise<DebugActionResult> {
    return this.exec("Debugger.pause", false, false);
  }
  stepOver(): Promise<DebugActionResult> {
    return this.exec("Debugger.stepOver", true, true);
  }
  stepInto(): Promise<DebugActionResult> {
    return this.exec("Debugger.stepInto", true, true);
  }
  stepOut(): Promise<DebugActionResult> {
    return this.exec("Debugger.stepOut", true, true);
  }

  // Block until the next pause (or resolve immediately if already paused).
  async waitForPause(timeoutMs?: number): Promise<DebugActionResult> {
    if (this.status === "stopped" || !this.client) {
      return { ok: false, reason: "No debug session is active." };
    }
    if (this.paused) return { ok: true, paused: this.paused };
    const ms = Math.min(Math.max(Number(timeoutMs) || DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (value: DebugPaused | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value) resolve({ ok: true, paused: value });
        else resolve({ ok: false, reason: "Session ended before pausing.", ended: true });
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pauseWaiters = this.pauseWaiters.filter((w) => w !== waiter);
        resolve({ ok: false, timedOut: true, reason: `No pause within ${ms}ms.` });
      }, ms);
      this.pauseWaiters.push(waiter);
    });
  }

  // ---- Inspection ---------------------------------------------------------

  getStack(): DebugActionResult {
    if (this.status !== "paused" || !this.paused) {
      return { ok: false, reason: "The target is not paused." };
    }
    return { ok: true, frames: this.paused.frames, topFrameId: this.paused.topFrameId };
  }

  async getVariables(input: {
    frameId?: string;
    includeGlobal?: boolean;
  }): Promise<DebugActionResult> {
    if (!this.client) return { ok: false, reason: "No debug session is active." };
    if (this.status !== "paused" || !this.paused) {
      return { ok: false, reason: "The target is not paused." };
    }
    const frame = this.paused.frames.find((f) => f.id === input.frameId) || this.paused.frames[0];
    if (!frame) return { ok: false, reason: "No call frame available." };
    const scopesOut: Array<{ type: string; name?: string; variables: unknown[] }> = [];
    for (const scope of frame.scopes) {
      if (scope.type === "global" && !input.includeGlobal) continue;
      if (!scope.objectId) {
        scopesOut.push({ type: scope.type, name: scope.name, variables: [] });
        continue;
      }
      try {
        const res = (await this.client.send("Runtime.getProperties", {
          objectId: scope.objectId,
          ownProperties: true,
          generatePreview: false,
        })) as { result?: PropertyDescriptor[] };
        const vars = (res.result || [])
          .slice(0, MAX_VARS_PER_SCOPE)
          .filter((p) => p.value || p.get)
          .map((p) => ({
            name: p.name,
            ...this.viewRemote(p.value),
          }));
        scopesOut.push({ type: scope.type, name: scope.name, variables: vars });
      } catch (err) {
        scopesOut.push({
          type: scope.type,
          name: scope.name,
          variables: [{ name: "<error>", value: err instanceof Error ? err.message : String(err) }],
        });
      }
    }
    return { ok: true, frameId: frame.id, scopes: scopesOut };
  }

  async getProperties(objectId: string): Promise<DebugActionResult> {
    if (!this.client) return { ok: false, reason: "No debug session is active." };
    if (!objectId) return { ok: false, reason: "An objectId is required." };
    try {
      const res = (await this.client.send("Runtime.getProperties", {
        objectId,
        ownProperties: true,
        generatePreview: false,
      })) as { result?: PropertyDescriptor[] };
      const props = (res.result || [])
        .slice(0, MAX_VARS_PER_SCOPE)
        .filter((p) => p.value || p.get)
        .map((p) => ({ name: p.name, ...this.viewRemote(p.value) }));
      return { ok: true, properties: props };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async evaluate(input: { expression: string; frameId?: string }): Promise<DebugActionResult> {
    if (!this.client) return { ok: false, reason: "No debug session is active." };
    const expression = String(input.expression ?? "");
    if (!expression) return { ok: false, reason: "An expression is required." };
    try {
      let result: { result?: RemoteObject; exceptionDetails?: ExceptionDetails };
      if (this.status === "paused" && this.paused) {
        const frameId =
          input.frameId && this.paused.frames.some((f) => f.id === input.frameId)
            ? input.frameId
            : this.paused.topFrameId;
        result = (await this.client.send("Debugger.evaluateOnCallFrame", {
          callFrameId: frameId,
          expression,
          objectGroup: "console",
          includeCommandLineAPI: true,
          silent: false,
          returnByValue: false,
          generatePreview: true,
        })) as { result?: RemoteObject; exceptionDetails?: ExceptionDetails };
      } else {
        result = (await this.client.send("Runtime.evaluate", {
          expression,
          objectGroup: "console",
          includeCommandLineAPI: true,
          replMode: true,
          returnByValue: false,
          generatePreview: true,
          awaitPromise: true,
        })) as { result?: RemoteObject; exceptionDetails?: ExceptionDetails };
      }
      if (result.exceptionDetails) {
        const d = result.exceptionDetails;
        const text = d.exception ? this.previewValue(d.exception) : d.text || "Evaluation error";
        return { ok: false, error: text };
      }
      return { ok: true, result: this.viewRemote(result.result) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  getStatus(): DebugActionResult {
    return { ok: true, ...this.serialize() };
  }

  // ---- Value formatting ---------------------------------------------------

  private previewValue(obj: RemoteObject | undefined): string {
    if (!obj) return "undefined";
    if (obj.type === "string") return String(obj.value ?? obj.description ?? "");
    if ("value" in obj && obj.value !== undefined) return String(obj.value);
    if (obj.unserializableValue) return obj.unserializableValue;
    return obj.description || obj.className || obj.subtype || obj.type;
  }

  private viewRemote(obj: RemoteObject | undefined): {
    type: string;
    subtype?: string;
    value: string;
    objectId?: string;
    expandable: boolean;
  } {
    if (!obj) return { type: "undefined", value: "undefined", expandable: false };
    return {
      type: obj.type,
      subtype: obj.subtype,
      value: this.previewValue(obj),
      objectId: obj.objectId,
      expandable: !!obj.objectId,
    };
  }
}

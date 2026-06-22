// SDK-free client for the TypeScript standalone server (`tsserver`). Spawns the
// project's own `typescript/lib/tsserver.js` as a long-lived child and speaks
// its newline-delimited JSON protocol to pull project-wide diagnostics. Used by
// the controller to power the live "Problems" panel. No external dependency:
// tsserver ships inside the project's `typescript` package — the same server
// that powers VS Code — so diagnostics match the project's TS version.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Diagnostic, DiagnosticCategory } from "./types.ts";

// Resolve the project's own tsserver entry point. Returns null when typescript
// isn't installed in the project (the diagnostics feature then stays disabled).
export function resolveTsserverPath(cwd: string): string | null {
  try {
    const req = createRequire(path.join(cwd, "package.json"));
    return req.resolve("typescript/lib/tsserver.js");
  } catch {
    return null;
  }
}

// Resolve a real Node executable to run tsserver.js. `process.execPath` is NOT
// usable here: inside the Copilot extension fork it points at the host CLI
// binary (e.g. `.../copilot`), which refuses to run an arbitrary JS file. So we
// only trust execPath when it is actually node, then fall back to npm's node
// path and a PATH scan, and finally to a bare "node" for the OS to resolve.
let cachedNodePath: string | null = null;
export function resolveNodePath(): string {
  if (cachedNodePath) return cachedNodePath;
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const candidates: string[] = [];
  if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) candidates.push(process.execPath);
  if (process.env.npm_node_execpath) candidates.push(process.env.npm_node_execpath);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        cachedNodePath = c;
        return c;
      }
    } catch {}
  }
  cachedNodePath = exe;
  return exe;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".astro",
  ".svelte-kit",
  ".cache",
  ".output",
  ".vercel",
]);
const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JS_EXT = new Set([".js", ".jsx", ".mjs", ".cjs"]);
// Conventional source roots. A file under one of these is the most reliable
// representative: it is almost always part of the project's main tsconfig.
const SOURCE_DIRS = new Set([
  "src",
  "lib",
  "app",
  "source",
  "server",
  "pages",
  "components",
  "routes",
  "packages",
]);
// Root-level config files (vitest.config.ts, vite.config.ts, ...) are usually
// excluded from the project's tsconfig `include`, so opening one lands tsserver
// in a loose inferred project that can't see the real sources. Use them only as
// a last resort.
const CONFIG_FILE = /\.config\.[mc]?[jt]sx?$/i;

// Find a representative source file so tsserver can resolve the containing
// project. Preference order: a file inside a conventional source dir > a
// non-config file in another subdir > a non-config file at the root > a config
// file > any JS file. This avoids picking an excluded root config file, which
// would otherwise make tsserver analyze an empty inferred project.
export function findRepresentativeFile(root: string): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let otherSubdirTs: string | null = null;
  let rootTs: string | null = null;
  let configTs: string | null = null;
  let jsFallback: string | null = null;
  while (queue.length) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name);
      if (TS_EXT.has(ext) && !e.name.endsWith(".d.ts")) {
        const full = path.join(dir, e.name);
        const seg0 = path.relative(root, full).split(path.sep)[0];
        if (CONFIG_FILE.test(e.name)) configTs ??= full;
        else if (dir !== root && SOURCE_DIRS.has(seg0)) return full;
        else if (dir === root) rootTs ??= full;
        else otherSubdirTs ??= full;
      } else if (!jsFallback && JS_EXT.has(ext) && !CONFIG_FILE.test(e.name)) {
        jsFallback = path.join(dir, e.name);
      }
    }
    if (depth < 5) {
      for (const e of entries) {
        if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
          queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return rootTs ?? otherSubdirTs ?? configTs ?? jsFallback;
}

interface TsDiagnosticBody {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  text: string;
  code?: number;
  category: DiagnosticCategory;
}

interface PendingErr {
  seq: number;
  diags: Diagnostic[];
  resolve: (diags: Diagnostic[]) => void;
  timer: NodeJS.Timeout;
}

// tsserver protocol events that carry diagnostics. `suggestionDiag` is skipped:
// it mostly surfaces library deprecation hints (noise for a Problems panel) and
// falls outside the errors-and-warnings scope.
const DIAG_EVENTS = new Set(["syntacticDiag", "semanticDiag"]);

export class TsServerClient extends EventEmitter {
  readonly cwd: string;
  readonly tsserverPath: string;
  private child: ChildProcess | null = null;
  private seq = 0;
  private buf = "";
  private openedFile: string | null = null;
  private repFile: string | null = null;
  private pendingErr: PendingErr | null = null;
  private inflight: Promise<Diagnostic[]> | null = null;

  constructor(cwd: string, tsserverPath: string) {
    super();
    this.cwd = cwd;
    this.tsserverPath = tsserverPath;
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    const child = spawn(
      resolveNodePath(),
      [this.tsserverPath, "--disableAutomaticTypingAcquisition"],
      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => this.onData(text));
    child.on("exit", () => this.handleExit());
    child.on("error", () => this.handleExit());
    this.child = child;
  }

  stop(): void {
    const child = this.child;
    this.handleExit();
    if (child) {
      try {
        child.kill();
      } catch {}
    }
  }

  private handleExit(): void {
    this.child = null;
    this.openedFile = null;
    this.buf = "";
    if (this.pendingErr) {
      clearTimeout(this.pendingErr.timer);
      const { resolve, diags } = this.pendingErr;
      this.pendingErr = null;
      resolve(diags);
    }
  }

  private send(command: string, args?: unknown): number | null {
    if (!this.child?.stdin?.writable) return null;
    const seq = ++this.seq;
    this.child.stdin.write(
      `${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`,
    );
    return seq;
  }

  private onData(text: string): void {
    this.buf += text;
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line.startsWith("{")) {
        let msg: { type?: string; event?: string; body?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          msg = {};
        }
        if (msg.type === "event") this.onEvent(msg.event, msg.body);
      }
      idx = this.buf.indexOf("\n");
    }
  }

  private onEvent(event: string | undefined, body: unknown): void {
    if (!event) return;
    if (DIAG_EVENTS.has(event)) {
      const pending = this.pendingErr;
      if (!pending) return;
      const b = body as { file?: string; diagnostics?: TsDiagnosticBody[] };
      const file = b.file;
      if (!file || !this.withinProject(file)) return;
      for (const d of b.diagnostics || []) {
        if (d.category !== "error" && d.category !== "warning") continue;
        pending.diags.push({
          file,
          start: d.start,
          end: d.end,
          code: d.code ?? null,
          category: d.category,
          text: d.text,
        });
      }
    } else if (event === "requestCompleted") {
      const reqSeq = (body as { request_seq?: number })?.request_seq;
      if (this.pendingErr && reqSeq === this.pendingErr.seq) this.finishErr();
    }
  }

  private finishErr(): void {
    const pending = this.pendingErr;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingErr = null;
    pending.diags.sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.start.line - b.start.line ||
        a.start.offset - b.start.offset,
    );
    pending.resolve(pending.diags);
  }

  // Is `file` inside the project tree (and not under node_modules)?
  private withinProject(file: string): boolean {
    const rel = path.relative(this.cwd, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return !rel.split(path.sep).includes("node_modules");
  }

  private representativeFile(): string | null {
    if (this.repFile && existsSync(this.repFile)) return this.repFile;
    this.repFile = findRepresentativeFile(this.cwd);
    return this.repFile;
  }

  // Force tsserver to re-read project files from disk on the next request. Used
  // after file-system changes (the canvas is not an editor, so there is no
  // change/save protocol — diagnostics always reflect saved files on disk).
  // Closing the opened file matters: tsserver treats opened files as
  // client-owned, so `reloadProjects` alone won't pick up their on-disk edits.
  reload(): void {
    if (this.running) {
      if (this.openedFile) this.send("close", { file: this.openedFile });
      this.send("reloadProjects");
    }
    this.openedFile = null;
    this.repFile = null;
  }

  // Request project-wide diagnostics. Serialized: concurrent callers share the
  // same in-flight promise.
  getProjectDiagnostics(): Promise<Diagnostic[]> {
    if (this.inflight) return this.inflight;
    this.inflight = this.collect().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private collect(): Promise<Diagnostic[]> {
    if (!this.running) this.start();
    const file = this.representativeFile();
    if (!file) return Promise.resolve([]);
    if (this.openedFile !== file) {
      this.send("open", { file });
      this.openedFile = file;
    }
    return new Promise<Diagnostic[]>((resolve) => {
      const seq = this.send("geterrForProject", { file, delay: 0 });
      if (seq == null) {
        resolve([]);
        return;
      }
      const timer = setTimeout(() => {
        if (this.pendingErr?.seq === seq) {
          const diags = this.pendingErr.diags;
          this.pendingErr = null;
          resolve(diags);
        }
      }, 20000);
      this.pendingErr = { seq, diags: [], resolve, timer };
    });
  }
}

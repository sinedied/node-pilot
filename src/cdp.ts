// Minimal Chrome DevTools Protocol (CDP) client over Node's built-in global
// WebSocket — zero runtime dependencies. It speaks JSON-RPC: requests are
// `{ id, method, params }` and the reply is `{ id, result }` or `{ id, error }`;
// protocol events arrive as `{ method, params }` with no `id`. The debugger uses
// it to drive Node's V8 Inspector (and, in a later phase, browsers — same
// protocol over `--remote-debugging-port`).
import { EventEmitter } from "node:events";

export interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export type CdpParams = Record<string, unknown>;

interface CdpResponseMessage {
  id: number;
  result?: CdpParams;
  error?: { code?: number; message?: string };
}

interface CdpEventMessage {
  method: string;
  params?: CdpParams;
}

interface Pending {
  resolve: (value: CdpParams) => void;
  reject: (err: Error) => void;
}

export class CdpClient {
  private ws: WebSocket;
  private nextId: number;
  private pending: Map<number, Pending>;
  private emitter: EventEmitter;
  closed: boolean;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(200);
    this.closed = false;
    ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev));
    ws.addEventListener("close", () => this.onClose());
    // Swallow late socket errors; in-flight requests reject via onClose().
    ws.addEventListener("error", () => {});
  }

  // Open a CDP WebSocket and resolve once the connection is established.
  static connect(wsUrl: string, opts: { timeoutMs?: number } = {}): Promise<CdpClient> {
    const timeoutMs = opts.timeoutMs ?? 10000;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`CDP connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new CdpClient(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`CDP connection failed: ${wsUrl}`));
        },
        { once: true },
      );
    });
  }

  // List the inspector targets (each exposes a `webSocketDebuggerUrl`) via the
  // built-in fetch. Works for Node (`/json/list`) and Chromium browsers alike.
  static async fetchTargets(
    host: string,
    port: number,
    opts: { timeoutMs?: number } = {},
  ): Promise<CdpTarget[]> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${host}:${port}/json/list`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`/json/list returned HTTP ${res.status}`);
      const data = (await res.json()) as CdpTarget[];
      return Array.isArray(data) ? data : [];
    } finally {
      clearTimeout(timer);
    }
  }

  // Issue a CDP command and resolve with its `result`, or reject on a protocol
  // error / closed connection.
  send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    if (this.closed) return Promise.reject(new Error("CDP client is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // Subscribe to a CDP event by method name (e.g. "Debugger.paused").
  on(method: string, handler: (params: CdpParams) => void): void {
    this.emitter.on(method, handler);
  }

  off(method: string, handler: (params: CdpParams) => void): void {
    this.emitter.off(method, handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {}
    this.failAll(new Error("CDP client closed."));
  }

  private onMessage(ev: MessageEvent): void {
    let msg: Partial<CdpResponseMessage & CdpEventMessage>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      this.emitter.emit(msg.method, msg.params ?? {});
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("CDP connection closed."));
    this.emitter.emit("disconnected", {});
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

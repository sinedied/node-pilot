// Per-instance loopback HTTP server. Serves the static UI from public/ under the
// `/__cockpit/` base path, streams controller events over SSE, exposes a small
// JSON action API, and reverse-proxies every other request to the running dev
// server so the preview iframe is *same-origin* with the canvas (which lets us
// capture it in-browser — see public/preview-capture.js). Binds to 127.0.0.1 on
// an ephemeral port.
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEvent } from "./types.ts";
import type { Controller } from "./controller.ts";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// The canvas UI lives under this base path so the server root is free for the
// reverse proxy. Keep it in sync with BASE in public/app.js and the asset refs
// in public/index.html.
const BASE = "/__cockpit";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body ?? {});
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

// Hard cap on POST body size (screenshots are the only large payload; the
// client downscales first, this is just a safety net against runaway uploads).
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: request bodies are arbitrary JSON, narrowed per-route below
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve({ __oversize: true });
        req.destroy();
        return;
      }
      data += c;
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => {
      if (!aborted) resolve({});
    });
  });
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function handleSse(controller: Controller, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "snapshot", state: controller.getState() })}\n\n`);
  const onEvent = (evt: AppEvent) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {}
  };
  controller.events.on("event", onEvent);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 20000);
  res.on("close", () => {
    clearInterval(ping);
    controller.events.off("event", onEvent);
  });
}

// Routes that complete quickly are awaited; long-running ones are fired off and
// reported through SSE so the HTTP call returns immediately.
async function handleApi(
  controller: Controller,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
): Promise<void> {
  const body = req.method === "POST" ? await readBody(req) : {};
  if (body?.__oversize) return sendJson(res, 413, { ok: false, reason: "Payload too large." });
  switch (route) {
    case "GET /api/state":
      return sendJson(res, 200, controller.getState());
    case "GET /api/settings":
      return sendJson(res, 200, await controller.getSettings());
    case "POST /api/settings":
      return sendJson(res, 200, await controller.setSettings(body));
    case "POST /api/refresh":
      return sendJson(res, 200, await controller.refresh());
    case "GET /api/projects":
      return sendJson(res, 200, await controller.getProjects());
    case "POST /api/projects/select": {
      const result = await controller.setActiveProject(
        typeof body.dir === "string" ? body.dir : undefined,
      );
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    case "POST /api/info/stats":
      return sendJson(res, 200, await controller.getProjectStats());
    case "POST /api/diagnostics":
      return sendJson(res, 200, await controller.getDiagnostics());
    case "POST /api/lint":
      return sendJson(res, 200, await controller.getLintDiagnostics());
    case "POST /api/diagnostics/fix": {
      if (body.all) return sendJson(res, 200, await controller.fixAllDiagnostics());
      return sendJson(res, 200, await controller.fixDiagnostic(body.diagnostic ?? null));
    }
    case "POST /api/lane": {
      const id = body.id;
      controller.runLane(id, body).catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    }
    case "POST /api/test":
      controller.runTests(body).catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    case "POST /api/test/watch":
      return sendJson(res, 200, await controller.setTestWatch(body.on === true));
    case "POST /api/script":
      controller.runScriptByName(body.name).catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    case "POST /api/dev/start":
      return sendJson(res, 200, await controller.startDev());
    case "POST /api/dev/stop":
      return sendJson(res, 200, await controller.stopDev());
    case "POST /api/dev/screenshot": {
      const data = typeof body.data === "string" ? body.data : "";
      if (!data) return sendJson(res, 400, { ok: false, reason: "No image data." });
      const mimeType = typeof body.mimeType === "string" ? body.mimeType : "image/png";
      const result = await controller.sendScreenshotToChat(body.prompt, data, mimeType);
      return sendJson(res, result.ok ? 200 : 502, result);
    }
    case "POST /api/deps/outdated":
      return sendJson(res, 200, await controller.listOutdated());
    case "POST /api/deps/audit":
      return sendJson(res, 200, await controller.runAudit());
    case "POST /api/deps/update":
      return sendJson(res, 200, await controller.sendCopilotUpdate(body));
    case "POST /api/deps/audit-fix":
      return sendJson(res, 200, await controller.sendCopilotAuditFix());
    case "POST /api/fix":
      return sendJson(res, 200, await controller.fixIssue(body.lane));
    case "POST /api/rayfin/state":
      return sendJson(res, 200, await controller.getRayfinState(body.force === true));
    case "POST /api/rayfin/cli":
      controller.runRayfinCli(body.args).catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    case "POST /api/rayfin/switch":
      controller
        .switchRayfinWorkspace(String(body.name || ""))
        .catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    case "POST /api/debug/start":
      return sendJson(res, 200, await controller.debugStart(body));
    case "POST /api/debug/attach":
      return sendJson(res, 200, await controller.debugAttach(body));
    case "POST /api/debug/stop":
      return sendJson(res, 200, await controller.debugStop());
    case "POST /api/debug/breakpoint":
      return sendJson(res, 200, await controller.debugSetBreakpoint(body));
    case "POST /api/debug/breakpoint/remove":
      return sendJson(res, 200, await controller.debugRemoveBreakpoint(body));
    case "POST /api/debug/continue":
      return sendJson(res, 200, await controller.debugContinue());
    case "POST /api/debug/pause":
      return sendJson(res, 200, await controller.debugPause());
    case "POST /api/debug/step-over":
      return sendJson(res, 200, await controller.debugStepOver());
    case "POST /api/debug/step-into":
      return sendJson(res, 200, await controller.debugStepInto());
    case "POST /api/debug/step-out":
      return sendJson(res, 200, await controller.debugStepOut());
    case "POST /api/debug/wait":
      return sendJson(res, 200, await controller.debugWaitForPause(body.timeoutMs));
    case "POST /api/debug/variables":
      return sendJson(res, 200, await controller.debugGetVariables(body));
    case "POST /api/debug/properties":
      return sendJson(res, 200, await controller.debugGetProperties(body.objectId));
    case "POST /api/debug/evaluate":
      return sendJson(res, 200, await controller.debugEvaluate(body));
    default:
      return sendJson(res, 404, { ok: false, reason: "Unknown endpoint." });
  }
}

// Origin (protocol//host:port) of the running dev server, or null when it is not
// running yet. The reverse proxy targets this; it changes per `dev:start`.
function devOrigin(controller: Controller): URL | null {
  if (controller.dev.status !== "running" || !controller.dev.url) return null;
  try {
    return new URL(controller.dev.url);
  } catch {
    return null;
  }
}

// Headers that must not be forwarded verbatim (hop-by-hop) or that would block
// framing / script injection of the proxied preview.
// Hop-by-hop headers, plus the ones that block framing / script injection of the
// proxied preview. `content-encoding` / `content-length` are handled explicitly
// per-response (preserved when streaming, recomputed when we rewrite HTML).
const STRIP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

// The two scripts injected into proxied HTML: the vendored rasterizer and our
// capture bridge. Loaded from the canvas namespace (same-origin with the page).
const INJECT_HTML =
  `<script src="${BASE}/vendor/snapdom.min.js"></script>` +
  `<script src="${BASE}/preview-capture.js"></script>`;

function injectIntoHtml(html: string): string {
  // Drop any in-document CSP that could block our same-origin injected scripts
  // (response-header CSP is already stripped; <meta http-equiv> is not).
  const out = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  if (/<\/head>/i.test(out)) return out.replace(/<\/head>/i, `${INJECT_HTML}</head>`);
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${INJECT_HTML}</body>`);
  return out + INJECT_HTML;
}

// Reverse-proxy a request to the running dev server. Identity-encoded HTML is
// buffered so we can strip CSP/XFO and inject the capture scripts; everything
// else (including any compressed response) streams straight through untouched.
function proxyToDev(controller: Controller, req: IncomingMessage, res: ServerResponse): void {
  const origin = devOrigin(controller);
  if (!origin) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No dev server running.");
    return;
  }
  const headers = { ...req.headers, host: origin.host };
  // Ask for an identity encoding so we can rewrite HTML without gunzipping.
  headers["accept-encoding"] = "identity";
  const requestFn = origin.protocol === "https:" ? httpsRequest : httpRequest;
  const proxyReq = requestFn(
    {
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      const type = String(proxyRes.headers["content-type"] || "");
      const encoding = String(proxyRes.headers["content-encoding"] || "").toLowerCase();
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v === undefined) continue;
        if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        outHeaders[k] = v;
      }
      // Only rewrite HTML we can actually read (identity-encoded). Compressed or
      // non-HTML responses stream through with their original headers intact.
      const canInject = type.includes("text/html") && (encoding === "" || encoding === "identity");
      if (canInject) {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (c) => chunks.push(c as Buffer));
        proxyRes.on("end", () => {
          const body = injectIntoHtml(Buffer.concat(chunks).toString("utf8"));
          const buf = Buffer.from(body, "utf8");
          outHeaders["content-length"] = String(buf.length);
          delete outHeaders["content-encoding"];
          res.writeHead(proxyRes.statusCode || 200, outHeaders);
          res.end(buf);
        });
        proxyRes.on("error", () => res.destroy());
      } else {
        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        proxyRes.pipe(res);
      }
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Preview proxy error.");
  });
  // Tear down the upstream request if the browser bails (rapid reloads / HMR).
  res.on("close", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

// Proxy a WebSocket upgrade (dev-server HMR) to the dev origin. Best-effort: any
// failure just closes the client socket, so HMR degrades but the preview still
// loads.
function proxyUpgrade(
  controller: Controller,
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
): void {
  const origin = devOrigin(controller);
  if (!origin) {
    clientSocket.destroy();
    return;
  }
  const port = Number(origin.port) || (origin.protocol === "https:" ? 443 : 80);
  const onConnect = () => {
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
    const h = { ...req.headers, host: origin.host };
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined) continue;
      for (const val of Array.isArray(v) ? v : [v]) headerLines.push(`${k}: ${val}`);
    }
    upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  };
  const upstream =
    origin.protocol === "https:"
      ? tlsConnect({ host: origin.hostname, port, servername: origin.hostname }, onConnect)
      : netConnect(port, origin.hostname, onConnect);
  const close = () => {
    clientSocket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  clientSocket.on("error", close);
}

export async function startServer(
  controller: Controller,
): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const p = url.pathname;
    try {
      // Canvas namespace: static UI, SSE and the JSON API.
      if (p === BASE || p === `${BASE}/`) return await serveStatic(res, "/");
      if (p.startsWith(`${BASE}/`)) {
        const sub = p.slice(BASE.length); // e.g. "/app.js", "/events", "/api/state"
        if (sub === "/events") return handleSse(controller, res);
        if (sub.startsWith("/api/")) {
          return await handleApi(controller, req, res, `${req.method} ${sub}`);
        }
        if (req.method === "GET") return await serveStatic(res, sub);
        res.writeHead(405);
        res.end("Method not allowed");
        return;
      }
      // Everything else is the dev-server preview, reverse-proxied same-origin.
      return proxyToDev(controller, req, res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
  });
  // HMR / dev-server WebSockets reach us at the canvas origin → proxy them on.
  server.on("upgrade", (req, socket, head) =>
    proxyUpgrade(controller, req, socket as Socket, head),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}${BASE}/` };
}

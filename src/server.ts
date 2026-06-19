// Per-instance loopback HTTP server: serves the static UI from public/, streams
// controller events over SSE, and exposes a small JSON action API that mirrors
// the agent-callable actions. Binds to 127.0.0.1 on an ephemeral port.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEvent } from "./types.ts";
import type { Controller } from "./controller.ts";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

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

// biome-ignore lint/suspicious/noExplicitAny: request bodies are arbitrary JSON, narrowed per-route below
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
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
  switch (route) {
    case "GET /api/state":
      return sendJson(res, 200, controller.getState());
    case "GET /api/settings":
      return sendJson(res, 200, await controller.getSettings());
    case "POST /api/settings":
      return sendJson(res, 200, await controller.setSettings(body));
    case "POST /api/refresh":
      return sendJson(res, 200, await controller.refresh());
    case "POST /api/info/stats":
      return sendJson(res, 200, await controller.getProjectStats());
    case "POST /api/lane": {
      const id = body.id;
      controller.runLane(id, body).catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    }
    case "POST /api/test":
      controller.runTests(body).catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    case "POST /api/script":
      controller.runScriptByName(body.name).catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    case "POST /api/dev/start":
      return sendJson(res, 200, await controller.startDev());
    case "POST /api/dev/stop":
      return sendJson(res, 200, await controller.stopDev());
    case "POST /api/deps/outdated":
      return sendJson(res, 200, await controller.listOutdated());
    case "POST /api/deps/audit":
      return sendJson(res, 200, await controller.runAudit());
    case "POST /api/deps/update":
      controller.safeUpdate(body).catch((e) => controller.log(String(e), "error"));
      return sendJson(res, 202, { started: true });
    case "POST /api/deps/fix": {
      const prompt = controller.deps.update?.fixPrompt;
      if (!prompt) return sendJson(res, 400, { ok: false, reason: "No update failure to fix." });
      await controller.sendPromptToChat(prompt);
      return sendJson(res, 200, { ok: true });
    }
    case "POST /api/fix":
      return sendJson(res, 200, await controller.fixIssue(body.lane));
    default:
      return sendJson(res, 404, { ok: false, reason: "Unknown endpoint." });
  }
}

export async function startServer(
  controller: Controller,
): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (url.pathname === "/events") return handleSse(controller, res);
      if (url.pathname.startsWith("/api/")) return await handleApi(controller, req, res, route);
      if (req.method === "GET") return await serveStatic(res, url.pathname);
      res.writeHead(405);
      res.end("Method not allowed");
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

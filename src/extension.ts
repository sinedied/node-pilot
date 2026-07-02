// Cockpit.js — the JavaScript / Node.js / web inner-loop console for the GitHub
// Copilot app. Wires the canvas declaration to a shared Controller and a
// per-instance loopback HTTP server. See plan / AGENTS.md for the design.
import {
  joinSession,
  createCanvas,
  type CanvasOpenContext,
  type CanvasCloseContext,
  type CopilotSession,
} from "@github/copilot-sdk/extension";
import { Controller } from "./controller.ts";
import { startServer } from "./server.ts";
import { buildActions } from "./actions.ts";
import { readPackageMetaSync } from "./update.ts";

const cwd = process.cwd();

// One controller (single project state) shared by every open canvas instance.
let sessionRef: CopilotSession | undefined;

async function sendToChat(prompt: string): Promise<void> {
  try {
    await sessionRef?.send({ prompt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sessionRef?.log?.(`Cockpit.js: failed to message chat: ${message}`, {
      level: "error",
    });
  }
}

async function sendImageToChat(
  prompt: string,
  dataBase64: string,
  mimeType: string,
): Promise<void> {
  if (!sessionRef) throw new Error("No active chat session.");
  try {
    await sessionRef.send({
      prompt,
      attachments: [{ type: "blob", data: dataBase64, mimeType, displayName: "preview.png" }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sessionRef.log?.(`Cockpit.js: failed to send screenshot: ${message}`, {
      level: "error",
    });
    throw new Error(message);
  }
}

// Own version + distribution repo, read once from the root package.json. Drives
// the self-update check (compares against sinedied/cockpit-js GitHub Releases).
const { version, repoSlug } = readPackageMetaSync();

const controller = new Controller(cwd, { sendToChat, sendImageToChat, version, repoSlug });

// One loopback server per open canvas instance; they all share `controller`.
const servers = new Map<string, Awaited<ReturnType<typeof startServer>>>();

const session = await joinSession({
  canvases: [
    createCanvas({
      id: "cockpit",
      displayName: "Cockpit.js",
      description:
        "Build, lint, type-check, test and run JavaScript / Node.js / web apps, preview the dev server, and update dependencies without breaking the app.",
      actions: buildActions(controller),
      open: async (ctx: CanvasOpenContext) => {
        await controller.ensureProjectDir(ctx?.session?.workingDirectory);
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(controller);
          servers.set(ctx.instanceId, entry);
        }
        const d = controller.detection;
        const status = d?.hasProject
          ? `${d.framework.label} · ${d.pm}`
          : "No Node.js project detected";
        return { title: "Cockpit.js", url: entry.url, status };
      },
      onClose: async (ctx: CanvasCloseContext) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise<void>((resolve) => entry.server.close(() => resolve()));
        }
        // Release the TypeScript language server and any watch process once no
        // canvas is open.
        if (servers.size === 0) {
          controller.stopTsServer();
          controller.stopTestWatch().catch(() => {});
          controller.stopDev().catch(() => {});
          controller.stopFunctionsHost().catch(() => {});
        }
      },
    }),
  ],
});

sessionRef = session;
await session.log("Cockpit.js ready.");

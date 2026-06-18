// Node Pilot — the JavaScript / Node.js / web inner-loop console for the GitHub
// Copilot app. Wires the canvas declaration to a shared Controller and a
// per-instance loopback HTTP server. See PLAN.md for the design.
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { Controller } from "./src/controller.mjs";
import { startServer } from "./src/server.mjs";
import { buildActions } from "./src/actions.mjs";

const cwd = process.cwd();

// One controller (single project state) shared by every open canvas instance.
let controller;
let sessionRef;

async function sendToChat(prompt) {
  try {
    await sessionRef?.send({ prompt });
  } catch (err) {
    await sessionRef?.log?.(`Node Pilot: failed to message chat: ${err.message}`, {
      level: "error",
    });
  }
}

controller = new Controller(cwd, { sendToChat });

// One loopback server per open canvas instance; they all share `controller`.
const servers = new Map();

const session = await joinSession({
  canvases: [
    createCanvas({
      id: "node-app",
      displayName: "Node Pilot",
      description:
        "Build, lint, type-check, test and run JavaScript / Node.js / web apps, preview the dev server, and update dependencies without breaking the app.",
      actions: buildActions(controller),
      open: async (ctx) => {
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
        return { title: "Node Pilot", url: entry.url, status };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise((resolve) => entry.server.close(() => resolve()));
        }
      },
    }),
  ],
});

sessionRef = session;
await session.log("Node Pilot ready.");

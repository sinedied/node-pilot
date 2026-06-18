# AGENTS.md

Context recap for AI agents working on this repo. Keep it short and current.

## What this is

**Node Pilot** — a GitHub Copilot **canvas** extension that runs the JS/Node/web
inner loop (scripts, build, lint, format, type-check, test, dev server, dependency
updates with auto-rollback) in the Copilot app side panel. Java equivalent for
inspiration: [coffilot](https://github.com/jdubois/coffilot). Full design in
[`PLAN.md`](./PLAN.md); user-facing docs in [`README.md`](./README.md).

## Architecture

- `extension.mjs` — the **only** file that imports `@github/copilot-sdk`. Declares the
  canvas (`id: "node-app"`, displayName "Node Pilot"), wires a shared `Controller`,
  one loopback HTTP server per open canvas instance, and `sendToChat`.
- `src/` — all SDK-free and unit-testable with plain Node:
  - `detect.mjs` (pm/scripts/framework/TS/runners), `pm.mjs`, `process-runner.mjs`
    (cross-platform spawn), `lanes.mjs`, `test-report.mjs`, `deps.mjs` (safe-update
    loop + rollback), `controller.mjs` (central state + SSE events), `server.mjs`
    (http + SSE + `/api/*`), `actions.mjs` (agent actions), `fix.mjs` (prompt builders).
- `public/` — vanilla HTML/CSS/JS UI (Console / Tests / Dev / Dependencies tabs).
- `.github/extensions/node-pilot/extension.mjs` — dog-food wrapper that imports the
  root `extension.mjs` so the repo runs the extension against itself.

## Critical gotchas

- **Working directory**: the extension process `cwd` is NOT the project root
  (`~/.copilot`). The project path comes from `ctx.session.workingDirectory` on every
  canvas `open`/action. `Controller.ensureProjectDir(dir)` anchors + re-detects; all
  action handlers are wrapped to call it first. Never rely on `process.cwd()` for the
  project.
- **No `console.log`** in the extension — stdout is reserved for JSON-RPC. Use
  `session.log()` (host-side) or `controller.broadcast`/SSE for UI.
- SDK import only resolves inside the Copilot runtime; keep `src/` SDK-free.
- Canvas action names must NOT start with `canvas.`.

## Workflow

- Apply changes, then **reload** in the Copilot app (rediscovers `.github/extensions/`)
  to pick them up. Verify with `open_canvas` (canvasId `node-app`) and
  `invoke_canvas_action`.
- Checks: `npm run check` (syntax-checks every module), `npm run format` /
  `npm run format:check` (Prettier).
- Regression harnesses live in the session state dir (`files/test-core.mjs`,
  `files/test-deps.mjs`), run with plain `node` — keep them green.

## Conventions

- Conventional Commits.
- ESM (`type: module`), Prettier-formatted, MIT licensed, author Yohan Lasorsa.

# AGENTS.md

Context recap for AI agents working on this repo. Keep it short and current.

## What this is

**Cockpit.js** — a GitHub Copilot **canvas** extension that runs the JS/Node/web
inner loop (scripts, build, lint, format, type-check, test, dev server, dependency
updates with auto-rollback) in the Copilot app side panel. Java equivalent for
inspiration: [coffilot](https://github.com/jdubois/coffilot). Full design in
[`PLAN.md`](./PLAN.md); user-facing docs in [`README.md`](./README.md).

## Architecture

- `extension.mjs` (root) — thin entry **named `extension.mjs`** because the Copilot
  runtime only discovers that filename. It just `import "./src/extension.ts"`.
- `src/extension.ts` — the **only** module that imports `@github/copilot-sdk`. Declares
  the canvas (`id: "cockpit"`, displayName "Cockpit.js"), wires a shared `Controller`,
  one loopback HTTP server per open canvas instance, and `sendToChat`.
- `src/` — TypeScript, SDK-free and unit-testable with plain Node:
  - `types.ts` (shared domain types), `detect.ts` (pm/scripts/framework/TS/runners),
    `pm.ts`, `process-runner.ts` (cross-platform spawn), `lanes.ts`, `test-report.ts`,
    `deps.ts` (safe-update loop + rollback), `info.ts` (lazy Info-tab metrics:
    transitive deps + sizes), `ts-server.ts` (SDK-free `tsserver` client powering
    the live Problems panel), `controller.ts` (central state + SSE
    events), `server.ts` (http + SSE + `/api/*`), `actions.ts` (agent actions),
    `fix.ts` (prompt builders), `settings.ts` (per-project pinned tasks + theme).
- `types/copilot-sdk.d.ts` — ambient shim for `@github/copilot-sdk/extension` so `tsc`
  resolves it in CI (the real package only exists inside the Copilot app).
- `public/` — vanilla HTML/CSS/JS UI (Info / Console / Problems / Tests / Dev /
  Dependencies tabs),
  GitHub Primer light/dark theming + inline Octicon sprite (MIT, bundled, no network).
  `public/app.js` stays JS, type-checked via `tsconfig.client.json` (`checkJs`).
- `test/` — Vitest specs (`core.test.ts`, `deps.test.ts`, `info.test.ts`,
  `settings.test.ts`, `ts-server.test.ts`). `scripts/smoke.mjs`
  dynamically imports every SDK-free `src/*.ts` to prove native type-stripping loads.
- `biome.json` — Biome config (lint + format, replaces Prettier). `noImportantStyles`
  is off (the cursor/spinner `!important` rules are deliberate, see gotcha below).
- `docs/site/` — a self-contained Astro + Starlight docs site (its own
  `astro.config.mjs` + `src/`), run via `astro --root docs/site`, so it never
  touches the extension's own `src/` or `public/`. It exists to **dogfood**
  Cockpit's own Dev lane (`npm run dev` → Astro detected → `localhost:4321`
  preview) and web Build (`npm run docs:build`). Edit docs content under
  `docs/site/src/content/docs/`.
- `.github/extensions/cockpit/extension.mjs` — dog-food wrapper that imports the
  root `extension.mjs` so the repo runs the extension against itself.
- `.github/workflows/ci.yml` — CI (`biome ci .` → build → smoke → test) on Node 22.18 & 24.

## Critical gotchas

- **Working directory**: the extension process `cwd` is NOT the project root
  (`~/.copilot`). The project path comes from `ctx.session.workingDirectory` on every
  canvas `open`/action. `Controller.ensureProjectDir(dir)` anchors + re-detects; all
  action handlers are wrapped to call it first. Never rely on `process.cwd()` for the
  project.
- **No `console.log`** in the extension — stdout is reserved for JSON-RPC. Use
  `session.log()` (host-side) or `controller.broadcast`/SSE for UI.
- SDK import only resolves inside the Copilot runtime; keep `src/` SDK-free (only
  `src/extension.ts` imports the SDK shim).
- Canvas action names must NOT start with `canvas.`.
- **TypeScript, no build step**: source is `.ts`, run directly via Node's native type
  stripping (Node ≥ 22.18). This imposes two rules, enforced by `tsconfig.json`
  (`erasableSyntaxOnly` + `verbatimModuleSyntax`):
  - **Explicit `.ts` import extensions** in relative imports (e.g.
    `import { Controller } from "./controller.ts"`).
  - **Erasable-only syntax** — no `enum`, runtime `namespace`, parameter properties or
    decorators; use `import type` / `export type` for type-only references.
  - `dist/` stays gitignored: nothing is emitted; `tsc` runs `--noEmit` as a checker.
- **No theme/icon inheritance**: the host injects no theme CSS vars/classes and the
  canvas API has no icon field. Theme follows OS `prefers-color-scheme` + a manual
  Auto/Light/Dark toggle; tab icon is a best-effort favicon (`public/icon.svg`).
- **Don't fight the native cursor**: the UI is a webview hosted by the native Copilot
  app, which owns the mouse cursor. With per-element cursors (e.g. `cursor: pointer` on
  buttons) the cursor flickers between default and pointer on hover — the webview and
  the native host contend over which to show. `pointer-events: none` does NOT fix it.
  The working resolution is to force **one uniform cursor everywhere**: a global
  `*, *::before, *::after { cursor: default !important; }` in `public/style.css`, with
  no per-element `cursor:` rules. One state means nothing for the host to flip between.
  Because the pointer cursor is unavailable, interactivity is signalled with visual
  state instead — `:hover` (bg/border/elevation), `:active` (slight `translateY(1px)`
  - darken = the click hint), and `:focus-visible` (accent focus ring) in
    `public/style.css`. Add affordances there; never reach for `cursor:`.
- **Settings persist server-side** in `~/.cockpit/settings.json` (keyed by project
  path), NOT in iframe `localStorage` — each canvas open gets a fresh loopback port,
  changing the origin and wiping `localStorage`. See `src/settings.ts`.
- **Lane availability**: each `resolve*()` in `lanes.ts` reports `{unavailable}`;
  `laneAvailability(d)` aggregates it onto `detection.availability` so the UI hides
  lanes/tabs that don't apply.
- **TS language server (`ts-server.ts` → Problems tab)** — a few hard-won rules:
  - **Never spawn `process.execPath`** to run `tsserver.js`. Inside the extension
    fork, `execPath` is the **host Copilot CLI binary** (e.g. `.../copilot`), which
    refuses to run an arbitrary JS file, so tsserver exits instantly and you silently
    get zero diagnostics. Use `resolveNodePath()` (trusts `execPath` only when it is
    actually `node`, else scans `PATH`). The GUI app's fork inherits a real `PATH`
    that includes the user's node.
  - **Representative file must be inside the project's tsconfig.** tsserver needs one
    open file to resolve the containing project, then `geterrForProject` reports for
    that file's project. Opening a **root-level `*.config.ts`** (usually excluded from
    `include`) lands tsserver in an empty *inferred project* → zero diagnostics.
    `findRepresentativeFile()` therefore prefers a file under a real source dir
    (`src`, `lib`, `app`, …) and treats root config files as a last resort.
  - **Refresh = `reloadProjects` + close the opened file.** tsserver treats opened
    files as client-owned, so `reloadProjects` alone won't pick up on-disk edits to the
    representative file; `reload()` sends `close` for it (then re-opens on the next
    request) so edits to *any* file — opened or not — are seen.
  - **`suggestionDiag` is noise** (library deprecation hints from lib.dom/lib.es5);
    only `syntacticDiag` + `semanticDiag` (category error/warning) are kept, filtered
    to files within the project tree.
  - **Saved files only.** The canvas is not an editor — there are no dirty buffers, so
    diagnostics always reflect what's on disk. Documented limitation, acceptable for a
    side panel.

## Workflow

The agent dev loop for any change:

1. **Make the change** in `src/*.ts` / `public/app.js` / docs.
2. **Run the required checks** until all green:
   - `npm run lint` (or `npm run lint:fix` to autofix) and `npm run format`
     (or `npm run format:check` to verify) — Biome. `npm run check` runs
     `biome check .` (lint + format) first, before build/smoke/test.
   - `npm run build` — `tsc` type-check of both `tsconfig.json` (Node) and
     `tsconfig.client.json` (the `checkJs` browser UI). Also aliased as `npm run typecheck`.
   - `npm run smoke` — loads every SDK-free `src/*.ts` through Node's native
     type-stripping (catches non-erasable syntax / bad `.ts` imports that `tsc` won't).
   - `npm test` — Vitest (`test/**`). `npm run check` runs the whole sequence at once.
3. **Reload + verify in the canvas**: reload the extension in the Copilot app
   (rediscovers `.github/extensions/`), then `open_canvas` (canvasId `cockpit`) and
   exercise the affected flow via the UI or `invoke_canvas_action`.
4. CI (`.github/workflows/ci.yml`) runs the same checks on Node **22.18** (the
   supported floor) and **24**.

> **Never `git commit` or `git push` without explicit human review and validation
> first.** Leave changes staged/working and hand them to the maintainer; they review,
> validate in the app, and commit. Conventional Commits when they do.

## Conventions

- Conventional Commits (applied by the human at commit time).
- TypeScript, ESM (`type: module`), Node ≥ 22.18, Biome-formatted, MIT licensed,
  author Yohan Lasorsa.

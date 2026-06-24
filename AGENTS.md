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
    transitive deps + sizes), `ts-server.ts` (SDK-free `tsserver` client) +
    `lint-report.ts` (linter JSON → `Diagnostic[]`) — together powering the live
    Problems panel, `controller.ts` (central state + SSE
    events), `server.ts` (http + SSE + `/api/*`), `actions.ts` (agent actions),
    `fix.ts` (prompt builders), `settings.ts` (per-project pinned tasks + theme).
- `types/copilot-sdk.d.ts` — ambient shim for `@github/copilot-sdk/extension` so `tsc`
  resolves it in CI (the real package only exists inside the Copilot app).
- `public/` — vanilla HTML/CSS/JS UI (Info / Preview / Tests / Problems / Dependencies /
  Console tabs — that's the **default order**; users reorder/hide tabs and toggle
  auto-run via a gear-launched **Settings** panel, `#tab-settings`, which is not itself
  a tab in `#tabs`),
  GitHub Primer light/dark theming + inline Octicon sprite (MIT, bundled, no network).
  `public/app.js` stays JS, type-checked via `tsconfig.client.json` (`checkJs`).
  `public/preview-capture.js` is the capture bridge injected into the proxied preview;
  `public/vendor/snapdom.min.js` is the vendored rasterizer it uses (see gotcha below).
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
  Auto/Light/Dark control that lives in the **Settings tab** (Appearance section, a
  `.segmented` control wired in `app.js`); tab icon is a best-effort favicon
  (`public/icon.svg`).
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
- **The canvas webview is WebKit on macOS, not Chromium**: a live UA probe in the
  real panel returned `AppleWebKit/605.1.15 (KHTML, like Gecko)` with no `Chrome`
  token (WKWebView). On Windows the host uses WebView2/Chromium and on Linux
  WebKitGTK/Chromium — so **target only standard, cross-engine web APIs**. Chromium-only
  surfaces are unavailable on macOS: Region/Element Capture (`CropTarget`,
  `RestrictionTarget`, `MediaStreamTrack.cropTo/restrictTo`), `getViewportMedia` and
  reliable `getDisplayMedia` self-capture all probed `false` / capture the whole app
  window. When you need a browser API, assume WebKit-grade support and verify
  cross-engine before relying on it.
- **Same-origin preview proxy (the key dev-server trick)**: the canvas server
  (`src/server.ts`) serves the UI under the base path `/__cockpit/` and **reverse-proxies
  every other path to the running dev server** (`controller.dev.url`). So the preview
  iframe loads `http://127.0.0.1:<port>/…` — the *canvas origin* — not the dev server's
  own host:port. That makes the iframe **same-origin** with the canvas, which is what
  lets "Fix with Copilot" capture just the website (no `getDisplayMedia`, no OS prompt):
  - The proxy strips `content-security-policy*` + `x-frame-options` (so framing +
    injection work), requests `identity` encoding, and injects two `<script>`s into
    proxied HTML before `</head>`: the vendored rasterizer + `public/preview-capture.js`.
    It also proxies `upgrade` (WebSocket) requests so dev-server HMR keeps working.
  - Capture flow: `#dev-fix` → parent `postMessage({type:'cockpit:capture'})` to the
    iframe → `preview-capture.js` rasterizes `document.documentElement` with snapdom →
    PNG dataURL → reply → existing crop overlay (rectangle + prompt) → POST
    `/api/dev/screenshot` (unchanged). Full document height is captured, not just the
    viewport. URL bar shows the *real* dev URL; `app.js` maps real↔proxy
    (`toProxy`/`toReal`) for navigation, reload and open-external.
  - Limits: proxy fidelity is scoped to dogfooding the project's own Astro site —
    dev servers that hard-code their absolute origin, exotic auth/cookies, or non-HTTP
    HMR may not round-trip; the manual URL bar + open-external still work.
- **Vendored client lib exception**: the UI is otherwise dependency-free vanilla JS, but
  `public/vendor/snapdom.min.js` (SnapDOM, MIT, self-contained, no sub-deps) is a
  deliberate, user-approved exception — it's the in-page rasterizer for the capture flow
  above. It's git-ignored from Biome (`!public/vendor` in `biome.json`) and not
  type-checked (`tsconfig.client.json` only includes `public/app.js`). Keep new client
  libs out unless there's an equally strong reason; if you add one, vendor a single
  self-contained file here and document why.
- **Settings persist server-side** in `~/.cockpit/settings.json` (keyed by project
  path), NOT in iframe `localStorage` — each canvas open gets a fresh loopback port,
  changing the origin and wiping `localStorage`. See `src/settings.ts`. The schema
  carries `theme`, `pinnedTasks`, plus the tab/auto-run prefs: `tabOrder` (string[] of
  tab ids, or `null` → materialized to the default order), `hiddenTabs` (string[]), and
  `autoLint`/`autoTest`/`autoDeps` (booleans, **default ON** — only an explicit
  persisted `false` disables them). `migrate()`/`saveSettings()` sanitize
  ids against `KNOWN_TABS` and coerce booleans; the client fetches them via
  `GET /api/settings` (not in `getState()`) and persists patches via `POST /api/settings`.
  `applyTabLayout()` in `app.js` reorders `#tabs` buttons and `.tab-hidden`-toggles
  hidden ones (≥1 must stay visible); reorder is HTML5 drag-and-drop in the panel.
- **Native test watch** (Tests tab Watch switch → `POST /api/test/watch {on}`): a
  persistent runner process like the dev server, NOT a one-shot. `resolveTestWatch()`
  (`lanes.ts`) only supports **vitest** (`--watch` + json `--outputFile`, first-class /
  dogfooded), **jest** (`--watchAll --json --outputFile`) and **node** (`--test --watch`,
  TAP re-parsed from the lane buffer); mocha/bun/script report `unavailable`. The
  controller fs-watches the json outputFile (vitest/jest) or debounce-reparses the TAP
  buffer (node) on each run and emits `test:report` + `test:watch`. A one-shot `runTests`
  is guarded off while watch is active; `extension.ts onClose` tears the watch down.
- **Auto-run on load**: when `autoLint`/`autoTest`/`autoDeps` are on, the controller runs
  those lanes **once per project path** (`_autoRanFor` set, keyed by cwd so a shared
  process can serve several projects) after the first project detection, only for
  available lanes (`runAutoTasks()` in `controller.ts`). It sets `_autoRunning` so the
  `lane:start` events carry `auto: true`; the client then populates results/badges
  **without** switching the active tab (explicit user runs still switch).
- **Lane availability**: each `resolve*()` in `lanes.ts` reports `{unavailable}`;
  `laneAvailability(d)` aggregates it onto `detection.availability` so the UI hides
  lanes/tabs that don't apply.
- **Tasks dropdown model** (`#scripts-menu`, `classifyTasks()`/`renderScriptsMenu()` in
  `app.js`): one list in **package.json declared order** — no separate Tasks/Scripts
  groups. The "special" built-in tasks are **build / lint / format / test** (`LANE_TASKS`);
  each binds to its first present candidate script (`LANE_CANDIDATES`, mirroring
  `lanes.ts` `laneScript()`/`pickScript`). A script that backs a special is shown
  **bold with an accent star octicon (`oct-star-fill`) after the name** and runs/pins
  as the **lane** (no duplicate lane/script row); built-in specials with no backing script (e.g. Lint/Format via Biome)
  are listed as script-less specials **at the top**. Other same-family scripts
  (`lint:fix`, `format:check`, `test:watch`) stay ordinary. `defaultPinnedTasks()`
  (`lanes.ts`) follows the same order. **Type-check is no longer a promoted task** — the
  Problems tab (TS language server) supersedes it, so a `typecheck`/`tsc` script just runs
  as an ordinary script. `LANE_TASK_ORDER` dropped `typecheck`; `resolveTypecheck`/
  `availability.typecheck` are kept only for the agent action + `/api/lane` back-compat.
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
- **Linter diagnostics (`lint-report.ts` → Problems tab, merged with TS)** — the Problems
  panel shows **both** TypeScript and lint findings, grouped by file:
  - **Separate from the Console lint lane.** `lanes.resolveLintJson()` resolves a
    machine-readable JSON command (`biome lint --reporter=json .`, `eslint . --format json`,
    or `oxlint --format=json`); `lint-report.ts` parses it into the shared `Diagnostic[]`
    shape (`source:"lint"`, absolute paths, `rule` = lint rule id, `code:null`). The
    human-readable lint *lane* that feeds the Console is unchanged.
  - **Parse `res.stdout`, not `res.output`.** `process-runner.run()` now returns `stdout`
    and `stderr` separately precisely so linter stderr notices don't corrupt JSON parsing.
    Non-JSON stdout ⇒ lint `error` state (linter misconfig), not a crash.
  - **Severity → category**: error→error, warn→warning, everything below (info/hint)→
    `suggestion`. Suggestions render as low-priority rows and **don't drive the tab badge**
    (badge = errors else warnings, summed across TS + lint).
  - **Shares the TS fs watchers + idle timer.** `refreshLint()` calls `setupTsWatchers()` +
    `resetTsIdle()`, and `onTsFsEvent` schedules a debounced re-lint, so lint-only projects
    still get live updates. Overlapping runs are coalesced (`_lintRunning` + `_lintDirty`).
  - **Availability is independent.** The Problems tab shows when `availability.diagnostics`
    **or** `availability.lint` is true; each source degrades on its own. SSE events
    `lint:status` / `lint:diagnostics` mirror `ts:status` / `ts:diagnostics`.
  - **Fix prompts are source-aware.** `buildDiagnosticFixPrompt` tags each line `TS####` or
    `lint(<rule>)` and says "TypeScript", "lint", or "TypeScript + lint"; `fixAllDiagnostics`
    merges both lists.

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
   exercise the affected flow via the UI or `invoke_canvas_action`. For UI work,
   check it at **small panel widths** too (see the responsive rule in Conventions).
4. **Rubber-duck review**: after a set of changes passes the checks and canvas
   verification — and before declaring the work done — run a `/rubber-duck` review of
   the changes and address its findings. If Rubber Duck was run, make sure to mention it in the final message with a dedicated section including a brief summary of what it caught and fixed.
5. CI (`.github/workflows/ci.yml`) runs the same checks on Node **22.18** (the
   supported floor) and **24**.

> **Never `git commit` or `git push` without explicit human review and validation
> first.** Leave changes staged/working and hand them to the maintainer; they review,
> validate in the app, and commit. Conventional Commits when they do.

## Conventions

- Conventional Commits (applied by the human at commit time).
- TypeScript, ESM (`type: module`), Node ≥ 22.18, Biome-formatted, MIT licensed,
  author Yohan Lasorsa.
- **Responsive UI**: the canvas renders in a side panel the user can resize and dock
  narrow, so every UI must stay usable at small widths — nothing clipped or cut off by
  horizontal overflow. Let content wrap, scroll, or collapse into a menu instead. The
  canonical example is the tab bar: tabs that don't fit collapse into a trailing `⋯`
  (More) overflow menu (`recomputeTabOverflow()` in `public/app.js`). When changing the
  UI, verify it at a narrow panel width, not just wide.

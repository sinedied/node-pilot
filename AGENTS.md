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
    `fix.ts` (prompt builders), `settings.ts` (per-project pinned tasks + theme),
    `update.ts` (SDK-free self-update check: semver compare + GitHub Releases fetch +
    `package.json` meta read + the self-update prompt builder, see "Self-update" below),
    `cdp.ts` (zero-dep Chrome DevTools Protocol client) + `debug.ts` (`DebugSession`:
    the agent-facing Node.js debugger — launch/attach, breakpoints, stepping, inspect),
    `projects.ts` (`enumerateProjects(root)` — monorepo / multi-root discovery powering
    the header project selector, see gotcha below),
    `rayfin.ts` (Microsoft Rayfin BaaS dashboard: detection + offline read of
    `rayfin/` files — rayfin.yml / .deployments.json / .env / dab-config.json /
    schema.ts — + allow-listed `rayfin` CLI lanes; one deliberate agent action
    (`rayfin_new_project`), see below).
- `types/copilot-sdk.d.ts` — ambient shim for `@github/copilot-sdk/extension` so `tsc`
  resolves it in CI (the real package only exists inside the Copilot app).
- `public/` — vanilla HTML/CSS/JS UI (Info / Preview / Rayfin / Tests / Problems /
  Dependencies / Debugger / Console tabs — that's the **default order**; Rayfin is
  **conditional**, shown when a Rayfin project is detected (like Preview/Tests/Problems)
  **or** when there's no Node project at all (the create-new-project intro state);
  users reorder/hide tabs and toggle
  auto-run via a gear-launched **Settings** panel, `#tab-settings`, which is not itself
  a tab in `#tabs`),
  GitHub Primer light/dark theming + inline Octicon sprite (MIT, bundled, no network).
  The Rayfin tab/header uses a bespoke `oct-rayfin` symbol (derived from the user's brand
  glyph: a leaping salmon) kept at its native `viewBox="0 0 24 24"` — the only non-16×16
  symbol. It's simplified for legibility at the 14px tab size: just the body **outline**
  (`fill="none" stroke="currentColor" stroke-width="2"`, `linejoin/linecap="round"`) plus a
  solid dot eye (`<circle r="1.8">`). The original `@`-eye, fin detail, and the forked belly
  notch were dropped (and the stroke bumped to 2) because they muddied into a blob / read
  thin at 14px; the path is also inset ~1.6u from the viewBox edges so the 2u stroke on the
  snout/tail isn't clipped. The API-endpoint row keeps `oct-server` (semantically a server,
  not the brand).
  `public/app.js` stays JS, type-checked via `tsconfig.client.json` (`checkJs`).
  Lane/action buttons use `.lane-btn`, which carries a fixed `min-height` + `line-height: 1`
  and a 14×14 `.oi` so icon and text-only buttons line up at the same height — don't
  reintroduce per-button height drift when adding new ones.
  `public/preview-capture.js` is the capture bridge injected into the proxied preview;
  `public/vendor/snapdom.min.js` is the vendored rasterizer it uses (see gotcha below).
- `test/` — Vitest specs (`core.test.ts`, `deps.test.ts`, `info.test.ts`,
  `settings.test.ts`, `ts-server.test.ts`, `update.test.ts`). `scripts/smoke.mjs`
  dynamically imports every SDK-free `src/*.ts` to prove native type-stripping loads.
- `biome.json` — Biome config (lint + format, replaces Prettier). `noImportantStyles`
  is off (the cursor/spinner `!important` rules are deliberate, see gotcha below).
- `docs/site/` — a self-contained Astro + Starlight docs site (its own
  `astro.config.mjs` + `src/`), run via `astro --root docs/site`, so it never
  touches the extension's own `src/` or `public/`. It exists to **dogfood**
  Cockpit's own Dev lane (`npm run dev` → Astro detected → `localhost:4321`
  preview) and web Build (`npm run docs:build`). Edit docs content under
  `docs/site/src/content/docs/`. **astro 7 + `@astrojs/starlight` 0.41.x**: upgraded
  from astro 6 once Starlight shipped astro-7 support (0.41.1 peer-requires `astro ^7.0.2`
  and pulls `@astrojs/mdx@^7` + `astro-expressive-code@^0.44`). astro + starlight are
  **mutually peer-coupled** — bump them together, and after any change verify BOTH
  `npm run docs:build` AND `npm run dev` (the `npm run check` suite does NOT exercise the
  docs site). Cockpit's own `update_dependencies` can't do this coupled bump (its
  per-package bisection rolls them back independently) — upgrade them by hand with a clean
  resolve (`rm -rf node_modules package-lock.json && npm install`).
- `.github/extensions/cockpit/extension.mjs` — dog-food wrapper that imports the
  root `extension.mjs` so the repo runs the extension against itself.
- `e2e/` — **permanent dogfood fixtures**, its own npm **workspace root**
  (`package.json` with `workspaces:["*"]`, name `cockpit-e2e`) kept **out** of
  Cockpit's own install/lockfile so fixture deps never pollute Cockpit's
  Dependencies/Audit tab. **Two Rayfin fixtures** (see the Rayfin gotcha for the split):
  `e2e/rayfin-app/` (`rayfin-mock-app`) is the **offline mock** — committed real-schema
  `rayfin/` files (`fabric*` `.deployments.json` + nested-provider `rayfin.yml` + `.env` /
  `dab-config.json` / `data/schema.ts` / `functions/`) so the **Rayfin tab renders fully
  offline** (no Docker/Fabric/login/install); `e2e/rayfin-todo-app/` (`rayfin-todo-app`) is
  the **real, deployable** app (the official `todo-app-template`: real `@microsoft/rayfin-*`
  deps, Vite + React) kept as **source only** for hands-on deploy testing. Both excluded from
  Biome via `"!e2e"` in `biome.json`; tsconfig/vitest/smoke already scope to
  `src`/`public`/`test`. Dogfood by opening a Cockpit session at `e2e/rayfin-app/` (→ offline
  Rayfin tab), `e2e/rayfin-todo-app/` (→ real deploy/login flow) or `e2e/` (→ monorepo
  detection signal). Mock dotfiles contain **only fabricated** values — never real secrets.
- `.github/workflows/ci.yml` — CI (`biome ci .` → build → smoke → test) on Node 22.18 & 24.
- `.github/workflows/release.yml` + `.releaserc.json` — semantic-release pipeline that cuts
  GitHub Releases on push to `main` (the Releases the self-update check reads back; see
  "Self-update & release pipeline").

## Critical gotchas

- **Working directory & the root/active split**: the extension process `cwd` is NOT
  the project root (`~/.copilot`). The host session path comes from
  `ctx.session.workingDirectory` on every canvas `open`/action. The controller tracks
  **two** paths: `root` (the host session dir) and `cwd` (the **active project**, which
  may be a monorepo member the user focused). `Controller.ensureProjectDir(dir)` anchors
  + re-detects and is called first by every wrapped action handler; it re-roots only on a
  genuine host-dir change (and **fully tears down** the old project — dev/test-watch/
  tsserver/debug + `resetProjectState()` — before re-anchoring). On first init or a root
  change it picks the active dir via `resolveActiveDir()`: the **persisted focus**
  (`settings.activeProject`) if it still exists, else the root when the root is itself a
  project, else the first discovered project (a container root with no `package.json`),
  else the root. Project transitions are serialized by a `_transition` gate so a
  concurrent action can't read a half-applied `cwd`/`detection` mid-switch. Never rely on
  `process.cwd()` for the project.
- **Monorepo / multi-project selector**: `src/projects.ts` `enumerateProjects(root)`
  discovers selectable projects under the session root: npm/yarn `workspaces` globs +
  `pnpm-workspace.yaml` `packages:` globs (block-list **and** inline flow-array forms;
  quote-aware comment stripping; each resolved member must contain a `package.json`),
  **plus** Rush `rush.json` `projects[].projectFolder` members (JSONC, comment-stripped),
  **plus** a bounded depth-2 scan for other standalone `package.json`
  dirs (excluding `node_modules`/`dist`/`build`/`coverage`/`.next`/`.astro`/fixtures/
  examples/etc.), de-duped. `!`-negation globs are applied as exclusions (to members
  **and** the scan), and any dir escaping the root via `..` is dropped. The root is
  always selectable when it's itself a project (group = root pkg name);
  members group under the root header; standalone scanned dirs group under
  "Other projects" (or, when the root has no `package.json`, directly under the container
  folder name). The header **project selector** (`#project-wrap`, left-most in the
  toolbar with a `.sep` divider) is **conditional** — shown only when `multi` (≥2
  projects), mirroring the Rayfin/Preview gating. Selecting a project calls
  `controller.setActiveProject(dir)`: it validates `dir` against the enumerated list
  (rejects arbitrary paths), stops the previous project's cwd-bound subsystems
  (dev/test-watch/tsserver/debug), `resetProjectState()`, repoints `cwd`, persists the
  choice under the **root**'s settings (`activeProject`), re-`init()`s, then broadcasts a
  full `snapshot`. Routes: `GET /api/projects` (→ `ProjectsState { root, active, multi,
  projects }`, fetched on client boot **and on every SSE (re)connect** since the connect
  `snapshot` omits projects), `POST /api/projects/select { dir }`; ongoing
  updates ride the `projects` SSE event. `get_status` carries a read-only `projects`
  block (active + list) so the agent knows the focus; there is **no agent action to
  switch** (human-facing only, like Rayfin). **Deps caveat**: install/audit/outdated
  conventionally run at the workspace root (single root lockfile); focusing a member runs
  deps ops in that member dir via the uniform chdir model — root focus gives canonical
  deps behavior.
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
- **Vendored client libs (deliberate exceptions)**: the UI is otherwise dependency-free
  vanilla JS, but three self-contained MIT files live under `public/vendor/`:
  `snapdom.min.js` (SnapDOM — in-page rasterizer for the capture flow above),
  `cytoscape.min.js` (Cytoscape.js v3.x — graph engine for the Rayfin data-model **Graph**
  view, **lazy-loaded** via an injected `<script>` only when Graph is first opened, so the
  ~435 KB never blocks canvas startup) and `cytoscape-fcose.min.js` (the fcose
  force-directed layout extension, bundled self-contained with its cose-base/layout-base
  deps via esbuild; lazy-loaded right after the core and registered with `cytoscape.use()`,
  with a built-in `cose` fallback if it fails to load). All are git-ignored from Biome
  (`!public/vendor` in `biome.json`) and not type-checked (`tsconfig.client.json` only includes
  `public/app.js`);   each carries a provenance header (source/version/license). Refresh cytoscape by
  re-copying its dist from the `cytoscape` `devDependencies` entry; refresh fcose by
  re-bundling the `cytoscape-fcose` devDependency (`esbuild <entry-in-project>.mjs --bundle
  --minify --format=iife` with an entry that does `import fcose from "cytoscape-fcose";
  window.cytoscapeFcose = fcose;`); snapdom is vendored
  by hand from its upstream release (no devDependency). Keep new client libs out unless there's an equally strong reason; if you add
  one, vendor a single self-contained file here and document why.
- **Settings persist server-side** in `~/.cockpit/settings.json` (keyed by project
  path), NOT in iframe `localStorage` — each canvas open gets a fresh loopback port,
  changing the origin and wiping `localStorage`. See `src/settings.ts`. The schema
  carries `theme`, `pinnedTasks`, plus the tab/auto-run prefs: `tabOrder` (string[] of
  tab ids, or `null` → materialized to the default order), `hiddenTabs` (string[]), and
  `autoProblems`/`autoTest`/`autoDeps` (booleans, **default ON** — only an explicit
  persisted `false` disables them; `autoProblems` was formerly `autoLint`, migrated
  by `migrate()` honoring the legacy key). `migrate()`/`saveSettings()` sanitize
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
- **Auto-run on load**: when `autoProblems`/`autoTest`/`autoDeps` are on, the controller
  primes those tabs **once per project path** (`_autoRanFor` set, keyed by cwd so a shared
  process can serve several projects) after the first project detection, only for
  available tools (`runAutoTasks()` in `controller.ts`). `autoProblems` primes the
  **Problems** tab via the live-diagnostics path — `getLintDiagnostics()` + `getDiagnostics()`
  (NOT the lint *lane*) — so `this.lint`/`this.tsLs` populate the boot snapshot and broadcast,
  making the Problems pill show on load/after reload. It sets `_autoRunning` so the
  `lane:start` events carry `auto: true`; the client then populates results/badges
  **without** switching the active tab (explicit user runs still switch).
  **`init(force)` vs the `_autoRanFor` guard (the project-switch revisit bug):**
  every path that calls `resetProjectState()` (it wipes `this.deps`/`lint`/`tsLs`/`test`)
  must re-prime via `init(true)`, because `_autoRanFor` is a once-per-cwd-per-process set
  that is **never cleared by reset**. Without the force, switching **back** to an
  already-visited project (A→B→A) clears the caches but the guard skips `runAutoTasks()`,
  leaving the Problems/Deps pills empty until a manual refresh. So:
  `setActiveProject()` → `init(true)`; `ensureProjectDir()` root-change branch →
  `init(rootChanged)`; first-ever detection of a root stays `init(false)` so the guard
  still dedups concurrent canvas opens of the same root. Rule of thumb: **`_autoRanFor`
  only dedups redundant re-detection of the *same* live project; any reset → `init(force)`.**
- **`_projectGen` — stale-result guard for fire-and-forget tasks**: because `init(true)`
  now re-runs the on-load tasks on **every** switch and `runAutoTasks()` is fire-and-forget,
  a slow run started for project A (e.g. `npm audit`, `npm outdated`, a test run, tsserver
  analysis) could finish **after** the user switched to B and publish A's results into B's
  pills. `_projectGen` is a counter bumped in `resetProjectState()` (the single choke point
  for both switch paths). Each result-publishing method captures it before its `await` and
  **discards the write/broadcast if it changed mid-run**: `deps.listOutdated`/`deps.runAudit`
  (before writing `controller.deps.*`), `runTests` (before `this.test.report = …`), and
  `refreshDiagnostics` (before `setTsState`). It's the deps/test/TS analogue of `_lintGen`
  (which `runLintLoop` already uses, bumped in `stopTsServer`). When adding any new
  fire-and-forget task that mutates per-project state, capture `_projectGen` at entry and
  gate the publish the same way.
- **Lint is a Problems-tab concept**: clicking the **Lint** task (dropdown row or pinned
  button) focuses/refreshes the **Problems** tab (`runTask()` → `showTab("problems")`),
  it does NOT run the lint lane into the Console. The lint *lane* (`/api/lane {id:"lint"}`,
  in `CONSOLE_LANES`) is kept for back-compat (agent action).
- **Lane availability**: each `resolve*()` in `lanes.ts` reports `{unavailable}`;
  `laneAvailability(d)` aggregates it onto `detection.availability` so the UI hides
  lanes/tabs that don't apply.
- **Tasks dropdown model** (`#scripts-menu`, `classifyTasks()`/`renderScriptsMenu()` in
  `app.js`): one list in **package.json declared order** — no separate Tasks/Scripts
  groups. The "special" built-in tasks are **build / lint / format / test / e2e**
  (`LANE_TASKS`); each binds to its first present candidate script (`LANE_CANDIDATES`,
  mirroring `lanes.ts` `laneScript()`/`pickScript`). A script that backs a special is shown
  **bold with an accent zap octicon (`oct-zap`) after the name** and runs/pins
  as the **lane** (no duplicate lane/script row); built-in specials with no backing script (e.g. Lint/Format via Biome)
  are listed as script-less specials **at the top**. Other same-family scripts
  (`lint:fix`, `format:check`, `test:watch`) stay ordinary. `defaultPinnedTasks()`
  (`lanes.ts`) follows the same order. **Type-check is no longer a promoted task** — the
  Problems tab (TS language server) supersedes it, so a `typecheck`/`tsc` script just runs
  as an ordinary script. `LANE_TASK_ORDER` dropped `typecheck`; `resolveTypecheck`/
  `availability.typecheck` are kept only for the agent action + `/api/lane` back-compat.
  **E2E lane**: `resolveE2e` is a **Console** lane (`playwright test` or an `e2e`/`test:e2e`
  script), available only when `@playwright/test` is detected (`d.playwright`); pinnable
  like the other specials, `run_e2e` agent action. Deliberately **not** a Tests-tab suite —
  Playwright's JSON report has its own schema (no parser), so it streams like build/lint.
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
    `oxlint --format=json`, or `xo --reporter json` → reuses the eslint parser since XO emits
    ESLint JSON); `lint-report.ts` parses it into the shared `Diagnostic[]`
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
- **Dependencies tab = two sections, each self-refreshing + agentic actions** (`deps.ts`, `fix.ts`, `#tab-deps`):
  - **Per-section refresh**: each section header has its own icon refresh button —
    `#deps-updates-refresh` → `/api/deps/outdated` (`listOutdated()`), `#deps-audit-refresh` →
    `/api/deps/audit` (`runAudit()`). The tab pill (`#deps-badge`, `renderDepsBadge()`) shows
    outdated + vuln counts (red on high/critical) and populates on load via `autoDeps` (which calls
    `listOutdated`/`runAudit` directly, carried in the boot snapshot).
  - **Updates section**: outdated table with **one** changelog-priority link per row
    (Changelog → Repo → npm fallback), built offline from `node_modules/<pkg>/package.json`
    (`buildDepLinks()` / `normalizeRepoUrl()`; GitHub → `/releases`). dev/prod badge is classified
    from the project `package.json` via `readDevSet()` (npm `outdated --json` has **no** type field).
    Checkboxes show in **both** modes with a header select-all (all updatable pre-selected); Target is
    **Default** (selected → in-range `wanted`) vs **Latest** (selected → `latest`). **Update with Copilot**
    (`/api/deps/update {mode,packages}` → `sendCopilotUpdate()`) resolves targets from the picked
    packages and sends a chat prompt (`buildDepsUpdatePrompt`); the agent drives `update_dependencies`
    (verify **build + lint + test**, auto-rollback) then `audit`, reverting anything that introduces a
    **new high/critical** advisory.
  - **Security section**: severity pills live in the section header; per-package vulnerability table
    (severity, range, fix target/major, advisory links from npm `via[].url`, parsed by exported
    `parseAudit()`). **Fix with Copilot** (`/api/deps/audit-fix` → `sendCopilotAuditFix()`) is an
    **`audit fix`-first, verify-gated** orchestrator: if the PM supports it (`supportsAuditFix()`:
    npm/pnpm/yarn, **not bun**) and there are fixable advisories, it runs `deps.safeAuditFix()` —
    snapshot manifest+lock, stream `pm.auditFix(pm)` (semver-safe, **never `--force`**) to the
    **"update" lane**, run `defaultVerify()` (build+lint+test); **auto-rollback** if any step breaks
    (mirrors `update_dependencies`). It then re-audits and **only escalates to Copilot for what
    remains** (`buildDepsAuditFixPrompt` over the still-fixable vulns); if `audit fix` resolved
    everything it does **not** ping chat. `npm audit fix` exits non-zero when vulns remain even on
    success, so the **verify suite — not the exit code — is the gate.** The richer result
    (`{ok,ran,rolledBack,fixed,remaining,escalated}`) drives the `#deps-audit-fix` toasts.
  - `defaultVerify()` is **build + lint + test** (no typecheck — the Problems tab covers types).
    The in-process `safeUpdate()` loop stays as the engine the `update_dependencies` action calls;
    the buttons no longer run it directly — they hand off to the agent.

- **Debugger tab = agent-facing Node.js debugger over CDP** (`cdp.ts`, `debug.ts`, `#tab-debugger`):
  - **Zero deps**: speaks the Chrome DevTools Protocol over Node 24's global `WebSocket` + `fetch`
    (`CdpClient` = JSON-RPC + `/json/list`). No `ws`, no `chrome-remote-interface`.
  - **The priority is the agent surface**: 16 `debug_*` actions in `actions.ts` (start/attach/stop,
    set/remove/list breakpoints, continue/pause/step over·into·out, `debug_wait_for_pause` — the
    blocking primitive for agentic step loops — get_stack/get_variables/get_properties/evaluate/get_state).
    Each returns structured JSON; the UI (`renderDebugger*` in `app.js`, `/api/debug/*` in `server.ts`,
    `debug:*` SSE events) is just a second consumer of the same `DebugSession`.
  - **Launch** = `node --inspect-brk=127.0.0.1:0 <program>` (parse the `Debugger listening on ws://…`
    line from stderr — no port race); **attach** = `fetchTargets(host, port)`. Never inject `--inspect-brk`
    into `npm run …` (npm grabs the port) — launch `node` directly or **attach** to a `--inspect` process.
  - **Node quirks baked in**: `CallFrame.url` is empty, so files are resolved from a `scriptId→url` map
    built from `Debugger.scriptParsed`. CDP lines are 0-based (converted to 1-based). On macOS `/tmp` is a
    symlink to `/private/tmp`, so a breakpoint's `file://` URL must match the real path to bind.
    `stopOnEntry` defaults **true** (deterministic agent control); when false the entry break auto-resumes
    *unless* a user breakpoint resolved to the entry line. Resume/step clear `paused` synchronously so a
    follow-up evaluate can't reuse stale call-frame ids. A monotonic `gen` token guards against a slow,
    superseded `start()` tearing down a newer session. Browser debugging is **Phase 2** (deferred).
- **Rayfin tab = human-facing dashboard, deliberately NOT an agent surface** (`rayfin.ts`,
  `#tab-rayfin`): the opposite stance to the Debugger. Microsoft Rayfin ships its own MCP
  (`@microsoft/rayfin-mcp`) + CLI + agent skills, so duplicating `rayfin` commands as
  `rayfin_*` agent actions would be redundant. Instead the tab reads `rayfin/` files
  offline (`readRayfinState`: rayfin.yml → config, `.deployments.json` → Fabric workspace +
  `dab-config.json`/`schema.ts` → data-model viewer (a **List | Graph** toggle: a two-pane
  list/detail on the List side, a Cytoscape node-link diagram of entities + relations on
  the Graph side — see the vendored-lib note above),
  `.env` → public vars, `functions/` + connectors) and its buttons run **allow-listed**
  `rayfin` CLI commands as Console **lanes** (`rayfin:<cmd>`, via `npm exec -- rayfin …`),
  streamed like build/lint. The Fabric-workspace switcher is a **custom popover dropdown**
  (`#rf-switch-toggle` + `#rf-switch-menu`, mirroring the project selector) — not a native
  `<select>` — so it matches the rest of the chrome. `validateRayfinArgs` gates an
  **exact-command** allow-list
  (`SAFE_ARG` regex + `ALLOWED_COMMANDS` set of full argv shapes) — not just a first-verb
  check — because the same-origin preview proxy makes `/api/rayfin/cli` reachable from
  proxied dev-server content; `up switch <name>` is separate (the target is validated
  against the known deployment list, then spawned as one argv element).
  **Deploy** (`POST /api/rayfin/deploy` → `deployRayfinWorkspace()`): the **not-deployed**
  empty state renders a workspace input (`#rf-deploy-workspace`); its value picks the `rayfin
  up` flag by **shape** (`rayfinWorkspaceFlag()`: portal URL → `--workspace-uri`, bare GUID →
  `--workspace-id`, else display name → `--workspace`) and is passed as a **single argv
  element** (injection-safe), so — like `up switch` — it bypasses the generic `SAFE_ARG`
  allow-list (which can't express names-with-spaces). Blank input redeploys to the default
  workspace. Deploys always append **`-y`** because the Console lane is **non-interactive**
  (would otherwise hang on the confirmation prompt). The header Deploy button (`data-rf-deploy`)
  and the empty-state input share this one endpoint.
  **Two deliberate agent touchpoints** (everything else stays human-facing): (1) a
  read-only `rayfin` block on `get_status` (detected? dialect, auth methods, signed-in,
  active workspace, app/portal URLs) — detection state, not a CLI duplicate; and (2) the
  **`rayfin_new_project`** action (`actions.ts`) — **always available, even with no project
  open** — which calls `controller.startRayfinProject()` →
  `sendToChat(<src/prompts/rayfin-start.md>)`, handing Copilot the canonical scaffold
  prompt. The same flow backs `POST /api/rayfin/start`, wired to the **intro/empty state**
  the tab shows when there's **no Node project at all** (`#rf-intro`: what Rayfin is + a
  "Create new Rayfin project" button + docs links; the CLI-driven `#rf-detected` block is
  hidden). Tab visibility: shown when a Rayfin project is detected **or** when there's no
  project at all; hidden for a non-Rayfin Node project (where only the agent tool applies).
  Detection (`detectRayfin`) is
  cheap (rayfin.yml or `@microsoft/rayfin*` deps → `Detection.rayfin`); the full dashboard
  is lazy (`/api/rayfin/state`, cached in `controller._rayfin`, invalidated on detect +
  after every CLI lane). Never surface secrets — only public IDs/URLs from
  `.deployments.json`/`.env`. **Sign-in is resolved by the CLI, not a file check**: the
  controller runs `rayfin login status` (`probeRayfinSignedIn` → `rayfinLoginStatusArgv` +
  `interpretLoginStatus`) when (re)building the cached dashboard model. The CLI is the
  source of truth because credentials can live in a **global** store (`~/.rayfin/auth.json`),
  not project-local — the old `existsSyncSafe(<project>/rayfin/.rayfin/auth.json)` check gave
  a false "Signed out". The probe is **gated on `hasLocalRayfinBin(cwd)`** (walks up
  `node_modules/.bin/rayfin{,.cmd}` for hoisted monorepos) so it only spawns when the CLI is
  installed — never hitting the registry or prompting — and is **timeout-bounded (~5s, child
  killed)**. It's **tri-state**: exit 0 → signed in, exit > 0 → signed out, any
  error/timeout/missing-CLI → **`auth.signedIn = null` ("Unknown")** — never collapsed to a
  false "Signed out". npm still passes `--no` (belt-and-suspenders against any prompt/fetch).
  The client chip renders Signed in / Signed out / Unknown accordingly.
  - **Grounded in the real `@microsoft/rayfin-cli`, not the mock.** The model reads the
    **real on-disk schemas**: `.deployments.json` records are `fabric*`-prefixed
    (`fabricItemId` / `fabricApiUrl` / `fabricWorkspaceId` / `fabricTenantId` /
    `fabricDeepLink` / `hostingUrl`), mapped to the client `RayfinDeployment` aliases
    (`itemId`/`apiUrl`/`workspaceId`/`tenantId`/`portalUrl`/`hostingUrl`) with the
    un-prefixed names kept as a **fallback** for hand-written fixtures. → **Open app** =
    `hostingUrl`, **Open Fabric workspace** = `fabricDeepLink` (else `portalUrl`, else a URL
    composed from the workspace GUID), **API endpoint** = `fabricApiUrl`. Reading only the
    legacy names was the bug where a real deploy showed *only* "Open app". `rayfin.yml` auth
    methods derive from the **nested provider blocks** (`auth.fabric.enabled` /
    `auth.password.enabled` / `auth.email.enabled`), with the flat `auth.methods:` list as a
    fallback (`parseAuthMethods`).
  - **`ALLOWED_COMMANDS`** lists only real, still-wired shapes: `login`, `logout`, `up`,
    `up status`, `up db apply`, `functions typegen`, `connector list`, `init ai-files
    install`. The fabricated `dev start`/`dev stop`/`dev status`/`dev db apply` and the old
    `ai-files` shape were dropped — `rayfin dev` is a **Docker-based local backend** that
    Cockpit doesn't surface yet.
  - **Local-dev is hidden, not removed (Item 1).** Local-with-remote-backend isn't wired, so
    the `dev stop` / `dev status` / `dev db apply` ("Apply to local") buttons carry a plain
    `hidden` attribute in `index.html` (kept for when it lands). **"Start local"**
    (`#rf-start-local`) is repurposed to launch the project's dev server — it calls
    `/api/dev/start` + `showTab("preview")`, exactly like the Preview tab's Start.
  - **Agent files (Item 5):** `hasRayfinAgentFiles()` checks the CLI's `rayfin/.lockfile.json`
    marker (falls back to `AGENTS.md` + `.mcp.json`). The "Set up agent files" button runs the
    real `init ai-files install` lane, uses a non-Copilot icon (`oct-tools` — it's a CLI
    action), and is **hidden once `hasAgentFiles` is true** (`renderRayfin`).
  - **Add + switch workspaces (Item 3):** the switcher menu (`renderRayfinSwitchMenu`) ends
    with an **"+ Add workspace…"** item that swaps in an inline target input
    (`showRayfinAddWorkspaceForm`) and hands off to the same `POST /api/rayfin/deploy
    { workspace }` path as the header Deploy button (the server picks `--workspace` /
    `--workspace-id` / `--workspace-uri` by value shape). The toggle is enabled with ≥1
    deployment (the first deploy still goes through the header Deploy button / empty state).
  - **Version + self-update (Item 6):** `readInstalledRayfinVersion(cwd)` reads the installed
    version offline from `node_modules/@microsoft/rayfin-cli` (fallback `-core`, walks up for
    hoisted monorepos), surfaced as `RayfinState.cli.installed`. `src/rayfin-update.ts`
    (SDK-free, unit-tested, mirrors `src/update.ts`) checks the **npm registry**
    (`registry.npmjs.org/@microsoft/rayfin-cli/latest`, 5s timeout, injectable fetch, every
    failure non-fatal → `error:true`, never a false "update available"). The controller owns
    the network call + cache: `getRayfinUpdateInfo(force)` (6h throttle + in-flight guard +
    `_projectGen` stale-guard; merges the result into `_rayfin.cli` and broadcasts
    `rayfin:state`) and `sendCopilotRayfinUpdate()` (hands Copilot the version-locked
    `@microsoft/rayfin-*` bump-and-verify prompt via `buildRayfinUpdatePrompt`). Routes:
    `POST /api/rayfin/update/check` / `…/apply`. The header (`#rf-head`) shows `Rayfin vX.Y.Z`
    + an accent "update available" badge + a gradient **Update Rayfin** `.copilot-btn` (a
    recurring Copilot handoff — project-scoped, **not** `[data-global]`, unlike the
    extension self-update). The client fires the check once per installed version on Rayfin
    load (`cli.checkedAt == null`).
  - **Two e2e fixtures (Item 4):** `e2e/rayfin-app/` is the **offline mock**
    (`rayfin-mock-app`) — its committed `rayfin/` files now use the **real** schema
    (`fabric*` deployment fields + nested-provider `rayfin.yml`) so the offline render matches
    a real deploy (all three deployment links appear). `e2e/rayfin-todo-app/`
    (`rayfin-todo-app`) is the **real, deployable** app — the official `todo-app-template`
    (real `@microsoft/rayfin-*` deps, Vite + React), kept as **source only** (excluded from
    Cockpit's install/lockfile, biome, tsc, vitest, smoke). The two can't share a package name
    (same `e2e` workspace root), hence the mock's `rayfin-mock-app` rename. A deploy's
    `rayfin/.env` is auto-gitignored (`*.env*`); the mock's `.env` is already tracked.

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
> **Pushing to `main` triggers an automatic release** (semantic-release cuts a GitHub
> Release the self-update check reads back — see "Self-update & release pipeline"), so
> **only `git push` when the human explicitly says so** — never on your own initiative,
> even right after a commit they asked for.

## Conventions

- Conventional Commits (applied by the human at commit time).
- TypeScript, ESM (`type: module`), Node ≥ 22.18, Biome-formatted, MIT licensed,
  author Yohan Lasorsa.
- **Responsive UI**: the canvas renders in a side panel the user can resize and dock
  narrow, so every UI must stay usable at small widths — nothing clipped or cut off by
  horizontal overflow. Let content wrap, scroll, or collapse into a menu instead. The
  canonical example is the tab bar: tabs that don't fit collapse into a trailing `⋯`
  (More) overflow menu (`recomputeTabOverflow()` in `public/app.js`). When changing the
  UI, verify it at a narrow panel width, not just wide. Tab badges follow the overflow:
  `tabBadgeOf()` (keyed by `data-tab` → `#problems/#tests/#deps-badge`; Debugger has no
  badge) feeds both the dropdown items (each shows its own count) and `syncTabMoreBadge()`,
  which collapses hidden badges into a single **severity dot** on `⋯` (red > yellow > blue,
  no number — counts across tabs aren't summable).

## Self-update & release pipeline

Cockpit checks for newer releases of itself and lets Copilot apply the update; an
automated GitHub Actions pipeline cuts those releases. The two halves are coupled — the
update-check reads exactly the Releases the pipeline produces — so keep them in lockstep.

### Distribution repo

- **`sinedied/cockpit-js` is the distribution/canonical repo** (where releases are cut and
  read back). The dev repo is `node-pilot`. The update-check and `.releaserc.json` both
  assume `cockpit-js`. The local clone's remote may still say `node-pilot` → the GitHub
  repo must be renamed/pointed to `cockpit-js` for releases to land where the check looks.
- The slug is derived from `package.json` `repository`, falling back to the
  `DEFAULT_REPO_SLUG` constant in `src/update.ts`.

### Self-update feature

- **Source of truth = GitHub Releases.** `src/update.ts` (pure, SDK-free, unit-tested) does
  semver compare + `GET /repos/<slug>/releases/latest`. Any failure (offline / rate-limited
  / 404 no-releases / 5s timeout) returns `error: true` and **never** a false
  "update available" — the UI shows a quiet "Couldn't check for updates".
- **Mechanism = Copilot-assisted.** The extension can't reload itself; only the host/agent
  can `extensions_reload`. So "Update Cockpit.js" hands a crafted prompt (install dir,
  current→latest, release URL) to chat via `sendToChat` (`buildSelfUpdatePrompt`), mirroring
  `sendCopilotUpdate`. Never auto-apply — only on an explicit click.
- **Controller:** `version`/`repoSlug` come in via `ControllerOptions` (read once from
  `package.json` by `extension.ts` → `readPackageMetaSync()`), are exposed in `getState()`,
  and drive `getUpdateInfo(force)` (in-memory cache, ~6h throttle; `force` bypasses) +
  `sendCopilotSelfUpdate()`. Network checks are non-fatal and keep the last good result.
- **Routes:** `POST /api/update/check {force}` → `getUpdateInfo`; `POST /api/update/apply` →
  `sendCopilotSelfUpdate`.
- **Setting:** `checkUpdatesOnLaunch` (default true) — same per-project storage as
  `theme`/`auto*` even though it's semantically global; the on-load check honors it.
- **UI:** Settings → "About Cockpit.js" card (version line, status, "Check for updates"
  `.lane-btn`, "What's new" external link, gradient "Update Cockpit.js" `.copilot-btn`) plus
  an accent **update dot** on the gear (`#settings-update-dot`) when an update is available.
  The self-update controls are **extension-scoped, not project-scoped** → marked
  `[data-global]` and excluded from `setControlsEnabled` (the `.lane-btn:not([data-global]),
  .copilot-btn:not([data-global])` selector) so they stay usable with no project open.

### Release pipeline (semantic-release)

- `.github/workflows/release.yml` runs on push to `main`: checkout (`fetch-depth: 0`),
  Node 22.18, `npm ci`, **`npm run check`** as a release gate, then `npx semantic-release`
  with the built-in `GITHUB_TOKEN`. `concurrency: release` serializes runs.
- `.releaserc.json`: branches `["main"]`; commit-analyzer + release-notes-generator +
  `@semantic-release/changelog` + `@semantic-release/npm` with **`npmPublish: false`** (bumps
  `package.json` version without publishing — the package is `private`) +
  `@semantic-release/git` (commits `package.json` + `package-lock.json` + `CHANGELOG.md` back
  as `chore(release): x.y.z [skip ci]`, the `[skip ci]` avoiding a CI loop) +
  `@semantic-release/github` (creates the Release/tag).
- **Why coupled:** every release bumps `package.json` version AND tags a matching Release, so
  an installed copy's version always lines up with `releases/latest` → `updateAvailable` is
  accurate.
- **Caveats:** (a) if `main` is branch-protected to require PRs, the direct bump-back push
  fails → allow the Action to bypass, use a PAT, or switch to release-please (PR-based).
  (b) First semantic-release run defaults to `v1.0.0`; to keep a `0.x` line, seed a `v0.1.0`
  tag first. (c) Validate with `npx semantic-release --dry-run` (needs a token); don't
  trigger a real release as part of unrelated work.
- **Known advisory — undici (high), unfixable via npm tooling, accepted:** `semantic-release`
  core-depends on `@semantic-release/npm` → `npm` (latest), which **bundles** an old
  `undici` inside its own tarball (`node_modules/npm/node_modules/undici`). Bundled deps
  can't be rewritten by npm `overrides` or `npm audit fix` (both verified no-ops), and npm
  is already at its latest release. It surfaces in `npm audit` / the Cockpit audit as 1 high.
  **Risk ≈ 0:** it only runs in the CI release job (node-gyp during native builds), never in
  the shipped extension, and `@semantic-release/npm` runs `npmPublish: false`. The only way
  to eliminate it is to drop semantic-release for **release-please** (a GitHub Action with
  zero devDeps). Left as-is intentionally; don't chase it with overrides.



The canvas UI targets the **GitHub App look** in both light and dark. All visuals are
hand-rolled in `public/index.html` + `public/style.css` (the host mirrors its own theme
tokens onto the canvas document, but this project uses its **own** Primer-aligned token
set, not the host semantic tokens — stay within this vocabulary).

### Theme tokens (`:root` in `style.css`)
Surfaces `--bg` / `--bg-elev` / `--bg-inset`; lines `--border` / `--border-muted`; text
`--text` / `--dim`; brand `--accent` / `--accent-emphasis` / `--on-emphasis` (`#fff`);
status `--green` / `--red` / `--yellow`; purple `--purple` (foreground/outline) and the
Copilot set `--copilot` (solid emphasis purple / focus-ring source) + the tri-stop
gradient endpoints `--copilot-grad-1` (blue) / `--copilot-grad-2` (purple) /
`--copilot-grad-3` (fuchsia); control-state tints — **two** flavors: `--surface-hover` /
`--surface-active` (solid, from `--bg-elev`) and `--control-hover` / `--control-active`
(translucent overlay) — see Interaction states; console `--console-bg` / `--console-fg`;
plus `--radius` (6px), `--mono`, `--focus-ring`, `--shadow-sm` (**elevation only** — see
Flat principle). **Never hardcode hex** in rules — add/extend a token (the only deliberate
literals are `#fff`/`#000` inside `color-mix()` lighten/darken and overlay scrims).

### Theming model (3 blocks, keep in sync)
1. `:root` — the single source of truth for **light** tokens.
2. `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` — dark when
   the OS is dark **and** the user hasn't forced Light (the `:not` guard makes the Light
   toggle win over OS dark).
3. `:root[data-theme="dark"]` — dark when the user explicitly forces Dark.

The toggle (`applyTheme()` in `app.js`) sets/removes `data-theme` = `light` | `dark` |
(absent = auto). The two dark blocks (2 & 3) carry **identical** values — change both.
Tokens that are theme-agnostic or derive from other themed tokens via lazy `var()` live
only in `:root` and follow the active theme automatically: `--on-emphasis`, `--radius`,
`--mono`, `--shadow-sm`, `--focus-ring` (→ `--accent`), and `--surface-hover` /
`--surface-active` / `--control-hover` / `--control-active` (→ `--bg-elev` + `--text`).
Per-theme color literals (surfaces, text, borders, accents, the Copilot gradient
endpoints) go in all three blocks. CSS
`light-dark()` would collapse this to one block but is intentionally **not** used yet
(needs Chrome 123+; webview baseline unconfirmed).

### Flat principle (the core look)
The GitHub App theme is **flat**. Controls (buttons, tabs, segmented, menu items, rows,
inputs, the switch) carry **no bevels, no inset highlights, and no drop shadows**. The
only depth cue is a 1px border + a background tint. `box-shadow` is reserved for **true
elevation** — things that float above the page: popovers/menus, the toast
(`.toast`), the intro/empty-state card, and the drag lift (`.settings-tab-row.dragging`).
Those are the *only* legitimate `--shadow-sm` users; never add a shadow to a resting or
hovered control. Gradients are allowed (the Copilot button), but they must be **flat 2D
fills** — a color transition across the face, not a glossy top-light bevel.

### Button taxonomy
- `.lane-btn` — the default action button (elevated surface, hairline border). Modifiers:
  `.primary` = `--accent-emphasis` fill (**blue**, the primary non-Copilot CTA);
  `.task` = quiet transparent/muted.
- `.icon-btn` / `.ghost-btn` — square icon-only buttons (refresh, kebab, etc.).
- `.copilot-btn` — **the one flat blue→purple→fuchsia gradient variant for the recurring
  Copilot handoffs in the inner loop: Fix / Send / Update** (`#console-fix`, `#problems-fix`,
  `#test-fix`, `#dev-fix`, `#capture-send`, `#deps-update`, `#deps-audit-fix`). A **flat**
  `135deg` tri-stop gradient (`--copilot-grad-1` blue → `--copilot-grad-2` purple →
  `--copilot-grad-3` fuchsia) over a **matching gradient border** — the fill is a
  `padding-box` gradient and the border a `border-box` gradient of the same stops darkened
  `~16%` (`border: 1px solid transparent`; this keeps the rounded corners and stays flat).
  White text/icon, `.lane-btn` metrics, a **purple** focus ring (not the accent one). **No
  inset highlight, no drop shadow** — the gradient is the pop. Hover darkens uniformly
  (`brightness(.96)`); active a touch more. It is the only gradient-FILLED control. It
  shares the project-scoped `setControlsEnabled()` disable path with `.lane-btn` (the
  buttons live in project-scoped tabs), so keep both classes in that selector.
- `.fix-btn` — the compact **gradient-OUTLINE** sibling for inline per-item fixes (only
  use today: `.diag-fix`, the hover-revealed icon button on each diagnostic row). Same
  Copilot identity in a lightweight form: a full tri-stop gradient `border-box` border over
  a subtle gradient-tint `padding-box` fill, and a **gradient-filled icon** via the
  `#copilot-grad` SVG def (`.fix-btn .oi { fill: url(#copilot-grad) }`). A labeled variant
  would clip the same gradient onto its text (`background-clip: text`). Purple focus ring +
  `brightness(.94)` press, like `.copilot-btn`.

**The `#copilot-grad` SVG def** lives in the inline sprite `<defs>` (`public/index.html`):
a `<linearGradient>` whose stops are `style="stop-color: var(--copilot-grad-1|2|3)"`, so the
icon gradient stays theme-aware. It's the paint server for gradient-filled Copilot icons.

**Rule: recurring Copilot handoffs (Fix/Send/Update) = the blue→purple→fuchsia gradient.**
Filled `.copilot-btn` for the prominent ones, gradient-outline `.fix-btn` for compact inline
ones. Blue `.primary` is reserved for non-Copilot primary actions. Deliberate exception:
`#rf-create` ("Start a new Rayfin project") also sends a prompt to Copilot but stays blue
`.lane-btn.primary` — it's a one-off onboarding/create primary action shown in the
no-project intro state, not a recurring inner-loop handoff. Revisit if more "create"
handoffs appear (they'd want their own treatment rather than diluting the gradient).

### Interaction states (shared groups near the top of `style.css`)
- **`cursor` is forbidden everywhere** (`cursor: default !important` on `*`): the native
  Copilot app and the webview fight over the pointer cursor and flicker. Hover / press /
  focus visuals are the only affordance — so keep them perceptible (don't make hover too
  subtle), but flat.
- **Hover** = a background tint only, in **two flavors** (because `--bg-elev ≈ --bg`, a
  surface-derived step is invisible under a *transparent* control on the toolbar):
  - filled controls that rest on a surface (`.lane-btn:not(.task)`) use `--surface-hover`
    — a SOLID step of `--bg-elev` toward `--text`.
  - transparent controls (`.lane-btn.task`, `.icon-btn`, `.ghost-btn`, `.menu-item`,
    `.segmented`, `.suite-head`, rows) use `--control-hover` — a TRANSLUCENT `--text`
    overlay that shows on any base.
  The border stays `--border` (**never darken it to `--dim`** — reads as an out-of-theme
  black outline) and there is **no shadow**. Never use `--bg-inset` for a hover (it's
  near-black in dark and turns controls black).
- **Press** (`:active`) = the matching stronger background (`--surface-active` /
  `--control-active`), or `brightness(.94)` for gradient/accent fills (`.primary`,
  `.copilot-btn`, `.fix-btn`, `.segmented .on`). **No `translateY` push-down** — GitHub
  shifts the background, it does not move the button.
- **Filled buttons darken on hover** (GitHub behavior): `.lane-btn.primary` and
  `.copilot-btn` use `brightness(.96)`, not a lighten. **Gotcha:** the generic
  `.lane-btn:hover` grey-`--surface-hover` rule and `.lane-btn.primary:hover{filter:…}` have
  **equal specificity**, so the generic rule must explicitly exclude primary
  (`.lane-btn:hover:not(:disabled):not(.primary)`) — otherwise a `.primary` blue button turns
  **grey** on hover instead of darkening. Keep the `:not(.primary)` on that selector.
- **Focus** (keyboard `:focus-visible`) = `box-shadow: 0 0 0 3px var(--focus-ring)` (accent)
  for most controls, a **purple** ring for the Copilot buttons (`.copilot-btn`, `.fix-btn`);
  inputs and the switch use the same box-shadow ring (not `outline`). Mouse clicks leave no
  persistent ring. List rows (`.rf-entity-row`) show selection via `.active` (accent-tinted
  bg) and a hover < focus < selected hierarchy (focus uses the stronger `--bg-inset` bg,
  hover the subtle `--control-hover`) — no ring.
- Disabled controls are inert (no hover/press response). `@media (prefers-reduced-motion)`
  collapses all transitions. The shared transition list animates `background-color`,
  `border-color`, `color`, `box-shadow` (no `transform` — nothing moves).

### Shape, chip & icon conventions
- Boxes/cards/buttons use `var(--radius)`; pills/chips use `999px`; avatars/dots `50%`;
  inline code `4px`. Cards/sections = `--bg-elev` surface + `--border` hairline.
- Chips (`.chip`, `.status-chip`) = `999px`, colored border + colored text per status
  (pass→green, fail→red, paused→accent, …), no fill.
- **Badge colors are semantic.** `--yellow` is **warning-only** (`.suite.warning`,
  `.diag-row.warning`, `.tab-badge.warning`, audit `MAJOR`, severity `moderate`, etc.).
  Informational badges use the **accent** (info) color — text and border the *same*
  `--accent`, no fill (e.g. the info "private" badge `.info-meta-badge`). Never use yellow
  for non-warnings, never make an info badge grey/neutral, and never mismatch a badge's text
  and border color.
- Icons are octicons from the inline `<svg>` sprite: `<svg class="oi"><use href="#oct-…"/></svg>`,
  14px, `--dim` by default, `--accent` on `.lane-btn` hover, `--on-emphasis` on filled
  buttons. Keep an informative icon even when restyling (e.g. `#dev-fix` keeps its camera
  icon to signal the screenshot step, while adopting the `.copilot-btn` color).

### Layout: scrolling tab panels
- `.tab-panel` is `position:absolute; inset:0; …; overflow-y:auto` (a fixed viewport). Inside
  a panel that stacks multiple sections (e.g. `#tab-deps` = Updates + Security), **sections
  must be `flex:0 0 auto`** so they take their natural height and the *panel* scrolls as one
  column. **Never give the sections (or their inner tables) `min-height:0`** — that lets flex
  shrink a section below its content, and the inner table then overflows its box and paints
  **over** the next section (the historic Updates/Security overlap bug). One scroll container
  (the panel), naturally-sized children.

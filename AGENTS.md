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
  `settings.test.ts`, `ts-server.test.ts`). `scripts/smoke.mjs`
  dynamically imports every SDK-free `src/*.ts` to prove native type-stripping loads.
- `biome.json` — Biome config (lint + format, replaces Prettier). `noImportantStyles`
  is off (the cursor/spinner `!important` rules are deliberate, see gotcha below).
- `docs/site/` — a self-contained Astro + Starlight docs site (its own
  `astro.config.mjs` + `src/`), run via `astro --root docs/site`, so it never
  touches the extension's own `src/` or `public/`. It exists to **dogfood**
  Cockpit's own Dev lane (`npm run dev` → Astro detected → `localhost:4321`
  preview) and web Build (`npm run docs:build`). Edit docs content under
  `docs/site/src/content/docs/`. **astro is pinned to 6.x**: `@astrojs/starlight`
  has no astro-7-compatible release yet (its peer wants `astro ^6.4.5`), and astro 7
  silently breaks `npm run dev` (nested astro-6 `@astrojs/mdx` can't resolve
  `@astrojs/markdown-remark`) even though `astro build` passes. Revisit when Starlight
  ships astro 7 support.
- `.github/extensions/cockpit/extension.mjs` — dog-food wrapper that imports the
  root `extension.mjs` so the repo runs the extension against itself.
- `e2e/` — **permanent dogfood fixtures**, its own npm **workspace root**
  (`package.json` with `workspaces:["*"]`, name `cockpit-e2e`) kept **out** of
  Cockpit's own install/lockfile so fixture deps never pollute Cockpit's
  Dependencies/Audit tab. `e2e/rayfin-app/` is a mock Microsoft Rayfin project
  (rayfin.yml + `@microsoft/rayfin*` deps + mock `rayfin/.deployments.json` / `.env` /
  `dab-config.json` / `data/schema.ts` / `functions/`) so the **Rayfin tab renders
  fully offline** (no Docker/Fabric/login/install). Excluded from Biome via `"!e2e"`
  in `biome.json`; tsconfig/vitest/smoke already scope to `src`/`public`/`test`.
  Dogfood by opening a Cockpit session at `e2e/rayfin-app/` (→ Rayfin tab) or at
  `e2e/` (→ monorepo detection signal). Mock dotfiles contain **only fabricated**
  values — never real secrets.
- `.github/workflows/ci.yml` — CI (`biome ci .` → build → smoke → test) on Node 22.18 & 24.

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
- **Lint is a Problems-tab concept**: clicking the **Lint** task (dropdown row or pinned
  button) focuses/refreshes the **Problems** tab (`runTask()` → `showTab("problems")`),
  it does NOT run the lint lane into the Console. The lint *lane* (`/api/lane {id:"lint"}`,
  in `CONSOLE_LANES`) is kept for back-compat (agent action).
- **Lane availability**: each `resolve*()` in `lanes.ts` reports `{unavailable}`;
  `laneAvailability(d)` aggregates it onto `detection.availability` so the UI hides
  lanes/tabs that don't apply.
- **Tasks dropdown model** (`#scripts-menu`, `classifyTasks()`/`renderScriptsMenu()` in
  `app.js`): one list in **package.json declared order** — no separate Tasks/Scripts
  groups. The "special" built-in tasks are **build / lint / format / test** (`LANE_TASKS`);
  each binds to its first present candidate script (`LANE_CANDIDATES`, mirroring
  `lanes.ts` `laneScript()`/`pickScript`). A script that backs a special is shown
  **bold with an accent zap octicon (`oct-zap`) after the name** and runs/pins
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
    `parseAudit()`). **Fix with Copilot** (`/api/deps/audit-fix` → `sendCopilotAuditFix()` →
    `buildDepsAuditFixPrompt`) prompts the agent to bump fixable packages and report the unfixable ones.
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
  `.deployments.json`/`.env`; auth tokens (`rayfin/.rayfin/auth.json`) are only presence-checked.

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
  UI, verify it at a narrow panel width, not just wide. Tab badges follow the overflow:
  `tabBadgeOf()` (keyed by `data-tab` → `#problems/#tests/#deps-badge`; Debugger has no
  badge) feeds both the dropdown items (each shows its own count) and `syncTabMoreBadge()`,
  which collapses hidden badges into a single **severity dot** on `⋯` (red > yellow > blue,
  no number — counts across tabs aren't summable).

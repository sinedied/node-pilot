# Cockpit.js Plan

## Vision

**Cockpit.js** is the JavaScript / Node.js / web inner-loop console for the GitHub
Copilot app: a [canvas extension](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions)
that lets you run your project's scripts, build, lint, type-check, test and run the
dev server, preview the running web app, and keep dependencies current **without
breaking the build** — and hand any failure straight to the agent with **Fix with
Copilot**, all from the Copilot app side panel.

It is zero-config: it auto-detects the package manager, scripts, framework, test
runner, linter and TypeScript from the project, and degrades gracefully when a
capability is missing.

> Inspired by [coffilot](https://github.com/jdubois/coffilot) (the Java equivalent),
> reimagined for the JS/Node/web ecosystem and agentic-first development.

## Principles (priority order)

1. **Stay local and safe.** The console server binds to `127.0.0.1` on an ephemeral
   port; mutating actions are explicit; nothing leaves the machine.
2. **Zero-config.** Detect the package manager (lockfile / `packageManager` field),
   scripts, framework, test runner, linter, TypeScript, workspaces and Node engine
   from the project rather than asking.
3. **Fast inner loop.** Parallel Build / Lint / Type-check / Test lanes plus an
   independent long-lived Dev lane, with live streamed output.
4. **Useful failures.** Every failure offers a context-rich **Fix with Copilot**.
5. **Safe by construction.** Dependency updates are verified and auto-rolled-back on
   failure, so the app never silently breaks.
6. **Simple, themed UI** that matches the Copilot app.

## Architecture

Mirrors the canvas-extension model (loopback HTTP server + SSE + agent actions):

- **Standalone, publishable repo** that dog-foods itself, like coffilot. A tiny
  `.github/extensions/cockpit/extension.mjs` wrapper re-exports the root
  `extension.mjs` so opening this repo in the Copilot app loads Cockpit.js directly.
- `joinSession({ canvases: [createCanvas({ id: "cockpit", ... })] })`.
- `open()` boots one loopback HTTP server per canvas instance (ephemeral port,
  `127.0.0.1`), serving the UI from `public/` plus JSON action endpoints and an
  **SSE** endpoint that streams live console / test / status events. Returns
  `{ title, url }`; `onClose` tears the server down.
- **Vanilla UI** (HTML/CSS/JS in `public/`, no build step) themed to the app, like
  coffilot — keeps the extension dependency-free and fast to load.
- **Process management**: spawn package-manager / tool commands cross-platform,
  stream stdout+stderr over SSE, track exit codes, and keep long-lived processes
  (dev server) separate from one-shot build lanes.
- **State is in-memory** per extension load (a known limitation; see below).

### Package-manager detection & command mapping

Detect the PM from lockfiles, then the `packageManager` field (corepack), default
`npm`:

| Marker              | PM   | run script     | install        |
| ------------------- | ---- | -------------- | -------------- |
| `bun.lockb`         | bun  | `bun run <s>`  | `bun install`  |
| `pnpm-lock.yaml`    | pnpm | `pnpm run <s>` | `pnpm install` |
| `yarn.lock`         | yarn | `yarn run <s>` | `yarn install` |
| `package-lock.json` | npm  | `npm run <s>`  | `npm install`  |

Add/remove/update use the per-PM syntax. The `packageManager` field is honored via
corepack when present.

### Detection capability tiers (graceful degradation)

| Tier            | Detected from                                            | What the console offers                               |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| **(none)**      | no `package.json`                                        | "needs a Node.js project" notice; lanes disabled      |
| **Node (base)** | `package.json`                                           | Script runner; Build / Lint / Test from scripts; deps |
| **TypeScript**  | `tsconfig.json` / `typescript` dep                       | Type-check lane (`tsc --noEmit`)                      |
| **Framework**   | vite / next / nuxt / astro / svelte / remix config + dep | Dev lane with served-URL detection + embedded preview |
| **Test runner** | vitest / jest / node:test / bun config + dep             | Graphical test report (pass/fail, per-test, stacks)   |
| **Monorepo**    | `workspaces` field / `pnpm-workspace.yaml` / turbo / nx  | Workspace / package picker (basic in MVP)             |

A capability summary + active PM is shown in the status bar.

## MVP scope

1. **Project detection & status bar** — PM, framework(s), test runner, linter,
   TypeScript, workspaces, Node-engine check, capability badges; a **Refresh** button
   re-runs detection without reloading the extension.
2. **Script runner** — list `package.json` scripts as buttons and run any one with
   live streamed output; recognize common ones (build / lint / test / dev / start /
   typecheck / format).
3. **Build lane** — run the detected build script (or framework default), streamed;
   parse errors on failure → Fix with Copilot.
4. **Lint & Format lane** — run eslint / biome / oxlint (and prettier / biome format);
   show problem counts; optional `--fix`; failures → Fix with Copilot.
5. **Type-check lane** — `tsc --noEmit` when TypeScript is detected; diagnostics list
   → Fix with Copilot.
6. **Test lane** — run vitest / jest / node:test / bun test; parse results into a
   graphical view (summary chips, per-suite grouping, expandable failure stack traces)
   with a live progress bar and a raw-console toggle; optional watch mode; failures →
   Fix with Copilot.
7. **Dev-server lane** — start the dev server (`<pm> run dev` / framework default),
   detect the served URL from output (e.g. `Local: http://localhost:5173`), show it
   with **Open preview** (embedded iframe in the canvas) + open-in-browser; capture
   HMR / compile errors and stream them; **Stop** button; port-in-use detection with
   an offer to change the port or stop the holder. Runs independently of the build
   lanes. The console doubles as a filterable log viewer (severity filter + search).
8. **Dependency management (headline differentiator):**
   - **Outdated view** — `<pm> outdated --json` (or `npm-check-updates`) parsed into a
     table grouped by **patch / minor / major** (current → wanted → latest).
   - **Security audit** — `<pm> audit --json` → vulnerability list, with `audit fix`.
   - **Safe update loop** — pick packages or a scope (all patch / all minor / list);
     for each batch: snapshot `package.json` + lockfile → update → install → run the
     **verify suite** (type-check + lint + build + test, configurable) → keep if green,
     **auto-rollback** the batch if red; bisect on failure to pinpoint the culprit;
     stream progress and summarize kept vs reverted. Breakages offer Fix with Copilot.
9. **Fix with Copilot (universal)** — any lane failure pushes a context-rich prompt
   (command, exit code, parsed errors, relevant file paths) back into the chat via
   `session.send`, so the agent can diagnose and fix it.

### Agent-callable actions (so Copilot can drive the canvas)

`get_status`, `refresh`, `run_script({name})`, `build_app`, `lint`, `format`,
`typecheck`, `run_tests({watch?,pattern?})`, `start_dev`, `stop_dev`, `get_dev_url`,
`get_logs({filter?})`, `list_outdated`, `audit`,
`update_dependencies({scope, packages?, verify?})`, `rollback_last_update`,
`fix_issue({lane})`.

## For later (roadmap iterations)

- **Run affected tests** — run only tests impacted by uncommitted git changes
  (vitest `--changed`, jest `--onlyChanged`, or a dependency-graph mapping).
- **Bundle size analysis** — after build, render a treemap + largest modules via
  `vite-bundle-visualizer` / `rollup-plugin-visualizer` / webpack-bundle-analyzer /
  `source-map-explorer`; flag regressions vs the previous build; Analyze with Copilot.
- **Test coverage view** — per-file coverage %, surface untested files, thresholds.
- **Node process metrics** — live CPU, RSS / heap, event-loop lag and handle counts
  for the dev/app process (the Node analog of coffilot's JVM metrics) with a badge.
- **Flame graph** — on-demand CPU profile via `0x` / `clinic flame` / `--cpu-prof`,
  rendered interactively with top hotspots + Analyze with Copilot; degrade gracefully
  when the profiler is absent.
- **Env doctor** — diff `.env` vs `.env.example`, flag missing/unused vars, detect
  required vars referenced in code.
- **Node / engines & PM doctor** — check Node version vs `engines` / `.nvmrc`,
  corepack / `packageManager` mismatch and lockfile drift, with one-click fixes.
- **Lighthouse / web-vitals audit** — quick perf / a11y / SEO audit against the
  running dev server; findings → Copilot.
- **Embedded preview enhancements** — device frames, in-page console + network
  capture, route navigation.
- **Monorepo orchestration** — per-package lanes, turbo / nx task-graph awareness,
  run for selected workspace(s).
- **Migration / codemod runners** — jscodeshift and framework codemods with the same
  verify + rollback safety as dependency updates.
- **Persisted per-project settings** — verify-suite config, default dev port,
  auto-open preview, selected workspace.
- **Persisted state across reloads** — move lane state out of memory.

## Known limitations (MVP)

- **State is in-memory** and single-lane (one build lane + one dev server at a time);
  reset on extension reload rather than persisted.
- **Output is raw text** initially; the graphical report is only for known test
  runners (vitest / jest / node:test / bun).
- **Embedded preview** is limited to what the dev server exposes on loopback.

## Repo layout

```
cockpit/
  extension.mjs                     # wiring: canvas declaration + server bootstrap
  src/
    detect.mjs                      # PM / scripts / framework / TS / runner / workspaces
    pm.mjs                          # package-manager command abstraction
    server.mjs                      # http + SSE + static + action endpoints
    lanes.mjs                       # build / lint / format / typecheck / dev runners
    test-report.mjs                 # parse vitest / jest / node:test / bun output
    deps.mjs                        # outdated / audit / safe-update loop + rollback
    actions.mjs                     # agent-callable canvas actions
    fix.mjs                         # "Fix with Copilot" prompt builders
  public/
    index.html  app.js  style.css   # themed vanilla UI
  .github/extensions/cockpit/extension.mjs   # dog-food wrapper -> root extension.mjs
  copilot-extension.json            # { "name": "cockpit", "version": 1 }
  package.json                      # metadata + check/lint/format scripts + biome
  README.md  PLAN.md  LICENSE  .gitignore  biome.json
```

## Milestones (tracked in SQL)

1. **Repo scaffolding** — standalone repo files, manifest, `package.json`, dog-food
   wrapper, biome, gitignore, README skeleton, git init.
2. **Canvas + server skeleton** — `createCanvas`, loopback HTTP server, SSE stream,
   static UI shell, `open` / `onClose`.
3. **Project detection** — PM, scripts, frameworks, TS, test runner, workspaces,
   engines + status bar + Refresh.
4. **PM abstraction + process runner** — spawn, stream over SSE, cross-platform,
   exit-code tracking, long-lived vs one-shot processes.
5. **Script runner** — list and run any `package.json` script.
6. **Build / Lint / Format / Type-check lanes** — streamed, with error parsing.
7. **Test lane** — graphical report (vitest / jest / node:test / bun) + live progress.
8. **Dev-server lane** — start/stop, URL detection, embedded preview, log viewer,
   port-in-use handling.
9. **Dependency management** — outdated + audit views; safe update loop with verify +
   rollback + bisect.
10. **Fix with Copilot** — wire across all lanes.
11. **Agent actions** — surface the full action set.
12. **Polish** — theming / responsive UI, README, dog-food self-test.

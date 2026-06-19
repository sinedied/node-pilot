# Cockpit.js

**The JavaScript / Node.js / web inner-loop console for the GitHub Copilot app.**

Cockpit.js is a [Copilot **canvas** extension](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions)
that puts your project's whole inner loop in the Copilot side panel: run scripts,
build, lint, format, type-check and test; start the dev server and preview the app;
and keep dependencies current **without breaking the build**. Any failure can be
handed straight to the agent with one click — **Fix with Copilot**.

It is zero-config: Cockpit.js auto-detects your package manager, scripts, framework,
test runner, linter, formatter and TypeScript, and degrades gracefully when a
capability is missing.

> Inspired by [coffilot](https://github.com/jdubois/coffilot) (the Java equivalent),
> reimagined for the JS / Node / web ecosystem and agentic-first development.

## Features

- **Project detection & status bar** — package manager, framework, test runner,
  linter, formatter, TypeScript, workspaces, with a **Refresh** button.
- **Script runner** — every `package.json` script as a button, with live output.
- **Build / Lint / Format / Type-check lanes** — streamed output, error parsing,
  and a one-click **Fix with Copilot** on failure.
- **Test lane** — runs Vitest / Jest / `node:test` / Bun and renders a structured
  pass/fail report (summary chips, per-suite grouping, expandable stack traces).
- **Dev-server lane** — start/stop the dev server, auto-detect the served URL,
  preview it in an embedded panel, and stream HMR / compile errors.
- **Dependency management (headline feature)** — outdated view grouped by
  patch / minor / major, security audit, and a **safe update loop** that verifies
  every update (type-check + build + test) and **automatically rolls back** anything
  that breaks the app.
- **Fix with Copilot, everywhere** — every lane failure can push a context-rich
  prompt (command, exit code, parsed errors, file paths) into the chat.

## Supported tooling

| Capability      | Detected from                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Package manager | `bun.lockb` · `pnpm-lock.yaml` · `yarn.lock` · `package-lock.json` · `packageManager` field (default `npm`) |
| Framework / dev | Vite · Next.js · Nuxt · Astro · SvelteKit · Remix (config + dependency)                                     |
| TypeScript      | `tsconfig.json` / `typescript` dependency                                                                   |
| Test runner     | Vitest · Jest · `node:test` · Bun                                                                           |
| Linter / format | ESLint · Biome · oxlint · Prettier                                                                          |
| Monorepo        | `workspaces` · `pnpm-workspace.yaml` · Turbo · Nx                                                           |

Missing a capability simply hides the matching lane — there is nothing to configure.

## Install

### Try it on this repo (dog-food)

This repository dog-foods itself through a tiny wrapper at
`.github/extensions/cockpit/extension.mjs`. Open the repo in the GitHub Copilot
app and the **Cockpit.js** canvas becomes available — open it from the canvas
catalog or ask Copilot to "open Cockpit.js".

```sh
git clone https://github.com/sinedied/cockpit
# open the folder in the GitHub Copilot app
```

### Use it in another project

Copy the extension into the target project under `.github/extensions/cockpit/`
(its root `extension.mjs`, `src/`, `public/` and `copilot-extension.json`), or
install it from the repository with the Copilot app's "install extension" flow.
The canvas then drives that project's inner loop.

No bundler and no runtime dependencies: the TypeScript backend runs directly on
Node ≥ 22.18 (native type-stripping) and the UI is plain HTML/CSS/JS.

## Usage

### In the canvas

Open the **Cockpit.js** canvas in the side panel. The status bar shows the detected
setup; the tabs give you **Info** (project overview — stack, platform and
dependency/size metrics — plus refresh / theme), **Console**
(scripts + build/lint/format/type-check), **Tests**, **Dev** (server + preview) and
**Dependencies** (outdated / audit / safe update). Every failing run offers **Fix with
Copilot**.

### From the agent

Copilot can drive the same operations through canvas actions, e.g. _"build the app",
_"run the tests"_, _"start the dev server"_, _"update all patch-level dependencies
safely"\_. Available actions:

`get_status` · `get_project_info` · `refresh` · `run_script` · `build_app` · `lint` ·
`format` · `typecheck` · `run_tests` · `start_dev` · `stop_dev` · `get_dev_url` ·
`get_logs` · `list_outdated` · `audit` · `update_dependencies` · `rollback_last_update` ·
`fix_issue`.

### Safe dependency updates

`update_dependencies` (or the **Dependencies** tab) takes a scope (`patch` / `minor`
/ `major`) or an explicit package list. For each batch it snapshots `package.json`
and the lockfile, applies the updates, runs the **verify suite** (type-check + build

- test by default), keeps the change if everything is green, and **rolls back**
  anything that breaks — isolating the culprit so the rest of the updates still land.
  `rollback_last_update` restores the state from just before the last update.

## How it works

Cockpit.js follows the canvas-extension model: a per-instance loopback HTTP server
(bound to `127.0.0.1` on an ephemeral port) serves the UI and exposes JSON action
endpoints plus a Server-Sent-Events stream for live console / test / status updates.
A single in-process `Controller` is the source of truth shared by both the UI and the
agent actions, so they always drive the exact same operations.

```
extension.mjs            thin entry (required filename) → imports src/extension.ts
src/
  extension.ts           canvas declaration + per-instance server wiring (SDK)
  types.ts               shared domain types
  detect.ts              package manager / scripts / framework / TS / runners
  pm.ts                  package-manager command abstraction
  process-runner.ts      cross-platform spawn (one-shot + long-lived)
  lanes.ts               build / lint / format / type-check / dev / test commands
  test-report.ts         parse Vitest / Jest / node:test / Bun output
  deps.ts                outdated / audit + safe-update loop + rollback
  controller.ts          central state + orchestration (+ SSE events)
  server.ts              http + SSE + static + /api endpoints
  actions.ts             agent-callable canvas actions
  fix.ts                 "Fix with Copilot" prompt builders
  settings.ts            per-project pinned-tasks + theme persistence
types/copilot-sdk.d.ts   ambient SDK shim (so tsc resolves the SDK in CI)
public/                  index.html · app.js · style.css (Primer-styled vanilla UI)
test/                    Vitest specs · scripts/smoke.mjs (type-stripping load)
tsconfig*.json           Node + browser (checkJs) type-check configs
biome.json               Biome lint + format config
docs/site/                Astro + Starlight docs site (dogfoods the Dev / web Build lanes)
.github/workflows/ci.yml CI: biome → build → smoke → test on Node 22.18 & 24
```

The toolbar is a single row of **pinned tasks** — built-in lanes (Build, Type-check,
Lint, Format, Test) and `package.json` scripts share one zone with no distinction.
Open the **Tasks** menu to pin/unpin any of them (click a name to run it now); when a
project has no saved config yet, every built-in lane that applies is pinned by
default. Only tasks that actually apply are shown, and the Tests/Dev tabs hide when
there is nothing to run there. The pinned tasks and the theme preference are
persisted per project in `~/.cockpit/settings.json` — not in your repository. (iframe
`localStorage` is unreliable here because each canvas open gets a fresh loopback port,
which changes the page origin.)

The backend is **TypeScript with no build step** — Node ≥ 22.18 runs the `.ts`
sources directly via native type-stripping, so there is nothing to compile or bundle
at load. Everything in `src/` is SDK-free and independently runnable with plain Node;
only `src/extension.ts` imports the Copilot SDK.

## Development

Requires **Node ≥ 22.18** (for native TypeScript type-stripping — the backend runs
`.ts` directly with no build step).

```sh
npm install
npm run check          # biome (lint + format) + build + smoke + test (everything CI runs)

npm run build          # tsc type-check (Node + browser configs); alias: npm run typecheck
npm run smoke          # load every SDK-free module via native type-stripping
npm test               # Vitest unit tests (npm run test:watch / npm run coverage)
npm run lint           # Biome lint (npm run lint:fix to autofix)
npm run format         # format with Biome (npm run format:check to verify)
```

This repo also dogfoods Cockpit's **Dev** and web **Build** lanes with an Astro +
Starlight docs site under `docs/site/`: `npm run dev` starts it (auto-detected, served at
`http://localhost:4321/`) and `npm run docs:build` builds it.

After editing the extension, reload it in the Copilot app (the runtime rediscovers
`.github/extensions/`) to pick up changes.

## Known limitations

- State is in-memory and single-lane (one build lane + one dev server at a time);
  it resets on extension reload.
- The structured test report covers the known runners (Vitest / Jest / `node:test` /
  Bun); other runners fall back to raw output.
- Outdated/audit JSON is parsed reliably for npm (and pnpm); yarn / bun degrade to a
  best-effort summary.
- **Theme** follows your OS appearance (via `prefers-color-scheme`), repainted with
  GitHub Primer colors, plus a manual Auto/Light/Dark toggle. The host does not expose
  its own in-app theme to canvas extensions, so OS appearance is the best automatic
  signal available.
- **Tab icon**: the canvas API exposes only a title/status, so a custom tab icon
  isn't supported. Cockpit.js ships an SVG favicon (`public/icon.svg`) as a best-effort
  fallback in case the host surfaces it.

## Roadmap

Run-affected-tests, bundle-size analysis, coverage view, Node process metrics, flame
graphs, env doctor, Node/engines & PM doctor, Lighthouse audit, richer embedded
preview, monorepo orchestration, codemod runners, and persisted settings/state. See
[`PLAN.md`](./PLAN.md) for the full design and roadmap.

## License

[MIT](./LICENSE) © Yohan Lasorsa

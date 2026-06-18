# Node Pilot

**The JavaScript / Node.js / web inner-loop console for the GitHub Copilot app.**

Node Pilot is a [Copilot **canvas** extension](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions)
that puts your project's whole inner loop in the Copilot side panel: run scripts,
build, lint, format, type-check and test; start the dev server and preview the app;
and keep dependencies current **without breaking the build**. Any failure can be
handed straight to the agent with one click — **Fix with Copilot**.

It is zero-config: Node Pilot auto-detects your package manager, scripts, framework,
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
`.github/extensions/node-pilot/extension.mjs`. Open the repo in the GitHub Copilot
app and the **Node Pilot** canvas becomes available — open it from the canvas
catalog or ask Copilot to "open Node Pilot".

```sh
git clone https://github.com/sinedied/node-pilot
# open the folder in the GitHub Copilot app
```

### Use it in another project

Copy the extension into the target project under `.github/extensions/node-pilot/`
(its root `extension.mjs`, `src/`, `public/` and `copilot-extension.json`), or
install it from the repository with the Copilot app's "install extension" flow.
The canvas then drives that project's inner loop.

No build step and no runtime dependencies — the UI is plain HTML/CSS/JS.

## Usage

### In the canvas

Open the **Node Pilot** canvas in the side panel. The status bar shows the detected
setup; the tabs give you **Console** (scripts + build/lint/format/type-check),
**Tests**, **Dev** (server + preview) and **Dependencies** (outdated / audit / safe
update). Every failing run offers **Fix with Copilot**.

### From the agent

Copilot can drive the same operations through canvas actions, e.g. _"build the app",
_"run the tests"_, _"start the dev server"_, _"update all patch-level dependencies
safely"\_. Available actions:

`get_status` · `refresh` · `run_script` · `build_app` · `lint` · `format` ·
`typecheck` · `run_tests` · `start_dev` · `stop_dev` · `get_dev_url` · `get_logs` ·
`list_outdated` · `audit` · `update_dependencies` · `rollback_last_update` ·
`fix_issue`.

### Safe dependency updates

`update_dependencies` (or the **Dependencies** tab) takes a scope (`patch` / `minor`
/ `major`) or an explicit package list. For each batch it snapshots `package.json`
and the lockfile, applies the updates, runs the **verify suite** (type-check + build

- test by default), keeps the change if everything is green, and **rolls back**
  anything that breaks — isolating the culprit so the rest of the updates still land.
  `rollback_last_update` restores the state from just before the last update.

## How it works

Node Pilot follows the canvas-extension model: a per-instance loopback HTTP server
(bound to `127.0.0.1` on an ephemeral port) serves the UI and exposes JSON action
endpoints plus a Server-Sent-Events stream for live console / test / status updates.
A single in-process `Controller` is the source of truth shared by both the UI and the
agent actions, so they always drive the exact same operations.

```
extension.mjs            canvas declaration + per-instance server wiring
src/
  detect.mjs             package manager / scripts / framework / TS / runners
  pm.mjs                 package-manager command abstraction
  process-runner.mjs     cross-platform spawn (one-shot + long-lived)
  lanes.mjs              build / lint / format / type-check / dev / test commands
  test-report.mjs        parse Vitest / Jest / node:test / Bun output
  deps.mjs               outdated / audit + safe-update loop + rollback
  controller.mjs         central state + orchestration (+ SSE events)
  server.mjs             http + SSE + static + /api endpoints
  actions.mjs            agent-callable canvas actions
  fix.mjs                "Fix with Copilot" prompt builders
public/                  index.html · app.js · style.css (themed vanilla UI)
```

Everything in `src/` is SDK-free and independently runnable with plain Node; only
`extension.mjs` imports the Copilot SDK.

## Development

```sh
npm install
npm run check          # syntax-check every module
npm run format         # format with Prettier
npm run format:check   # verify formatting
```

After editing the extension, reload it in the Copilot app (the runtime rediscovers
`.github/extensions/`) to pick up changes.

## Known limitations

- State is in-memory and single-lane (one build lane + one dev server at a time);
  it resets on extension reload.
- The structured test report covers the known runners (Vitest / Jest / `node:test` /
  Bun); other runners fall back to raw output.
- Outdated/audit JSON is parsed reliably for npm (and pnpm); yarn / bun degrade to a
  best-effort summary.

## Roadmap

Run-affected-tests, bundle-size analysis, coverage view, Node process metrics, flame
graphs, env doctor, Node/engines & PM doctor, Lighthouse audit, richer embedded
preview, monorepo orchestration, codemod runners, and persisted settings/state. See
[`PLAN.md`](./PLAN.md) for the full design and roadmap.

## License

[MIT](./LICENSE) © Yohan Lasorsa

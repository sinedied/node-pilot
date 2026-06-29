<!-- prettier-ignore -->
<div align="center">

<img src="./docs/images/logo.png" alt="Cockpit.js logo" width="180" />

# Cockpit.js

**Your JavaScript / Node.js / web project cockpit for the GitHub Copilot app.**

[![Build status](https://img.shields.io/github/actions/workflow/status/sinedied/cockpit-js/ci.yml?branch=main&style=flat-square)](https://github.com/sinedied/cockpit-js/actions/workflows/ci.yml)
![Node.js version](https://img.shields.io/badge/Node.js->=22.18-3c873a?style=flat-square&logo=node.js&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](./LICENSE)
![GitHub Copilot canvas extension](https://img.shields.io/badge/GitHub%20Copilot-canvas%20extension-8957e5?style=flat-square&logo=githubcopilot&logoColor=white)

⭐ If you find this project useful, star it on GitHub — it helps a lot!

[Features](#features) • [Supported tooling](#supported-tooling) • [Install](#install) • [Usage](#usage) • [Development](./docs/development.md)

</div>

Cockpit.js is a [GitHub Copilot **canvas** extension](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions)
that puts your project's entire inner loop in the Copilot side panel: run scripts,
build, lint, format, type-check and test; start the dev server and preview the app;
debug with breakpoints; and keep dependencies current **without breaking the build**.
Any failure can be handed straight to the agent with one click — **Fix with Copilot**.

It is **zero-config**: Cockpit.js auto-detects your package manager, scripts, framework,
test runner, linter, formatter and TypeScript setup, and degrades gracefully when a
capability is missing — there is nothing to wire up.

> [!TIP]
> Everything the UI does is also exposed as Copilot **agent actions**, so you can ask
> Copilot to "build the app", "run the tests", or "safely update all minor dependencies"
> and it drives the exact same operations.

## Features

- **Zero-config detection** — package manager, framework, test runner, linter, formatter,
  TypeScript and workspaces are detected automatically; missing capabilities just hide
  their tab.
- **Build / Lint / Format / Type-check lanes** — every `package.json` script plus
  first-class lanes with streamed output and error parsing.
- **Live Problems panel** — TypeScript language server **and** linter diagnostics merged
  per file, refreshed as files change.
- **Structured tests** — Vitest / Jest / `node:test` / Bun with a pass/fail report and
  optional native watch.
- **Dev server & live Preview** — start/stop the dev server and preview the app embedded
  in the panel.
- **Safe dependency updates** — outdated + audit in one tab, with a verify-and-rollback
  loop that won't break the build.
- **Node.js debugger** — breakpoints, stepping and inspection over the Chrome DevTools
  Protocol, fully agent-driveable.

…plus a multi-project/monorepo selector, an offline Microsoft Rayfin dashboard, theming,
self-update, and **Fix with Copilot** on any failure — one click sends the command, errors
and context straight to chat.

## Supported tooling

| Capability       | Detected from                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Package manager  | `bun.lockb` · `pnpm-lock.yaml` · `yarn.lock` · `package-lock.json` · `packageManager` field (default `npm`) |
| Framework / dev  | Vite · Next.js · Nuxt · Astro · SvelteKit · Remix (config + dependency)                                      |
| TypeScript       | `tsconfig.json` / `typescript` dependency                                                                    |
| Test runner      | Vitest · Jest · `node:test` · Bun                                                                            |
| Linter / format  | Biome · ESLint · oxlint · Prettier                                                                           |
| Monorepo         | npm / yarn / pnpm `workspaces` · standalone packages                                                         |

Missing a capability simply hides the matching lane or tab — there is nothing to configure.

## Install

> [!IMPORTANT]
> Cockpit.js requires **Node.js ≥ 22.18** — the backend runs TypeScript directly via
> native type-stripping, with no build step.

### Try it on this repo (dog-food)

This repository dog-foods itself through a tiny wrapper at
`.github/extensions/cockpit/extension.mjs`. Open the repo in the GitHub Copilot app and
the **Cockpit.js** canvas becomes available — open it from the canvas catalog or ask
Copilot to "open Cockpit.js".

```sh
git clone https://github.com/sinedied/cockpit-js
# open the folder in the GitHub Copilot app, then open the Cockpit.js canvas
```

### Use it in another project

Copy the extension into the target project under `.github/extensions/cockpit/` (the root
`extension.mjs`, `src/`, `public/` and `copilot-extension.json`), or install it through
the Copilot app's "install extension" flow. The canvas then drives that project's inner
loop.

There is **no bundler and no runtime dependencies**: the TypeScript backend runs directly
on Node ≥ 22.18 and the UI is plain HTML/CSS/JS.

## Usage

### In the canvas

Open the **Cockpit.js** canvas in the side panel. The header shows the detected setup (and
a project selector in monorepos); the tabs cover the whole inner loop:

- **Info** — project overview: stack, platform, and dependency/size metrics.
- **Preview** — dev server controls + embedded app preview with visual Fix-with-Copilot.
- **Rayfin** — Microsoft Rayfin dashboard (shown only for Rayfin projects).
- **Tests** — structured test report with optional native watch.
- **Problems** — live TypeScript + linter diagnostics.
- **Dependencies** — outdated updates + security audit with safe, verified updates.
- **Debugger** — Node.js breakpoints, stepping and inspection.
- **Console** — scripts and the Build / Lint / Format / Type-check lanes.

A gear icon opens **Settings** to reorder/hide tabs, toggle on-load auto-runs, and switch
theme. Every failing run offers **Fix with Copilot**.

### From the agent

Copilot can drive the same operations through canvas actions, e.g. _"build the app"_,
_"run the tests"_, _"start the dev server"_, _"safely update all minor dependencies"_, or
_"set a breakpoint and step into the failing function"_. Available actions:

- **Status & project** — `get_status` · `get_project_info` · `refresh` · `fix_issue`
- **Scripts & lanes** — `run_script` · `build_app` · `lint` · `format` · `typecheck` · `run_tests`
- **Diagnostics** — `get_diagnostics`
- **Dev server** — `start_dev` · `stop_dev` · `get_dev_url` · `get_logs`
- **Dependencies** — `list_outdated` · `audit` · `update_dependencies` · `rollback_last_update`
- **Debugger** — `debug_start` · `debug_attach` · `debug_stop` · `debug_set_breakpoint` ·
  `debug_remove_breakpoint` · `debug_list_breakpoints` · `debug_continue` · `debug_pause` ·
  `debug_step_over` · `debug_step_into` · `debug_step_out` · `debug_wait_for_pause` ·
  `debug_get_stack` · `debug_get_variables` · `debug_get_properties` · `debug_evaluate` ·
  `debug_get_state`
- **Rayfin** — `rayfin_new_project`

### Safe dependency updates

`update_dependencies` (or the **Dependencies** tab) takes a scope (`patch` / `minor` /
`major`) or an explicit package list. For each batch it snapshots `package.json` and the
lockfile, applies the updates, runs the **verify suite** (build + lint + test by default),
keeps the change if everything is green, and **rolls back** anything that breaks —
isolating the culprit so the rest of the updates still land. `rollback_last_update`
restores the state from just before the last update.

Security fixes follow an **`audit fix`-first** strategy: when the package manager supports
it, Cockpit.js runs a semver-safe `audit fix` (never `--force`), verifies it, rolls back on
breakage, and only escalates the **remaining** advisories to Copilot.

### Keeping Cockpit.js up to date

Cockpit.js periodically checks GitHub Releases for a newer version. When one is available,
an update indicator appears in **Settings → About**; clicking **Update Cockpit.js** hands
Copilot a ready-made prompt to fetch and apply the update.

## Development

Contributions welcome! See [docs/development.md](./docs/development.md) for setup,
architecture, and the build/test workflow.

## Known limitations

- State is in-memory and single-lane (one build lane + one dev server at a time); it resets
  on extension reload.
- The structured test report covers the known runners (Vitest / Jest / `node:test` / Bun);
  other runners fall back to raw output.
- Outdated/audit JSON is parsed reliably for npm and pnpm; yarn / bun degrade to a
  best-effort summary.
- The **Problems panel reflects saved files**, not unsaved editor buffers — the canvas is
  not an editor, so diagnostics analyze what's on disk.
- **Theme** follows your OS appearance (`prefers-color-scheme`), repainted with GitHub Primer
  colors, plus a manual Auto / Light / Dark toggle — the host does not expose its own in-app
  theme to canvas extensions.
- The embedded preview proxy targets standard HTTP dev servers; servers that hard-code an
  absolute origin or use exotic auth may not round-trip (the URL bar and open-external still
  work).

## Related projects

- [coffilot](https://github.com/jdubois/coffilot) — the Java equivalent that inspired
  Cockpit.js, reimagined here for the JavaScript / Node / web ecosystem and agentic-first
  development.

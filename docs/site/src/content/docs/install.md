---
title: Install & usage
description: How to install Cockpit.js and drive your project from the canvas or the agent.
---

## Requirements

**Node ≥ 22.18** — the TypeScript backend runs directly via native type-stripping,
so there is no bundler and no build step.

## Try it on this repo (dogfood)

This repository dogfoods itself through a tiny wrapper at
`.github/extensions/cockpit/extension.mjs`. Open the repo in the GitHub Copilot
app and the **Cockpit.js** canvas becomes available — open it from the canvas
catalog or ask Copilot to "open Cockpit.js".

```sh
git clone https://github.com/sinedied/node-pilot
# open the folder in the GitHub Copilot app
```

## Use it in another project

Copy the extension into the target project under `.github/extensions/cockpit/`
(its root `extension.mjs`, `src/`, `public/` and `copilot-extension.json`), or
install it from the repository with the Copilot app's "install extension" flow.
The canvas then drives that project's inner loop.

## In the canvas

Open the **Cockpit.js** canvas in the side panel. The tabs give you:

- **Info** — project overview (stack, platform, dependency/size metrics) plus
  refresh / theme controls.
- **Console** — scripts + build / lint / format / type-check.
- **Tests** — structured pass/fail report.
- **Dev** — server + preview.
- **Dependencies** — outdated / audit / safe update.

Every failing run offers **Fix with Copilot**.

## From the agent

Copilot can drive the same operations through canvas actions, e.g. _"build the
app"_, _"run the tests"_, _"start the dev server"_, _"update all patch-level
dependencies safely"_. Available actions:

`get_status` · `get_project_info` · `refresh` · `run_script` · `build_app` ·
`lint` · `format` · `typecheck` · `run_tests` · `start_dev` · `stop_dev` ·
`get_dev_url` · `get_logs` · `list_outdated` · `audit` · `update_dependencies` ·
`rollback_last_update` · `fix_issue`.

## Safe dependency updates

`update_dependencies` (or the **Dependencies** tab) takes a scope (`patch` /
`minor` / `major`) or an explicit package list. For each batch it snapshots
`package.json` and the lockfile, applies the updates, runs the verify suite
(type-check + build + test by default), keeps the change if everything is green,
and **rolls back** anything that breaks — isolating the culprit so the rest of
the updates still land. `rollback_last_update` restores the state from just
before the last update.

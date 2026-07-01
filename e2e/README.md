# Cockpit.js dogfood fixtures (`e2e/`)

Permanent, committed test apps used to dogfood Cockpit.js tabs and detection.

This folder is **its own workspace root** (`package.json` declares
`"workspaces": ["*"]`) and is intentionally **not** part of Cockpit.js's root
install — its dependencies never land in Cockpit.js's own lockfile or its
Dependencies/Audit tab. It is excluded from Cockpit.js's biome/tsc/vitest/smoke.

## How to use

- Open a Cockpit.js session pointed at **`e2e/`** → Cockpit.js detects a **monorepo**
  (the `workspaces` field).
- Open a Cockpit.js session pointed at **`e2e/rayfin-app/`** → the **offline mock**
  Rayfin project; the Rayfin tab renders fully with no install/login/Docker.
- Open a Cockpit.js session pointed at **`e2e/rayfin-todo-app/`** → a **real,
  deployable** Rayfin app (the official `todo-app-template`) for exercising
  login / deploy / workspace-switch against your own Fabric account.

## Apps

| App | Dogfoods |
| --- | --- |
| [`rayfin-app/`](./rayfin-app/) | The Rayfin tab, **offline**: a mock app whose committed `rayfin/` files (real-schema `rayfin.yml`, `.deployments.json`, `dab-config.json`, `data/schema.ts`) render every section (environment, Fabric workspace + API endpoint links, data model graph) with no network. Fabricated values only — never real secrets. |
| [`rayfin-todo-app/`](./rayfin-todo-app/) | The Rayfin tab, **for real**: the official Microsoft Rayfin `todo-app-template` (real `@microsoft/rayfin-*` deps, real `rayfin/rayfin.yml`, Vite + React). Kept as source only — **not** installed/built in CI. |

## The two Rayfin fixtures

- **`rayfin-app/` (mock, offline):** the everyday fixture. It exists so the
  Rayfin tab can be developed and screenshotted without a Fabric account,
  Docker, or any install. Its `rayfin/.deployments.json` uses the **real**
  `fabric*` field names (`fabricItemId` / `fabricApiUrl` / `fabricWorkspaceId` /
  `fabricDeepLink` / `hostingUrl`) so the offline render matches what a real
  deploy writes — including the **Open Fabric workspace** and **API endpoint**
  links. Everything is fabricated; there are no real credentials.

- **`rayfin-todo-app/` (real, deployable):** use this to actually test the
  login / deploy / workspace-switch flow end-to-end. Install and deploy it
  yourself (it needs your own Microsoft Fabric account):

  ```sh
  cd e2e/rayfin-todo-app
  npm install
  npx rayfin login
  npx rayfin up        # deploys the backend to Fabric and writes rayfin/.deployments.json
  npm run dev          # runs the backend on Fabric + Vite locally
  ```

  Deploying writes `rayfin/.deployments.json` + `rayfin/.env` (gitignored), at
  which point the Rayfin tab shows the live deployment.

## Installing the mock (optional)

The mock renders **fully offline** from its committed files — no install needed.
To exercise its CLI-lane buttons for real, install on demand:

```sh
cd e2e && npm install
```

`node_modules/` here is gitignored.

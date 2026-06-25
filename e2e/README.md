# Cockpit.js dogfood fixtures (`e2e/`)

Permanent, committed test apps used to dogfood Cockpit.js tabs and detection.

This folder is **its own workspace root** (`package.json` declares
`"workspaces": ["*"]`) and is intentionally **not** part of Cockpit's root
install — its dependencies never land in Cockpit's own lockfile or its
Dependencies/Audit tab. It is excluded from Cockpit's biome/tsc/vitest/smoke.

## How to use

- Open a Cockpit session pointed at **`e2e/`** → Cockpit detects a **monorepo**
  (the `workspaces` field).
- Open a Cockpit session pointed at **`e2e/rayfin-app/`** → Cockpit detects a
  **Rayfin** project and shows the **Rayfin tab**.

## Apps

| App | Dogfoods |
| --- | --- |
| [`rayfin-app/`](./rayfin-app/) | The Rayfin tab (Microsoft Rayfin BaaS dashboard) |

## Installing (optional)

The Rayfin tab renders **fully offline** from committed mock files
(`rayfin/.deployments.json`, `rayfin/.env`, `rayfin/dab-config.json`) — no
install, Docker, Fabric or login required. To exercise the CLI-lane buttons for
real, install on demand:

```sh
cd e2e && npm install
```

`node_modules/` here is gitignored.

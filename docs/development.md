# Development

How to set up, build, test and understand the internals of Cockpit.js. For an overview
of what the extension does, see the [README](../README.md).

Requires **Node.js ≥ 22.18** (for native TypeScript type-stripping — the backend runs
`.ts` directly with no build step).

```sh
npm install
npm run check          # everything CI runs: biome (lint + format) + build + smoke + test

npm run build          # tsc type-check (Node + browser configs); alias: npm run typecheck
npm run smoke          # load every SDK-free module via native type-stripping
npm test               # Vitest unit tests (npm run test:watch / npm run coverage)
npm run lint           # Biome lint (npm run lint:fix to autofix)
npm run format         # format with Biome (npm run format:check to verify)
```

This repo also dogfoods Cockpit.js's **Dev** and web **Build** lanes with an Astro + Starlight
docs site under `docs/site/`: `npm run dev` starts it (auto-detected, served at
`http://localhost:4321/`) and `npm run docs:build` builds it.

After editing the extension, reload it in the Copilot app (the runtime rediscovers
`.github/extensions/`) to pick up changes.

## How it works

Cockpit.js follows the canvas-extension model: a per-instance loopback HTTP server (bound
to `127.0.0.1` on an ephemeral port) serves the UI and exposes JSON action endpoints plus a
Server-Sent-Events stream for live console / test / status updates. A single in-process
`Controller` is the source of truth shared by both the UI and the agent actions, so they
always drive the exact same operations.

```text
extension.mjs            thin entry (required filename) → imports src/extension.ts
src/
  extension.ts           canvas declaration + per-instance server wiring (the only SDK importer)
  types.ts               shared domain types
  detect.ts              package manager / scripts / framework / TS / runners
  projects.ts            monorepo / multi-project discovery
  pm.ts                  package-manager command abstraction
  process-runner.ts      cross-platform spawn (one-shot + long-lived)
  lanes.ts               build / lint / format / type-check / dev / test commands
  test-report.ts         parse Vitest / Jest / node:test / Bun output
  deps.ts                outdated / audit + safe-update loop + rollback
  info.ts                lazy Info-tab metrics (transitive deps + sizes)
  ts-server.ts           SDK-free tsserver client (live diagnostics)
  lint-report.ts         linter JSON → diagnostics (merged into Problems)
  cdp.ts / debug.ts      zero-dep Chrome DevTools Protocol client + debug session
  rayfin.ts              Microsoft Rayfin detection + offline dashboard state
  update.ts              SDK-free self-update check (GitHub Releases)
  controller.ts          central state + orchestration (+ SSE events)
  server.ts              http + SSE + static + /api endpoints
  actions.ts             agent-callable canvas actions
  fix.ts                 "Fix with Copilot" prompt builders
  settings.ts            per-project tabs / theme / auto-run persistence
public/                  index.html · app.js · style.css (Primer-styled vanilla UI)
docs/site/               Astro + Starlight docs site (dogfoods the Dev / web Build lanes)
test/                    Vitest specs · scripts/smoke.mjs (type-stripping load)
.github/workflows/       ci.yml (lint → build → smoke → test) · release.yml (semantic-release)
```

The backend is **TypeScript with no build step** — Node ≥ 22.18 runs the `.ts` sources
directly via native type-stripping, so there is nothing to compile or bundle at load.
Everything in `src/` is SDK-free and independently runnable with plain Node; only
`src/extension.ts` imports the Copilot SDK. Settings persist per project in
`~/.cockpit/settings.json` (not in your repository, and not in iframe `localStorage`,
which is unreliable here because each canvas open gets a fresh loopback port).

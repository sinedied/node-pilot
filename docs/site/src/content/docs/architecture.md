---
title: Architecture
description: How Cockpit.js is wired together internally.
---

Cockpit.js follows the canvas-extension model: a per-instance loopback HTTP
server (bound to `127.0.0.1` on an ephemeral port) serves the UI and exposes
JSON action endpoints plus a Server-Sent-Events stream for live console / test /
status updates. A single in-process `Controller` is the source of truth shared by
both the UI and the agent actions, so they always drive the exact same operations.

## Source layout

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
public/                  index.html · app.js · style.css (vanilla UI)
test/                    Vitest specs · scripts/smoke.mjs (type-stripping load)
```

## No build step

The backend is **TypeScript with no build step** — Node ≥ 22.18 runs the `.ts`
sources directly via native type-stripping, so there is nothing to compile or
bundle at load. Everything in `src/` is SDK-free and independently runnable with
plain Node; only `src/extension.ts` imports the Copilot SDK. A `tsc --noEmit`
build script exists purely for type-checking (CI and the Build lane).

## Pinned tasks

The toolbar is a single row of **pinned tasks** — built-in lanes (Build,
Type-check, Lint, Format, Test) and `package.json` scripts share one zone with no
distinction. Open the **Tasks** menu to pin/unpin any of them; when a project has
no saved config yet, every built-in lane that applies is pinned by default. The
pinned tasks and theme preference are persisted per project in
`~/.cockpit/settings.json` — not in your repository.

## Tooling

Linting and formatting use [Biome](https://biomejs.dev); tests use
[Vitest](https://vitest.dev); this docs site is built with
[Astro](https://astro.build) + [Starlight](https://starlight.astro.build). CI
runs Biome → build → smoke → test on Node 22.18 and 24.

---
title: Features
description: What Cockpit.js can do for your JavaScript / Node.js / web project.
---

Cockpit.js streamlines the entire inner loop from the Copilot side panel.

## Project detection & status

Package manager, framework, test runner, linter, formatter, TypeScript and
workspaces are all auto-detected — with a **Refresh** button to re-scan. The
**Info** tab surfaces project metrics like dependency counts, install size and
the platform (minimum Node.js version, package manager).

## Script runner

Every `package.json` script is available as a button with live output. Pin your
most-used tasks to the toolbar from the **Tasks** menu.

## Build / Lint / Format / Type-check lanes

Streamed output, error parsing, and a one-click **Fix with Copilot** on any
failure. Lanes that don't apply to your project are hidden automatically.

## Test lane

Runs Vitest / Jest / `node:test` / Bun and renders a structured pass/fail report:
summary chips, per-file grouping with test counts and timing, and expandable
stack traces. Passing files fold away so failures stand out.

## Dev-server lane

Start/stop the dev server, auto-detect the served URL, preview it in an embedded
panel, and stream HMR / compile errors.

## Dependency management

The headline feature: an outdated view grouped by patch / minor / major, a
security audit, and a **safe update loop** that verifies every update
(type-check + build + test) and **automatically rolls back** anything that breaks
the app.

## Fix with Copilot, everywhere

Every lane failure can push a context-rich prompt — command, exit code, parsed
errors and file paths — straight into the chat.

## Supported tooling

| Capability      | Detected from                                                                  |
| --------------- | ------------------------------------------------------------------------------ |
| Package manager | `bun.lockb` · `pnpm-lock.yaml` · `yarn.lock` · `package-lock.json` · `packageManager` |
| Framework / dev | Vite · Next.js · Nuxt · Astro · SvelteKit · Remix                              |
| TypeScript      | `tsconfig.json` / `typescript` dependency                                       |
| Test runner     | Vitest · Jest · `node:test` · Bun                                              |
| Linter / format | ESLint · Biome · oxlint · Prettier                                             |
| Monorepo        | `workspaces` · `pnpm-workspace.yaml` · Turbo · Nx                              |

Missing a capability simply hides the matching lane — there is nothing to configure.

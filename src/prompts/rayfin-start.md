# Rayfin — New Project Setup

You are helping a developer create a new Rayfin project.
Rayfin is a TypeScript Backend-as-a-Service platform: decorate data models, get auto-generated APIs (REST + GraphQL), type-safe clients, auth, and a local dev stack.

## Step 1: Ask what they want to build

Ask the user what they want to build. Based on their answer, recommend one of these templates:

- **`dataapp`** _(default)_ — Fabric data analytics app. Best for building on top of data in Microsoft Fabric.
- **`todoapp`** — Full todo app with auth, database entities, and a working frontend. Best for learning Rayfin end-to-end or as a feature-rich starting point.
- **`gettingstartedauth`** — Minimal app with authentication wired up. Best when auth is needed but you want to add your own data model.
- **`blankapp`** — Bare scaffolding with auth + data services enabled but no entities or UI. Best for experienced users who want a clean slate.

If unsure, default to `dataapp`. If the user has no Fabric workspace and wants something self-contained, suggest `todoapp` instead.

## Step 2: Check prerequisites

Rayfin requires:

- **Node.js 20 or later** — verify with `node --version`.
- **Git** — verify with `git --version`.

If either is missing, help the user install them before continuing:

- macOS: `brew install node git`
- Windows: `winget install -e --id OpenJS.NodeJS.LTS Git.Git`
- Linux (Debian/Ubuntu): use [nodejs.org/en/download](https://nodejs.org/en/download), then `sudo apt install -y git`

Do **not** proceed until `node --version` reports v20 or higher.

## Step 3: Create the project

The scaffolder creates a new subdirectory named after the project in the current working directory. By default, plan to create the project in the user's current directory unless one of these applies:

- **Already inside a Rayfin project** (the cwd has a `rayfin/` folder, or `package.json` lists `@microsoft/rayfin-*` dependencies): tell the user they're already in one. Confirm they really want to create a new one and ask where before continuing — they may have run the command by mistake.
- **User explicitly asked for a different location**: use what they specified.

Suggest a project name based on what they described in Step 1 (kebab-case, no spaces) and confirm it with the user. Then run the scaffolder non-interactively (use `npx -y` so the agent isn't blocked by the npm-create install prompt):

```bash
npx -y @microsoft/create-rayfin@latest <name> --template <template>
```

`<template>` is one of the IDs from Step 1 (`dataapp`, `todoapp`, `gettingstartedauth`, `blankapp`). The command will create a new `<name>/` subdirectory, install dependencies, and write agent rules + an MCP server config into the project automatically — do not duplicate that work.

After it finishes, `cd <name>` for any follow-up commands.

If the command fails because `npx` is missing, the user does not have Node.js installed; go back to Step 2.

## Step 4: Plan and customize the project

The project is scaffolded. Now help the user build what they described in Step 1 _before_ running anything.

Enter plan mode and outline the first changes — entities to model under `rayfin/data/`, frontend views to add under `src/`, and any packages to install. Confirm the plan with the user before writing code.

The project includes `AGENTS.md` files and an MCP server (`@microsoft/rayfin-mcp`) that exposes version-locked docs through tools like `list_docs`, `search_docs`, `get_doc`, and `discover_packages`. Use those tools to look up Rayfin APIs instead of guessing — they're already wired into the project.

Do **not** start the backend or frontend as part of this workflow. The user will run the app themselves when they're ready (see the project's `README.md` for the relevant commands).

## Useful links

- Docs: <http://aka.ms/rayfin/docs>
- GitHub: <https://github.com/microsoft/project-rayfin>
- Scaffolder package: <https://www.npmjs.com/package/@microsoft/create-rayfin>

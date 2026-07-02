# Backend functions (experimental)

> **Experimental** — Rayfin functions are provided by the experimental
> [`@microsoft/rayfin-functions`](https://www.npmjs.com/package/@microsoft/rayfin-functions)
> package and may change.

Serverless backend functions for this app. They run on the Azure Functions host
(locally on `RAYFIN_FUNCTIONS_PORT`, `7071` by default) and are called from the
frontend through the typed client.

## Layout

- `src/types.ts` — the `AppFunctionsSchema` type: one entry per function with its
  `input`/`output` contract. This is the single source of truth for call typing.
- `src/handlers.ts` — the function implementations (Azure Functions Node.js v4).
- `host.json` — Azure Functions host configuration (required for `func start`).
- `package.json` — this folder is its own Node package: `main` points at the
  compiled entry (`dist/src/handlers.js`) and `npm run build` runs `tsc`. A
  `prebuild` hook runs `scripts/ensure-local-settings.mjs` (see below).
- `tsconfig.json` — self-contained build (`src/**/*` → `dist/`). The parent
  `rayfin/tsconfig.json` excludes `functions/**/*` so it isn't double-compiled.
- `scripts/ensure-local-settings.mjs` — the `prebuild` hook that seeds the Azure
  Functions runtime keys into `local.settings.json` (see below).

## Running locally

```sh
rayfin dev functions apply     # builds, generates types, and starts the host
# or, directly:
npm run build && func start --port 7071
```

`func start` needs `local.settings.json` (gitignored — it may hold deployment
identifiers) to contain `FUNCTIONS_WORKER_RUNTIME: "node"`, or it fails with
"Worker runtime cannot be 'None'". A fresh clone won't have that file. The
`prebuild` hook (`scripts/ensure-local-settings.mjs`) seeds the runtime keys
automatically — it runs before every `npm run build`, which both commands above
invoke — and only adds missing keys, so any deployment values written by
`rayfin dev functions apply` are preserved. No manual editing needed.

## Calling a function

The schema is passed as the second type parameter of `RayfinClient` (see
`src/services/rayfinClient.ts`), so calls are fully type-checked:

```ts
const greeting = await client.functions.helloWorld.invoke({ firstName: 'Ada' });
const sum = await client.functions.add.invoke({ a: 2, b: 3 });
```

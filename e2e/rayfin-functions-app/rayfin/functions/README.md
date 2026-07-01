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

## Calling a function

The schema is passed as the second type parameter of `RayfinClient` (see
`src/services/rayfinClient.ts`), so calls are fully type-checked:

```ts
const greeting = await client.functions.helloWorld.invoke({ firstName: 'Ada' });
const sum = await client.functions.add.invoke({ a: 2, b: 3 });
```

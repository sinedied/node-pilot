// Rayfin Functions schema (experimental — @microsoft/rayfin-functions).
//
// Each key is a callable backend function; the value declares its `input`
// (an object of named params, or `void` for none) and `output` type. Pass this
// type as the second type parameter of `RayfinClient` so that
// `client.functions.<name>.invoke(...)` calls are fully type-checked:
//
//   const res = await client.functions.helloWorld.invoke({ firstName: 'Ada' });
//
// See src/services/rayfinClient.ts for the wiring.
import type { FunctionsSchema } from '@microsoft/rayfin-functions';

export type AppFunctionsSchema = {
  helloWorld: { input: { firstName: string; lastName?: string }; output: string };
  add: { input: { a: number; b: number }; output: number };
  summarize: { input: { text: string; maxWords?: number }; output: { summary: string } };
};

// Compile-time assertion that the schema conforms to FunctionsSchema.
export type _AssertAppFunctionsSchema = AppFunctionsSchema extends FunctionsSchema
  ? true
  : never;

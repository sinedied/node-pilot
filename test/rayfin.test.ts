// Unit tests for the Rayfin schema/config parsing (src/rayfin.ts): the tolerant
// decorator parser and the DAB permission enrichment (object-form actions +
// pluralized entity-name matching). No network or CLI needed.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hasFuncBin,
  hasLocalRayfinBin,
  hasRayfinAgentFiles,
  interpretLoginStatus,
  mergeEntities,
  parseFunctionHandlers,
  parseFunctionsSchema,
  parseSchema,
  parseSchemaRegistration,
  parseYml,
  rayfinDevFunctionsArgv,
  rayfinLoginStatusArgv,
  readInstalledRayfinVersion,
  readRayfinState,
  rayfinWorkspaceFlag,
  resolveFunctionInvokeUrl,
  resolveFunctionPathSegment,
  resolveFunctionsHostOrigin,
} from "../src/rayfin.ts";

describe("rayfinWorkspaceFlag", () => {
  it("maps a portal URL to --workspace-uri", () => {
    expect(rayfinWorkspaceFlag("https://app.fabric.microsoft.com/groups/abc/list")).toBe(
      "--workspace-uri",
    );
    expect(rayfinWorkspaceFlag("HTTP://example.com")).toBe("--workspace-uri");
  });
  it("maps a bare GUID to --workspace-id", () => {
    expect(rayfinWorkspaceFlag("11111111-2222-3333-4444-555555555555")).toBe("--workspace-id");
    expect(rayfinWorkspaceFlag("AABBCCDD-1234-5678-9ABC-DEF012345678")).toBe("--workspace-id");
  });
  it("maps a display name (or anything else) to --workspace", () => {
    expect(rayfinWorkspaceFlag("My Workspace")).toBe("--workspace");
    expect(rayfinWorkspaceFlag("prod")).toBe("--workspace");
    // GUID-like-but-not-a-GUID stays a name
    expect(rayfinWorkspaceFlag("1234")).toBe("--workspace");
  });
  it("trims surrounding whitespace before detecting the shape", () => {
    expect(rayfinWorkspaceFlag("  https://x.test/  ")).toBe("--workspace-uri");
    expect(rayfinWorkspaceFlag("  11111111-2222-3333-4444-555555555555 ")).toBe("--workspace-id");
  });
});

describe("parseSchema", () => {
  it("parses the canonical one-decorator-per-line shape", () => {
    const ents = parseSchema(`
      @role("admin")
      @entity()
      export class User {
        @uuid()
        id!: string;

        @text({ nullable: true })
        nickname?: string;

        @many(() => Project, "owner")
        projects!: Project[];
      }
    `);
    expect(ents).toHaveLength(1);
    const user = ents[0];
    expect(user.name).toBe("User");
    expect(user.isEntity).toBe(true);
    expect(user.roles).toEqual(["admin"]);
    const byName = Object.fromEntries(user.fields.map((f) => [f.name, f]));
    expect(byName.id.type).toBe("uuid");
    expect(byName.id.optional).toBe(false);
    expect(byName.nickname.optional).toBe(true);
    expect(byName.projects.relation).toEqual({ kind: "many", target: "Project" });
  });

  it("handles a decorator and its property on the same line", () => {
    const ents = parseSchema(`
      export class Tag {
        @text() label!: string;
      }
    `);
    expect(ents[0].fields).toEqual([
      { name: "label", type: "text", optional: false, relation: null },
    ]);
  });

  it("picks the type decorator when several are stacked and merges nullable", () => {
    const ents = parseSchema(`
      export class Note {
        @text()
        @unique()
        @nullable()
        slug: string;
      }
    `);
    const [field] = ents[0].fields;
    expect(field.name).toBe("slug");
    expect(field.type).toBe("text"); // not "unique" / "nullable"
    expect(field.optional).toBe(true); // from @nullable() in the stack
  });

  it("handles decorator args spanning multiple lines", () => {
    const ents = parseSchema(`
      export class Post {
        @text({
          maxLength: 200,
          nullable: true
        })
        title: string;
      }
    `);
    const [field] = ents[0].fields;
    expect(field.type).toBe("text");
    expect(field.optional).toBe(true); // nullable: true inside the multi-line args
  });

  it("returns an empty list for an unrelated file", () => {
    expect(parseSchema("export const x = 1;\n")).toEqual([]);
  });
});

describe("readRayfinState DAB enrichment", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("matches pluralized DAB keys and normalizes object-form actions", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(path.join(rf, "data"), { recursive: true });
    await writeFile(
      path.join(rf, "data", "schema.ts"),
      `@entity()
       export class Category {
         @uuid()
         id!: string;
       }
      `,
    );
    // DAB key "Categories" (pluralized) and an object-form action.
    await writeFile(
      path.join(rf, "dab-config.json"),
      JSON.stringify({
        entities: {
          Categories: {
            permissions: [
              { role: "admin", actions: [{ action: "read" }, "create"] },
              { role: "anonymous", actions: "*" },
            ],
          },
        },
      }),
    );

    const state = await readRayfinState(dir);
    expect("entities" in state).toBe(true);
    if (!("entities" in state)) return;
    const category = state.entities.find((e) => e.name === "Category");
    expect(category).toBeTruthy();
    expect(category?.permissions).toEqual([
      { role: "admin", actions: ["read", "create"] },
      { role: "anonymous", actions: ["*"] },
    ]);
  });

  it("leaves sign-in unknown (null) — resolved by the CLI probe, not a file check", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(path.join(rf, ".rayfin"), { recursive: true });
    // Even with a project-local auth file present, the model no longer reads it.
    await writeFile(path.join(rf, ".rayfin", "auth.json"), "{}");
    const state = await readRayfinState(dir);
    expect("auth" in state).toBe(true);
    if (!("auth" in state)) return;
    expect(state.auth.signedIn).toBeNull();
  });
});

describe("readRayfinState per-entity-file layout", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("surfaces entities defined in their own data/<Entity>.ts (schema.ts only registers)", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const data = path.join(dir, "rayfin", "data");
    await mkdir(data, { recursive: true });
    // Canonical Rayfin: schema.ts aggregates/registers, the @entity lives elsewhere.
    await writeFile(
      path.join(data, "schema.ts"),
      `import { Todo } from './Todo.js';
       export type AppSchema = { Todo: Todo };
       export const schema = [Todo];
      `,
    );
    await writeFile(
      path.join(data, "Todo.ts"),
      `import { entity, role, uuid, text, boolean } from '@microsoft/rayfin-core';
       @entity()
       @role('authenticated', '*', { policy: (c, i) => c.sub.eq(i.user_id) })
       export class Todo {
         @uuid() id!: string;
         @text({ max: 100 }) title!: string;
         @boolean() isCompleted!: boolean;
         @text() user_id!: string;
       }
      `,
    );

    const state = await readRayfinState(dir);
    expect("entities" in state).toBe(true);
    if (!("entities" in state)) return;
    const todo = state.entities.find((e) => e.name === "Todo");
    expect(todo).toBeTruthy();
    expect(todo?.isEntity).toBe(true);
    expect(todo?.roles).toContain("authenticated");
    expect(todo?.fields.map((f) => f.name)).toEqual(["id", "title", "isCompleted", "user_id"]);
  });

  it("merges entities across files and resolves cross-file relations", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const data = path.join(dir, "rayfin", "data");
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "schema.ts"), "export const schema = [];\n");
    await writeFile(
      path.join(data, "User.ts"),
      `import { role, uuid, many } from '@microsoft/rayfin-core';
       import { Project } from './Project.js';
       @role('member')
       export class User {
         @uuid() id!: string;
         @many(() => Project) projects!: Project[];
       }
      `,
    );
    await writeFile(
      path.join(data, "Project.ts"),
      `import { entity, uuid, one } from '@microsoft/rayfin-core';
       import { User } from './User.js';
       @entity()
       export class Project {
         @uuid() id!: string;
         @one(() => User) owner!: User;
       }
      `,
    );

    const state = await readRayfinState(dir);
    expect("entities" in state).toBe(true);
    if (!("entities" in state)) return;
    const names = state.entities.map((e) => e.name).sort();
    expect(names).toEqual(["Project", "User"]);
    const user = state.entities.find((e) => e.name === "User");
    expect(user?.fields.find((f) => f.name === "projects")?.relation).toEqual({
      kind: "many",
      target: "Project",
    });
    const project = state.entities.find((e) => e.name === "Project");
    expect(project?.fields.find((f) => f.name === "owner")?.relation).toEqual({
      kind: "one",
      target: "User",
    });
  });

  it("dedupes by name, keeping the richer definition over an empty re-export stub", () => {
    const stub = [{ name: "Todo", isEntity: false, roles: [], fields: [], permissions: [] }];
    const real = [
      {
        name: "Todo",
        isEntity: true,
        roles: ["authenticated"],
        fields: [{ name: "id", type: "uuid", optional: false, relation: null }],
        permissions: [],
      },
    ];
    // Order-independent: the richer entry wins whether seen first or last.
    expect(mergeEntities(stub, real)[0]).toEqual(real[0]);
    expect(mergeEntities(real, stub)[0]).toEqual(real[0]);
  });

  it("uses schema.ts registration as the authoritative set + order, excluding unregistered classes", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const data = path.join(dir, "rayfin", "data");
    await mkdir(data, { recursive: true });
    // Registration lists Project then User (reverse of alphabetical filenames) and
    // omits Draft — Draft must not appear and order must follow the registration.
    await writeFile(
      path.join(data, "schema.ts"),
      `import { Project } from './Project.js';
       import { User } from './User.js';
       export const schema = [Project, User];
      `,
    );
    await writeFile(
      path.join(data, "User.ts"),
      `import { role, uuid } from '@microsoft/rayfin-core';
       @role('member') export class User { @uuid() id!: string; }
      `,
    );
    await writeFile(
      path.join(data, "Project.ts"),
      `import { entity, uuid } from '@microsoft/rayfin-core';
       @entity() export class Project { @uuid() id!: string; }
      `,
    );
    // An unregistered helper class living in data/ — must be filtered out.
    await writeFile(
      path.join(data, "Draft.ts"),
      `import { entity, uuid } from '@microsoft/rayfin-core';
       @entity() export class Draft { @uuid() id!: string; }
      `,
    );

    const state = await readRayfinState(dir);
    expect("entities" in state).toBe(true);
    if (!("entities" in state)) return;
    expect(state.entities.map((e) => e.name)).toEqual(["Project", "User"]);
  });
});

describe("parseSchemaRegistration", () => {
  it("reads the `export const schema = [...]` array (in order)", () => {
    expect(parseSchemaRegistration("export const schema = [User, Category, Project];")).toEqual([
      "User",
      "Category",
      "Project",
    ]);
  });
  it("falls back to the `type *Schema = { Name: Name }` keys", () => {
    expect(
      parseSchemaRegistration("export type TodoAppSchema = { Todo: Todo; Tag: Tag };"),
    ).toEqual(["Todo", "Tag"]);
  });
  it("returns [] for an empty array or no registration (caller scans all files)", () => {
    expect(parseSchemaRegistration("export const schema = [];")).toEqual([]);
    expect(parseSchemaRegistration("@entity() export class Foo {}")).toEqual([]);
  });
});

describe("parseFunctionsSchema", () => {
  it("extracts the full contract (name, input, output, params) of each function", () => {
    const src = `import type { FunctionsSchema } from '@microsoft/rayfin-functions';
      export type AppFunctionsSchema = {
        helloWorld: { input: { firstName: string; lastName?: string }; output: string };
        add: { input: { a: number; b: number }; output: number };
        summarize: { input: { text: string; maxWords?: number }; output: { summary: string } };
      } satisfies FunctionsSchema;`;
    const fns = parseFunctionsSchema(src);
    expect(fns.map((f) => f.name)).toEqual(["helloWorld", "add", "summarize"]);
    expect(fns[0]).toEqual({
      name: "helloWorld",
      input: "{ firstName: string; lastName?: string }",
      output: "string",
      params: [
        { name: "firstName", type: "string", optional: false },
        { name: "lastName", type: "string", optional: true },
      ],
    });
    expect(fns[2].output).toBe("{ summary: string }");
    expect(fns[2].params).toEqual([
      { name: "text", type: "string", optional: false },
      { name: "maxWords", type: "number", optional: true },
    ]);
  });

  it("walks nested braces without stopping at the first inner `}`", () => {
    const src = `type XSchema = {
      a: { input: { deep: { x: 1 } }; output: void };
      b: { input: Record<string, unknown>; output: string };
    };`;
    const fns = parseFunctionsSchema(src);
    expect(fns.map((f) => f.name)).toEqual(["a", "b"]);
    // `Record<string, unknown>` is not an object literal → no named params.
    expect(fns[1].params).toEqual([]);
    expect(fns[1].input).toBe("Record<string, unknown>");
  });

  it("treats a void / non-object input as having no params", () => {
    const src = `type FnSchema = {
      ping: { input: void; output: string };
    };`;
    const fns = parseFunctionsSchema(src);
    expect(fns[0]).toEqual({ name: "ping", input: "void", output: "string", params: [] });
  });

  it("ignores comments and returns [] when no schema is present", () => {
    expect(parseFunctionsSchema("// helloWorld: nope\n/* add: nope */\nconst x = 1;")).toEqual([]);
  });

  it("prefers the `*FunctionsSchema` alias over an earlier helper `*Schema` type", () => {
    const src = `type HelperSchema = { notAFunction: string };
      export type AppFunctionsSchema = {
        realFn: { input: { x: number }; output: number };
      } satisfies FunctionsSchema;`;
    expect(parseFunctionsSchema(src).map((f) => f.name)).toEqual(["realFn"]);
  });
});

describe("resolveFunctionInvokeUrl", () => {
  it("builds the POST URL for a localhost base URL", () => {
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/api", "add")).toBe(
      "http://127.0.0.1:7071/api/add",
    );
    expect(resolveFunctionInvokeUrl("http://localhost:7071/api/", "helloWorld")).toBe(
      "http://localhost:7071/api/helloWorld",
    );
  });

  it("rejects non-local hosts (no SSRF via the same-origin preview proxy)", () => {
    expect(resolveFunctionInvokeUrl("http://evil.example.com/api", "add")).toBeNull();
    expect(resolveFunctionInvokeUrl("http://169.254.169.254/latest", "add")).toBeNull();
  });

  it("rejects non-http protocols and non-identifier function names", () => {
    expect(resolveFunctionInvokeUrl("file:///etc/passwd", "add")).toBeNull();
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/api", "../secret")).toBeNull();
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/api", "a b")).toBeNull();
    expect(resolveFunctionInvokeUrl("not a url", "add")).toBeNull();
  });

  it("rejects userinfo, query, and fragment (no request shaping)", () => {
    expect(resolveFunctionInvokeUrl("http://user:pass@127.0.0.1:7071/api", "add")).toBeNull();
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/api?x=1", "add")).toBeNull();
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/api#frag", "add")).toBeNull();
  });

  it("rejects deep base paths (no arbitrary local path probing)", () => {
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/a/b/c", "add")).toBeNull();
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:5432/latest/meta-data", "add")).toBeNull();
    // A shallow route-prefix path is still allowed.
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/", "add")).toBe(
      "http://127.0.0.1:7071/add",
    );
  });

  it("uses a static custom route as the path segment when supplied", () => {
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/api", "getUser", "users/list")).toBe(
      "http://127.0.0.1:7071/api/users/list",
    );
  });

  it("falls back to the function name for unsafe/param routes", () => {
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/api", "getUser", "users/{id}")).toBe(
      "http://127.0.0.1:7071/api/getUser",
    );
    expect(resolveFunctionInvokeUrl("http://127.0.0.1:7071/api", "getUser", "../secret")).toBe(
      "http://127.0.0.1:7071/api/getUser",
    );
  });
});

describe("parseFunctionHandlers", () => {
  it("parses app.http registrations (name only → defaults)", () => {
    const h = parseFunctionHandlers(
      `import { app } from "@azure/functions";
       app.http("helloWorld", { handler: async () => ({ body: "hi" }) });`,
    );
    expect(h).toEqual([{ name: "helloWorld", route: null, routeDynamic: false, methods: null }]);
  });

  it("captures a static route and explicit methods", () => {
    const h = parseFunctionHandlers(
      `app.http("getUser", { methods: ["GET", "POST"], route: "users/list", handler: h1 });`,
    );
    expect(h).toEqual([
      { name: "getUser", route: "users/list", routeDynamic: false, methods: ["GET", "POST"] },
    ]);
  });

  it("marks a non-literal (param/dynamic) route as routeDynamic", () => {
    const h = parseFunctionHandlers(
      `app.http('getUser', { route: \`users/\${id}\`, handler: h });`,
    );
    expect(h[0]).toMatchObject({ name: "getUser", route: null, routeDynamic: true });
  });

  it("marks a static route carrying route params/wildcards as routeDynamic", () => {
    const h = parseFunctionHandlers(`app.http("getUser", { route: "users/{id}", handler: h });`);
    expect(h[0]).toMatchObject({ name: "getUser", route: null, routeDynamic: true });
    const w = parseFunctionHandlers(`app.http("files", { route: "files/{*path}", handler: h });`);
    expect(w[0]).toMatchObject({ name: "files", route: null, routeDynamic: true });
  });

  it("dedupes repeated names and ignores commented-out registrations", () => {
    const h = parseFunctionHandlers(
      `app.http("a", { handler: x });
       // app.http("commented", { handler: y });
       app.http("a", { handler: z });
       app.http("b", { handler: w });`,
    );
    expect(h.map((x) => x.name)).toEqual(["a", "b"]);
  });
});

describe("resolveFunctionPathSegment", () => {
  it("prefers a safe static route, else the function name", () => {
    expect(resolveFunctionPathSegment("getUser", "users/list")).toBe("users/list");
    expect(resolveFunctionPathSegment("getUser", null)).toBe("getUser");
    expect(resolveFunctionPathSegment("getUser", "/leading/")).toBe("leading");
  });

  it("falls back to the name for traversal or unexpected characters", () => {
    expect(resolveFunctionPathSegment("getUser", "../x")).toBe("getUser");
    expect(resolveFunctionPathSegment("getUser", "a b")).toBe("getUser");
  });
});

describe("resolveFunctionsHostOrigin", () => {
  it("returns the localhost origin", () => {
    expect(resolveFunctionsHostOrigin("http://127.0.0.1:7071/api")).toBe("http://127.0.0.1:7071");
    expect(resolveFunctionsHostOrigin("http://localhost:7071/api/")).toBe("http://localhost:7071");
  });

  it("rejects non-local or non-http URLs", () => {
    expect(resolveFunctionsHostOrigin("http://evil.example.com/api")).toBeNull();
    expect(resolveFunctionsHostOrigin("file:///tmp")).toBeNull();
    expect(resolveFunctionsHostOrigin("not a url")).toBeNull();
  });

  it("rejects deep base paths", () => {
    expect(resolveFunctionsHostOrigin("http://127.0.0.1:7071/a/b")).toBeNull();
  });
});

describe("rayfinDevFunctionsArgv", () => {
  it("builds `rayfin -y dev functions apply` via the detected package manager", () => {
    expect(rayfinDevFunctionsArgv("npm")).toEqual([
      "npm",
      "exec",
      "--",
      "rayfin",
      "-y",
      "dev",
      "functions",
      "apply",
    ]);
    expect(rayfinDevFunctionsArgv("pnpm")).toEqual([
      "pnpm",
      "exec",
      "rayfin",
      "-y",
      "dev",
      "functions",
      "apply",
    ]);
  });
});

describe("hasFuncBin", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("returns false when func is absent from PATH and node_modules", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "np-func-"));
    dirs.push(dir);
    expect(hasFuncBin(dir, { PATH: "" })).toBe(false);
  });

  it("finds func on PATH", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "np-func-"));
    dirs.push(dir);
    const bin = path.join(dir, "bin");
    await mkdir(bin, { recursive: true });
    const name = process.platform === "win32" ? "func.exe" : "func";
    await writeFile(path.join(bin, name), "");
    expect(hasFuncBin(dir, { PATH: bin })).toBe(true);
  });
});

describe("readRayfinState functions gating", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("lists functions from functions/src/types.ts when functions are enabled", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(path.join(rf, "functions", "src"), { recursive: true });
    await writeFile(
      path.join(rf, "rayfin.yml"),
      `name: Fn App
version: 1.0.0
services:
  functions:
    enabled: true
`,
    );
    await writeFile(
      path.join(rf, "functions", "src", "types.ts"),
      `import type { FunctionsSchema } from '@microsoft/rayfin-functions';
       export type AppFunctionsSchema = {
         helloWorld: { input: { name: string }; output: string };
         add: { input: { a: number; b: number }; output: number };
       } satisfies FunctionsSchema;`,
    );

    const state = await readRayfinState(dir);
    expect("functions" in state).toBe(true);
    if (!("functions" in state)) return;
    expect(state.functions.map((f) => f.name)).toEqual(["helloWorld", "add"]);
    expect(state.config?.functionsEnabled).toBe(true);
  });

  it("cross-checks the schema against app.http() handlers (hasHandler + orphanHandlers)", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(path.join(rf, "functions", "src"), { recursive: true });
    await writeFile(
      path.join(rf, "rayfin.yml"),
      `name: Fn App
version: 1.0.0
services:
  functions:
    enabled: true
`,
    );
    await writeFile(
      path.join(rf, "functions", "src", "types.ts"),
      `import type { FunctionsSchema } from '@microsoft/rayfin-functions';
       export type AppFunctionsSchema = {
         helloWorld: { input: { name: string }; output: string };
         add: { input: { a: number; b: number }; output: number };
       } satisfies FunctionsSchema;`,
    );
    // `helloWorld` has a handler; `add` doesn't; `strayFn` is a handler with no
    // schema entry (an orphan).
    await writeFile(
      path.join(rf, "functions", "src", "handlers.ts"),
      `app.http('helloWorld', { methods: ['POST'], handler: hw });
       app.http("strayFn", { methods: ['POST'], handler: stray });`,
    );

    const state = await readRayfinState(dir);
    expect("functions" in state).toBe(true);
    if (!("functions" in state)) return;
    const byName = Object.fromEntries(state.functions.map((f) => [f.name, f.hasHandler]));
    expect(byName).toEqual({ helloWorld: true, add: false });
    expect(state.orphanHandlers).toEqual(["strayFn"]);
  });

  it("reports no functions when the directory is absent (section stays gated off)", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(rf, { recursive: true });
    await writeFile(
      path.join(rf, "rayfin.yml"),
      `name: Plain App
version: 1.0.0
services:
  data:
    enabled: true
    dialect: mssql
`,
    );

    const state = await readRayfinState(dir);
    expect("functions" in state).toBe(true);
    if (!("functions" in state)) return;
    expect(state.functions).toEqual([]);
    expect(state.config?.functionsEnabled).toBeFalsy();
  });

  it("does not surface `src` as a function when the schema file is present but empty", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(path.join(rf, "functions", "src"), { recursive: true });
    await writeFile(path.join(rf, "rayfin.yml"), "name: Empty Fn App\nversion: 1.0.0\n");
    // Schema file exists but declares nothing — its keys are authoritative, so the
    // `src/` dir must NOT leak through as a bogus function via the legacy fallback.
    await writeFile(
      path.join(rf, "functions", "src", "types.ts"),
      "import type { FunctionsSchema } from '@microsoft/rayfin-functions';\n",
    );

    const state = await readRayfinState(dir);
    expect("functions" in state).toBe(true);
    if (!("functions" in state)) return;
    expect(state.functions).toEqual([]);
  });

  it("falls back to per-subdir listing for the legacy functions layout", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(path.join(rf, "functions", "hello"), { recursive: true });
    await mkdir(path.join(rf, "functions", "world"), { recursive: true });
    await writeFile(
      path.join(rf, "rayfin.yml"),
      `name: Legacy Fn App
version: 1.0.0
services:
  functions:
    enabled: true
`,
    );

    const state = await readRayfinState(dir);
    expect("functions" in state).toBe(true);
    if (!("functions" in state)) return;
    expect(state.functions.map((f) => f.name)).toEqual(["hello", "world"]);
  });
});

describe("readRayfinState deployment mapping", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads the real fabric*-prefixed deployment fields (the Fabric workspace + API links)", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-dep-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(rf, { recursive: true });
    await writeFile(
      path.join(rf, ".deployments.json"),
      JSON.stringify({
        active: "prod",
        deployments: {
          prod: {
            fabricItemId: "item-123",
            fabricApiUrl: "https://app.example/api",
            fabricWorkspaceId: "ws-456",
            fabricTenantId: "tenant-789",
            fabricDeepLink: "https://fabric.example/groups/ws-456/items/item-123",
            hostingUrl: "https://app.example",
            deployedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const state = await readRayfinState(dir);
    const active = state.deployments.list.find((d) => d.active);
    expect(active).toBeTruthy();
    expect(active?.itemId).toBe("item-123");
    expect(active?.apiUrl).toBe("https://app.example/api"); // API endpoint link
    expect(active?.workspaceId).toBe("ws-456");
    expect(active?.tenantId).toBe("tenant-789");
    expect(active?.hostingUrl).toBe("https://app.example"); // Open app link
    expect(active?.portalUrl).toBe("https://fabric.example/groups/ws-456/items/item-123"); // Open Fabric workspace
  });

  it("falls back to legacy/un-prefixed field names and composes a portal URL from the workspace id", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-dep-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(rf, { recursive: true });
    await writeFile(
      path.join(rf, ".deployments.json"),
      JSON.stringify({
        active: "legacy",
        deployments: {
          legacy: {
            itemId: "old-item",
            apiUrl: "https://legacy.example/api",
            workspaceId: "old-ws",
            hostingUrl: "https://legacy.example",
          },
        },
      }),
    );
    const state = await readRayfinState(dir);
    const active = state.deployments.list.find((d) => d.active);
    expect(active?.itemId).toBe("old-item");
    expect(active?.apiUrl).toBe("https://legacy.example/api");
    expect(active?.workspaceId).toBe("old-ws");
    // No deepLink/portalUrl on disk → composed from the workspace GUID.
    expect(active?.portalUrl).toBe("https://app.fabric.microsoft.com/groups/old-ws");
  });

  it("treats empty prefixed fields as absent and falls back to a populated legacy alias", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-dep-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(rf, { recursive: true });
    await writeFile(
      path.join(rf, ".deployments.json"),
      JSON.stringify({
        active: "mixed",
        deployments: {
          mixed: {
            fabricItemId: "",
            fabricApiUrl: "   ",
            fabricWorkspaceId: "",
            apiUrl: "https://legacy.example/api",
            workspaceId: "legacy-ws",
            itemId: "legacy-item",
            fabricDeepLink: "",
            portalUrl: "https://legacy.example/portal",
            hostingUrl: "",
          },
        },
      }),
    );
    const state = await readRayfinState(dir);
    const active = state.deployments.list.find((d) => d.active);
    // Empty fabric* strings must not shadow the populated legacy aliases.
    expect(active?.itemId).toBe("legacy-item");
    expect(active?.apiUrl).toBe("https://legacy.example/api");
    expect(active?.workspaceId).toBe("legacy-ws");
    // Empty fabricDeepLink → legacy portalUrl.
    expect(active?.portalUrl).toBe("https://legacy.example/portal");
    // Empty hostingUrl normalizes to null (no broken "Open app" link).
    expect(active?.hostingUrl).toBeNull();
  });
});

describe("parseYml auth methods", () => {
  it("derives auth methods from the real nested provider blocks", () => {
    const yml = parseYml(`name: My App
services:
  auth:
    enabled: true
    fabric:
      enabled: true
    password:
      enabled: true
  data:
    dialect: mssql`);
    expect(yml.name).toBe("My App");
    expect(yml.dialect).toBe("mssql");
    expect(yml.authMethods).toEqual(["fabric", "password"]);
  });

  it("ignores a provider block that is not enabled", () => {
    const yml = parseYml(`services:
  auth:
    fabric:
      enabled: true
    password:
      enabled: false`);
    expect(yml.authMethods).toEqual(["fabric"]);
  });

  it("falls back to a flat methods: list when no provider blocks are present", () => {
    const yml = parseYml(`services:
  auth:
    methods:
      - fabric
      - password`);
    expect(yml.authMethods).toEqual(["fabric", "password"]);
  });
});

describe("parseYml service flags", () => {
  const full = `id: demo
name: Demo App
version: 2.4.1
services:
  auth:
    enabled: true
    fabric:
      enabled: true
  data:
    enabled: true
    dialect: mssql
  staticHosting:
    enabled: true
    folder: dist
    buildCommand: npm run build:fabric
    indexDocument: index.html
  storage:
    enabled: true
  functions:
    enabled: false`;

  it("reads the top-level app version", () => {
    expect(parseYml(full).version).toBe("2.4.1");
  });

  it("reads each service's immediate enabled flag (not a nested provider's)", () => {
    const yml = parseYml(full);
    expect(yml.storageEnabled).toBe(true);
    expect(yml.functionsEnabled).toBe(false);
  });

  it("reads staticHosting folder + build command", () => {
    const sh = parseYml(full).staticHosting;
    expect(sh?.folder).toBe("dist");
    expect(sh?.buildCommand).toBe("npm run build:fabric");
    expect(sh?.indexDocument).toBe("index.html");
  });

  it("distinguishes an absent service (null) from an explicit enabled: false", () => {
    const yml = parseYml(`name: No Extras
services:
  data:
    enabled: true
    dialect: postgresql`);
    expect(yml.storageEnabled).toBeNull();
    expect(yml.functionsEnabled).toBeNull();
    expect(yml.version).toBeNull();
    expect(yml.dialect).toBe("postgresql");
  });

  it("reads only the service's own enabled flag, never a nested child's", () => {
    // `functions:` has no direct `enabled:`, only a nested provider that does —
    // service enablement must stay null (unknown), not inherit the child value.
    const yml = parseYml(`services:
  functions:
    runtime:
      enabled: true`);
    expect(yml.functionsEnabled).toBeNull();
  });

  it("tolerates a trailing comment on the service key line", () => {
    const yml = parseYml(`services:
  storage: # experimental
    enabled: true`);
    expect(yml.storageEnabled).toBe(true);
  });
});

describe("hasRayfinAgentFiles", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("is true when the CLI lockfile marker is present", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-af-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(rf, { recursive: true });
    await writeFile(path.join(rf, ".lockfile.json"), JSON.stringify({ items: {}, version: 1 }));
    expect(hasRayfinAgentFiles(dir, rf)).toBe(true);
  });

  it("falls back to AGENTS.md + .mcp.json when there is no lockfile", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-af-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(rf, { recursive: true });
    await writeFile(path.join(dir, "AGENTS.md"), "# agents");
    await writeFile(path.join(dir, ".mcp.json"), "{}");
    expect(hasRayfinAgentFiles(dir, rf)).toBe(true);
  });

  it("is false when neither the lockfile nor both fallback files exist", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-af-"));
    const rf = path.join(dir, "rayfin");
    await mkdir(rf, { recursive: true });
    await writeFile(path.join(dir, "AGENTS.md"), "# agents"); // only one of the two
    expect(hasRayfinAgentFiles(dir, rf)).toBe(false);
  });
});

describe("readInstalledRayfinVersion", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function writePkg(base: string, pkg: string, version: string): Promise<void> {
    const pkgDir = path.join(base, "node_modules", ...pkg.split("/"));
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  }

  it("reads the CLI version from node_modules", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-ver-"));
    await writePkg(dir, "@microsoft/rayfin-cli", "1.33.2");
    expect(readInstalledRayfinVersion(dir)).toBe("1.33.2");
  });

  it("falls back to the SDK core when the CLI is absent", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-ver-"));
    await writePkg(dir, "@microsoft/rayfin-core", "1.30.0");
    expect(readInstalledRayfinVersion(dir)).toBe("1.30.0");
  });

  it("walks up to a hoisted monorepo install", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-ver-"));
    await writePkg(dir, "@microsoft/rayfin-cli", "1.33.2");
    const nested = path.join(dir, "packages", "app");
    await mkdir(nested, { recursive: true });
    expect(readInstalledRayfinVersion(nested)).toBe("1.33.2");
  });

  it("returns null when no Rayfin package is installed", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-ver-"));
    expect(readInstalledRayfinVersion(dir)).toBeNull();
  });
});

describe("rayfinLoginStatusArgv", () => {
  it("builds an exec for each package manager (npm gets --no)", () => {
    expect(rayfinLoginStatusArgv("npm")).toEqual([
      "npm",
      "exec",
      "--no",
      "--",
      "rayfin",
      "login",
      "status",
    ]);
    expect(rayfinLoginStatusArgv("pnpm")).toEqual(["pnpm", "exec", "rayfin", "login", "status"]);
    expect(rayfinLoginStatusArgv("yarn")).toEqual([
      "yarn",
      "exec",
      "--",
      "rayfin",
      "login",
      "status",
    ]);
    expect(rayfinLoginStatusArgv("bun")).toEqual(["bun", "x", "rayfin", "login", "status"]);
  });
});

describe("hasLocalRayfinBin", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("is false when the bin is absent", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-bin-"));
    expect(hasLocalRayfinBin(dir)).toBe(false);
  });

  it("is true when node_modules/.bin/rayfin exists", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-bin-"));
    const bin = path.join(dir, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "rayfin"), "#!/bin/sh\n");
    expect(hasLocalRayfinBin(dir)).toBe(true);
  });

  it("walks up to find a hoisted monorepo bin", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "np-rayfin-bin-"));
    const bin = path.join(dir, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "rayfin"), "#!/bin/sh\n");
    const member = path.join(dir, "packages", "app");
    await mkdir(member, { recursive: true });
    expect(hasLocalRayfinBin(member)).toBe(true);
  });
});

describe("interpretLoginStatus", () => {
  it("maps exit 0 to signed in", () => {
    expect(interpretLoginStatus({ code: 0 })).toBe(true);
  });
  it("maps a positive exit code to signed out", () => {
    expect(interpretLoginStatus({ code: 1 })).toBe(false);
    expect(interpretLoginStatus({ code: 2 })).toBe(false);
  });
  it("maps spawn errors and negative/killed exits to unknown (null)", () => {
    expect(interpretLoginStatus({ code: -1, error: "ENOENT" })).toBeNull();
    expect(interpretLoginStatus({ code: -1 })).toBeNull();
    expect(interpretLoginStatus({ code: 0, error: "boom" })).toBeNull();
  });
});

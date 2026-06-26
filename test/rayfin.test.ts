// Unit tests for the Rayfin schema/config parsing (src/rayfin.ts): the tolerant
// decorator parser and the DAB permission enrichment (object-form actions +
// pluralized entity-name matching). No network or CLI needed.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSchema, readRayfinState, rayfinWorkspaceFlag } from "../src/rayfin.ts";

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
});

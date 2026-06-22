// Integration tests for the tsserver client (src/ts-server.ts). Spawns the
// repo's own tsserver against temp fixtures and asserts project-wide
// diagnostics surface (and clear) correctly. No network needed.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TsServerClient,
  findRepresentativeFile,
  resolveNodePath,
  resolveTsserverPath,
} from "../src/ts-server.ts";

const STRICT_TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true },
});

async function makeProject(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "np-tsls-"));
  await writeFile(path.join(dir, "tsconfig.json"), STRICT_TSCONFIG);
  await writeFile(path.join(dir, "index.ts"), source);
  return dir;
}

const dirs: string[] = [];
const clients: TsServerClient[] = [];

function client(cwd: string): TsServerClient {
  const tsserverPath = resolveTsserverPath(process.cwd());
  if (!tsserverPath) throw new Error("tsserver not resolvable from the repo");
  const c = new TsServerClient(cwd, tsserverPath);
  clients.push(c);
  return c;
}

afterEach(async () => {
  while (clients.length) clients.pop()?.stop();
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("resolveTsserverPath", () => {
  it("resolves the project's own tsserver entry point", () => {
    const p = resolveTsserverPath(process.cwd());
    expect(p).toBeTruthy();
    expect(p).toMatch(/typescript[\\/]lib[\\/]tsserver\.js$/);
  });

  it("returns null when typescript is not installed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "np-nots-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "package.json"), "{}");
    expect(resolveTsserverPath(dir)).toBeNull();
  });
});

describe("findRepresentativeFile", () => {
  it("prefers a TypeScript source file", async () => {
    const dir = await makeProject("export const x = 1;\n");
    dirs.push(dir);
    expect(findRepresentativeFile(dir)).toBe(path.join(dir, "index.ts"));
  });

  it("prefers a source-dir file over an excluded root config file", async () => {
    // Regression: a root-level *.config.ts is usually excluded from the
    // project's tsconfig `include`, so opening it lands tsserver in an empty
    // inferred project. The picker must reach into src/ instead.
    const dir = await mkdtemp(path.join(os.tmpdir(), "np-tsls-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "vitest.config.ts"), "export default {};\n");
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
    expect(findRepresentativeFile(dir)).toBe(path.join(dir, "src", "index.ts"));
  });
});

describe("resolveNodePath", () => {
  it("resolves a real node executable", () => {
    const node = resolveNodePath();
    expect(node).toBeTruthy();
    expect(existsSync(node)).toBe(true);
  });
});

describe("TsServerClient.getProjectDiagnostics", () => {
  it("reports a type error at the right position", async () => {
    const dir = await makeProject('const x: number = "s";\nexport const y = x;\n');
    dirs.push(dir);
    const c = client(dir);
    const diags = await c.getProjectDiagnostics();

    // Only the fixture file — no node_modules / lib.d.ts noise.
    expect(diags.every((d) => d.file.startsWith(dir))).toBe(true);
    const ts2322 = diags.find((d) => d.code === 2322);
    expect(ts2322).toBeTruthy();
    expect(ts2322?.category).toBe("error");
    expect(ts2322?.start).toEqual({ line: 1, offset: 7 });
  }, 25000);

  it("returns no diagnostics for a clean project", async () => {
    const dir = await makeProject("export const x: number = 1;\n");
    dirs.push(dir);
    const c = client(dir);
    const diags = await c.getProjectDiagnostics();
    expect(diags).toEqual([]);
  }, 25000);

  it("clears diagnostics after the file is fixed on disk", async () => {
    const dir = await makeProject('const x: number = "s";\nexport const y = x;\n');
    dirs.push(dir);
    const c = client(dir);
    expect((await c.getProjectDiagnostics()).length).toBeGreaterThan(0);

    await writeFile(path.join(dir, "index.ts"), "const x: number = 1;\nexport const y = x;\n");
    c.reload();
    expect(await c.getProjectDiagnostics()).toEqual([]);
  }, 25000);
});

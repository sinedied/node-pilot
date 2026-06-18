// Unit tests for the lazy project-stats helpers (src/info.ts) against a temp
// fixture tree. No network needed; npm pack --dry-run runs offline.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { walkNodeModules, buildOutputSize, packSize, computeStats } from "../src/info.ts";
import { formatBytes } from "../src/util.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "np-info-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture-pkg", version: "1.2.3" }, null, 2),
  );
  await writeFile(path.join(dir, "index.js"), "export const x = 1;\n");

  // Build output dir.
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "dist", "out.js"), "console.log('built');\n");

  // node_modules: one plain package, one scoped package with a nested dep,
  // plus a .bin dir that must be ignored (no package.json).
  const nm = path.join(dir, "node_modules");
  await mkdir(path.join(nm, "foo"), { recursive: true });
  await writeFile(path.join(nm, "foo", "package.json"), `{"name":"foo","version":"1.0.0"}`);
  await writeFile(path.join(nm, "foo", "index.js"), "module.exports = 1;\n");

  await mkdir(path.join(nm, "@scope", "bar", "node_modules", "baz"), { recursive: true });
  await writeFile(path.join(nm, "@scope", "bar", "package.json"), `{"name":"@scope/bar"}`);
  await writeFile(path.join(nm, "@scope", "bar", "index.js"), "module.exports = 2;\n");
  await writeFile(
    path.join(nm, "@scope", "bar", "node_modules", "baz", "package.json"),
    `{"name":"baz"}`,
  );

  await mkdir(path.join(nm, ".bin"), { recursive: true });
  await writeFile(path.join(nm, ".bin", "foo"), "#!/bin/sh\n");
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("walkNodeModules", () => {
  it("counts installed packages including scoped + nested, ignoring .bin", async () => {
    const res = await walkNodeModules(dir);
    expect(res).not.toBeNull();
    expect(res?.installedCount).toBe(3); // foo, @scope/bar, baz
    expect(res?.installBytes).toBeGreaterThan(0);
  });

  it("returns null when there is no node_modules", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "np-info-empty-"));
    try {
      expect(await walkNodeModules(empty)).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("buildOutputSize", () => {
  it("finds and measures a known output dir", async () => {
    const res = await buildOutputSize(dir);
    expect(res?.dir).toBe("dist");
    expect(res?.bytes).toBeGreaterThan(0);
  });

  it("returns null when no build output exists", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "np-info-nobuild-"));
    try {
      expect(await buildOutputSize(empty)).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("packSize", () => {
  it("parses npm pack --dry-run --json output", async () => {
    const res = await packSize(dir);
    expect(res).not.toBeNull();
    expect(res?.packedBytes).toBeGreaterThan(0);
    expect(res?.entryCount).toBeGreaterThanOrEqual(1);
  });
});

describe("computeStats", () => {
  it("skips the pack step when the package is not publishable", async () => {
    const stats = await computeStats(dir, false);
    expect(stats.pack).toBeNull();
    expect(stats.installedCount).toBe(3);
    expect(stats.build?.dir).toBe("dist");
  });
});

describe("formatBytes", () => {
  it("formats byte counts in base-1000 units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1500)).toBe("1.5 kB");
    expect(formatBytes(2_000_000)).toBe("2.0 MB");
    expect(formatBytes(null)).toBe("—");
  });
});

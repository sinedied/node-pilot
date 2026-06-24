// Functional test for the dependency safe-update loop. Requires network access
// (npm install); when offline, the whole suite is skipped rather than failing.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Controller } from "../src/controller.ts";

const dir = await mkdtemp(path.join(os.tmpdir(), "np-deps-"));
const manifest = path.join(dir, "package.json");
await writeFile(
  manifest,
  JSON.stringify(
    {
      name: "deps-sample",
      version: "1.0.0",
      // Deliberately one patch behind: is-odd 3.0.0 (latest 3.0.1).
      dependencies: { "is-odd": "3.0.0" },
      scripts: { build: 'node -e "process.exit(1)"' },
    },
    null,
    2,
  ),
);

const inst = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
  cwd: dir,
  encoding: "utf8",
  timeout: 120000,
});
const online = inst.status === 0;

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(!online)("dependency safe-update loop", () => {
  const controller = new Controller(dir, { autoRun: false, sendToChat: async () => {} });

  it("lists is-odd as an outdated patch bump", async () => {
    await controller.init();
    const od = await controller.listOutdated();
    const isOdd = od.list.find((p) => p.name === "is-odd");
    expect(isOdd).toBeTruthy();
    expect(isOdd?.bump).toBe("patch");
  });

  it("rolls back a package whose verify step fails", async () => {
    const r1 = await controller.safeUpdate({ scope: "patch", verify: ["build"] });
    expect(r1.failed?.some((f) => f.name === "is-odd")).toBe(true);
    expect(r1.kept?.length).toBe(0);
    const after = JSON.parse(await readFile(manifest, "utf8"));
    expect(after.dependencies["is-odd"]).toBe("3.0.0");
  });

  it("keeps and bumps a package when verify passes", async () => {
    const r2 = await controller.safeUpdate({ scope: "patch", verify: [] });
    expect(r2.kept?.some((t) => t.name === "is-odd")).toBe(true);
    const after = JSON.parse(await readFile(manifest, "utf8"));
    expect(after.dependencies["is-odd"]).toMatch(/3\.0\.1/);
  });
});

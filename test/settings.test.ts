import { describe, it, expect } from "vitest";
import { migrate } from "../src/settings.ts";
import { defaultPinnedTasks } from "../src/lanes.ts";
import type { ProjectDetection } from "../src/types.ts";

describe("settings migration", () => {
  it("keeps a new pinnedTasks list and drops invalid entries", () => {
    const out = migrate({
      pinnedTasks: [
        { type: "lane", id: "build" },
        { type: "script", name: "ci" },
        { type: "lane", id: "bogus" },
        { type: "script" },
        null,
      ],
      theme: "dark",
    } as never);
    expect(out.pinnedTasks).toEqual([
      { type: "lane", id: "build" },
      { type: "script", name: "ci" },
    ]);
    expect(out.theme).toBe("dark");
  });

  it("migrates legacy pinnedScripts to script tasks, never to lanes", () => {
    const out = migrate({ pinnedScripts: ["build", "release", "test"] });
    expect(out.pinnedTasks).toEqual([
      { type: "script", name: "build" },
      { type: "script", name: "release" },
      { type: "script", name: "test" },
    ]);
  });

  it("treats a legacy empty pinnedScripts as an intentional empty list", () => {
    const out = migrate({ pinnedScripts: [] });
    expect(out.pinnedTasks).toEqual([]);
  });

  it("returns null pinnedTasks when there is no config (use defaults)", () => {
    expect(migrate(undefined).pinnedTasks).toBeNull();
    expect(migrate({ theme: "light" }).pinnedTasks).toBeNull();
  });

  it("defaults the on-load auto-runs ON, but respects an explicit false", () => {
    const fresh = migrate(undefined);
    expect(fresh.autoLint).toBe(true);
    expect(fresh.autoTest).toBe(true);
    expect(fresh.autoDeps).toBe(true);
    const off = migrate({ autoLint: false, autoTest: false, autoDeps: false } as never);
    expect(off.autoLint).toBe(false);
    expect(off.autoTest).toBe(false);
    expect(off.autoDeps).toBe(false);
  });
});

describe("defaultPinnedTasks", () => {
  it("is empty without a project", () => {
    expect(defaultPinnedTasks(null)).toEqual([]);
    expect(defaultPinnedTasks({ hasProject: false } as never)).toEqual([]);
  });

  it("pins available built-in lanes in toolbar order", () => {
    const detection = {
      hasProject: true,
      pm: "npm",
      framework: { id: null },
      linter: null,
      formatter: null,
      scripts: { build: "tsc", test: "vitest" },
      scriptNames: ["build", "test"],
      deps: {},
      devDeps: {},
      typescript: true,
    } as unknown as ProjectDetection;
    const tasks = defaultPinnedTasks(detection);
    const ids = tasks.map((t) => (t.type === "lane" ? t.id : t.name));
    expect(tasks.every((t) => t.type === "lane")).toBe(true);
    expect(ids).toContain("build");
    expect(ids).toContain("test");
    // dev is never a pinned task (it lives in its own tab).
    expect(ids).not.toContain("dev");
    // order follows the toolbar order (build before test).
    expect(ids.indexOf("build")).toBeLessThan(ids.indexOf("test"));
  });

  it("lists script-less specials first, then script-backed in package.json order", () => {
    const detection = {
      hasProject: true,
      pm: "npm",
      framework: { id: null },
      linter: "biome",
      formatter: "biome",
      testRunner: null,
      // Declared order puts `test` before `build`.
      scripts: { test: "vitest run", build: "tsc" },
      scriptNames: ["test", "build"],
      deps: {},
      devDeps: {},
      typescript: true,
    } as unknown as ProjectDetection;
    const ids = defaultPinnedTasks(detection).map((t) => (t.type === "lane" ? t.id : t.name));
    // Lint + Format are available via Biome but have no backing script, so they
    // come first (in lane order); then the script-backed specials follow their
    // package.json index (test before build).
    expect(ids).toEqual(["lint", "format", "test", "build"]);
  });

  it("drops type-check as a promoted task", () => {
    const detection = {
      hasProject: true,
      pm: "npm",
      framework: { id: null },
      linter: null,
      formatter: null,
      testRunner: null,
      scripts: { typecheck: "tsc --noEmit", build: "tsc" },
      scriptNames: ["typecheck", "build"],
      deps: {},
      devDeps: {},
      typescript: true,
    } as unknown as ProjectDetection;
    const ids = defaultPinnedTasks(detection).map((t) => (t.type === "lane" ? t.id : t.name));
    expect(ids).not.toContain("typecheck");
  });
});

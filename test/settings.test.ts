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
});

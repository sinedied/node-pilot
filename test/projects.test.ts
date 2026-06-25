// Monorepo / multi-project discovery + project switching tests.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enumerateProjects } from "../src/projects.ts";
import { Controller } from "../src/controller.ts";

async function pkg(dir: string, json: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(json, null, 2));
}

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("enumerateProjects — workspaces", () => {
  it("resolves npm `workspaces` globs into members grouped under the root", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "np-ws-"));
    await pkg(root, { name: "monorepo", private: true, workspaces: ["packages/*"] });
    await pkg(path.join(root, "packages/a"), { name: "@scope/a" });
    await pkg(path.join(root, "packages/b"), { name: "@scope/b" });

    const out = await enumerateProjects(root);
    const names = out.map((p) => p.name);
    expect(names).toEqual(["monorepo", "@scope/a", "@scope/b"]);
    // Root first, members grouped under the root's name.
    expect(out[0]).toMatchObject({ rel: ".", isWorkspaceRoot: true, group: "monorepo" });
    expect(out[1]).toMatchObject({ rel: "packages/a", group: "monorepo" });
    expect(out.every((p) => p.group === "monorepo")).toBe(true);
  });

  it("supports the `{ packages: [...] }` workspaces object form", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "np-wsobj-"));
    await pkg(root, { name: "root", workspaces: { packages: ["apps/web"] } });
    await pkg(path.join(root, "apps/web"), { name: "web" });

    const out = await enumerateProjects(root);
    expect(out.map((p) => p.name)).toEqual(["root", "web"]);
  });

  it("reads pnpm-workspace.yaml package globs", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "np-pnpm-"));
    await pkg(root, { name: "pnpm-root" });
    await writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n  - 'tools/cli'\n",
    );
    await pkg(path.join(root, "apps/site"), { name: "site" });
    await pkg(path.join(root, "tools/cli"), { name: "cli" });

    const out = await enumerateProjects(root);
    expect(out.map((p) => p.name).sort()).toEqual(["cli", "pnpm-root", "site"]);
    // pnpm-workspace.yaml marks the root as a workspace root.
    expect(out.find((p) => p.rel === ".")?.isWorkspaceRoot).toBe(true);
  });
});

describe("enumerateProjects — scan", () => {
  it("finds standalone sibling packages under 'Other projects'", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "np-multi-"));
    await pkg(root, { name: "app-root" });
    await pkg(path.join(root, "frontend"), { name: "frontend" });
    await pkg(path.join(root, "backend"), { name: "backend" });

    const out = await enumerateProjects(root);
    expect(out.map((p) => p.name)).toEqual(["app-root", "backend", "frontend"]);
    expect(out[0].group).toBe("app-root");
    expect(out[1].group).toBe("Other projects");
    expect(out[2].group).toBe("Other projects");
  });

  it("excludes node_modules / dist / coverage and other noise dirs", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "np-noise-"));
    await pkg(root, { name: "root" });
    await pkg(path.join(root, "real"), { name: "real" });
    await pkg(path.join(root, "node_modules/dep"), { name: "dep" });
    await pkg(path.join(root, "dist/bundle"), { name: "bundle" });
    await pkg(path.join(root, "coverage/x"), { name: "cov" });
    await pkg(path.join(root, "examples/demo"), { name: "demo" });

    const out = await enumerateProjects(root);
    expect(out.map((p) => p.name)).toEqual(["root", "real"]);
  });

  it("de-duplicates a workspace member also reachable by the scan", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "np-dedup-"));
    await pkg(root, { name: "root", workspaces: ["packages/*"] });
    await pkg(path.join(root, "packages/a"), { name: "a" });

    const out = await enumerateProjects(root);
    expect(out.map((p) => p.name)).toEqual(["root", "a"]);
    expect(out.filter((p) => p.name === "a")).toHaveLength(1);
  });

  it("returns just the root for a single-project repo", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "np-single-"));
    await pkg(root, { name: "solo" });

    const out = await enumerateProjects(root);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "solo", rel: "." });
  });
});

describe("Controller.setActiveProject", () => {
  let prevHome: string | undefined;
  let home: string;

  beforeAll(async () => {
    // Redirect ~/.cockpit writes into a temp HOME so the selection persistence
    // doesn't touch the developer's real settings file.
    home = await mkdtemp(path.join(os.tmpdir(), "np-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterAll(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it("switches the active project, validates targets, and re-anchors cwd", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "np-switch-"));
    await pkg(root, { name: "root", workspaces: ["packages/*"] });
    await pkg(path.join(root, "packages/a"), { name: "a" });
    const member = path.join(root, "packages/a");

    const controller = new Controller(root, { autoRun: false });
    await controller.init();

    const projects = await controller.getProjects();
    expect(projects.multi).toBe(true);
    expect(projects.active).toBe(root);

    // Unknown target is rejected.
    const bad = await controller.setActiveProject(path.join(root, "nope"));
    expect(bad.ok).toBe(false);
    expect(controller.cwd).toBe(root);

    // Empty target is rejected.
    expect((await controller.setActiveProject(undefined)).ok).toBe(false);

    // Valid member focuses it.
    const ok = await controller.setActiveProject(member);
    expect(ok.ok).toBe(true);
    expect(controller.cwd).toBe(member);
    expect((await controller.getProjects()).active).toBe(member);

    // Re-selecting the same project is a no-op success.
    expect((await controller.setActiveProject(member)).ok).toBe(true);

    controller.stopTsServer();
  });
});

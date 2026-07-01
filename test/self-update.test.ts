// Unit tests for the in-process self-update (src/self-update.ts). The network
// fetch and the `tar` spawn are both injected, so these run fully offline: the
// fake `run` simulates extraction by writing a fixture tree into the staging dir.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tarballUrl, isGitCheckout, applyRelease, buildReloadPrompt } from "../src/self-update.ts";
import type { RunResult } from "../src/types.ts";

// A non-empty Response stand-in for the injected fetch.
function tarballResponse(ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: async () => new Uint8Array([0x1f, 0x8b, 0x08, 0x00]).buffer,
  } as unknown as Response;
}

// Pull the `-C <dir>` target out of a `tar` argv.
function extractDir(argv: string[]): string {
  const i = argv.indexOf("-C");
  return i >= 0 ? argv[i + 1] : "";
}

// A fake `run` that "extracts" a release: writes a package.json (with the given
// version) plus a marker file into tar's `-C` staging dir, then succeeds.
function fakeTar(version: string) {
  return async (argv: string[]): Promise<RunResult> => {
    const dir = extractDir(argv);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ version }));
    await writeFile(path.join(dir, "NEW_FILE.txt"), "from-release");
    return { code: 0, signal: null, output: "", stdout: "", stderr: "" };
  };
}

describe("tarballUrl", () => {
  it("builds the GitHub tarball endpoint for a tag", () => {
    expect(tarballUrl("sinedied/cockpit-js", "v1.1.0")).toBe(
      "https://api.github.com/repos/sinedied/cockpit-js/tarball/v1.1.0",
    );
  });
});

describe("buildReloadPrompt", () => {
  it("names the version and asks for extensions_reload", () => {
    const prompt = buildReloadPrompt("1.2.3");
    expect(prompt).toContain("v1.2.3");
    expect(prompt).toContain("extensions_reload");
  });
});

describe("isGitCheckout", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "cockpit-git-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("is false for a plain folder copy", () => {
    expect(isGitCheckout(tmp)).toBe(false);
  });

  it("is true when a .git entry exists", async () => {
    await mkdir(path.join(tmp, ".git"));
    expect(isGitCheckout(tmp)).toBe(true);
  });
});

describe("applyRelease", () => {
  let root: string; // the install's parent (where staging lives)
  let dir: string; // the install dir itself
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cockpit-install-"));
    dir = path.join(root, "cockpit");
    await mkdir(dir);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await writeFile(path.join(dir, "OLD_FILE.txt"), "from-old-install");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses to update a git checkout", async () => {
    await mkdir(path.join(dir, ".git"));
    const res = await applyRelease({
      dir,
      slug: "sinedied/cockpit-js",
      tag: "v1.1.0",
      version: "1.1.0",
      fetchImpl: async () => tarballResponse(),
      run: fakeTar("1.1.0"),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/git checkout/i);
    // Untouched.
    expect(existsSync(path.join(dir, "OLD_FILE.txt"))).toBe(true);
  });

  it("swaps the install to the downloaded release on the happy path", async () => {
    const res = await applyRelease({
      dir,
      slug: "sinedied/cockpit-js",
      tag: "v1.1.0",
      version: "1.1.0",
      fetchImpl: async () => tarballResponse(),
      run: fakeTar("1.1.0"),
    });
    expect(res.ok).toBe(true);
    expect(res.installedVersion).toBe("1.1.0");
    // New tree is in place, old files pruned by the whole-dir swap.
    expect(existsSync(path.join(dir, "NEW_FILE.txt"))).toBe(true);
    expect(existsSync(path.join(dir, "OLD_FILE.txt"))).toBe(false);
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    expect(pkg.version).toBe("1.1.0");
    // No staging/backup leftovers in the parent.
    const leftovers = (await readdir(root)).filter(
      (n) => n.startsWith(".cockpit") || n.includes(".bak"),
    );
    expect(leftovers).toEqual([]);
  });

  it("aborts (and leaves the install intact) on a version mismatch", async () => {
    const res = await applyRelease({
      dir,
      slug: "sinedied/cockpit-js",
      tag: "v1.1.0",
      version: "1.1.0",
      fetchImpl: async () => tarballResponse(),
      run: fakeTar("9.9.9"), // tarball carries the wrong version
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/match/i);
    // Original install untouched.
    expect(existsSync(path.join(dir, "OLD_FILE.txt"))).toBe(true);
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    expect(pkg.version).toBe("1.0.0");
  });

  it("reports an error when the download fails", async () => {
    const res = await applyRelease({
      dir,
      slug: "sinedied/cockpit-js",
      tag: "v1.1.0",
      version: "1.1.0",
      fetchImpl: async () => tarballResponse(false, 404),
      run: fakeTar("1.1.0"),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/download/i);
    expect(existsSync(path.join(dir, "OLD_FILE.txt"))).toBe(true);
  });

  it("fails cleanly when tar errors", async () => {
    const res = await applyRelease({
      dir,
      slug: "sinedied/cockpit-js",
      tag: "v1.1.0",
      version: "1.1.0",
      fetchImpl: async () => tarballResponse(),
      run: async () => ({ code: 2, signal: null, output: "tar: broken", stderr: "tar: broken" }),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unpack/i);
    expect(existsSync(path.join(dir, "OLD_FILE.txt"))).toBe(true);
  });
});

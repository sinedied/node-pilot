// Functional test for the dependency safe-update loop. Requires network access
// (npm install); when offline, the whole suite is skipped rather than failing.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Controller } from "../src/controller.ts";
import { normalizeRepoUrl, buildDepLinks, parseAudit, readDevSet } from "../src/deps.ts";
import { buildDepsUpdatePrompt, buildDepsAuditFixPrompt } from "../src/fix.ts";

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

describe("readDevSet", () => {
  it("returns the devDependencies keys, empty for prod-only or missing", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "np-dev-"));
    await writeFile(
      path.join(d, "package.json"),
      JSON.stringify({
        dependencies: { "is-odd": "3.0.0" },
        devDependencies: { vitest: "1.0.0", biome: "1.0.0" },
      }),
    );
    const set = await readDevSet(d);
    expect(set.has("vitest")).toBe(true);
    expect(set.has("biome")).toBe(true);
    expect(set.has("is-odd")).toBe(false);
    expect(await readDevSet(path.join(d, "nope"))).toEqual(new Set());
    await rm(d, { recursive: true, force: true });
  });
});

describe("normalizeRepoUrl", () => {
  it("normalizes git+https / .git", () => {
    expect(normalizeRepoUrl("git+https://github.com/sindresorhus/is-odd.git")).toBe(
      "https://github.com/sindresorhus/is-odd",
    );
  });
  it("normalizes git+ssh and scp-style urls", () => {
    expect(normalizeRepoUrl("git+ssh://git@github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("git@github.com:a/b.git")).toBe("https://github.com/a/b");
  });
  it("expands shorthand and bare user/repo to GitHub", () => {
    expect(normalizeRepoUrl("github:a/b")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("a/b")).toBe("https://github.com/a/b");
  });
  it("reads the url field from an object and strips a hash", () => {
    expect(normalizeRepoUrl({ url: "https://github.com/a/b#readme" })).toBe(
      "https://github.com/a/b",
    );
  });
  it("returns null for missing or non-http input", () => {
    expect(normalizeRepoUrl(undefined)).toBeNull();
    expect(normalizeRepoUrl("not a url")).toBeNull();
  });
});

describe("buildDepLinks", () => {
  it("points the changelog at GitHub releases for a github repo", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "np-links-"));
    await mkdir(path.join(d, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      path.join(d, "node_modules", "pkg", "package.json"),
      JSON.stringify({ repository: "git+https://github.com/a/b.git" }),
    );
    const links = await buildDepLinks(d, "pkg");
    expect(links.repo).toBe("https://github.com/a/b");
    expect(links.changelog).toBe("https://github.com/a/b/releases");
    expect(links.isGithub).toBe(true);
    expect(links.npm).toBe("https://www.npmjs.com/package/pkg");
    await rm(d, { recursive: true, force: true }).catch(() => {});
  });
  it("falls back to the npm link when no metadata exists", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "np-links-"));
    const links = await buildDepLinks(d, "ghost");
    expect(links.repo).toBeUndefined();
    expect(links.changelog).toBeUndefined();
    expect(links.npm).toBe("https://www.npmjs.com/package/ghost");
    await rm(d, { recursive: true, force: true }).catch(() => {});
  });
});

describe("parseAudit", () => {
  it("extracts advisories, severity and a fix target", () => {
    const json = JSON.stringify({
      metadata: { vulnerabilities: { total: 1, high: 1 } },
      vulnerabilities: {
        lodash: {
          severity: "high",
          range: "<4.17.21",
          fixAvailable: { name: "lodash", version: "4.17.21", isSemVerMajor: false },
          via: [
            {
              title: "Prototype Pollution",
              url: "https://github.com/advisories/GHSA-xxxx",
              severity: "high",
            },
          ],
        },
      },
    });
    const r = parseAudit(json);
    const v = r.vulnerabilities[0];
    expect(v.name).toBe("lodash");
    expect(v.fixAvailable).toBe(true);
    expect(v.fix).toEqual({ name: "lodash", version: "4.17.21", major: false });
    expect(v.advisories[0]).toEqual({
      title: "Prototype Pollution",
      url: "https://github.com/advisories/GHSA-xxxx",
      severity: "high",
    });
  });
  it("marks a vulnerability with no fix as not fixable", () => {
    const r = parseAudit(
      JSON.stringify({ vulnerabilities: { foo: { severity: "low", fixAvailable: false } } }),
    );
    expect(r.vulnerabilities[0].fixAvailable).toBe(false);
    expect(r.vulnerabilities[0].fix).toBeUndefined();
  });
});

describe("deps Copilot prompts", () => {
  it("update prompt lists targets, the audit baseline, and severe identities", () => {
    const p = buildDepsUpdatePrompt({
      mode: "latest",
      targets: [{ name: "left-pad", from: "1.0.0", to: "1.3.0" }],
      baselineAudit: { high: 2, critical: 1 },
      baselineSevere: ["lodash", "minimist"],
    });
    expect(p).toContain("left-pad");
    expect(p).toContain('"left-pad@1.3.0"');
    expect(p).toContain("high: 2, critical: 1");
    expect(p).toContain("lodash, minimist");
    expect(p).toContain("update_dependencies");
  });
  it("update prompt reports no pre-existing severe advisories as 'none'", () => {
    const p = buildDepsUpdatePrompt({
      mode: "default",
      targets: [{ name: "left-pad", from: "1.0.0", to: "1.3.0" }],
      baselineAudit: { high: 0, critical: 0 },
    });
    expect(p).toContain("**none**");
  });
  it("audit-fix prompt separates fixable from unfixable", () => {
    const p = buildDepsAuditFixPrompt({
      vulnerabilities: [
        {
          name: "a",
          severity: "high",
          range: "<1",
          fixAvailable: true,
          via: [],
          advisories: [],
          fix: { name: "a", version: "1.2.3", major: false },
        },
        {
          name: "b",
          severity: "low",
          range: "<2",
          fixAvailable: false,
          via: [],
          advisories: [],
        },
      ],
    });
    expect(p).toContain("a@1.2.3");
    expect(p).toContain("no automatic fix");
    expect(p).toContain("b");
  });
});

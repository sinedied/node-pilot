// Monorepo / multi-project discovery. Given a session root, enumerate the
// projects a user can focus Cockpit on: the root itself, any declared workspace
// members (npm/yarn `workspaces` + pnpm-workspace.yaml), and other independent
// package.json directories found by a bounded subfolder scan. Detection reads
// files only (no install, no CLI), so it stays cheap and works offline.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJson, readText, existsSyncSafe } from "./util.ts";
import type { ProjectInfo } from "./types.ts";

interface PackageJson {
  name?: string;
  workspaces?: unknown;
}

// Directory names that never contain a user-selectable project (build output,
// vendored deps, VCS, caches, and conventional example/fixture trees).
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "output",
  "coverage",
  ".next",
  ".nuxt",
  ".astro",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".vercel",
  ".netlify",
  ".output",
  "tmp",
  "temp",
  "vendor",
  "examples",
  "example",
  "fixtures",
  "fixture",
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
]);

// How deep the standalone-package scan walks below the session root.
const SCAN_DEPTH = 2;

const OTHER_GROUP = "Other projects";

function pkgName(pkg: PackageJson | null, dir: string): string {
  return (typeof pkg?.name === "string" && pkg.name.trim()) || path.basename(dir);
}

function isWorkspaceRootPkg(dir: string, pkg: PackageJson | null): boolean {
  return Boolean(pkg?.workspaces) || existsSyncSafe(path.join(dir, "pnpm-workspace.yaml"));
}

// Collect the workspace member glob patterns from package.json `workspaces`
// (array form or `{ packages: [...] }`) and from pnpm-workspace.yaml.
async function workspacePatterns(dir: string, pkg: PackageJson | null): Promise<string[]> {
  const out: string[] = [];
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) {
    for (const p of ws) if (typeof p === "string") out.push(p);
  } else if (ws && typeof ws === "object") {
    const pkgs = (ws as { packages?: unknown }).packages;
    if (Array.isArray(pkgs)) for (const p of pkgs) if (typeof p === "string") out.push(p);
  }
  const yamlPath = path.join(dir, "pnpm-workspace.yaml");
  if (existsSyncSafe(yamlPath)) {
    const yaml = await readText(yamlPath);
    if (yaml) out.push(...parsePnpmPackages(yaml));
  }
  return out;
}

// Minimal pnpm-workspace.yaml parser: pull the string entries under the
// top-level `packages:` list. We only need the glob strings, so a dependency-
// free line scan is enough (avoids pulling in a YAML lib).
function parsePnpmPackages(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (m) {
        out.push(m[1].replace(/^['"]|['"]$/g, ""));
        continue;
      }
      // A non-list, non-blank line at indent 0 ends the packages block.
      if (line.trim() && !/^\s/.test(line)) inPackages = false;
    }
  }
  return out;
}

// Resolve one workspace glob pattern to concrete directories. Supports the
// shapes that appear in real configs: explicit paths (`apps/web`), a single
// trailing wildcard (`packages/*`), a bare `*`, and `**` ("any descendant with
// a package.json"). Negations (`!…`) are skipped conservatively.
async function resolvePattern(root: string, pattern: string): Promise<string[]> {
  const pat = pattern.replace(/\/+$/, "");
  if (!pat || pat.startsWith("!")) return [];

  if (pat.includes("**")) {
    const base = pat.split("**")[0].replace(/\/+$/, "");
    const start = base ? path.join(root, base) : root;
    return scanForPackages(start, SCAN_DEPTH);
  }

  const star = pat.indexOf("*");
  if (star === -1) {
    const dir = path.join(root, pat);
    return existsSyncSafe(path.join(dir, "package.json")) ? [dir] : [];
  }

  // Single wildcard segment: expand the directory just before the `*`.
  const prefix = pat.slice(0, star).replace(/\/+$/, "");
  const parent = prefix ? path.join(root, prefix) : root;
  const entries = await safeReaddir(parent);
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const dir = path.join(parent, e.name);
    if (existsSyncSafe(path.join(dir, "package.json"))) dirs.push(dir);
  }
  return dirs;
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Walk subdirectories (up to `depth` levels) collecting every directory that
// holds a package.json, skipping noise directories. Used both for the
// standalone-package scan and for `**` workspace patterns.
async function scanForPackages(start: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, left: number): Promise<void> {
    if (left < 0) return;
    const entries = await safeReaddir(dir);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const child = path.join(dir, e.name);
      if (existsSyncSafe(path.join(child, "package.json"))) found.push(child);
      await walk(child, left - 1);
    }
  }
  await walk(start, depth - 1);
  return found;
}

// Enumerate the selectable projects under `root`, ordered for the selector menu:
// the root first, then its workspace members (grouped under the root's name),
// then any standalone scanned packages (grouped under "Other projects").
export async function enumerateProjects(root: string): Promise<ProjectInfo[]> {
  const rootPkg = await readJson<PackageJson>(path.join(root, "package.json"));
  const rootName = pkgName(rootPkg, root);
  const seen = new Set<string>([root]);
  const out: ProjectInfo[] = [];

  // The root is always selectable (when it is itself a project).
  if (rootPkg) {
    out.push({
      dir: root,
      rel: ".",
      name: rootName,
      group: rootName,
      isWorkspaceRoot: isWorkspaceRootPkg(root, rootPkg),
    });
  }

  // Declared workspace members, grouped under the root's name.
  const patterns = await workspacePatterns(root, rootPkg);
  const members: string[] = [];
  for (const pat of patterns) {
    for (const dir of await resolvePattern(root, pat)) {
      if (!seen.has(dir)) {
        seen.add(dir);
        members.push(dir);
      }
    }
  }
  members.sort();
  for (const dir of members) {
    const pkg = await readJson<PackageJson>(path.join(dir, "package.json"));
    out.push({
      dir,
      rel: path.relative(root, dir) || ".",
      name: pkgName(pkg, dir),
      group: rootName,
      isWorkspaceRoot: isWorkspaceRootPkg(dir, pkg),
    });
  }

  // Standalone packages found by scanning, that aren't already workspace members.
  // When the root is itself a project they go under "Other projects"; when the
  // root is just a container (no package.json) they head up under its name.
  const scannedGroup = rootPkg ? OTHER_GROUP : rootName;
  const scanned = (await scanForPackages(root, SCAN_DEPTH)).filter((d) => !seen.has(d)).sort();
  for (const dir of scanned) {
    seen.add(dir);
    const pkg = await readJson<PackageJson>(path.join(dir, "package.json"));
    out.push({
      dir,
      rel: path.relative(root, dir) || ".",
      name: pkgName(pkg, dir),
      group: scannedGroup,
      isWorkspaceRoot: isWorkspaceRootPkg(dir, pkg),
    });
  }

  return out;
}

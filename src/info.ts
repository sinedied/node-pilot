// Lazy, expensive-to-compute project metrics that the Info tab requests on
// demand: transitive dependency count, on-disk install footprint, published
// package size and build-output size. Pure and SDK-free so it stays unit
// testable; cross-platform (no `du`/shell — a JS fs walk does the counting).
import path from "node:path";
import { readdir, lstat } from "node:fs/promises";
import { run } from "./process-runner.ts";
import { existsSyncSafe } from "./util.ts";
import type { BuildStats, PackStats, ProjectStats } from "./types.ts";

// Known build-output directories, in priority order, across common toolchains.
const BUILD_DIRS = ["dist", "build", ".next", ".output", "out"];

// True when `dir` directly contains an installed package (its parent is a
// `node_modules` dir, or a scope dir directly under `node_modules`). Used to
// count package instances without over-counting nested `package.json` files
// that some packages ship as `type` markers inside subfolders (e.g. dist/).
function isPackageRoot(dir: string): boolean {
  const parent = path.basename(path.dirname(dir));
  if (parent === "node_modules") return true;
  const grand = path.basename(path.dirname(path.dirname(dir)));
  return grand === "node_modules" && parent.startsWith("@");
}

// Recursively sum the size of every regular file under `dir`. Symlinks are
// skipped to avoid cycles and to count pnpm's real store files only once.
// When `countPackages` is set, also tallies installed package roots.
async function walkDir(
  dir: string,
  acc: { bytes: number; count: number },
  countPackages: boolean,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".bin") continue;
      await walkDir(full, acc, countPackages);
    } else if (entry.isFile()) {
      if (countPackages && entry.name === "package.json" && isPackageRoot(dir)) {
        acc.count++;
      }
      try {
        acc.bytes += (await lstat(full)).size;
      } catch {
        /* races: file vanished mid-walk */
      }
    }
  }
}

// Count installed packages (incl. transitive) and the node_modules footprint
// in a single walk. Returns null when there is no node_modules directory.
export async function walkNodeModules(
  cwd: string,
): Promise<{ installedCount: number; installBytes: number } | null> {
  const nm = path.join(cwd, "node_modules");
  if (!existsSyncSafe(nm)) return null;
  const acc = { bytes: 0, count: 0 };
  await walkDir(nm, acc, true);
  return { installedCount: acc.count, installBytes: acc.bytes };
}

// Total size (bytes) of every file under `dir`.
async function dirSize(dir: string): Promise<number> {
  const acc = { bytes: 0, count: 0 };
  await walkDir(dir, acc, false);
  return acc.bytes;
}

// Find and measure a build-output directory if one exists (we never build).
export async function buildOutputSize(cwd: string): Promise<BuildStats | null> {
  for (const name of BUILD_DIRS) {
    const dir = path.join(cwd, name);
    if (existsSyncSafe(dir)) {
      return { dir: name, bytes: await dirSize(dir) };
    }
  }
  return null;
}

// Extract the first top-level JSON array from mixed output (npm may interleave
// warnings on stderr, which the runner merges into the same stream).
function parseJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Published package size via `npm pack --dry-run --json` (npm ships with Node,
// so this works regardless of the project's package manager). Returns null when
// the command fails or the output can't be parsed.
export async function packSize(cwd: string): Promise<PackStats | null> {
  const res = await run(["npm", "pack", "--dry-run", "--json"], { cwd });
  const arr = parseJsonArray(res.output);
  const first = arr?.[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  const packed = Number(first.size);
  const unpacked = Number(first.unpackedSize);
  const entries = Number(first.entryCount);
  if (!Number.isFinite(packed)) return null;
  return {
    packedBytes: packed,
    unpackedBytes: Number.isFinite(unpacked) ? unpacked : 0,
    entryCount: Number.isFinite(entries) ? entries : 0,
  };
}

// Compute the full lazy stats bundle. `publishable` gates the npm-pack step so
// it isn't run (noisily, misleadingly) on private apps.
export async function computeStats(cwd: string, publishable: boolean): Promise<ProjectStats> {
  const [installed, build, pack] = await Promise.all([
    walkNodeModules(cwd),
    buildOutputSize(cwd),
    publishable ? packSize(cwd) : Promise.resolve(null),
  ]);
  return {
    installedCount: installed?.installedCount ?? null,
    installBytes: installed?.installBytes ?? null,
    pack,
    build,
  };
}

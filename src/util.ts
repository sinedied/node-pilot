// Small shared helpers used across Cockpit.js modules.
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function existsSyncSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(p: string): Promise<T | null> {
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

// Find the first existing file from a list of candidate names in `cwd`.
export function firstExisting(cwd: string, names: string[]): string | null {
  for (const name of names) {
    if (existsSyncSafe(path.join(cwd, name))) return name;
  }
  return null;
}

// Cap an array to its last `max` items (used for in-memory log ring buffers).
export function pushCapped<T>(arr: T[], item: T, max = 5000): T[] {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
  return arr;
}

// Extract the first http(s) localhost/loopback URL from a chunk of text. The
// path is matched conservatively so surrounding quotes/parens/punctuation in
// log lines (e.g. npm's command echo) don't get swallowed into the URL.
const URL_RE =
  /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'<>)\]}]*)?)/i;
export function extractUrl(text: string): string | null {
  const m = URL_RE.exec(text || "");
  if (!m) return null;
  // Trim a trailing punctuation character that is unlikely to be part of a URL.
  const url = m[1].replace(/[.,;:]$/, "");
  // Normalize 0.0.0.0 to localhost so the preview iframe can load it.
  return url.replace("0.0.0.0", "localhost");
}

// Detect "port already in use" style messages across tools.
export function isPortInUse(text: string): boolean {
  return /EADDRINUSE|address already in use|port \d+ is (?:already )?in use/i.test(text || "");
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Human-readable byte size (B / kB / MB / GB, base-1000 to match npm/registry).
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = n / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

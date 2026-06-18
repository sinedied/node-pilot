// Small shared helpers used across Node Pilot modules.
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function existsSyncSafe(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export async function readJson(p) {
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readText(p) {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

// Find the first existing file from a list of candidate names in `cwd`.
export function firstExisting(cwd, names) {
  for (const name of names) {
    if (existsSyncSafe(path.join(cwd, name))) return name;
  }
  return null;
}

// Cap an array to its last `max` items (used for in-memory log ring buffers).
export function pushCapped(arr, item, max = 5000) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
  return arr;
}

// Extract the first http(s) localhost/loopback URL from a chunk of text. The
// path is matched conservatively so surrounding quotes/parens/punctuation in
// log lines (e.g. npm's command echo) don't get swallowed into the URL.
const URL_RE =
  /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'<>)\]}]*)?)/i;
export function extractUrl(text) {
  const m = URL_RE.exec(text || "");
  if (!m) return null;
  // Trim a trailing punctuation character that is unlikely to be part of a URL.
  const url = m[1].replace(/[.,;:]$/, "");
  // Normalize 0.0.0.0 to localhost so the preview iframe can load it.
  return url.replace("0.0.0.0", "localhost");
}

// Detect "port already in use" style messages across tools.
export function isPortInUse(text) {
  return /EADDRINUSE|address already in use|port \d+ is (?:already )?in use/i.test(text || "");
}

export function nowIso() {
  return new Date().toISOString();
}

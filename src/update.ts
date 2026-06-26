// Self-update check for Cockpit.js. Compares the installed package.json version
// against the latest GitHub Release of the distribution repo and reports whether
// a newer version is available. Pure and SDK-free so it stays unit testable; the
// network call is injected (`fetchImpl`) for deterministic tests.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The distribution repo whose Releases define "the latest version". This is NOT
// the development repo (node-pilot) — releases are cut here and read back by the
// update check. Overridable via the package.json `repository` field.
export const DEFAULT_REPO_SLUG = "sinedied/cockpit-js";

// The extension's own root (one level up from this src/ module), used to locate
// package.json for the installed version.
export const EXTENSION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  // Dot-separated prerelease identifiers; empty = a stable release.
  prerelease: string[];
}

// Parse "1.2.3", "v1.2.3", "1.2.3-rc.1", "1.2.3+build". Returns null when the
// core x.y.z can't be read (anything malformed sorts as "oldest" downstream).
export function parseSemver(input: string | null | undefined): ParsedSemver | null {
  if (typeof input !== "string") return null;
  const s = input.trim().replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

// Compare prerelease identifier lists per semver §11: numeric identifiers compare
// by value, alphanumeric lexically, numeric < alphanumeric, and a larger set of
// fields outranks a prefix. A stable release (empty list) outranks any prerelease.
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers have the lower precedence
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

// -1 / 0 / 1 for a<b / a==b / a>b. Unparseable inputs sort as "oldest" so a
// malformed local version never spuriously reports "up to date".
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export interface LatestRelease {
  tag: string;
  version: string;
  htmlUrl: string;
  name: string;
  publishedAt: string | null;
}

type FetchImpl = typeof globalThis.fetch;

// Fetch the latest GitHub Release for `slug` ("owner/repo"). Returns null on any
// non-2xx (incl. 404 = no releases yet), network error, timeout or parse failure
// — the caller treats "couldn't read the remote" as "no update", never an error
// surfaced to the user. Times out via AbortController.
export async function fetchLatestRelease(
  slug: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<LatestRelease | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "cockpit-js",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (!res?.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const tag = typeof data.tag_name === "string" ? data.tag_name : "";
    const version = tag.replace(/^v/i, "");
    if (!parseSemver(version)) return null;
    return {
      tag,
      version,
      htmlUrl:
        typeof data.html_url === "string" ? data.html_url : `https://github.com/${slug}/releases`,
      name: typeof data.name === "string" && data.name ? data.name : tag,
      publishedAt: typeof data.published_at === "string" ? data.published_at : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  checkedAt: number;
  // True when the remote couldn't be read (offline / rate-limited / no releases).
  // The UI shows a quiet "couldn't check" — never a false "update available".
  error: boolean;
}

// Fetch the latest release and compare it to `currentVersion`.
export async function checkForUpdate(
  currentVersion: string,
  slug: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<UpdateInfo> {
  const latest = await fetchLatestRelease(slug, opts);
  const checkedAt = Date.now();
  if (!latest) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseName: null,
      checkedAt,
      error: true,
    };
  }
  return {
    currentVersion,
    latestVersion: latest.version,
    updateAvailable: compareSemver(currentVersion, latest.version) < 0,
    releaseUrl: latest.htmlUrl,
    releaseName: latest.name,
    checkedAt,
    error: false,
  };
}

// Extract "owner/repo" from a package.json `repository` field (string shorthand,
// "github:owner/repo", or { url } object with a git/https URL). Null when none.
export function deriveSlug(repository: unknown): string | null {
  let url: string | null = null;
  if (typeof repository === "string") url = repository;
  else if (repository && typeof repository === "object") {
    const u = (repository as { url?: unknown }).url;
    if (typeof u === "string") url = u;
  }
  if (!url) return null;
  const shorthand = /^github:([^/]+\/[^/#]+)$/i.exec(url);
  if (shorthand) return stripGit(shorthand[1]);
  const full = /github\.com[:/]([^/]+\/[^/#?]+)/i.exec(url);
  if (full) return stripGit(full[1]);
  if (/^[^/\s]+\/[^/\s]+$/.test(url)) return stripGit(url);
  return null;
}

function stripGit(s: string): string {
  return s.replace(/\.git$/i, "");
}

// Read { version, repoSlug } from the extension's package.json (synchronously, so
// the controller can expose the version in its first state snapshot). `repoSlug`
// derives from the `repository` field, falling back to DEFAULT_REPO_SLUG.
export function readPackageMetaSync(extensionDir: string = EXTENSION_DIR): {
  version: string;
  repoSlug: string;
} {
  try {
    const pkg = JSON.parse(readFileSync(path.join(extensionDir, "package.json"), "utf8")) as {
      version?: unknown;
      repository?: unknown;
    };
    const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    return { version, repoSlug: deriveSlug(pkg.repository) || DEFAULT_REPO_SLUG };
  } catch {
    return { version: "0.0.0", repoSlug: DEFAULT_REPO_SLUG };
  }
}

export interface SelfUpdatePromptInput {
  installDir: string;
  currentVersion: string;
  latestVersion: string;
  repoSlug: string;
  releaseUrl: string | null;
}

// The prompt handed to Copilot chat when the user clicks "Update Cockpit.js". The
// extension can't reload itself, so the agent does the file swap + reload. We give
// it both versions, the install dir and the repo so it can pick git-pull vs
// reinstall, but leave the exact mechanics to its judgement.
export function buildSelfUpdatePrompt(input: SelfUpdatePromptInput): string {
  const { installDir, currentVersion, latestVersion, repoSlug, releaseUrl } = input;
  const lines = [
    `A new release of the Cockpit.js extension is available: v${currentVersion} → v${latestVersion}.`,
    "",
    `Please update the installed extension at \`${installDir}\`:`,
    `1. If that folder is a git checkout of \`${repoSlug}\`, fetch and check out the \`v${latestVersion}\` tag (or pull the default branch). Otherwise reinstall it from https://github.com/${repoSlug} over the same folder.`,
    "2. Run `npm install` if its dependencies changed.",
    "3. Reload the extension so the new version takes effect (the `extensions_reload` tool, or by restarting the Copilot app).",
    "",
    "Then confirm the newly installed version is running.",
  ];
  if (releaseUrl) lines.push("", `Release notes: ${releaseUrl}`);
  return lines.join("\n");
}

// In-process self-update for the Cockpit.js extension. Downloads a GitHub Release
// tarball and swaps it over the install directory — no Copilot involvement and no
// `npm install` (the extension ships no runtime dependencies, so an update is a
// pure file swap). SDK-free and unit-testable: the network `fetch` and the `tar`
// spawn are both injectable.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { run as defaultRun } from "./process-runner.ts";

type FetchImpl = typeof globalThis.fetch;
type RunImpl = typeof defaultRun;

// GitHub's tarball endpoint for a tag. It 302-redirects to codeload; Node's fetch
// follows redirects, so the caller just reads the final body.
export function tarballUrl(slug: string, tag: string): string {
  return `https://api.github.com/repos/${slug}/tarball/${encodeURIComponent(tag)}`;
}

// True when the install dir is a git working tree (dev/dogfood checkout). We refuse
// to swap files over it — that would clobber the maintainer's uncommitted work.
// `.git` may be a directory (normal clone) or a file (worktree/submodule); either
// counts. Real user installs are plain folder copies with no `.git`.
export function isGitCheckout(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

export interface ApplyReleaseOptions {
  // The extension's install directory (EXTENSION_DIR) to update in place.
  dir: string;
  slug: string;
  tag: string;
  // The version we expect the downloaded tarball's package.json to carry; the swap
  // aborts on a mismatch so a wrong/corrupt download never lands.
  version: string;
  fetchImpl?: FetchImpl;
  run?: RunImpl;
  timeoutMs?: number;
}

export interface ApplyReleaseResult {
  ok: boolean;
  installedVersion?: string;
  reason?: string;
}

// Download the release tarball for `tag` and replace the contents of `dir` with it.
// Steps: refuse on a git checkout → fetch the tarball → extract into a staging dir
// on the *same filesystem* as the install (so the final swap is a rename, not a
// slow cross-device copy) → validate the extracted version → atomically swap
// (rename old aside, rename new into place, restore on failure). Returns a result
// object; never throws for the expected failure modes (offline, bad tar, mismatch).
export async function applyRelease(opts: ApplyReleaseOptions): Promise<ApplyReleaseResult> {
  const { dir, slug, tag, version } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const run = opts.run ?? defaultRun;
  const timeoutMs = opts.timeoutMs ?? 30000;

  if (isGitCheckout(dir)) {
    return {
      ok: false,
      reason: "Cockpit.js is running from a git checkout — update it with git instead.",
    };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "No network client available." };
  }

  // Download the tarball into memory (releases are a couple of MB).
  let buf: Buffer;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(tarballUrl(slug, tag), {
      headers: { "User-Agent": "cockpit-js" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res?.ok) {
      return {
        ok: false,
        reason: `Couldn't download the release (HTTP ${res?.status ?? "error"}).`,
      };
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Couldn't download the release: ${message}` };
  } finally {
    clearTimeout(timer);
  }
  if (!buf.length) return { ok: false, reason: "Downloaded release was empty." };

  // Stage the new tree next to the install dir so the final swap is a same-FS rename.
  const parent = path.dirname(dir);
  const work = await mkdtemp(path.join(parent, ".cockpit-update-"));
  const staged = path.join(work, "staged");
  const backup = path.join(parent, `.${path.basename(dir)}.bak-${path.basename(work)}`);
  try {
    const tgz = path.join(work, "release.tgz");
    await writeFile(tgz, buf);
    await mkdir(staged, { recursive: true });

    // Extract, dropping the GitHub-generated top-level `<owner>-<repo>-<sha>/` dir.
    const r = await run(["tar", "-xzf", tgz, "-C", staged, "--strip-components=1"]);
    if (r.code !== 0) {
      const detail = (r.stderr || r.output || "").trim().slice(0, 300);
      return { ok: false, reason: `Failed to unpack the release${detail ? `: ${detail}` : "."}` };
    }

    // Sanity-check the extracted version before letting it replace the install.
    const stagedVersion = await readStagedVersion(staged);
    if (stagedVersion !== version) {
      return {
        ok: false,
        reason: `Downloaded version (${stagedVersion ?? "unknown"}) didn't match the expected v${version}.`,
      };
    }

    // Swap: move the current install aside, move the new tree into place. If the
    // second rename fails, put the original back so we never leave a missing dir.
    await rename(dir, backup);
    try {
      await rename(staged, dir);
    } catch (err) {
      await rename(backup, dir).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Couldn't install the new version: ${message}` };
    }
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    return { ok: true, installedVersion: version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Self-update failed: ${message}` };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function readStagedVersion(stagedDir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(stagedDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// The single Copilot interaction left in the update flow: the extension can't
// reload itself, so after a successful on-disk swap we ask the agent to reload.
export function buildReloadPrompt(version: string): string {
  return [
    `Cockpit.js has been updated to v${version} on disk.`,
    "Reload the extension with the `extensions_reload` tool to finish — no other steps are needed.",
  ].join("\n");
}

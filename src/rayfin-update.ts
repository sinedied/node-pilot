// Update check for a project's Microsoft Rayfin tooling. Mirrors src/update.ts
// (the extension's own self-update) but reads "latest" from the npm registry —
// where the version-locked `@microsoft/rayfin-*` packages are published — rather
// than GitHub Releases. Pure and SDK-free so it stays unit testable; the network
// call is injectable (`fetchImpl`) and every failure is non-fatal (`error:true`,
// never a false "update available").
import { compareSemver, parseSemver } from "./update.ts";

// The package whose published version defines "latest Rayfin". The CLI and SDK
// are version-locked, so the CLI's latest is the set's latest.
export const RAYFIN_CLI_PACKAGE = "@microsoft/rayfin-cli";

type FetchImpl = typeof globalThis.fetch;

// Fetch the latest published version of `pkg` from the npm registry. Returns null
// on any non-2xx, network error, timeout or parse failure. Uses the small
// per-package `latest` dist-tag document (`/<pkg>/latest`).
export async function fetchLatestRayfinVersion(
  pkg: string = RAYFIN_CLI_PACKAGE,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${pkg}/latest`, {
      headers: { Accept: "application/json", "User-Agent": "cockpit-js" },
      signal: controller.signal,
    });
    if (!res?.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const version = typeof data.version === "string" ? data.version : null;
    return version && parseSemver(version) ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface RayfinUpdateInfo {
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: number;
  // True when the remote couldn't be read (offline / rate-limited / parse error)
  // — the UI shows a quiet "couldn't check", never a false "update available".
  error: boolean;
}

// Fetch the latest version and compare it to the installed one. `updateAvailable`
// is only true when we know both versions and installed < latest.
export async function checkRayfinUpdate(
  installedVersion: string | null,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number; pkg?: string } = {},
): Promise<RayfinUpdateInfo> {
  const latest = await fetchLatestRayfinVersion(opts.pkg ?? RAYFIN_CLI_PACKAGE, opts);
  const checkedAt = Date.now();
  if (!latest) {
    return {
      installedVersion,
      latestVersion: null,
      updateAvailable: false,
      checkedAt,
      error: true,
    };
  }
  return {
    installedVersion,
    latestVersion: latest,
    updateAvailable: !!installedVersion && compareSemver(installedVersion, latest) < 0,
    checkedAt,
    error: false,
  };
}

export interface RayfinUpdatePromptInput {
  installedVersion: string | null;
  latestVersion: string;
}

// The prompt handed to Copilot chat when the user clicks "Update Rayfin". The
// extension can't run an interactive install loop safely, so the agent bumps the
// whole version-locked `@microsoft/rayfin-*` set and verifies build/lint/test
// (rolling back on breakage), mirroring the dependency-update philosophy.
export function buildRayfinUpdatePrompt(input: RayfinUpdatePromptInput): string {
  const { installedVersion, latestVersion } = input;
  const from = installedVersion ? `v${installedVersion}` : "the installed version";
  return [
    `A newer Microsoft Rayfin release is available: ${from} → v${latestVersion}.`,
    "",
    "Please update this project's Rayfin tooling and SDK to the latest matching version:",
    `1. Bump every \`@microsoft/rayfin-*\` dependency together (CLI + SDK — e.g. rayfin-cli, rayfin-core, rayfin-client, rayfin-auth-provider-fabric, rayfin-data) to \`^${latestVersion}\`. They are version-locked and must move as a set.`,
    "2. Reinstall so the lockfile updates.",
    "3. Verify the app still builds, lints and tests. If anything breaks, roll the bump back rather than leaving the project in a broken state.",
    "",
    "Then confirm the new Rayfin version is installed.",
  ].join("\n");
}

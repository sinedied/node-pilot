// Unit tests for the Rayfin update check (src/rayfin-update.ts). The npm-registry
// fetch is injected so these run offline and deterministically.
import { describe, expect, it } from "vitest";
import {
  buildRayfinUpdatePrompt,
  checkRayfinUpdate,
  fetchLatestRayfinVersion,
} from "../src/rayfin-update.ts";

function okFetch(version: unknown): typeof globalThis.fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ version }),
  })) as unknown as typeof globalThis.fetch;
}

const failFetch: typeof globalThis.fetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof globalThis.fetch;

const notFoundFetch: typeof globalThis.fetch = (async () => ({
  ok: false,
  json: async () => ({}),
})) as unknown as typeof globalThis.fetch;

describe("fetchLatestRayfinVersion", () => {
  it("returns the version from the registry document", async () => {
    expect(await fetchLatestRayfinVersion(undefined, { fetchImpl: okFetch("1.40.0") })).toBe(
      "1.40.0",
    );
  });

  it("returns null on a network error", async () => {
    expect(await fetchLatestRayfinVersion(undefined, { fetchImpl: failFetch })).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    expect(await fetchLatestRayfinVersion(undefined, { fetchImpl: notFoundFetch })).toBeNull();
  });

  it("returns null when the version is missing or unparseable", async () => {
    expect(
      await fetchLatestRayfinVersion(undefined, { fetchImpl: okFetch("not-a-version") }),
    ).toBeNull();
    expect(await fetchLatestRayfinVersion(undefined, { fetchImpl: okFetch(undefined) })).toBeNull();
  });
});

describe("checkRayfinUpdate", () => {
  it("flags an update when installed < latest (1)", async () => {
    const info = await checkRayfinUpdate("1.33.0", { fetchImpl: okFetch("1.40.0") });
    expect(info.updateAvailable).toBe(true);
    expect(info.latestVersion).toBe("1.40.0");
    expect(info.error).toBe(false);
  });

  it("reports no update when installed === latest (0)", async () => {
    const info = await checkRayfinUpdate("1.40.0", { fetchImpl: okFetch("1.40.0") });
    expect(info.updateAvailable).toBe(false);
    expect(info.error).toBe(false);
  });

  it("reports no update when installed > latest (-1)", async () => {
    const info = await checkRayfinUpdate("2.0.0", { fetchImpl: okFetch("1.40.0") });
    expect(info.updateAvailable).toBe(false);
    expect(info.error).toBe(false);
  });

  it("never reports an update available, only error, when the fetch fails (offline)", async () => {
    const info = await checkRayfinUpdate("1.33.0", { fetchImpl: failFetch });
    expect(info.error).toBe(true);
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBeNull();
  });

  it("does not flag an update when the installed version is unknown", async () => {
    const info = await checkRayfinUpdate(null, { fetchImpl: okFetch("1.40.0") });
    expect(info.updateAvailable).toBe(false);
    expect(info.error).toBe(false);
    expect(info.latestVersion).toBe("1.40.0");
  });
});

describe("buildRayfinUpdatePrompt", () => {
  it("mentions both versions and the version-locked set", () => {
    const prompt = buildRayfinUpdatePrompt({ installedVersion: "1.33.0", latestVersion: "1.40.0" });
    expect(prompt).toContain("v1.33.0");
    expect(prompt).toContain("v1.40.0");
    expect(prompt).toContain("@microsoft/rayfin-*");
    expect(prompt.toLowerCase()).toContain("roll");
  });

  it("handles an unknown installed version gracefully", () => {
    const prompt = buildRayfinUpdatePrompt({ installedVersion: null, latestVersion: "1.40.0" });
    expect(prompt).toContain("the installed version");
    expect(prompt).toContain("v1.40.0");
  });
});

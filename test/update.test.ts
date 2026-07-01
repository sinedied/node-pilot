// Unit tests for the self-update check (src/update.ts). All network access goes
// through an injected `fetchImpl`, so these run fully offline and deterministic.
import { describe, it, expect } from "vitest";
import {
  compareSemver,
  parseSemver,
  deriveSlug,
  fetchLatestRelease,
  checkForUpdate,
} from "../src/update.ts";

// Minimal Response stand-in for the injected fetch.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("compareSemver", () => {
  it("orders by major, minor, patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("ignores a leading v and build metadata", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3+build.5", "1.2.3")).toBe(0);
  });

  it("ranks a prerelease below the matching stable release", () => {
    expect(compareSemver("1.2.3-rc.1", "1.2.3")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3-rc.1")).toBe(1);
    expect(compareSemver("1.2.3-rc.1", "1.2.3-rc.2")).toBe(-1);
    expect(compareSemver("1.2.3-alpha", "1.2.3-alpha.1")).toBe(-1);
  });

  it("treats malformed versions as oldest", () => {
    expect(compareSemver("garbage", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "garbage")).toBe(1);
    expect(compareSemver("garbage", "nonsense")).toBe(0);
  });
});

describe("parseSemver", () => {
  it("parses core and prerelease parts", () => {
    expect(parseSemver("v1.2.3-rc.1+meta")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["rc", "1"],
    });
  });

  it("returns null for non-strings and malformed input", () => {
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("x.y.z")).toBeNull();
  });
});

describe("deriveSlug", () => {
  it("reads owner/repo from common repository shapes", () => {
    expect(deriveSlug("https://github.com/sinedied/cockpit-js.git")).toBe("sinedied/cockpit-js");
    expect(deriveSlug({ url: "git+https://github.com/sinedied/cockpit-js.git" })).toBe(
      "sinedied/cockpit-js",
    );
    expect(deriveSlug("github:sinedied/cockpit-js")).toBe("sinedied/cockpit-js");
    expect(deriveSlug("sinedied/cockpit-js")).toBe("sinedied/cockpit-js");
  });

  it("returns null when there is no usable repository", () => {
    expect(deriveSlug(undefined)).toBeNull();
    expect(deriveSlug({})).toBeNull();
    expect(deriveSlug("not a repo")).toBeNull();
  });
});

describe("fetchLatestRelease", () => {
  it("maps a release payload", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        tag_name: "v1.4.0",
        html_url: "https://github.com/sinedied/cockpit-js/releases/tag/v1.4.0",
        name: "1.4.0",
        published_at: "2024-01-01T00:00:00Z",
      });
    const out = await fetchLatestRelease("sinedied/cockpit-js", { fetchImpl });
    expect(out).toEqual({
      tag: "v1.4.0",
      version: "1.4.0",
      htmlUrl: "https://github.com/sinedied/cockpit-js/releases/tag/v1.4.0",
      name: "1.4.0",
      publishedAt: "2024-01-01T00:00:00Z",
    });
  });

  it("returns null on 404 (no releases yet)", async () => {
    const fetchImpl = async () => jsonResponse({ message: "Not Found" }, false, 404);
    expect(await fetchLatestRelease("sinedied/cockpit-js", { fetchImpl })).toBeNull();
  });

  it("returns null on a network error", async () => {
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    expect(await fetchLatestRelease("sinedied/cockpit-js", { fetchImpl })).toBeNull();
  });

  it("returns null when the request times out", async () => {
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(
      await fetchLatestRelease("sinedied/cockpit-js", {
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        timeoutMs: 5,
      }),
    ).toBeNull();
  });

  it("returns null when the tag is not a valid semver", async () => {
    const fetchImpl = async () => jsonResponse({ tag_name: "nightly" });
    expect(await fetchLatestRelease("sinedied/cockpit-js", { fetchImpl })).toBeNull();
  });
});

describe("checkForUpdate", () => {
  const release = (version: string) => async () =>
    jsonResponse({
      tag_name: `v${version}`,
      html_url: `https://github.com/sinedied/cockpit-js/releases/tag/v${version}`,
      name: version,
    });

  it("reports an available update when the remote is newer", async () => {
    const info = await checkForUpdate("1.0.0", "sinedied/cockpit-js", {
      fetchImpl: release("1.1.0"),
    });
    expect(info.updateAvailable).toBe(true);
    expect(info.latestVersion).toBe("1.1.0");
    expect(info.latestTag).toBe("v1.1.0");
    expect(info.releaseUrl).toContain("/releases/tag/v1.1.0");
    expect(info.error).toBe(false);
  });

  it("reports up to date when versions match", async () => {
    const info = await checkForUpdate("1.1.0", "sinedied/cockpit-js", {
      fetchImpl: release("1.1.0"),
    });
    expect(info.updateAvailable).toBe(false);
    expect(info.error).toBe(false);
  });

  it("does not nag when the local version is ahead (dev repo)", async () => {
    const info = await checkForUpdate("2.0.0", "sinedied/cockpit-js", {
      fetchImpl: release("1.1.0"),
    });
    expect(info.updateAvailable).toBe(false);
  });

  it("flags an error (not an update) when the remote can't be read", async () => {
    const fetchImpl = async () => {
      throw new Error("offline");
    };
    const info = await checkForUpdate("1.0.0", "sinedied/cockpit-js", { fetchImpl });
    expect(info.error).toBe(true);
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBeNull();
    expect(info.latestTag).toBeNull();
  });
});

// Core functional + unit tests for Cockpit.js (no SDK, no network needed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Controller } from "../src/controller.ts";
import { parseJestLike, parseTap, parseTextCounts } from "../src/test-report.ts";
import { resolveBuild, resolveTest, laneAvailability } from "../src/lanes.ts";
import { classifyBump } from "../src/deps.ts";
import type { ProjectDetection } from "../src/types.ts";

let dir: string;
let controller: Controller;
let chatPrompt: string | null = null;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "np-sample-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "sample-app",
        version: "1.0.0",
        scripts: {
          build: "node -e \"console.log('built ok')\"",
          lint: "node -e \"console.log('lint ok')\"",
          test: "node --test",
          dev: "node -e \"console.log('  ➜  Local:   http://localhost:5199/'); setInterval(()=>{},1000)\"",
        },
      },
      null,
      2,
    ),
  );
  // package-lock.json so PM detection => npm
  await writeFile(path.join(dir, "package-lock.json"), "{}");
  await mkdir(path.join(dir, "test"), { recursive: true });
  await writeFile(
    path.join(dir, "test", "sample.test.js"),
    `import { test } from "node:test";
import assert from "node:assert";
test("passes", () => { assert.equal(1 + 1, 2); });
test("fails", () => { assert.equal(1 + 1, 3); });
`,
  );
  controller = new Controller(dir, {
    sendToChat: async (p) => {
      chatPrompt = p;
    },
  });
  await controller.init();
});

afterAll(async () => {
  if (controller?.dev.status === "running") await controller.stopDev();
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("detection", () => {
  it("detects the project and package manager", () => {
    const d = controller.detection;
    expect(d?.hasProject).toBe(true);
    expect((d as ProjectDetection).pm).toBe("npm");
  });

  it("detects the node test runner", () => {
    expect((controller.detection as ProjectDetection).testRunner).toBe("node");
  });

  it("lists package.json scripts", () => {
    const names = (controller.detection as ProjectDetection).scriptNames;
    expect(names).toContain("build");
    expect(names).toContain("dev");
  });

  it("computes lane availability", () => {
    const av = laneAvailability(controller.detection as ProjectDetection);
    expect(av.build).toBe(true);
    expect(av.test).toBe(true);
    expect(av.dev).toBe(true);
    expect(av.typecheck).toBe(false);
  });
});

describe("lanes", () => {
  it("runs the build lane to success", async () => {
    const build = await controller.runLane("build");
    expect(build.ok).toBe(true);
    expect(controller.lanes.build.status).toBe("passed");
  });

  it("resolves the build command from the build script", () => {
    const cmd = resolveBuild(controller.detection as ProjectDetection);
    expect(cmd.unavailable).toBeFalsy();
    if (!cmd.unavailable) expect(cmd.argv).toEqual(["npm", "run", "build"]);
  });

  it("resolves the node test runner command", () => {
    const cmd = resolveTest(controller.detection as ProjectDetection);
    expect(cmd.unavailable).toBeFalsy();
    if (!cmd.unavailable) expect(cmd.parser).toBe("tap");
  });
});

describe("test runner + report", () => {
  it("parses a 1 pass / 1 fail report and marks the lane failed", async () => {
    const tests = await controller.runTests({});
    expect(tests.report?.total).toBe(2);
    expect(tests.report?.passed).toBe(1);
    expect(tests.report?.failed).toBe(1);
    expect(controller.lanes.test.status).toBe("failed");
  });

  it("sends a context-rich fix prompt to chat", async () => {
    await controller.fixIssue("test");
    expect(typeof chatPrompt).toBe("string");
    expect(chatPrompt).toMatch(/tests are failing/i);
  });
});

describe("dev server lifecycle", () => {
  it("starts, detects the URL, and stops", async () => {
    const started = await controller.startDev();
    expect(started.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(controller.dev.url).toBe("http://localhost:5199/");
    const stopped = await controller.stopDev();
    expect(stopped.ok).toBe(true);
  });
});

describe("test-report parsers", () => {
  it("parses a jest/vitest-style JSON payload", () => {
    const report = parseJestLike({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
      testResults: [
        {
          name: "a.test.js",
          startTime: 1000,
          endTime: 1250,
          assertionResults: [
            { ancestorTitles: ["group"], title: "ok", status: "passed" },
            { ancestorTitles: [], title: "bad", status: "failed", failureMessages: ["boom"] },
          ],
        },
      ],
    });
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.suites[0].durationMs).toBe(250);
    expect(report.suites[0].tests[1].message).toBe("boom");
  });

  it("parses TAP output", () => {
    const report = parseTap("ok 1 - works\nnot ok 2 - broken\nok 3 - skip # SKIP later\n");
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("scrapes plain-text counts as a last resort", () => {
    const report = parseTextCounts("12 passing\n2 failing\n1 pending");
    expect(report.passed).toBe(12);
    expect(report.failed).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.total).toBe(15);
  });
});

describe("semver classification", () => {
  it("classifies patch / minor / major / downgrade bumps", () => {
    expect(classifyBump("1.0.0", "1.0.1")).toBe("patch");
    expect(classifyBump("1.0.0", "1.1.0")).toBe("minor");
    expect(classifyBump("1.0.0", "2.0.0")).toBe("major");
    expect(classifyBump("2.0.0", "1.0.0")).toBe("downgrade");
    expect(classifyBump("1.0.0", "1.0.0")).toBe("none");
    expect(classifyBump("^1.2.3", "1.2.4")).toBe("patch");
  });
});

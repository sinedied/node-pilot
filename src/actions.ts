// Agent-callable canvas actions. Each delegates to the shared controller so the
// agent and the UI drive exactly the same operations.
import type { Controller } from "./controller.ts";
import type { ActionContext, ActionDefinition } from "./types.ts";
import { formatBytes } from "./util.ts";

function statusSummary(controller: Controller): Record<string, unknown> {
  const d = controller.detection;
  if (!d?.hasProject) return { hasProject: false, reason: d?.reason };
  const lanes = Object.fromEntries(
    Object.entries(controller.lanes).map(([id, l]) => [id, l.status]),
  );
  return {
    hasProject: true,
    name: d.name,
    packageManager: d.pm,
    framework: d.framework.label,
    typescript: d.typescript,
    testRunner: d.testRunner,
    linter: d.linter,
    formatter: d.formatter,
    workspaces: d.workspaces,
    scripts: d.scriptNames,
    lanes,
    dev: { status: controller.dev.status, url: controller.dev.url },
    test: controller.test.report
      ? {
          passed: controller.test.report.passed,
          failed: controller.test.report.failed,
          total: controller.test.report.total,
        }
      : null,
  };
}

export function buildActions(controller: Controller): ActionDefinition[] {
  const actions: ActionDefinition[] = [
    {
      name: "get_status",
      description:
        "Get the detected project setup (package manager, framework, tooling) and current lane / dev-server / test status.",
      handler: () => statusSummary(controller),
    },
    {
      name: "get_project_info",
      description:
        "Get a project overview: name, version, platform (Node requirement, package manager, module type, license) and dependency/size metrics (direct + total installed deps, install footprint, published package size, build-output size).",
      handler: async () => {
        const d = controller.detection;
        if (!d?.hasProject) return { hasProject: false, reason: d?.reason };
        const stats = await controller.getProjectStats();
        const s = "hasProject" in stats ? null : stats;
        return {
          hasProject: true,
          name: d.name,
          version: d.version,
          description: d.description,
          license: d.license,
          private: d.private,
          platform: {
            nodeRequirement: d.engines?.node ?? d.nvmrc ?? null,
            packageManager: d.packageManagerField || d.pm,
            moduleType: d.moduleType,
            runtimeNode: d.runtimeNode,
          },
          dependencies: {
            direct: d.dependencyCount,
            dev: d.devDependencyCount,
            totalInstalled: s?.installedCount ?? null,
          },
          sizes: {
            installFootprint: s?.installBytes != null ? formatBytes(s.installBytes) : null,
            packed: s?.pack ? formatBytes(s.pack.packedBytes) : null,
            unpacked: s?.pack ? formatBytes(s.pack.unpackedBytes) : null,
            buildOutput: s?.build ? `${formatBytes(s.build.bytes)} (${s.build.dir})` : null,
          },
        };
      },
    },
    {
      name: "refresh",
      description:
        "Re-run project detection (package manager, scripts, framework, tooling) without reloading the extension.",
      handler: async () => {
        await controller.refresh();
        return statusSummary(controller);
      },
    },
    {
      name: "run_script",
      description: "Run a package.json script by name and wait for it to finish.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async (ctx: ActionContext) => controller.runScriptByName(String(ctx.input?.name)),
    },
    {
      name: "build_app",
      description:
        "Run the project's build (build script or framework default) and wait for the result.",
      handler: async () => controller.runLane("build"),
    },
    {
      name: "lint",
      description: "Run the linter. Pass { fix: true } to apply autofixes.",
      inputSchema: { type: "object", properties: { fix: { type: "boolean" } } },
      handler: async (ctx: ActionContext) =>
        controller.runLane("lint", { fix: Boolean(ctx.input?.fix) }),
    },
    {
      name: "format",
      description: "Run the formatter. Pass { check: true } to verify formatting without writing.",
      inputSchema: { type: "object", properties: { check: { type: "boolean" } } },
      handler: async (ctx: ActionContext) =>
        controller.runLane("format", { check: Boolean(ctx.input?.check) }),
    },
    {
      name: "typecheck",
      description: "Run the TypeScript type-checker (tsc --noEmit) and wait for the result.",
      handler: async () => controller.runLane("typecheck"),
    },
    {
      name: "run_tests",
      description:
        "Run the test suite and return a structured pass/fail report. Optional { pattern } filters tests.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
      handler: async (ctx: ActionContext) => {
        const r = await controller.runTests({ pattern: ctx.input?.pattern as string | undefined });
        return r.report
          ? { ok: r.ok, passed: r.report.passed, failed: r.report.failed, total: r.report.total }
          : r;
      },
    },
    {
      name: "start_dev",
      description:
        "Start the dev server. Returns once it is launching; the served URL is reported via get_dev_url once detected.",
      handler: async () => controller.startDev(),
    },
    {
      name: "stop_dev",
      description: "Stop the running dev server.",
      handler: async () => controller.stopDev(),
    },
    {
      name: "get_dev_url",
      description: "Get the dev server status and its detected local URL (if up).",
      handler: () => ({
        status: controller.dev.status,
        url: controller.dev.url,
        port: controller.dev.port,
      }),
    },
    {
      name: "get_logs",
      description:
        "Get the recent output of a lane ('build'|'lint'|'format'|'typecheck'|'test'|'dev'). Defaults to the dev server.",
      inputSchema: {
        type: "object",
        properties: { lane: { type: "string" }, lines: { type: "number" } },
      },
      handler: (ctx: ActionContext) => {
        const lane = (ctx.input?.lane as string) || "dev";
        const lines = (ctx.input?.lines as number) || 200;
        const src = lane === "dev" ? controller.dev.output : controller.lanes[lane]?.output;
        const text = (src || []).join("");
        return { lane, output: text.split(/\r?\n/).slice(-lines).join("\n") };
      },
    },
    {
      name: "list_outdated",
      description: "List outdated dependencies grouped by patch / minor / major.",
      handler: async () => {
        const r = await controller.listOutdated();
        return { supported: r.supported, count: r.list.length, packages: r.list };
      },
    },
    {
      name: "audit",
      description: "Run a security audit and return the vulnerability summary.",
      handler: async () => {
        const r = await controller.runAudit();
        return {
          metadata: r.metadata,
          count: r.vulnerabilities.length,
          vulnerabilities: r.vulnerabilities.slice(0, 50),
        };
      },
    },
    {
      name: "update_dependencies",
      description:
        "Safely update dependencies: apply updates, run the verify suite (type-check + build + test), and automatically roll back any package that breaks it. scope is 'patch' | 'minor' | 'major'; or pass an explicit { packages: ['name@version', ...] }. Optional { verify: ['typecheck','build','test','lint'] } overrides the verify steps.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["patch", "minor", "major"] },
          packages: { type: "array", items: { type: "string" } },
          verify: { type: "array", items: { type: "string" } },
        },
      },
      handler: async (ctx: ActionContext) => {
        const r = await controller.safeUpdate({
          scope: (ctx.input?.scope as "patch" | "minor" | "major") || "minor",
          packages: (ctx.input?.packages as string[]) || null,
          verify: (ctx.input?.verify as string[]) || null,
        });
        return {
          ok: r.ok,
          kept: (r.kept || []).map((t) => `${t.name}@${t.version}`),
          rolledBack: (r.failed || []).map((t) => ({
            name: t.name,
            version: t.version,
            brokeStep: t.step,
          })),
        };
      },
    },
    {
      name: "rollback_last_update",
      description:
        "Restore package.json and the lockfile to the state from just before the last safe update, then reinstall.",
      handler: async () => controller.rollbackLastUpdate(),
    },
    {
      name: "get_diagnostics",
      description:
        "Get live project-wide problems — TypeScript diagnostics from the project's own language server plus linter findings (Biome / ESLint / oxlint) — with file, line, column, source ('ts'|'lint'), TS code or lint rule, severity and message. Reflects saved files on disk. Returns combined counts plus the merged list.",
      handler: async () => {
        const d = controller.detection;
        if (!d?.hasProject) return { hasProject: false, reason: d?.reason };
        const tsAvail = !!d.availability?.diagnostics;
        const lintAvail = !!d.availability?.lint;
        if (!tsAvail && !lintAvail)
          return {
            available: false,
            reason: "Neither TypeScript nor a linter (Biome / ESLint / oxlint) detected.",
          };
        const ts = tsAvail ? await controller.getDiagnostics() : null;
        const lint = lintAvail ? await controller.getLintDiagnostics() : null;
        const merged = [...(ts?.diagnostics ?? []), ...(lint?.diagnostics ?? [])];
        return {
          available: true,
          status: { ts: ts?.status ?? null, lint: lint?.status ?? null },
          errorCount: (ts?.errorCount ?? 0) + (lint?.errorCount ?? 0),
          warningCount: (ts?.warningCount ?? 0) + (lint?.warningCount ?? 0),
          infoCount: lint?.infoCount ?? 0,
          diagnostics: merged.slice(0, 200).map((x) => ({
            file: x.file,
            line: x.start.line,
            column: x.start.offset,
            source: x.source ?? "ts",
            code: x.code,
            rule: x.rule ?? null,
            category: x.category,
            message: x.text,
          })),
        };
      },
    },
    {
      name: "fix_issue",
      description:
        "Push the most recent failure of a lane ('build'|'lint'|'typecheck'|'test'|'dev'|'script:<name>') to the chat as a context-rich Fix-with-Copilot prompt.",
      inputSchema: { type: "object", properties: { lane: { type: "string" } }, required: ["lane"] },
      handler: async (ctx: ActionContext) => controller.fixIssue(String(ctx.input?.lane)),
    },
  ];

  // Anchor to the session's working directory before every action runs.
  return actions.map((action) => ({
    ...action,
    handler: async (ctx: ActionContext) => {
      await controller.ensureProjectDir(ctx?.session?.workingDirectory);
      return action.handler(ctx);
    },
  }));
}

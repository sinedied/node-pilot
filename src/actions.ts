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
  const summary: Record<string, unknown> = {
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
  // Read-only Rayfin awareness (detection facts + cached dashboard, when loaded).
  // The Rayfin tab drives the CLI directly; we deliberately add no rayfin_* agent
  // actions since Rayfin ships its own MCP/CLI/skills the agent already uses.
  if (d.rayfin) {
    const r = controller._rayfin;
    const dep = r?.deployments.list.find((x) => x.active) ?? null;
    summary.rayfin = {
      detected: true,
      dialect: d.rayfin.dialect,
      authMethods: d.rayfin.authMethods,
      signedIn: r?.auth.signedIn ?? null,
      activeWorkspace: r?.deployments.active ?? null,
      appUrl: dep?.hostingUrl ?? null,
      fabricWorkspaceUrl: dep?.portalUrl ?? null,
    };
  }
  // Read-only multi-project awareness so the agent knows which project Cockpit is
  // focused on (and what else exists) in a monorepo / multi-root workspace. The
  // selector is human-facing; we add no agent action to switch projects.
  const projects = controller._projects;
  if (projects && projects.length > 1) {
    const active = projects.find((p) => p.dir === controller.cwd) ?? null;
    summary.projects = {
      active: active ? { name: active.name, path: active.rel } : null,
      list: projects.map((p) => ({ name: p.name, path: p.rel })),
    };
  }
  return summary;
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
        "Safely update dependencies: apply updates, run the verify suite (build + lint + test by default), and automatically roll back any package that breaks it. scope is 'patch' | 'minor' | 'major'; or pass an explicit { packages: ['name@version', ...] }. Optional { verify: ['build','lint','test','typecheck'] } overrides the verify steps. This tool only handles the verify/rollback loop — to guard against security regressions, call the separate audit action afterwards and roll back (via rollback_last_update) any package that introduced a new high/critical advisory.",
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
    // ---- Debugger (CDP) ----------------------------------------------------
    {
      name: "debug_start",
      description:
        "Launch a Node.js program under the debugger (node --inspect-brk). Provide { program } (path to a .js/.ts entry, resolved against the project dir) and optional { args, stopOnEntry, pauseOnExceptions }. By default it stops at entry so you can set breakpoints before calling debug_continue. pauseOnExceptions is 'none'|'uncaught'|'all'.",
      inputSchema: {
        type: "object",
        properties: {
          program: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          stopOnEntry: { type: "boolean" },
          pauseOnExceptions: { type: "string", enum: ["none", "uncaught", "all"] },
        },
        required: ["program"],
      },
      handler: async (ctx: ActionContext) =>
        controller.debugStart({
          program: ctx.input?.program as string,
          args: (ctx.input?.args as string[]) || undefined,
          stopOnEntry: ctx.input?.stopOnEntry as boolean | undefined,
          pauseOnExceptions: ctx.input?.pauseOnExceptions as
            | "none"
            | "uncaught"
            | "all"
            | undefined,
        }),
    },
    {
      name: "debug_attach",
      description:
        "Attach the debugger to an already-running Node.js inspector (e.g. a process started with --inspect). Provide { port } (default 9229) and optional { host } or a full { url } (ws://…). Use this to debug the dev server or test runner.",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string" },
          port: { type: "number" },
          url: { type: "string" },
          pauseOnExceptions: { type: "string", enum: ["none", "uncaught", "all"] },
        },
      },
      handler: async (ctx: ActionContext) =>
        controller.debugAttach({
          host: ctx.input?.host as string | undefined,
          port: ctx.input?.port as number | undefined,
          url: ctx.input?.url as string | undefined,
          pauseOnExceptions: ctx.input?.pauseOnExceptions as
            | "none"
            | "uncaught"
            | "all"
            | undefined,
        }),
    },
    {
      name: "debug_stop",
      description:
        "Stop the active debug session (kills a launched process; detaches an attached one). Breakpoints are kept for the next run.",
      handler: async () => controller.debugStop(),
    },
    {
      name: "debug_set_breakpoint",
      description:
        "Set (or replace) a breakpoint. Provide { file, line } (1-based line; file resolved against the project dir) and optional { column, condition }. Can be called before debug_start; pending breakpoints are applied when the session connects. Returns the breakpoint with `verified` once the inspector resolves it.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          column: { type: "number" },
          condition: { type: "string" },
        },
        required: ["file", "line"],
      },
      handler: async (ctx: ActionContext) =>
        controller.debugSetBreakpoint({
          file: String(ctx.input?.file),
          line: Number(ctx.input?.line),
          column: ctx.input?.column as number | undefined,
          condition: ctx.input?.condition as string | undefined,
        }),
    },
    {
      name: "debug_remove_breakpoint",
      description:
        "Remove a breakpoint by { id } (as returned by debug_set_breakpoint / debug_list_breakpoints) or by { file, line }.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
        },
      },
      handler: async (ctx: ActionContext) =>
        controller.debugRemoveBreakpoint({
          id: ctx.input?.id as string | undefined,
          file: ctx.input?.file as string | undefined,
          line: ctx.input?.line as number | undefined,
        }),
    },
    {
      name: "debug_list_breakpoints",
      description: "List all breakpoints (with their verified state and CDP ids).",
      handler: () => controller.debugListBreakpoints(),
    },
    {
      name: "debug_continue",
      description:
        "Resume execution until the next breakpoint or pause. Requires the target to be paused.",
      handler: async () => controller.debugContinue(),
    },
    {
      name: "debug_pause",
      description: "Pause the running target as soon as possible.",
      handler: async () => controller.debugPause(),
    },
    {
      name: "debug_step_over",
      description:
        "Step over the current line (run called functions without stepping into them). Requires a paused target.",
      handler: async () => controller.debugStepOver(),
    },
    {
      name: "debug_step_into",
      description: "Step into the function call on the current line. Requires a paused target.",
      handler: async () => controller.debugStepInto(),
    },
    {
      name: "debug_step_out",
      description: "Step out of the current function back to its caller. Requires a paused target.",
      handler: async () => controller.debugStepOut(),
    },
    {
      name: "debug_wait_for_pause",
      description:
        "Block until the target next pauses (breakpoint, step, exception or entry), then return the pause reason and call stack. Resolves immediately if already paused. Optional { timeoutMs } (default 30000, max 120000). Use this after debug_continue / debug_step_* to observe where execution stopped.",
      inputSchema: { type: "object", properties: { timeoutMs: { type: "number" } } },
      handler: async (ctx: ActionContext) =>
        controller.debugWaitForPause(ctx.input?.timeoutMs as number | undefined),
    },
    {
      name: "debug_get_stack",
      description:
        "Get the current call stack while paused: each frame's function name, file, line/column and a frameId to pass to debug_get_variables / debug_evaluate.",
      handler: () => controller.debugGetStack(),
    },
    {
      name: "debug_get_variables",
      description:
        "While paused, get the variables in scope for a frame, grouped by scope (local, closure, …). Optional { frameId } (defaults to the top frame) and { includeGlobal } to also dump the (large) global scope. Object/array values include an `objectId` you can expand with debug_get_properties.",
      inputSchema: {
        type: "object",
        properties: { frameId: { type: "string" }, includeGlobal: { type: "boolean" } },
      },
      handler: async (ctx: ActionContext) =>
        controller.debugGetVariables({
          frameId: ctx.input?.frameId as string | undefined,
          includeGlobal: Boolean(ctx.input?.includeGlobal),
        }),
    },
    {
      name: "debug_get_properties",
      description:
        "Expand an object/array by its `objectId` (from debug_get_variables or debug_evaluate) and return its properties.",
      inputSchema: {
        type: "object",
        properties: { objectId: { type: "string" } },
        required: ["objectId"],
      },
      handler: async (ctx: ActionContext) =>
        controller.debugGetProperties(String(ctx.input?.objectId)),
    },
    {
      name: "debug_evaluate",
      description:
        "Evaluate a JavaScript expression. While paused it runs in the context of a call frame (defaults to the top frame; pass { frameId } to choose another) so locals are in scope; otherwise it runs in the global REPL context. Returns the value (with an `objectId` for non-primitives).",
      inputSchema: {
        type: "object",
        properties: { expression: { type: "string" }, frameId: { type: "string" } },
        required: ["expression"],
      },
      handler: async (ctx: ActionContext) =>
        controller.debugEvaluate({
          expression: String(ctx.input?.expression),
          frameId: ctx.input?.frameId as string | undefined,
        }),
    },
    {
      name: "debug_get_state",
      description:
        "Get the debugger status: stopped|starting|running|paused, the target, the current pause (reason + stack) and the breakpoint list.",
      handler: () => controller.debugGetState(),
    },
    // ---- Rayfin (Microsoft Fabric Apps) ------------------------------------
    {
      name: "rayfin_new_project",
      description:
        "Start a brand-new Rayfin project (Microsoft Fabric Apps backend-as-a-service). Available even when no project is open. Hands Copilot the canonical setup prompt (pick a template, check prerequisites, scaffold with create-rayfin, then plan the data model). Use this when the user asks to create / scaffold / bootstrap a new Rayfin or Fabric app.",
      handler: async () => controller.startRayfinProject(),
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

// Build context-rich prompts that Cockpit.js hands back to the agent so it can
// diagnose and fix a failure. Output is trimmed to keep prompts focused.
import path from "node:path";
import type { AuditVulnerability, Diagnostic, TestReport, UpdateFailure } from "./types.ts";

function tail(text: string | undefined, lines = 120): string {
  const arr = (text || "").split(/\r?\n/);
  return arr.slice(-lines).join("\n").trim();
}

const LANE_LABELS: Record<string, string> = {
  build: "build",
  lint: "lint",
  format: "format",
  typecheck: "type-check",
  test: "test",
  dev: "dev server",
  deps: "dependency update",
};

export interface FixPromptInput {
  lane: string;
  label?: string;
  command?: string | null;
  exitCode?: number;
  output?: string;
  extra?: string;
}

export function buildFixPrompt({
  lane,
  label,
  command,
  exitCode,
  output,
  extra,
}: FixPromptInput): string {
  const what = LANE_LABELS[lane] || lane;
  const parts = [
    `The Cockpit.js **${what}** step failed in this project. Please diagnose the root cause and fix it.`,
    "",
    `- Command: \`${command || label || "(unknown)"}\``,
  ];
  if (typeof exitCode === "number") parts.push(`- Exit code: ${exitCode}`);
  if (extra) parts.push(extra);
  parts.push("", "Relevant output (tail):", "```", tail(output), "```", "");
  parts.push(
    "Investigate the failing files, make the minimal change needed to fix it, then re-run the failing step to confirm it passes.",
  );
  return parts.join("\n");
}

export interface TestFixPromptInput {
  command: string;
  report?: TestReport | null;
  output?: string;
}

export function buildTestFixPrompt({ command, report, output }: TestFixPromptInput): string {
  const failed: string[] = [];
  for (const s of report?.suites || []) {
    for (const t of s.tests || []) {
      if (t.status === "failed")
        failed.push(`- ${t.name}${t.message ? `\n  ${t.message.split("\n")[0]}` : ""}`);
    }
  }
  const parts = [
    `Tests are failing in this project (${report?.failed ?? "?"} failed / ${report?.total ?? "?"} total). Please fix them.`,
    "",
    `- Command: \`${command}\``,
    "",
  ];
  if (failed.length) {
    parts.push("Failing tests:", failed.slice(0, 40).join("\n"), "");
  }
  parts.push("Output (tail):", "```", tail(output, 150), "```", "");
  parts.push(
    "Find the cause of each failure, fix the code (or the test if it is wrong), then re-run the tests.",
  );
  return parts.join("\n");
}

export interface DepsFixPromptInput {
  failures?: UpdateFailure[];
  verifyStep?: string;
  output?: string;
}

export function buildDepsFixPrompt({ failures, verifyStep, output }: DepsFixPromptInput): string {
  const list = (failures || [])
    .map((f) => `- ${f.name}${f.from ? ` ${f.from} → ${f.to}` : ""}`)
    .join("\n");
  const parts = [
    "A dependency update broke the project's verification suite. Cockpit.js rolled the breaking package(s) back to keep the app working. Please make the codebase compatible with the newer version(s), then we can update safely.",
    "",
    "Package(s) that could not be updated:",
    list || "(see output)",
    "",
  ];
  if (verifyStep) parts.push(`- Failing verification step: **${verifyStep}**`);
  parts.push("", "Failure output (tail):", "```", tail(output, 150), "```", "");
  parts.push(
    "Review each package's breaking changes / migration notes, update the affected code, then re-run the safe update for these packages.",
  );
  return parts.join("\n");
}

export interface UpdatePromptTarget {
  name: string;
  from?: string | null;
  to: string;
}

export interface DepsUpdatePromptInput {
  mode: "default" | "latest";
  targets: UpdatePromptTarget[];
  baselineAudit?: Record<string, number> | null;
  // Packages with a pre-existing high/critical advisory, so the agent treats
  // only genuinely new ones as a regression (count-only comparison is unreliable).
  baselineSevere?: string[];
}

// Prompt the agent to perform a dependency update end-to-end via Cockpit.js's
// deps tools: apply the targeted bumps, verify build+lint+test (auto-rollback per
// package), then ensure the update didn't introduce new high/critical advisories.
export function buildDepsUpdatePrompt({
  mode,
  targets,
  baselineAudit,
  baselineSevere,
}: DepsUpdatePromptInput): string {
  const specs = targets.map((t) => `${t.name}@${t.to}`);
  const list = targets
    .map((t) => `- ${t.name}${t.from ? ` ${t.from} → ${t.to}` : ` → ${t.to}`}`)
    .join("\n");
  const base = baselineAudit || {};
  const baseline = `high: ${base.high || 0}, critical: ${base.critical || 0}`;
  const severe = baselineSevere?.length ? baselineSevere.join(", ") : "none";
  const scopeNote =
    mode === "default"
      ? "These are the packages I picked, targeting the version allowed by package.json (in-range)."
      : "These are the packages I picked, targeting their latest versions (may cross the semver range).";
  return [
    "Please update my dependencies using Cockpit.js's tools, and keep the app working.",
    "",
    scopeNote,
    "",
    "Packages to update:",
    list,
    "",
    "Steps:",
    `1. Call the **update_dependencies** tool with \`packages: ${JSON.stringify(specs)}\` and \`verify: ["build","lint","test"]\`. It applies the updates, runs the verify suite, and automatically rolls back any single package that breaks a step.`,
    "2. Then call the **audit** tool. Before the update the counts were " +
      `**${baseline}** and the packages already carrying a high/critical advisory were: **${severe}**. ` +
      "If the update raises the high/critical count OR introduces a high/critical advisory in any package not in that list, roll the offending package(s) back (use **rollback_last_update** or re-run update_dependencies without them) — a security regression counts as a failure.",
    "3. If anything was reverted, briefly explain *why* (which verify step failed, or which new advisory appeared) and suggest what code changes would let us adopt the newer version later.",
    "",
    "Finally, report which packages were updated and kept, and which were reverted and why.",
  ].join("\n");
}

export interface DepsAuditFixPromptInput {
  vulnerabilities: AuditVulnerability[];
  // When true, `<pm> audit fix` already ran cleanly, so a survivor that npm only
  // flags `fixAvailable: true` with no concrete `fix.version` is stuck (bundled /
  // pinned / peer-constrained) and a plain version bump won't resolve it — those
  // are framed as "investigate manually". Only vulns npm gave a concrete fix
  // target for (which audit fix skipped) go in the actionable "update" bucket.
  auditFixRan?: boolean;
}

// Prompt the agent to remediate known vulnerabilities: bump the packages that
// have a fix available, verify build+lint+test, and report anything that can't be
// fixed automatically (no fix yet, or a breaking major that needs code changes).
export function buildDepsAuditFixPrompt({
  vulnerabilities,
  auditFixRan = false,
}: DepsAuditFixPromptInput): string {
  // A vuln is actionable via a bump only if there's something concrete to try.
  // After a clean `audit fix`, that means npm gave a concrete `fix.version` the
  // fix skipped (out of range / needs --force / major); a bare `fixAvailable`
  // survivor has no target and is stuck.
  const isActionable = (v: AuditVulnerability) =>
    auditFixRan ? Boolean(v.fix?.version) : v.fixAvailable;
  const fixable = vulnerabilities.filter(isActionable);
  const unfixable = vulnerabilities.filter((v) => !isActionable(v));
  const line = (v: AuditVulnerability, actionable: boolean) => {
    const fix =
      actionable && v.fix?.version
        ? ` → ${v.fix.name || v.name}@${v.fix.version}${v.fix.major ? " (major / possibly breaking)" : ""}`
        : actionable
          ? " → fix available"
          : auditFixRan && v.fixAvailable
            ? " → npm audit fix could not apply it (likely a bundled/pinned transitive dependency); investigate manually — a plain version bump won't resolve it"
            : " → no fix available yet";
    const adv = v.advisories
      .map((a) => a.url)
      .filter(Boolean)
      .slice(0, 2)
      .join(", ");
    return `- ${v.name} (${v.severity})${v.range ? ` ${v.range}` : ""}${fix}${adv ? ` — ${adv}` : ""}`;
  };
  const parts = [
    "Please fix the security vulnerabilities Cockpit.js found, without breaking the app.",
    "",
  ];
  if (fixable.length) {
    parts.push(
      "Vulnerabilities with a fix available:",
      fixable.map((v) => line(v, true)).join("\n"),
      "",
      'For these, call the **update_dependencies** tool with the fixed versions as explicit `packages` and `verify: ["build","lint","test"]` (it auto-rolls-back anything that breaks a step). Treat major-version fixes carefully — apply the code changes needed to keep build/lint/test green; if that\'s not feasible right now, leave the package and report it.',
      "",
    );
  }
  if (unfixable.length) {
    parts.push(
      "Vulnerabilities with no automatic fix (report these, don't force a bump):",
      unfixable.map((v) => line(v, false)).join("\n"),
      "",
    );
  }
  parts.push(
    "After applying fixes, run the **audit** tool again to confirm what's resolved, and report which vulnerabilities are fixed and which remain (and why).",
  );
  return parts.join("\n");
}

export interface DiagnosticFixPromptInput {
  cwd: string;
  diagnostics: Diagnostic[];
}

// Build a Fix-with-Copilot prompt for one or more problems from the live Problems
// panel — TypeScript diagnostics, linter findings, or a mix. Locations are 1-based
// line:column with the TS error code or lint rule so the agent can jump straight
// to the source.
export function buildDiagnosticFixPrompt({ cwd, diagnostics }: DiagnosticFixPromptInput): string {
  const rel = (file: string) => {
    const r = path.relative(cwd, file);
    return r && !r.startsWith("..") ? r : file;
  };
  const tag = (d: Diagnostic) => {
    if (d.source === "lint") return d.rule ? `lint(${d.rule})` : "lint";
    return d.code ? `TS${d.code}` : d.category;
  };
  const hasTs = diagnostics.some((d) => d.source !== "lint");
  const hasLint = diagnostics.some((d) => d.source === "lint");
  const kind = hasTs && hasLint ? "TypeScript + lint" : hasLint ? "lint" : "TypeScript";
  const single = diagnostics.length === 1;
  const lines = diagnostics
    .slice(0, 50)
    .map((d) => `- ${rel(d.file)}:${d.start.line}:${d.start.offset} — ${tag(d)}: ${d.text}`)
    .join("\n");
  const parts = single
    ? [`Please fix this ${kind} problem reported by Cockpit.js:`, "", lines, ""]
    : [
        `Please fix these ${diagnostics.length} ${kind} problems reported by Cockpit.js:`,
        "",
        lines,
        "",
      ];
  const sources = [
    hasTs ? "the project's own TypeScript language server" : null,
    hasLint ? "the project's linter" : null,
  ]
    .filter(Boolean)
    .join(" and ");
  parts.push(
    `These come from ${sources} (saved files on disk). Diagnose the root cause of each, make the minimal change to fix it, and keep the rest of the project type-safe and lint-clean.`,
  );
  return parts.join("\n");
}

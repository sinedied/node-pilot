// Build context-rich prompts that Cockpit.js hands back to the agent so it can
// diagnose and fix a failure. Output is trimmed to keep prompts focused.
import path from "node:path";
import type { Diagnostic, TestReport, UpdateFailure } from "./types.ts";

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

export interface DiagnosticFixPromptInput {
  cwd: string;
  diagnostics: Diagnostic[];
}

// Build a Fix-with-Copilot prompt for one or more TypeScript diagnostics from
// the live Problems panel. Locations are 1-based line:column with the TS error
// code so the agent can jump straight to the source.
export function buildDiagnosticFixPrompt({ cwd, diagnostics }: DiagnosticFixPromptInput): string {
  const rel = (file: string) => {
    const r = path.relative(cwd, file);
    return r && !r.startsWith("..") ? r : file;
  };
  const single = diagnostics.length === 1;
  const lines = diagnostics
    .slice(0, 50)
    .map((d) => {
      const code = d.code ? `TS${d.code}` : d.category;
      return `- ${rel(d.file)}:${d.start.line}:${d.start.offset} — ${code}: ${d.text}`;
    })
    .join("\n");
  const parts = single
    ? ["Please fix this TypeScript problem reported by Cockpit.js:", "", lines, ""]
    : [
        `Please fix these ${diagnostics.length} TypeScript problems reported by Cockpit.js:`,
        "",
        lines,
        "",
      ];
  parts.push(
    "These come from the project's own TypeScript language server (saved files on disk). Diagnose the root cause of each, make the minimal change to fix it, and keep the rest of the project type-safe.",
  );
  return parts.join("\n");
}

// Build context-rich prompts that Node Pilot hands back to the agent so it can
// diagnose and fix a failure. Output is trimmed to keep prompts focused.

function tail(text, lines = 120) {
  const arr = (text || "").split(/\r?\n/);
  return arr.slice(-lines).join("\n").trim();
}

const LANE_LABELS = {
  build: "build",
  lint: "lint",
  format: "format",
  typecheck: "type-check",
  test: "test",
  dev: "dev server",
  deps: "dependency update",
};

export function buildFixPrompt({ lane, label, command, exitCode, output, extra }) {
  const what = LANE_LABELS[lane] || lane;
  const parts = [
    `The Node Pilot **${what}** step failed in this project. Please diagnose the root cause and fix it.`,
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

export function buildTestFixPrompt({ command, report, output }) {
  const failed = [];
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

export function buildDepsFixPrompt({ failures, verifyStep, output }) {
  const list = (failures || [])
    .map((f) => `- ${f.name}${f.from ? ` ${f.from} → ${f.to}` : ""}`)
    .join("\n");
  const parts = [
    "A dependency update broke the project's verification suite. Node Pilot rolled the breaking package(s) back to keep the app working. Please make the codebase compatible with the newer version(s), then we can update safely.",
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

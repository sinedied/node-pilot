// Normalize test-runner output into a single graphical report shape:
//   { ok, total, passed, failed, skipped, pending, suites: [{ name, tests }] }
// where tests is [{ name, status, message }].

function emptyReport() {
  return { ok: true, total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, suites: [] };
}

// Vitest's JSON reporter mirrors Jest's, so one parser handles both.
export function parseJestLike(json) {
  const report = emptyReport();
  const results = Array.isArray(json?.testResults) ? json.testResults : [];
  for (const file of results) {
    const suite = { name: file.name || file.testFilePath || "tests", tests: [] };
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const a of assertions) {
      const status = a.status || "unknown";
      suite.tests.push({
        name: [...(a.ancestorTitles || []), a.title || a.fullName || ""]
          .filter(Boolean)
          .join(" › "),
        status,
        message: (a.failureMessages || []).join("\n\n").trim() || null,
      });
    }
    report.suites.push(suite);
  }

  if (typeof json?.numTotalTests === "number") {
    report.total = json.numTotalTests;
    report.passed = json.numPassedTests || 0;
    report.failed = json.numFailedTests || 0;
    report.pending = json.numPendingTests || 0;
    report.skipped = (json.numTodoTests || 0) + (json.numPendingTests || 0);
  } else {
    tallyFromSuites(report);
  }
  report.ok = report.failed === 0;
  return report;
}

function tallyFromSuites(report) {
  for (const s of report.suites) {
    for (const t of s.tests) {
      report.total++;
      if (t.status === "passed") report.passed++;
      else if (t.status === "failed") report.failed++;
      else if (t.status === "pending" || t.status === "skipped" || t.status === "todo")
        report.skipped++;
    }
  }
}

// node:test (and any TAP13 emitter): parse `ok` / `not ok` lines.
export function parseTap(text) {
  const report = emptyReport();
  const suite = { name: "tests", tests: [] };
  const lines = (text || "").split(/\r?\n/);
  let pendingFail = null;
  for (const line of lines) {
    const m = /^(ok|not ok)\s+\d+\s*-?\s*(.*)$/.exec(line.trim());
    if (m) {
      const failed = m[1] === "not ok";
      const directive = /#\s*(skip|todo)\b/i.exec(m[2]);
      const name = m[2].replace(/#\s*(skip|todo)\b.*/i, "").trim() || "(unnamed)";
      if (directive) {
        suite.tests.push({ name, status: "skipped", message: null });
      } else {
        suite.tests.push({ name, status: failed ? "failed" : "passed", message: null });
        if (failed) pendingFail = suite.tests[suite.tests.length - 1];
      }
      continue;
    }
    // Capture indented YAML diagnostics under a failing assertion as a message.
    if (pendingFail && /^\s+/.test(line)) {
      pendingFail.message = (pendingFail.message || "") + line + "\n";
    } else {
      pendingFail = null;
    }
  }
  if (suite.tests.length) report.suites.push(suite);
  tallyFromSuites(report);
  report.ok = report.failed === 0;
  return report;
}

// Last-resort: scrape pass/fail counts from arbitrary runner output (bun, mocha).
export function parseTextCounts(text) {
  const report = emptyReport();
  const t = text || "";
  const pass = /(\d+)\s+pass(?:ed|ing)?/i.exec(t) || /(\d+)\s+tests?\s+passed/i.exec(t);
  const fail = /(\d+)\s+fail(?:ed|ing)?/i.exec(t) || /(\d+)\s+tests?\s+failed/i.exec(t);
  const skip = /(\d+)\s+(?:skip(?:ped)?|pending|todo)/i.exec(t);
  report.passed = pass ? Number(pass[1]) : 0;
  report.failed = fail ? Number(fail[1]) : 0;
  report.skipped = skip ? Number(skip[1]) : 0;
  report.total = report.passed + report.failed + report.skipped;
  report.ok = report.failed === 0;
  report.suites = [];
  return report;
}

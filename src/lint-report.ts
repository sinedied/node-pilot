// Normalize a linter's machine-readable (JSON) output into the shared Diagnostic
// shape so lint findings can render alongside TypeScript diagnostics in the
// Problems panel. Supports Biome, ESLint and oxlint. Positions are 1-based
// line/column; files are resolved to absolute paths so lint + TS findings for the
// same file merge into one group.
import path from "node:path";
import type { Diagnostic, DiagnosticCategory } from "./types.ts";

// Map a textual severity ("error" / "warning" / "info" / "hint" / …) to a
// Diagnostic category. Everything below warning becomes a "suggestion" — shown in
// the panel as a low-priority hint that does not drive the tab badge.
function severityFromText(sev: unknown): DiagnosticCategory {
  const s = String(sev || "").toLowerCase();
  if (s === "error" || s === "fatal") return "error";
  if (s === "warn" || s === "warning") return "warning";
  return "suggestion";
}

function abs(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

function pos(line: unknown, col: unknown): { line: number; offset: number } {
  const l = Number(line);
  const c = Number(col);
  return { line: Number.isFinite(l) ? l : 1, offset: Number.isFinite(c) ? c : 1 };
}

// Biome `--reporter=json`: { diagnostics: [{ severity, message, category (rule id),
// location: { path, start:{line,column}, end:{line,column} } }] }. `message` is a
// string in the JSON reporter; `path` is usually a string but can be { file }.
// biome-ignore lint/suspicious/noExplicitAny: parses arbitrary external linter JSON
export function parseBiomeLint(json: any, cwd: string): Diagnostic[] {
  const list = Array.isArray(json?.diagnostics) ? json.diagnostics : [];
  const out: Diagnostic[] = [];
  for (const d of list) {
    const loc = d?.location || {};
    const rawPath = typeof loc.path === "string" ? loc.path : loc.path?.file;
    if (!rawPath) continue;
    const text =
      typeof d.message === "string"
        ? d.message
        : Array.isArray(d.message)
          ? d.message
              .map((m: { content?: string; text?: string }) => m?.content ?? m?.text ?? "")
              .join("")
          : String(d.description || "");
    const start = pos(loc.start?.line, loc.start?.column);
    out.push({
      file: abs(cwd, rawPath),
      start,
      end: pos(loc.end?.line ?? loc.start?.line, loc.end?.column ?? loc.start?.column),
      code: null,
      category: severityFromText(d.severity),
      text: text.trim() || "Lint problem",
      source: "lint",
      rule: d.category || null,
    });
  }
  return out;
}

// ESLint `--format json`: [{ filePath, messages:[{ ruleId, severity (1=warn/2=err),
// message, line, column, endLine, endColumn, fatal }] }].
// biome-ignore lint/suspicious/noExplicitAny: parses arbitrary external linter JSON
export function parseEslintLint(json: any, cwd: string): Diagnostic[] {
  const files = Array.isArray(json) ? json : [];
  const out: Diagnostic[] = [];
  for (const f of files) {
    const file = f?.filePath;
    if (!file) continue;
    for (const m of Array.isArray(f.messages) ? f.messages : []) {
      const category: DiagnosticCategory =
        m.fatal || m.severity === 2 ? "error" : m.severity === 1 ? "warning" : "suggestion";
      out.push({
        file: abs(cwd, file),
        start: pos(m.line, m.column),
        end: pos(m.endLine ?? m.line, m.endColumn ?? m.column),
        code: null,
        category,
        text: String(m.message || "").trim() || "Lint problem",
        source: "lint",
        rule: m.ruleId || (m.fatal ? "parse-error" : null),
      });
    }
  }
  return out;
}

// oxlint `--format=json`: { diagnostics: [{ message, code (e.g. "eslint(no-debugger)"),
// severity, filename, labels:[{ span:{ offset, length, line, column } }] }] }.
// biome-ignore lint/suspicious/noExplicitAny: parses arbitrary external linter JSON
export function parseOxlintLint(json: any, cwd: string): Diagnostic[] {
  const list = Array.isArray(json?.diagnostics) ? json.diagnostics : [];
  const out: Diagnostic[] = [];
  for (const d of list) {
    const file = d?.filename;
    if (!file) continue;
    const span = Array.isArray(d.labels) ? d.labels[0]?.span : null;
    const start = pos(span?.line, span?.column);
    out.push({
      file: abs(cwd, file),
      start,
      end: start,
      code: null,
      category: severityFromText(d.severity),
      text: String(d.message || "").trim() || "Lint problem",
      source: "lint",
      rule: d.code || null,
    });
  }
  return out;
}

// Parse raw linter stdout for the given parser into Diagnostic[]. Throws if the
// output is not valid JSON (the caller surfaces it as a lint "error" state).
export function parseLint(parser: string, raw: string, cwd: string): Diagnostic[] {
  const json = JSON.parse(raw);
  if (parser === "biome") return parseBiomeLint(json, cwd);
  if (parser === "eslint") return parseEslintLint(json, cwd);
  if (parser === "oxlint") return parseOxlintLint(json, cwd);
  return [];
}

// Order a merged diagnostics list errors-first, then warnings, then suggestions,
// keeping per-file locality so the Problems panel groups cleanly.
export function sortDiagnostics(diags: Diagnostic[]): Diagnostic[] {
  const rank: Record<string, number> = { error: 0, warning: 1, suggestion: 2, message: 3 };
  return [...diags].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const ra = rank[a.category] ?? 9;
    const rb = rank[b.category] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.start.line - b.start.line || a.start.offset - b.start.offset;
  });
}

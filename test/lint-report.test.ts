// Unit tests for the linter JSON → Diagnostic[] parsers (Biome / ESLint / oxlint).
import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  parseBiomeLint,
  parseEslintLint,
  parseLint,
  parseOxlintLint,
  sortDiagnostics,
} from "../src/lint-report.ts";

const cwd = "/project";

describe("parseBiomeLint", () => {
  it("maps biome diagnostics with rule id, severity and absolute path", () => {
    const json = {
      diagnostics: [
        {
          severity: "error",
          message: "This let declares a variable that is only assigned once.",
          category: "lint/style/useConst",
          location: {
            path: "src/app.ts",
            start: { line: 12, column: 3 },
            end: { line: 12, column: 9 },
          },
        },
        {
          severity: "information",
          message: "Template literals are preferred.",
          category: "lint/style/useTemplate",
          location: { path: "src/app.ts", start: { line: 40, column: 1 } },
        },
      ],
    };
    const out = parseBiomeLint(json, cwd);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      file: path.resolve(cwd, "src/app.ts"),
      start: { line: 12, offset: 3 },
      category: "error",
      source: "lint",
      rule: "lint/style/useConst",
      code: null,
    });
    // info / hint level collapses to a non-badging suggestion.
    expect(out[1].category).toBe("suggestion");
    expect(out[1].rule).toBe("lint/style/useTemplate");
  });

  it("tolerates an object-shaped path and missing diagnostics", () => {
    expect(parseBiomeLint({}, cwd)).toEqual([]);
    const out = parseBiomeLint(
      {
        diagnostics: [
          {
            severity: "warning",
            message: "x",
            category: "lint/a/b",
            location: { path: { file: "lib/x.js" }, start: { line: 1, column: 1 } },
          },
        ],
      },
      cwd,
    );
    expect(out[0].file).toBe(path.resolve(cwd, "lib/x.js"));
    expect(out[0].category).toBe("warning");
  });
});

describe("parseEslintLint", () => {
  it("maps eslint severities (2=error, 1=warning) and keeps absolute filePath", () => {
    const json = [
      {
        filePath: "/project/src/index.js",
        messages: [
          { ruleId: "no-unused-vars", severity: 1, message: "'x' is unused.", line: 3, column: 7 },
          {
            ruleId: "no-debugger",
            severity: 2,
            message: "Unexpected debugger.",
            line: 9,
            column: 1,
            endLine: 9,
            endColumn: 9,
          },
        ],
      },
    ];
    const out = parseEslintLint(json, cwd);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      file: "/project/src/index.js",
      category: "warning",
      source: "lint",
      rule: "no-unused-vars",
    });
    expect(out[1]).toMatchObject({
      category: "error",
      rule: "no-debugger",
      end: { line: 9, offset: 9 },
    });
  });

  it("treats fatal parse errors as errors with a parse-error rule fallback", () => {
    const json = [
      {
        filePath: "/project/bad.js",
        messages: [{ fatal: true, message: "Parsing error: Unexpected token", line: 1, column: 5 }],
      },
    ];
    const out = parseEslintLint(json, cwd);
    expect(out[0].category).toBe("error");
    expect(out[0].rule).toBe("parse-error");
  });
});

describe("parseOxlintLint", () => {
  it("reads label span line/column and the eslint(rule) code", () => {
    const json = {
      diagnostics: [
        {
          message: "`debugger` statement is not allowed",
          code: "eslint(no-debugger)",
          severity: "error",
          filename: "src/x.js",
          labels: [{ span: { offset: 20, length: 8, line: 4, column: 2 } }],
        },
      ],
    };
    const out = parseOxlintLint(json, cwd);
    expect(out[0]).toMatchObject({
      file: path.resolve(cwd, "src/x.js"),
      start: { line: 4, offset: 2 },
      category: "error",
      rule: "eslint(no-debugger)",
      source: "lint",
    });
  });
});

describe("parseLint dispatch + sort", () => {
  it("throws on non-JSON output", () => {
    expect(() => parseLint("biome", "not json", cwd)).toThrow();
  });

  it("returns [] for an unknown parser", () => {
    expect(parseLint("nope", "[]", cwd)).toEqual([]);
  });

  it("orders errors before warnings before suggestions within a file", () => {
    const file = path.resolve(cwd, "a.ts");
    const mk = (category: "error" | "warning" | "suggestion", line: number) => ({
      file,
      start: { line, offset: 1 },
      end: { line, offset: 1 },
      code: null,
      category,
      text: category,
      source: "lint" as const,
      rule: "r",
    });
    const sorted = sortDiagnostics([mk("suggestion", 1), mk("error", 9), mk("warning", 5)]);
    expect(sorted.map((d) => d.category)).toEqual(["error", "warning", "suggestion"]);
  });
});

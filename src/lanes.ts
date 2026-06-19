// Resolve each lane to a concrete command for the detected project. Prefer the
// project's own package.json scripts; otherwise fall back to running the locally
// installed tool with sensible defaults.
import { runScript, exec } from "./pm.ts";
import type {
  Detection,
  LaneAvailability,
  LaneResult,
  PinnedTask,
  ProjectDetection,
} from "./types.ts";

function hasScript(d: ProjectDetection, name: string): boolean {
  return Boolean(d.scripts?.[name]);
}

// Pick the first matching script name from a list of candidates.
function pickScript(d: ProjectDetection, candidates: string[]): string | null {
  for (const c of candidates) if (hasScript(d, c)) return c;
  return null;
}

export function resolveBuild(d: ProjectDetection): LaneResult {
  const script = pickScript(d, ["build"]);
  if (script) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  const fw = d.framework.id;
  const defaults: Record<string, string[]> = {
    next: ["next", "build"],
    nuxt: ["nuxt", "build"],
    astro: ["astro", "build"],
    sveltekit: ["vite", "build"],
    remix: ["remix", "vite:build"],
    angular: ["ng", "build"],
    qwik: ["vite", "build"],
    gatsby: ["gatsby", "build"],
    vite: ["vite", "build"],
  };
  if (defaults[fw]) return { label: defaults[fw].join(" "), argv: exec(d.pm, defaults[fw]) };
  if (d.typescript) return { label: "tsc -p .", argv: exec(d.pm, ["tsc", "-p", "."]) };
  return { unavailable: true, reason: "No build script or known framework detected." };
}

export function resolveLint(d: ProjectDetection, { fix = false } = {}): LaneResult {
  const script = pickScript(d, ["lint"]);
  if (script && !fix) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  if (d.linter === "eslint")
    return {
      label: `eslint .${fix ? " --fix" : ""}`,
      argv: exec(d.pm, ["eslint", ".", ...(fix ? ["--fix"] : [])]),
    };
  if (d.linter === "biome")
    return {
      label: `biome lint${fix ? " --write" : ""}`,
      argv: exec(d.pm, ["biome", "lint", ...(fix ? ["--write"] : []), "."]),
    };
  if (d.linter === "oxlint")
    return {
      label: `oxlint${fix ? " --fix" : ""}`,
      argv: exec(d.pm, ["oxlint", ...(fix ? ["--fix"] : [])]),
    };
  if (script) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  return { unavailable: true, reason: "No linter (eslint / biome / oxlint) detected." };
}

export function resolveFormat(d: ProjectDetection, { check = false } = {}): LaneResult {
  const script = pickScript(d, check ? ["format:check", "format"] : ["format"]);
  if (script) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  if (d.formatter === "prettier")
    return {
      label: `prettier ${check ? "--check" : "--write"} .`,
      argv: exec(d.pm, ["prettier", check ? "--check" : "--write", "."]),
    };
  if (d.formatter === "biome")
    return {
      label: `biome format ${check ? "" : "--write "}.`.trim(),
      argv: exec(d.pm, ["biome", "format", ...(check ? [] : ["--write"]), "."]),
    };
  return { unavailable: true, reason: "No formatter (prettier / biome) detected." };
}

export function resolveTypecheck(d: ProjectDetection): LaneResult {
  const script = pickScript(d, ["typecheck", "type-check", "tsc", "check-types"]);
  if (script) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  if (d.typescript) return { label: "tsc --noEmit", argv: exec(d.pm, ["tsc", "--noEmit"]) };
  return {
    unavailable: true,
    reason: "TypeScript not detected (no tsconfig.json / typescript dep).",
  };
}

export function resolveDev(d: ProjectDetection): LaneResult {
  const script = pickScript(d, ["dev", "start", "serve"]);
  if (script) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  const fw = d.framework.id;
  const defaults: Record<string, string[]> = {
    next: ["next", "dev"],
    nuxt: ["nuxt", "dev"],
    astro: ["astro", "dev"],
    sveltekit: ["vite", "dev"],
    remix: ["remix", "vite:dev"],
    angular: ["ng", "serve"],
    qwik: ["vite"],
    gatsby: ["gatsby", "develop"],
    vite: ["vite"],
  };
  if (defaults[fw]) return { label: defaults[fw].join(" "), argv: exec(d.pm, defaults[fw]) };
  return { unavailable: true, reason: "No dev / start script or known framework detected." };
}

export interface TestOptions {
  pattern?: string;
  outputFile?: string;
}

// Returns { label, argv, parser, outputFile? }. `parser` selects the report
// parser in test-report.ts.
export function resolveTest(
  d: ProjectDetection,
  { pattern, outputFile }: TestOptions = {},
): LaneResult {
  const pat = pattern ? [pattern] : [];
  switch (d.testRunner) {
    case "vitest":
      return {
        label: "vitest run",
        parser: "jest",
        outputFile,
        argv: exec(d.pm, [
          "vitest",
          "run",
          ...pat,
          "--reporter=json",
          ...(outputFile ? ["--outputFile", outputFile] : []),
        ]),
      };
    case "jest":
      return {
        label: "jest",
        parser: "jest",
        outputFile,
        argv: exec(d.pm, [
          "jest",
          ...pat,
          "--json",
          ...(outputFile ? ["--outputFile", outputFile] : []),
        ]),
      };
    case "node":
      return {
        label: "node --test",
        parser: "tap",
        argv: ["node", "--test", "--test-reporter=tap", ...pat],
      };
    case "mocha":
      return {
        label: "mocha --reporter tap",
        parser: "tap",
        argv: exec(d.pm, ["mocha", "--reporter", "tap", ...pat]),
      };
    case "bun":
      return { label: "bun test", parser: "text", argv: ["bun", "test", ...pat] };
    default:
      if (hasScript(d, "test"))
        return { label: `${d.pm} run test`, parser: "text", argv: runScript(d.pm, "test", pat) };
      return { unavailable: true, reason: "No test runner or test script detected." };
  }
}

export function resolveLane(
  d: ProjectDetection,
  laneId: string,
  opts: { fix?: boolean; check?: boolean } = {},
): LaneResult {
  switch (laneId) {
    case "build":
      return resolveBuild(d);
    case "lint":
      return resolveLint(d, opts);
    case "format":
      return resolveFormat(d, opts);
    case "typecheck":
      return resolveTypecheck(d);
    default:
      return { unavailable: true, reason: `Unknown lane: ${laneId}` };
  }
}

// Which lanes can actually run for this project — used by the UI to hide
// buttons/tabs that don't apply.
export function laneAvailability(d: ProjectDetection | null): LaneAvailability {
  if (!d?.hasProject) {
    return {
      build: false,
      typecheck: false,
      lint: false,
      format: false,
      test: false,
      dev: false,
    };
  }
  return {
    build: !resolveBuild(d).unavailable,
    typecheck: !resolveTypecheck(d).unavailable,
    lint: !resolveLint(d).unavailable,
    format: !resolveFormat(d).unavailable,
    test: !resolveTest(d).unavailable,
    dev: !resolveDev(d).unavailable,
  };
}

// The built-in lane tasks, in toolbar order. `dev` is intentionally excluded —
// it lives in its own tab (persistent start/stop/URL/preview state).
export const LANE_TASK_ORDER = ["build", "typecheck", "lint", "format", "test"] as const;

// Default pinned tasks when a project has no saved config yet: every built-in
// lane that can actually run, in order. These behave like any other pinned task
// (unpinnable) once a project has its own config.
export function defaultPinnedTasks(d: Detection | null): PinnedTask[] {
  const pd: ProjectDetection | null = d?.hasProject ? d : null;
  const av = laneAvailability(pd);
  return LANE_TASK_ORDER.filter((id) => av[id]).map((id) => ({ type: "lane", id }));
}

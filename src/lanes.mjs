// Resolve each lane to a concrete command for the detected project. Prefer the
// project's own package.json scripts; otherwise fall back to running the locally
// installed tool with sensible defaults.
import { runScript, exec } from "./pm.mjs";

function hasScript(d, name) {
  return Boolean(d.scripts && d.scripts[name]);
}

// Pick the first matching script name from a list of candidates.
function pickScript(d, candidates) {
  for (const c of candidates) if (hasScript(d, c)) return c;
  return null;
}

export function resolveBuild(d) {
  const script = pickScript(d, ["build"]);
  if (script) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  const fw = d.framework.id;
  const defaults = {
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

export function resolveLint(d, { fix = false } = {}) {
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

export function resolveFormat(d, { check = false } = {}) {
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

export function resolveTypecheck(d) {
  const script = pickScript(d, ["typecheck", "type-check", "tsc", "check-types"]);
  if (script) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  if (d.typescript) return { label: "tsc --noEmit", argv: exec(d.pm, ["tsc", "--noEmit"]) };
  return {
    unavailable: true,
    reason: "TypeScript not detected (no tsconfig.json / typescript dep).",
  };
}

export function resolveDev(d) {
  const script = pickScript(d, ["dev", "start", "serve"]);
  if (script) return { label: `${d.pm} run ${script}`, argv: runScript(d.pm, script) };
  const fw = d.framework.id;
  const defaults = {
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

// Returns { label, argv, parser, outputFile? }. `parser` selects the report
// parser in test-report.mjs.
export function resolveTest(d, { pattern, outputFile } = {}) {
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

export function resolveLane(d, laneId, opts = {}) {
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

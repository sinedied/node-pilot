// Project detection: package manager, scripts, framework, test runner, linter,
// formatter, TypeScript, workspaces and Node engine — all inferred from the
// project files, with no questions asked.
import path from "node:path";
import { readJson, readText, firstExisting, existsSyncSafe } from "./util.mjs";

function detectPm(cwd, pkg) {
  if (existsSyncSafe(path.join(cwd, "bun.lockb")) || existsSyncSafe(path.join(cwd, "bun.lock")))
    return "bun";
  if (existsSyncSafe(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSyncSafe(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSyncSafe(path.join(cwd, "package-lock.json"))) return "npm";
  const field = pkg?.packageManager;
  if (typeof field === "string") {
    const name = field.split("@")[0].trim();
    if (["npm", "pnpm", "yarn", "bun"].includes(name)) return name;
  }
  return "npm";
}

function detectFramework(cwd, deps) {
  const has = (n) => Boolean(deps[n]);
  if (has("next")) return { id: "next", label: "Next.js" };
  if (has("nuxt") || has("nuxt3")) return { id: "nuxt", label: "Nuxt" };
  if (has("astro")) return { id: "astro", label: "Astro" };
  if (has("@sveltejs/kit")) return { id: "sveltekit", label: "SvelteKit" };
  if (has("@remix-run/dev") || has("@react-router/dev"))
    return { id: "remix", label: "Remix / React Router" };
  if (has("@angular/core")) return { id: "angular", label: "Angular" };
  if (has("@builder.io/qwik") || has("@qwik.dev/core")) return { id: "qwik", label: "Qwik" };
  if (has("gatsby")) return { id: "gatsby", label: "Gatsby" };
  if (has("vite") || firstExisting(cwd, ["vite.config.js", "vite.config.ts", "vite.config.mjs"]))
    return { id: "vite", label: "Vite" };
  return { id: "node", label: "Node.js" };
}

function detectTestRunner(cwd, deps, scripts) {
  if (
    deps.vitest ||
    firstExisting(cwd, ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"])
  )
    return "vitest";
  if (
    deps.jest ||
    firstExisting(cwd, [
      "jest.config.js",
      "jest.config.ts",
      "jest.config.cjs",
      "jest.config.mjs",
      "jest.config.json",
    ])
  )
    return "jest";
  const testScript = scripts.test || "";
  if (/node\s+--test|node:test/.test(testScript)) return "node";
  if (deps.mocha) return "mocha";
  if (deps.ava) return "ava";
  return null;
}

function detectLinter(cwd, deps) {
  if (deps["@biomejs/biome"] || firstExisting(cwd, ["biome.json", "biome.jsonc"])) return "biome";
  if (deps.oxlint) return "oxlint";
  if (
    deps.eslint ||
    firstExisting(cwd, [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      ".eslintrc.yml",
      ".eslintrc.yaml",
    ])
  )
    return "eslint";
  return null;
}

function detectFormatter(cwd, deps) {
  if (
    deps.prettier ||
    firstExisting(cwd, [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      ".prettierrc.cjs",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
    ])
  )
    return "prettier";
  if (deps["@biomejs/biome"] || firstExisting(cwd, ["biome.json", "biome.jsonc"])) return "biome";
  return null;
}

async function detectWorkspaces(cwd, pkg) {
  const reasons = [];
  if (pkg?.workspaces) reasons.push("workspaces field");
  if (existsSyncSafe(path.join(cwd, "pnpm-workspace.yaml"))) reasons.push("pnpm-workspace.yaml");
  if (existsSyncSafe(path.join(cwd, "turbo.json"))) reasons.push("Turborepo");
  if (existsSyncSafe(path.join(cwd, "nx.json"))) reasons.push("Nx");
  if (existsSyncSafe(path.join(cwd, "lerna.json"))) reasons.push("Lerna");
  return reasons.length ? reasons : null;
}

export async function detect(cwd) {
  const pkg = await readJson(path.join(cwd, "package.json"));
  if (!pkg) {
    return {
      hasProject: false,
      cwd,
      reason: "No package.json found in the workspace.",
    };
  }

  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const pm = detectPm(cwd, pkg);
  const typescript =
    Boolean(deps.typescript) ||
    Boolean(firstExisting(cwd, ["tsconfig.json", "tsconfig.base.json"]));
  const framework = detectFramework(cwd, deps);
  const testRunner = detectTestRunner(cwd, deps, scripts);
  const linter = detectLinter(cwd, deps);
  const formatter = detectFormatter(cwd, deps);
  const workspaces = await detectWorkspaces(cwd, pkg);
  const playwright = Boolean(deps["@playwright/test"]);
  const nvmrc = (await readText(path.join(cwd, ".nvmrc")))?.trim() || null;

  return {
    hasProject: true,
    cwd,
    name: pkg.name || path.basename(cwd),
    version: pkg.version || null,
    pm,
    packageManagerField: pkg.packageManager || null,
    scripts,
    scriptNames: Object.keys(scripts),
    typescript,
    framework,
    testRunner,
    playwright,
    linter,
    formatter,
    workspaces,
    engines: pkg.engines || null,
    nvmrc,
    runtimeNode: process.version,
    dependencyCount: Object.keys(pkg.dependencies || {}).length,
    devDependencyCount: Object.keys(pkg.devDependencies || {}).length,
  };
}

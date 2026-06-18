// Package-manager abstraction. Maps high-level operations to the argv for the
// detected package manager (npm / pnpm / yarn / bun) so the rest of the code
// stays PM-agnostic.

export const PMS = ["npm", "pnpm", "yarn", "bun"];

// Build argv to run a named package.json script.
export function runScript(pm, name, extraArgs = []) {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "run", name, ...extraArgs];
    case "yarn":
      return ["yarn", "run", name, ...extraArgs];
    case "bun":
      return ["bun", "run", name, ...extraArgs];
    case "npm":
    default:
      return ["npm", "run", name, ...(extraArgs.length ? ["--", ...extraArgs] : [])];
  }
}

// Build argv to execute a locally installed binary (e.g. vite, tsc, eslint).
export function exec(pm, binArgs) {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "exec", ...binArgs];
    case "yarn":
      return ["yarn", "exec", "--", ...binArgs];
    case "bun":
      return ["bun", "x", ...binArgs];
    case "npm":
    default:
      return ["npm", "exec", "--", ...binArgs];
  }
}

// Build argv to install all dependencies from the manifest + lockfile.
export function install(pm) {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "install"];
    case "yarn":
      return ["yarn", "install"];
    case "bun":
      return ["bun", "install"];
    case "npm":
    default:
      return ["npm", "install"];
  }
}

// Build argv to add/upgrade one or more packages at explicit versions.
// `specs` is an array like ["react@18.3.1", "vite@5.4.0"].
export function add(pm, specs, { dev = false } = {}) {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "add", ...(dev ? ["-D"] : []), ...specs];
    case "yarn":
      return ["yarn", "add", ...(dev ? ["-D"] : []), ...specs];
    case "bun":
      return ["bun", "add", ...(dev ? ["-d"] : []), ...specs];
    case "npm":
    default:
      return ["npm", "install", ...(dev ? ["--save-dev"] : []), ...specs];
  }
}

// Build argv to list outdated dependencies as JSON (where supported).
export function outdated(pm) {
  switch (pm) {
    case "pnpm":
      return { argv: ["pnpm", "outdated", "--format", "json"], format: "pnpm-json" };
    case "npm":
      return { argv: ["npm", "outdated", "--json"], format: "npm-json" };
    case "bun":
      return { argv: ["bun", "outdated"], format: "text" };
    case "yarn":
      // Yarn Berry has no built-in `outdated`; surfaced as unsupported upstream.
      return { argv: ["yarn", "outdated", "--json"], format: "text" };
    default:
      return { argv: ["npm", "outdated", "--json"], format: "npm-json" };
  }
}

// Build argv to run a security audit as JSON (where supported).
export function audit(pm) {
  switch (pm) {
    case "pnpm":
      return { argv: ["pnpm", "audit", "--json"], format: "npm-json" };
    case "yarn":
      return { argv: ["yarn", "npm", "audit", "--json"], format: "yarn-json" };
    case "bun":
      return { argv: ["bun", "audit", "--json"], format: "npm-json" };
    case "npm":
    default:
      return { argv: ["npm", "audit", "--json"], format: "npm-json" };
  }
}

export function auditFix(pm) {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "audit", "--fix"];
    case "yarn":
      return ["yarn", "npm", "audit", "--fix"];
    case "npm":
    default:
      return ["npm", "audit", "fix"];
  }
}

export function lockfileFor(pm) {
  switch (pm) {
    case "pnpm":
      return "pnpm-lock.yaml";
    case "yarn":
      return "yarn.lock";
    case "bun":
      return "bun.lockb";
    case "npm":
    default:
      return "package-lock.json";
  }
}

export function supportsOutdatedJson(pm) {
  return pm === "npm" || pm === "pnpm";
}

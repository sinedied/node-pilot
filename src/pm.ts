// Package-manager abstraction. Maps high-level operations to the argv for the
// detected package manager (npm / pnpm / yarn / bun) so the rest of the code
// stays PM-agnostic.
import type { PackageManager } from "./types.ts";

export const PMS: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

export interface OutdatedCommand {
  argv: string[];
  format: "npm-json" | "pnpm-json" | "yarn-json" | "text";
}

export interface AuditCommand {
  argv: string[];
  format: "npm-json" | "yarn-json";
}

// Build argv to run a named package.json script.
export function runScript(pm: PackageManager, name: string, extraArgs: string[] = []): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "run", name, ...extraArgs];
    case "yarn":
      return ["yarn", "run", name, ...extraArgs];
    case "bun":
      return ["bun", "run", name, ...extraArgs];
    default:
      return ["npm", "run", name, ...(extraArgs.length ? ["--", ...extraArgs] : [])];
  }
}

// Build argv to execute a locally installed binary (e.g. vite, tsc, eslint).
export function exec(pm: PackageManager, binArgs: string[]): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "exec", ...binArgs];
    case "yarn":
      return ["yarn", "exec", "--", ...binArgs];
    case "bun":
      return ["bun", "x", ...binArgs];
    default:
      return ["npm", "exec", "--", ...binArgs];
  }
}

// Build argv to install all dependencies from the manifest + lockfile.
export function install(pm: PackageManager): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "install"];
    case "yarn":
      return ["yarn", "install"];
    case "bun":
      return ["bun", "install"];
    default:
      return ["npm", "install"];
  }
}

// Build argv to add/upgrade one or more packages at explicit versions.
// `specs` is an array like ["react@18.3.1", "vite@5.4.0"].
export function add(pm: PackageManager, specs: string[], { dev = false } = {}): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "add", ...(dev ? ["-D"] : []), ...specs];
    case "yarn":
      return ["yarn", "add", ...(dev ? ["-D"] : []), ...specs];
    case "bun":
      return ["bun", "add", ...(dev ? ["-d"] : []), ...specs];
    default:
      return ["npm", "install", ...(dev ? ["--save-dev"] : []), ...specs];
  }
}

// Build argv to list outdated dependencies as JSON (where supported).
export function outdated(pm: PackageManager): OutdatedCommand {
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
export function audit(pm: PackageManager): AuditCommand {
  switch (pm) {
    case "pnpm":
      return { argv: ["pnpm", "audit", "--json"], format: "npm-json" };
    case "yarn":
      return { argv: ["yarn", "npm", "audit", "--json"], format: "yarn-json" };
    case "bun":
      return { argv: ["bun", "audit", "--json"], format: "npm-json" };
    default:
      return { argv: ["npm", "audit", "--json"], format: "npm-json" };
  }
}

export function auditFix(pm: PackageManager): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "audit", "--fix"];
    case "yarn":
      return ["yarn", "npm", "audit", "--fix"];
    default:
      return ["npm", "audit", "fix"];
  }
}

export function lockfileFor(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm-lock.yaml";
    case "yarn":
      return "yarn.lock";
    case "bun":
      return "bun.lockb";
    default:
      return "package-lock.json";
  }
}

export function supportsOutdatedJson(pm: PackageManager): boolean {
  return pm === "npm" || pm === "pnpm";
}

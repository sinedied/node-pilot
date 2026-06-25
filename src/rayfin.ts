// Microsoft Rayfin (Backend-as-a-Service for the agentic era) support. Cockpit's
// Rayfin tab is a *human-facing* dashboard: it reads the project's rayfin/ files
// directly (no agent actions duplicated from the rayfin CLI) and shells out to
// the `rayfin` CLI for state-changing operations, streaming output to the
// Console like every other lane. This module owns the read-only model building,
// a tolerant schema parser, and the CLI argv allow-list.
import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJson, readText, existsSyncSafe } from "./util.ts";
import { exec } from "./pm.ts";
import type {
  PackageManager,
  RayfinConfig,
  RayfinDeployment,
  RayfinDetection,
  RayfinEntity,
  RayfinField,
  RayfinPermission,
  RayfinState,
} from "./types.ts";

const DOCS_URL = "https://github.com/microsoft/rayfin";

// ---- Detection ------------------------------------------------------------

// Cheap detection from the rayfin/ dir + dependency set. Returns null when the
// project is not a Rayfin app.
export async function detectRayfin(
  cwd: string,
  deps: Record<string, string>,
): Promise<RayfinDetection | null> {
  const dir = path.join(cwd, "rayfin");
  const configPath = existsSyncSafe(path.join(dir, "rayfin.yml"))
    ? path.join(dir, "rayfin.yml")
    : existsSyncSafe(path.join(dir, "rayfin.yaml"))
      ? path.join(dir, "rayfin.yaml")
      : null;
  const hasDep = Object.keys(deps).some((d) => d.startsWith("@microsoft/rayfin"));
  if (!configPath && !hasDep) return null;
  const ymlText = configPath ? await readText(configPath) : null;
  const yml = ymlText ? parseYml(ymlText) : null;
  return {
    dir,
    dialect: yml?.dialect ?? null,
    authMethods: yml?.authMethods ?? [],
    hasFunctions: existsSyncSafe(path.join(dir, "functions")),
    hasConnectors: existsSyncSafe(path.join(dir, "connectors")),
  };
}

// ---- rayfin.yml (minimal, targeted parser; no YAML dependency) ------------

interface ParsedYml {
  name: string | null;
  dialect: string | null;
  authMethods: string[];
  staticHosting: RayfinConfig["staticHosting"];
}

// Parse only the handful of fields the dashboard needs. Tolerant of formatting;
// not a general YAML parser.
export function parseYml(text: string): ParsedYml {
  const name = text.match(/^name:\s*(.+?)\s*$/m)?.[1] || null;
  const dialect = text.match(/\bdialect:\s*([\w-]+)/)?.[1] || null;
  const authMethods: string[] = [];
  const methodsBlock = text.match(/methods:\s*\n((?:[ \t]*-[ \t]*[\w-]+[ \t]*\n?)+)/);
  if (methodsBlock) {
    for (const m of methodsBlock[1].matchAll(/-[ \t]*([\w-]+)/g)) authMethods.push(m[1]);
  }
  let staticHosting: RayfinConfig["staticHosting"] = null;
  const shStart = text.indexOf("staticHosting:");
  if (shStart >= 0) {
    const block = text.slice(shStart);
    staticHosting = {
      folder: block.match(/folder:\s*(.+?)\s*$/m)?.[1] || null,
      indexDocument: block.match(/indexDocument:\s*(.+?)\s*$/m)?.[1] || null,
      buildCommand: block.match(/buildCommand:\s*(.+?)\s*$/m)?.[1] || null,
    };
  }
  return { name, dialect, authMethods, staticHosting };
}

// ---- Schema parser (decorators → entities) --------------------------------

// Line-based, tolerant parser for rayfin/data/schema.ts. Captures @entity /
// @role classes and their field decorators. Falls back gracefully (empty list)
// when the file shape is unexpected; dab-config.json supplements permissions.
export function parseSchema(text: string): RayfinEntity[] {
  const entities: RayfinEntity[] = [];
  let pendingRoles: string[] = [];
  let pendingEntity = false;
  let pendingDecorator: { name: string; args: string } | null = null;
  let current: RayfinEntity | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith("//")) continue;

    const role = t.match(/^@role\(\s*["']([^"']+)["']\s*\)/);
    if (role) {
      pendingRoles.push(role[1]);
      continue;
    }
    if (/^@entity\b/.test(t)) {
      pendingEntity = true;
      continue;
    }
    const cls = t.match(/^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (cls) {
      current = {
        name: cls[1],
        isEntity: pendingEntity,
        roles: pendingRoles,
        fields: [],
        permissions: [],
      };
      entities.push(current);
      pendingRoles = [];
      pendingEntity = false;
      pendingDecorator = null;
      continue;
    }
    // A field decorator on its own line (e.g. `@text({ maxLength: 200 })`).
    const dec = t.match(/^@(\w+)\((.*)\)\s*$/);
    if (dec && current) {
      pendingDecorator = { name: dec[1], args: dec[2] };
      continue;
    }
    // The property declaration that the pending decorator applies to.
    const prop = t.match(/^(\w+)([!?]?)\s*:\s*(.+?);?\s*$/);
    if (prop && current && pendingDecorator) {
      current.fields.push(buildField(prop[1], prop[2], pendingDecorator));
      pendingDecorator = null;
    }
  }
  return entities;
}

function buildField(
  name: string,
  marker: string,
  dec: { name: string; args: string },
): RayfinField {
  const isRelation = dec.name === "one" || dec.name === "many";
  if (isRelation) {
    const target = dec.args.match(/=>\s*(\w+)/)?.[1] || "?";
    return {
      name,
      type: target,
      optional: marker === "?",
      relation: { kind: dec.name as "one" | "many", target },
    };
  }
  const optional = marker === "?" || /\bnullable\s*:\s*true\b/.test(dec.args);
  return { name, type: dec.name, optional, relation: null };
}

// ---- dab-config.json (generated Data API Builder config) ------------------

interface DabEntity {
  permissions?: Array<{ role?: string; actions?: unknown }>;
}

function permissionsFromDab(dab: unknown): Map<string, RayfinPermission[]> {
  const out = new Map<string, RayfinPermission[]>();
  const entities = (dab as { entities?: Record<string, DabEntity> })?.entities;
  if (!entities || typeof entities !== "object") return out;
  for (const [name, ent] of Object.entries(entities)) {
    const perms: RayfinPermission[] = [];
    for (const p of ent?.permissions || []) {
      const actions = Array.isArray(p.actions)
        ? p.actions.map(String)
        : typeof p.actions === "string"
          ? [p.actions]
          : [];
      if (p.role) perms.push({ role: String(p.role), actions });
    }
    out.set(name, perms);
  }
  return out;
}

// ---- .deployments.json ----------------------------------------------------

interface DeploymentRecord {
  itemId?: string;
  apiUrl?: string;
  workspaceId?: string;
  tenantId?: string;
  portalUrl?: string;
  hostingUrl?: string;
  deployedAt?: string;
}

function fabricPortalUrl(rec: DeploymentRecord): string | null {
  if (rec.portalUrl) return rec.portalUrl;
  if (rec.workspaceId) return `https://app.fabric.microsoft.com/groups/${rec.workspaceId}`;
  return null;
}

// ---- Full dashboard model -------------------------------------------------

export async function readRayfinState(cwd: string): Promise<RayfinState> {
  const dir = path.join(cwd, "rayfin");
  const configPath = existsSyncSafe(path.join(dir, "rayfin.yml"))
    ? path.join(dir, "rayfin.yml")
    : existsSyncSafe(path.join(dir, "rayfin.yaml"))
      ? path.join(dir, "rayfin.yaml")
      : null;

  const ymlText = configPath ? await readText(configPath) : null;
  const yml = ymlText ? parseYml(ymlText) : null;
  const config: RayfinConfig | null = yml
    ? {
        name: yml.name,
        dialect: yml.dialect,
        authMethods: yml.authMethods,
        staticHosting: yml.staticHosting,
      }
    : null;

  // Deployments (workspace dashboard + switcher).
  const deploymentsPath = path.join(dir, ".deployments.json");
  const depsRaw = await readJson<{
    active?: string;
    deployments?: Record<string, DeploymentRecord>;
  }>(deploymentsPath);
  const active = depsRaw?.active ?? null;
  const list: RayfinDeployment[] = Object.entries(depsRaw?.deployments || {}).map(
    ([name, rec]) => ({
      name,
      active: name === active,
      itemId: rec.itemId ?? null,
      apiUrl: rec.apiUrl ?? null,
      workspaceId: rec.workspaceId ?? null,
      tenantId: rec.tenantId ?? null,
      portalUrl: fabricPortalUrl(rec),
      hostingUrl: rec.hostingUrl ?? null,
      deployedAt: rec.deployedAt ?? null,
    }),
  );

  // Data model: parse the schema, then enrich with DAB permissions when present.
  const schemaPath = existsSyncSafe(path.join(dir, "data", "schema.ts"))
    ? path.join(dir, "data", "schema.ts")
    : null;
  const schemaText = schemaPath ? await readText(schemaPath) : null;
  let entities = schemaText ? parseSchema(schemaText) : [];
  const dabPath = path.join(dir, "dab-config.json");
  const hasDabConfig = existsSyncSafe(dabPath);
  if (hasDabConfig) {
    const dab = await readJson<unknown>(dabPath);
    const perms = permissionsFromDab(dab);
    for (const ent of entities) ent.permissions = perms.get(ent.name) || [];
    // Fallback: if the schema parse found nothing, surface DAB entity names.
    if (!entities.length && perms.size) {
      entities = [...perms.keys()].map((name) => ({
        name,
        isEntity: true,
        roles: [],
        fields: [],
        permissions: perms.get(name) || [],
      }));
    }
  }

  const functions = await listDirs(path.join(dir, "functions"));
  const connectors = await listDirs(path.join(dir, "connectors"));
  const signedIn = existsSyncSafe(path.join(dir, ".rayfin", "auth.json"));
  const hasAgentFiles =
    existsSyncSafe(path.join(cwd, "AGENTS.md")) ||
    existsSyncSafe(path.join(cwd, "mcp-server.json"));

  return {
    detected: true,
    config,
    auth: { signedIn },
    deployments: { active, list },
    entities,
    functions,
    connectors,
    hasDabConfig,
    hasAgentFiles,
    paths: {
      config: configPath,
      schema: schemaPath,
      deployments: existsSyncSafe(deploymentsPath) ? deploymentsPath : null,
    },
    docsUrl: DOCS_URL,
    at: Date.now(),
  };
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ---- CLI argv (allow-list) ------------------------------------------------

// Permitted `rayfin <cmd> [subcommand…]` shapes. Restricting the command surface
// keeps the human-facing buttons from being repurposed into arbitrary execution.
const ALLOWED: Record<string, true> = {
  login: true,
  logout: true,
  status: true,
  dev: true,
  up: true,
  functions: true,
  connector: true,
  docs: true,
  "ai-files": true,
};

const SAFE_ARG = /^[A-Za-z0-9@._/:+-]+$/;

// Validate + normalize a rayfin argv. Returns the cleaned args, or null when the
// command is not allow-listed or an argument contains unexpected characters.
export function validateRayfinArgs(args: unknown): string[] | null {
  if (!Array.isArray(args) || !args.length) return null;
  const clean = args.map((a) => String(a).trim());
  if (!ALLOWED[clean[0]]) return null;
  if (!clean.every((a) => a.length > 0 && SAFE_ARG.test(a))) return null;
  return clean;
}

// Build argv to run the project-local `rayfin` binary via the detected PM.
export function rayfinArgv(pm: PackageManager, args: string[]): string[] {
  return exec(pm, ["rayfin", ...args]);
}

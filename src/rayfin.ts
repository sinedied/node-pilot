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

// Canonical Rayfin / Microsoft Fabric Apps reference links surfaced in the
// dashboard (and the no-project intro state on the client).
const RAYFIN_LINKS: Array<{ label: string; url: string; icon: string }> = [
  {
    label: "Fabric Apps docs",
    url: "https://learn.microsoft.com/en-us/fabric/apps/overview",
    icon: "oct-book",
  },
  { label: "Rayfin on GitHub", url: DOCS_URL, icon: "oct-mark-github" },
  {
    label: "Awesome Rayfin",
    url: "https://github.com/microsoft/awesome-rayfin",
    icon: "oct-star",
  },
];

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

interface Decorator {
  name: string;
  args: string;
}

// Field decorators that only annotate constraints — never the field's type — so
// when several are stacked on one property we don't mistake one for the type.
const METADATA_DECORATORS: ReadonlySet<string> = new Set([
  "unique",
  "index",
  "default",
  "nullable",
  "primary",
  "min",
  "max",
]);

// Collapse newlines that fall *inside decorator argument parentheses*, so a
// decorator whose args span several lines (e.g. `@text({\n  maxLength: 200\n})`)
// becomes one logical line. Only paren depth is tracked, so class/object `{ }`
// bodies — and the newlines that structure them — are left untouched.
function collapseDecoratorArgs(text: string): string {
  let depth = 0;
  let out = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "\n" || ch === "\r") && depth > 0) {
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

// Consume one `@name(...args...)` decorator from the start of a line, matching
// parentheses so nested calls like `@one(() => User)` are captured whole.
// Returns the decorator plus the remaining text, or null when the line does not
// start with a balanced decorator.
function consumeDecorator(line: string): { name: string; args: string; rest: string } | null {
  const head = line.match(/^@(\w+)\s*\(/);
  if (!head) return null;
  let depth = 1;
  let i = head[0].length;
  const start = i;
  for (; i < line.length && depth > 0; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  if (depth !== 0) return null;
  return { name: head[1], args: line.slice(start, i - 1), rest: line.slice(i).trim() };
}

// Tolerant parser for rayfin/data/schema.ts. Captures @entity / @role classes and
// their field decorators. Handles decorators stacked on a field, a decorator and
// its property on the same line, and decorator args spanning several lines. Falls
// back gracefully (empty list) when the file shape is unexpected; dab-config.json
// supplements permissions.
export function parseSchema(text: string): RayfinEntity[] {
  const entities: RayfinEntity[] = [];
  let pendingRoles: string[] = [];
  let pendingEntity = false;
  let pendingDecorators: Decorator[] = [];
  let current: RayfinEntity | null = null;

  // Blank full-line comments before collapsing, so an unbalanced paren in a
  // comment can't skew the paren-depth tracking below.
  const cleaned = collapseDecoratorArgs(text.replace(/^[ \t]*\/\/.*$/gm, ""));
  for (const raw of cleaned.split(/\r?\n/)) {
    let t = raw.trim();
    if (!t || t.startsWith("//")) continue;

    // Pull every leading decorator off the line (there may be several).
    const decs: Decorator[] = [];
    for (let d = consumeDecorator(t); d; d = consumeDecorator(t)) {
      decs.push({ name: d.name, args: d.args });
      t = d.rest;
    }
    // Bare `@entity` (no parentheses) isn't consumed above; honor it too.
    if (!decs.length && /^@entity\b/.test(t)) {
      pendingEntity = true;
      continue;
    }
    // Sort decorators into class-level (@role/@entity) and field-level.
    for (const d of decs) {
      if (d.name === "role") {
        const m = d.args.match(/["']([^"']+)["']/);
        if (m) pendingRoles.push(m[1]);
      } else if (d.name === "entity") {
        pendingEntity = true;
      } else {
        pendingDecorators.push(d);
      }
    }
    if (!t) continue; // line held only decorators

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
      pendingDecorators = [];
      continue;
    }

    const prop = t.match(/^(\w+)([!?]?)\s*:\s*(.+?);?\s*$/);
    if (prop && current && pendingDecorators.length) {
      current.fields.push(buildField(prop[1], prop[2], pendingDecorators));
      pendingDecorators = [];
      continue;
    }
    // Leading decorators that didn't resolve to a property we understand are
    // dropped so they can't leak onto an unrelated later field.
    if (decs.length) pendingDecorators = [];
  }
  return entities;
}

function buildField(name: string, marker: string, decs: Decorator[]): RayfinField {
  const relation = decs.find((d) => d.name === "one" || d.name === "many");
  const optional =
    marker === "?" ||
    decs.some((d) => d.name === "nullable" || /\bnullable\s*:\s*true\b/.test(d.args));
  if (relation) {
    const target = relation.args.match(/=>\s*(\w+)/)?.[1] || "?";
    return {
      name,
      type: target,
      optional,
      relation: { kind: relation.name as "one" | "many", target },
    };
  }
  const primary = decs.find((d) => !METADATA_DECORATORS.has(d.name)) ?? decs[0];
  return { name, type: primary.name, optional, relation: null };
}

// ---- dab-config.json (generated Data API Builder config) ------------------

interface DabEntity {
  permissions?: Array<{ role?: string; actions?: unknown }>;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

// Normalize an entity name to a singular, lower-case key so schema class names
// (e.g. `User`, `Category`) match DAB entity keys, which are frequently the
// pluralized REST route names (`Users`, `Categories`).
function singularKey(name: string): string {
  const s = name.toLowerCase();
  if (s.endsWith("ies")) return `${s.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}

function permissionsFromDab(dab: unknown): Map<string, RayfinPermission[]> {
  const out = new Map<string, RayfinPermission[]>();
  const entities = isRecord(dab) ? dab.entities : undefined;
  if (!isRecord(entities)) return out;
  for (const [name, raw] of Object.entries(entities)) {
    const ent = raw as DabEntity;
    const perms: RayfinPermission[] = [];
    if (Array.isArray(ent?.permissions)) {
      for (const p of ent.permissions) {
        if (!isRecord(p)) continue;
        const actions = Array.isArray(p.actions)
          ? p.actions
              .map((a) =>
                typeof a === "string"
                  ? a
                  : isRecord(a) && typeof a.action === "string"
                    ? a.action
                    : null,
              )
              .filter((a): a is string => !!a)
          : typeof p.actions === "string"
            ? [p.actions]
            : [];
        if (p.role) perms.push({ role: String(p.role), actions });
      }
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
  const list: RayfinDeployment[] = Object.entries(depsRaw?.deployments || {})
    .filter(([, rec]) => isRecord(rec))
    .map(([name, rec]) => ({
      name,
      active: name === active,
      itemId: rec.itemId ?? null,
      apiUrl: rec.apiUrl ?? null,
      workspaceId: rec.workspaceId ?? null,
      tenantId: rec.tenantId ?? null,
      portalUrl: fabricPortalUrl(rec),
      hostingUrl: rec.hostingUrl ?? null,
      deployedAt: rec.deployedAt ?? null,
    }));

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
    // DAB keys are often pluralized route names; match on a normalized key so a
    // `User` class still picks up the `Users` entity's permissions.
    const permsByKey = new Map<string, RayfinPermission[]>();
    for (const [dabName, p] of perms) {
      const key = singularKey(dabName);
      if (!permsByKey.has(key)) permsByKey.set(key, p);
    }
    for (const ent of entities) {
      ent.permissions = perms.get(ent.name) ?? permsByKey.get(singularKey(ent.name)) ?? [];
    }
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
  // Sign-in is resolved by the controller via `rayfin login status` (the CLI is
  // the source of truth — credentials may live globally, not project-local).
  // `null` here is the "unknown" placeholder until that probe runs.
  const signedIn: boolean | null = null;
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
    links: RAYFIN_LINKS,
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

// Exact `rayfin` command shapes the dashboard buttons are allowed to run. An
// exact-argv allow-list (not just a first-verb check) keeps the loopback
// /api/rayfin/cli endpoint — which is same-origin-reachable from proxied dev
// preview content — from being repurposed into arbitrary rayfin operations.
// The `up switch <deployment>` shape is handled separately (the target is
// validated against the known deployment list, so it isn't listed here).
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "login",
  "logout",
  "dev start",
  "dev stop",
  "dev status",
  "dev db apply",
  "up",
  "up status",
  "up db apply",
  "functions typegen",
  "connector list",
  "ai-files",
]);

const SAFE_ARG = /^[A-Za-z0-9@._/:+-]+$/;

// Validate + normalize a rayfin argv. Returns the cleaned args, or null when the
// command is not an allow-listed shape or an argument contains unexpected
// characters. Use `switchRayfinWorkspace` (controller) for `up switch <name>`.
export function validateRayfinArgs(args: unknown): string[] | null {
  if (!Array.isArray(args) || !args.length) return null;
  const clean = args.map((a) => String(a).trim());
  if (!clean.every((a) => a.length > 0 && SAFE_ARG.test(a))) return null;
  if (!ALLOWED_COMMANDS.has(clean.join(" "))) return null;
  return clean;
}

// Build argv to run the project-local `rayfin` binary via the detected PM.
export function rayfinArgv(pm: PackageManager, args: string[]): string[] {
  return exec(pm, ["rayfin", ...args]);
}

// Build argv to ask the CLI whether the user is signed in (`rayfin login status`).
// Safety (no install / no network / no prompt) is enforced by the controller's
// `hasLocalRayfinBin` preflight — this only runs when the binary is already on
// disk — but npm still gets `--no` as belt-and-suspenders so it can never prompt
// or fetch. The exit code is the source of truth (the CLI reads its own creds,
// which may live in a global store, not project-local).
export function rayfinLoginStatusArgv(pm: PackageManager): string[] {
  const cmd = ["rayfin", "login", "status"];
  switch (pm) {
    case "pnpm":
      // `pnpm exec` only runs binaries already in the project — never installs.
      return ["pnpm", "exec", ...cmd];
    case "yarn":
      // `yarn exec` likewise resolves from the local node_modules/.bin.
      return ["yarn", "exec", "--", ...cmd];
    case "bun":
      // `bun x` uses the local bin when present (guaranteed by the preflight).
      return ["bun", "x", ...cmd];
    default:
      // npm: `--no` => never install/prompt; run the local bin or fail fast.
      return ["npm", "exec", "--no", "--", ...cmd];
  }
}

// Whether the `rayfin` CLI is installed locally and runnable. We walk up from the
// project dir checking each `node_modules/.bin/rayfin` (mirroring how the package
// managers resolve a bin) so hoisted monorepo installs are found too. This gates
// the sign-in probe: when the CLI isn't present we report "unknown" instead of
// spawning a PM wrapper that would hit the registry and/or exit non-zero (which
// would wrongly read as "signed out"). Cross-platform: also checks `rayfin.cmd`.
export function hasLocalRayfinBin(cwd: string): boolean {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (existsSyncSafe(path.join(bin, "rayfin")) || existsSyncSafe(path.join(bin, "rayfin.cmd"))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// Map a `rayfin login status` run to a tri-state sign-in flag:
//   exit 0      => signed in (true)
//   exit > 0    => signed out (false)
//   spawn error / negative or killed exit => unknown (null)
// Unknown is deliberately never collapsed to "signed out" so a missing CLI,
// timeout, or crash can't show a false negative.
export function interpretLoginStatus(result: { code: number; error?: string }): boolean | null {
  if (result.error) return null;
  if (result.code === 0) return true;
  if (result.code > 0) return false;
  return null;
}

const WORKSPACE_GUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Pick the right `rayfin up` workspace flag for a user-entered target. The value
// is passed to the CLI as a single argv element (no shell), so it can't inject;
// this only decides which flag describes it:
//   - a portal URL  → --workspace-uri
//   - a bare GUID   → --workspace-id
//   - anything else → --workspace (display name)
export function rayfinWorkspaceFlag(
  value: string,
): "--workspace-uri" | "--workspace-id" | "--workspace" {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return "--workspace-uri";
  if (WORKSPACE_GUID.test(v)) return "--workspace-id";
  return "--workspace";
}

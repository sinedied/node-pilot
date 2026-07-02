// Microsoft Rayfin (Backend-as-a-Service for the agentic era) support. Cockpit's
// Rayfin tab is a *human-facing* dashboard: it reads the project's rayfin/ files
// directly (no agent actions duplicated from the rayfin CLI) and shells out to
// the `rayfin` CLI for state-changing operations, streaming output to the
// Console like every other lane. This module owns the read-only model building,
// a tolerant schema parser, and the CLI argv allow-list.
import path from "node:path";
import { readFileSync } from "node:fs";
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
  RayfinFunction,
  RayfinFunctionHandler,
  RayfinFunctionParam,
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
  version: string | null;
  dialect: string | null;
  authMethods: string[];
  storageEnabled: boolean | null;
  functionsEnabled: boolean | null;
  staticHosting: RayfinConfig["staticHosting"];
}

// Parse only the handful of fields the dashboard needs. Tolerant of formatting;
// not a general YAML parser.
export function parseYml(text: string): ParsedYml {
  const name = text.match(/^name:\s*(.+?)\s*$/m)?.[1] || null;
  const version = text.match(/^version:\s*(.+?)\s*$/m)?.[1] || null;
  const dialect = text.match(/\bdialect:\s*([\w-]+)/)?.[1] || null;
  const authMethods = parseAuthMethods(text);
  const storageEnabled = serviceEnabled(text, "storage");
  const functionsEnabled = serviceEnabled(text, "functions");
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
  return { name, version, dialect, authMethods, storageEnabled, functionsEnabled, staticHosting };
}

// Locate a `services.<name>:` block and return its lines (those indented deeper
// than the service key) plus the service key's own indent, so per-service fields
// can be read without a full YAML parser. Scoped to the `services:` mapping so a
// same-named key elsewhere can't match; tolerates a trailing `# comment` on the
// service line. `service` is always a fixed internal identifier, but escape it
// anyway so it's never interpreted as a regex.
function serviceBlock(text: string, service: string): { indent: number; lines: string[] } | null {
  const all = text.split(/\r?\n/);
  // Only search within the `services:` mapping when present.
  const servicesIdx = all.findIndex((l) => /^\s*services:\s*(?:#.*)?$/.test(l));
  const start = servicesIdx >= 0 ? servicesIdx + 1 : 0;
  const name = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^(\\s*)${name}:\\s*(?:#.*)?$`);
  for (let i = start; i < all.length; i++) {
    const m = all[i].match(head);
    if (!m) continue;
    const indent = m[1].length;
    const lines: string[] = [];
    for (let j = i + 1; j < all.length; j++) {
      const line = all[j];
      if (line.trim() === "") continue;
      const li = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (li <= indent) break;
      lines.push(line);
    }
    return { indent, lines };
  }
  return null;
}

// The service's OWN immediate `enabled:` flag (a direct child of the service
// key), never a nested provider's (e.g. `auth.fabric.enabled`). Returns null
// when the service — or its own flag — is absent, so "not configured" stays
// distinct from an explicit `enabled: false`.
function serviceEnabled(text: string, service: string): boolean | null {
  const block = serviceBlock(text, service);
  if (!block || !block.lines.length) return null;
  // Direct children share the shallowest indentation within the block; deeper
  // lines belong to nested mappings and must be ignored.
  const childIndent = Math.min(...block.lines.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0));
  for (const line of block.lines) {
    const li = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (li !== childIndent) continue;
    const m = line.match(/^\s*enabled:\s*(true|false)\b/);
    if (m) return m[1] === "true";
  }
  return null;
}

// Sign-in methods from rayfin.yml. The real schema enables providers as nested
// blocks (`auth.fabric.enabled: true`, `auth.password.enabled: true`,
// `auth.email.enabled: true`); older/hand-written configs use a flat
// `auth.methods:` list. Support both — provider blocks first, list as fallback.
function parseAuthMethods(text: string): string[] {
  const methods: string[] = [];
  for (const provider of ["fabric", "password", "email"]) {
    const re = new RegExp(`\\b${provider}:\\s*\\n\\s*enabled:\\s*true\\b`);
    if (re.test(text)) methods.push(provider);
  }
  if (methods.length) return methods;
  const methodsBlock = text.match(/methods:\s*\n((?:[ \t]*-[ \t]*[\w-]+[ \t]*\n?)+)/);
  if (methodsBlock) {
    for (const m of methodsBlock[1].matchAll(/-[ \t]*([\w-]+)/g)) methods.push(m[1]);
  }
  return methods;
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

// Merge entities parsed from several data/*.ts files, deduping by name. When the
// same entity name appears twice (e.g. an empty re-export stub plus the real
// definition), the richer entry wins so fields/roles/relations are preserved.
export function mergeEntities(into: RayfinEntity[], add: RayfinEntity[]): RayfinEntity[] {
  const out = [...into];
  for (const e of add) {
    const i = out.findIndex((x) => x.name === e.name);
    if (i < 0) out.push(e);
    else if (entityScore(e) > entityScore(out[i])) out[i] = e;
  }
  return out;
}

function entityScore(e: RayfinEntity): number {
  return e.fields.length * 2 + (e.isEntity ? 1 : 0) + e.roles.length;
}

// Extract the registered entity names from schema.ts — either the runtime
// `export const schema = [User, Project, ...]` array or the `type *Schema = {
// User: User; ... }` registration. Tolerant: returns [] when neither is present,
// so the caller falls back to scanning every data/*.ts file.
export function parseSchemaRegistration(text: string): string[] {
  const names: string[] = [];
  const arr = text.match(/\bschema\s*=\s*\[([^\]]*)\]/);
  if (arr) {
    for (const m of arr[1].matchAll(/[A-Za-z_$][\w$]*/g)) names.push(m[0]);
  }
  if (!names.length) {
    const typ = text.match(/\btype\s+\w*Schema\s*=\s*\{([^}]*)\}/);
    if (typ) {
      for (const line of typ[1].split(/[;,\n]/)) {
        const k = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
        if (k) names.push(k[1]);
      }
    }
  }
  return [...new Set(names)];
}

// Parse the exported `FunctionsSchema` type (rayfin/functions/src/types.ts) into
// the full contract of each function — not just its name, but the raw `input`
// and `output` type text and the named input params. Each schema value is a
// `{ input; output }` object literal (whose `input` is itself an object of named
// params), so a brace-aware walk is required — a flat regex would stop at the
// first nested `}`.
export type ParsedFunction = Omit<RayfinFunction, "hasHandler">;

// Return the substring *inside* the balanced `{…}` (or `[...]`/`(...)`) whose
// opening bracket is at `open` in `src`, or "" when unbalanced.
function balanced(src: string, open: number): string {
  const close = src[open] === "{" ? "}" : src[open] === "[" ? "]" : ")";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === src[open]) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

interface Member {
  key: string;
  optional: boolean;
  value: string;
}

// Split the body of a TS object/type literal into its top-level `key: value`
// members. Separators are `;` or `,` at depth 0; nested braces/brackets/parens
// and generic `<…>` are tracked so a `,` inside `Record<string, unknown>` or a
// nested `{ … }` doesn't split a member.
function splitMembers(body: string): Member[] {
  const members: Member[] = [];
  let depth = 0;
  let angle = 0;
  let start = 0;
  const flush = (end: number) => {
    const seg = body.slice(start, end).trim();
    start = end + 1;
    if (!seg) return;
    const m = seg.match(/^([A-Za-z_$][\w$]*)\s*(\??)\s*:\s*([\s\S]*)$/);
    if (m) members.push({ key: m[1], optional: m[2] === "?", value: m[3].trim() });
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "<") angle++;
    else if (ch === ">") {
      // Only treat `>` as a generic close when an unmatched `<` is open, so the
      // `>` in a `=>` arrow type can't drive the depth negative.
      if (angle > 0) angle--;
    } else if ((ch === ";" || ch === ",") && depth === 0 && angle === 0) {
      flush(i);
    }
  }
  flush(body.length);
  return members;
}

export function parseFunctionsSchema(text: string): ParsedFunction[] {
  // Drop comments so braces/colons inside them can't confuse the walk.
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Prefer the canonical `…FunctionsSchema` alias (the SDK's convention); fall
  // back to any `…Schema` object alias so a helper type named earlier in the
  // file (e.g. `type FooSchema = {…}`) can't shadow the real functions schema.
  const start =
    src.match(/type\s+\w*FunctionsSchema\s*=\s*\{/) ?? src.match(/type\s+\w*Schema\s*=\s*\{/);
  if (!start || start.index == null) return [];
  const open = start.index + start[0].length - 1; // index of the schema's `{`
  const body = balanced(src, open);
  const out: ParsedFunction[] = [];
  const seen = new Set<string>();
  for (const fn of splitMembers(body)) {
    if (seen.has(fn.key)) continue;
    seen.add(fn.key);
    let input = "";
    let output = "";
    const val = fn.value.trim();
    if (val.startsWith("{")) {
      for (const m of splitMembers(balanced(val, 0))) {
        if (m.key === "input") input = m.value.trim();
        else if (m.key === "output") output = m.value.trim();
      }
    }
    let params: RayfinFunctionParam[] = [];
    if (input.startsWith("{")) {
      params = splitMembers(balanced(input, 0)).map((p) => ({
        name: p.key,
        type: p.value,
        optional: p.optional,
      }));
    }
    out.push({ name: fn.key, input, output, params });
  }
  return out;
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

// On-disk record shape written by the real rayfin CLI (`upsertDeployment` in
// rayfin-tools): the fields are `fabric`-prefixed, with `fabricDeepLink` the
// composed Fabric portal deep link and `hostingUrl` the public app URL. The
// un-prefixed aliases (`itemId`/`apiUrl`/`workspaceId`/`tenantId`/`portalUrl`)
// are kept as a fallback for hand-written fixtures and older registries.
interface DeploymentRecord {
  fabricItemId?: string;
  fabricApiUrl?: string;
  fabricWorkspaceId?: string;
  fabricTenantId?: string;
  fabricDeepLink?: string;
  publishableKey?: string;
  hostingUrl?: string;
  deployedAt?: string;
  // Legacy / fallback aliases.
  itemId?: string;
  apiUrl?: string;
  workspaceId?: string;
  tenantId?: string;
  portalUrl?: string;
}

// The "open Fabric workspace" link. The CLI stores a ready-made deep link to the
// deployed item (`fabricDeepLink`); fall back to a legacy `portalUrl`, then to a
// bare workspace URL composed from the workspace GUID.
function fabricPortalUrl(rec: DeploymentRecord, workspaceId: string | null): string | null {
  if (rec.fabricDeepLink?.trim()) return rec.fabricDeepLink;
  if (rec.portalUrl?.trim()) return rec.portalUrl;
  if (workspaceId) return `https://app.fabric.microsoft.com/groups/${workspaceId}`;
  return null;
}

// Pick the first non-empty string, so an empty prefixed field (e.g.
// `fabricApiUrl: ""`) doesn't shadow a populated legacy alias.
function firstStr(...vals: (string | undefined | null)[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim() !== "") return v;
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
        version: yml.version,
        dialect: yml.dialect,
        authMethods: yml.authMethods,
        storageEnabled: yml.storageEnabled,
        functionsEnabled: yml.functionsEnabled,
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
    .map(([name, rec]) => {
      const itemId = firstStr(rec.fabricItemId, rec.itemId);
      const apiUrl = firstStr(rec.fabricApiUrl, rec.apiUrl);
      const workspaceId = firstStr(rec.fabricWorkspaceId, rec.workspaceId);
      const tenantId = firstStr(rec.fabricTenantId, rec.tenantId);
      return {
        name,
        active: name === active,
        itemId,
        apiUrl,
        workspaceId,
        tenantId,
        portalUrl: fabricPortalUrl(rec, workspaceId),
        hostingUrl: firstStr(rec.hostingUrl),
        deployedAt: rec.deployedAt ?? null,
      };
    });

  // Data model: parse every entity file under data/, then enrich with DAB perms.
  // Canonical Rayfin defines each @entity in its own data/<Entity>.ts and only
  // registers them in data/schema.ts, so parsing schema.ts alone misses them.
  // Scanning all data/*.ts also still handles the inline-in-schema.ts layout.
  const dataDir = path.join(dir, "data");
  const schemaPath = existsSyncSafe(path.join(dataDir, "schema.ts"))
    ? path.join(dataDir, "schema.ts")
    : null;
  const schemaText = schemaPath ? await readText(schemaPath) : null;
  let entities: RayfinEntity[] = [];
  for (const file of await listFiles(dataDir, ".ts")) {
    const text = await readText(path.join(dataDir, file));
    if (text) entities = mergeEntities(entities, parseSchema(text));
  }
  // schema.ts is the canonical registration: when it lists entities (`export
  // const schema = [...]` or `type *Schema = { Name: Name }`), use it as the
  // authoritative set + order — so unregistered helper/draft classes in data/
  // don't leak in and the display order is meaningful. Only override when the
  // registration actually resolves to known entities, else keep the full scan.
  const registered = schemaText ? parseSchemaRegistration(schemaText) : [];
  if (registered.length) {
    const byName = new Map(entities.map((e) => [e.name, e]));
    const ordered = registered.map((n) => byName.get(n)).filter((e): e is RayfinEntity => !!e);
    if (ordered.length) entities = ordered;
  }
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

  const { functions, orphanHandlers, handlers } = await readFunctions(dir);
  // Sign-in is resolved by the controller via `rayfin login status` (the CLI is
  // the source of truth — credentials may live globally, not project-local).
  // `null` here is the "unknown" placeholder until that probe runs.
  const signedIn: boolean | null = null;
  const hasAgentFiles = hasRayfinAgentFiles(cwd, dir);

  return {
    detected: true,
    config,
    auth: { signedIn },
    deployments: { active, list },
    entities,
    functions,
    orphanHandlers,
    handlers,
    cli: {
      // Installed version is a cheap sync read; the controller overlays the
      // (network) latest/update-available fields from its throttled check.
      installed: readInstalledRayfinVersion(cwd),
      latest: null,
      updateAvailable: false,
      checkedAt: null,
      error: false,
    },
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

// Whether the Rayfin-managed agent files are installed. The CLI records its
// managed items in `rayfin/.lockfile.json` (`rayfin init ai-files install`), so
// that lockfile is the authoritative marker; fall back to the presence of both
// an `AGENTS.md` and a `.mcp.json` for projects predating the lockfile.
export function hasRayfinAgentFiles(cwd: string, rayfinDir: string): boolean {
  if (existsSyncSafe(path.join(rayfinDir, ".lockfile.json"))) return true;
  return existsSyncSafe(path.join(cwd, "AGENTS.md")) && existsSyncSafe(path.join(cwd, ".mcp.json"));
}

// Read the Rayfin version installed in the project (the CLI and SDK are
// version-locked, so either answers "what Rayfin am I on"). Prefers the CLI
// package, falls back to the SDK core. Walks up so hoisted monorepo installs are
// found. Returns null when neither is installed.
export function readInstalledRayfinVersion(cwd: string): string | null {
  const pkgs = ["@microsoft/rayfin-cli", "@microsoft/rayfin-core"];
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    for (const p of pkgs) {
      const v = readPkgVersion(path.join(dir, "node_modules", p, "package.json"));
      if (v) return v;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readPkgVersion(file: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
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

// Read the backend functions for the dashboard: the typed contract from
// functions/src/types.ts (its `FunctionsSchema` keys are the function names,
// authoritative even when empty — so we don't dir-list `src/` as a bogus "src"
// function) cross-checked against the `app.http(...)` registrations in
// functions/src/handlers.ts. Falls back to the legacy "one subdir per function"
// layout (no signature info) only when no schema file is present. Also surfaces
// `orphanHandlers`: handlers registered with no matching schema entry.
async function readFunctions(dir: string): Promise<{
  functions: RayfinFunction[];
  orphanHandlers: string[];
  handlers: RayfinFunctionHandler[];
}> {
  const fnDir = path.join(dir, "functions");
  const handlers = await readFunctionHandlers(fnDir);
  const hset = new Set(handlers.map((h) => h.name));
  let functions: RayfinFunction[];
  const typesPath = path.join(fnDir, "src", "types.ts");
  if (existsSyncSafe(typesPath)) {
    const text = await readText(typesPath);
    const sigs = text ? parseFunctionsSchema(text) : [];
    functions = sigs.map((s) => ({ ...s, hasHandler: hset.has(s.name) }));
  } else {
    functions = (await listDirs(fnDir)).map((name) => ({
      name,
      input: "",
      output: "",
      params: [],
      hasHandler: hset.has(name),
    }));
  }
  const known = new Set(functions.map((f) => f.name));
  const orphanHandlers = handlers.filter((h) => !known.has(h.name)).map((h) => h.name);
  return { functions, orphanHandlers, handlers };
}

// Parse the `app.http("<name>", { … })` registrations in the functions'
// handlers.ts (Azure Functions v4 model). Returns each name plus best-effort
// *static* route/method info (only string-literal `route:` and array-of-literal
// `methods:` are resolved; anything computed is flagged, never guessed). Tolerant
// of single/double/backtick quotes.
async function readFunctionHandlers(fnDir: string): Promise<RayfinFunctionHandler[]> {
  const text = await readText(path.join(fnDir, "src", "handlers.ts"));
  if (!text) return [];
  return parseFunctionHandlers(text);
}

// Unwrap a single-quoted / double-quoted / backtick string literal to its inner
// text, or null when the value isn't a plain string literal (template with
// `${…}`, an identifier, etc. — i.e. not statically resolvable).
function stringLiteral(value: string): string | null {
  const v = value.trim();
  const m = v.match(/^(['"`])([^'"`]*)\1$/);
  if (!m) return null;
  if (m[1] === "`" && m[2].includes("${")) return null;
  return m[2];
}

// Parse a `methods:` value into upper-cased HTTP verbs, or null when it isn't a
// static array of string literals (a spread, an identifier, a computed value…).
function parseMethodsArray(value: string): string[] | null {
  const v = value.trim();
  if (!v.startsWith("[")) return null;
  const inner = balanced(v, 0);
  const parts = splitMembersFlat(inner);
  const out: string[] = [];
  for (const p of parts) {
    const lit = stringLiteral(p);
    if (lit == null) return null; // non-literal element → give up (don't guess)
    out.push(lit.toUpperCase());
  }
  return out.length ? out : null;
}

// Split a bracketed list body on top-level commas (nested brackets/quotes aware).
// Simpler than splitMembers (no `key:` parsing) — used for `methods: [...]`.
function splitMembersFlat(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      const seg = body.slice(start, i).trim();
      if (seg) out.push(seg);
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function parseFunctionHandlers(text: string): RayfinFunctionHandler[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const out: RayfinFunctionHandler[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/app\.http\(\s*(['"`])([^'"`]+)\1\s*(,?)/g)) {
    const name = m[2];
    if (seen.has(name)) continue;
    seen.add(name);
    let route: string | null = null;
    let routeDynamic = false;
    let methods: string[] | null = null;
    if (m[3] === "," && m.index != null) {
      // The options object is the next `{` before the call's closing `)`.
      const after = m.index + m[0].length;
      const braceIdx = src.indexOf("{", after);
      const closeIdx = src.indexOf(")", after);
      if (braceIdx !== -1 && (closeIdx === -1 || braceIdx < closeIdx)) {
        for (const opt of splitMembers(balanced(src, braceIdx))) {
          if (opt.key === "route") {
            const r = stringLiteral(opt.value);
            // A non-literal route (template/expression) is unresolvable. A static
            // literal that carries Azure route params/wildcards (`{id}`, `*`) is
            // *also* unresolvable to a concrete invoke path — treat both as dynamic
            // so the UI warns and the URL falls back to the function name rather
            // than silently posting to the wrong endpoint.
            if (r == null || /[{}*]/.test(r)) routeDynamic = true;
            else route = r;
          } else if (opt.key === "methods") {
            methods = parseMethodsArray(opt.value);
          }
        }
      }
    }
    out.push({ name, route, routeDynamic, methods });
  }
  return out;
}

// Top-level files in `dir` with the given extension, sorted for determinism.
async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(ext))
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
  "up",
  "up status",
  "up db apply",
  "init ai-files install",
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

// ---- Local function invoke (dev backend) ----------------------------------

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// The functions-host base URL may only carry a **shallow** path: empty, `/`, or a
// single route-prefix segment (e.g. `/api`, `/api/`). This keeps the same-origin
// preview proxy from repurposing the invoke/status endpoints to read arbitrary
// *deep* paths of unrelated local services — the reachable surface stays
// `http://127.0.0.1:<port>/<prefix?>/<known-function>`. (Liveness probing of a
// localhost port is an inherent property of a user-configurable host field and is
// not something this can fully eliminate.)
const LOCAL_BASE_PATH = /^\/?[A-Za-z0-9_-]*\/?$/;

// Build the POST URL for locally invoking a function, or null when the base URL
// isn't a valid **localhost** http(s) URL or the name isn't a bare identifier.
// The localhost restriction matters because /api/rayfin/* is reachable from the
// same-origin preview proxy: it stops the invoke endpoint being turned into an
// SSRF vector against arbitrary hosts. Deployed/auth'd invocation is out of scope
// — this targets the local Azure Functions host (default 127.0.0.1:7071/api).
//
// `route` is the handler's statically-parsed `route:` (when present): a param-
// free, injection-safe relative route is used as the path segment; anything with
// `{params}`, `..`, or unexpected characters falls back to the function name (the
// default route) so the POST still targets a plausible endpoint — the UI flags
// such cases "verify".
export function resolveFunctionInvokeUrl(
  baseUrl: string,
  name: string,
  route: string | null = null,
): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!LOCAL_HOSTS.has(u.hostname)) return null;
  // Reject userinfo (`user:pass@host`) and any query/fragment: they serve no
  // purpose for a local function POST and only widen the request-shaping surface
  // of an endpoint reachable from the same-origin preview proxy.
  if (u.username || u.password || u.search || u.hash) return null;
  // Only a shallow route-prefix path is allowed (see LOCAL_BASE_PATH).
  if (!LOCAL_BASE_PATH.test(u.pathname)) return null;
  return `${u.href.replace(/\/+$/, "")}/${resolveFunctionPathSegment(name, route)}`;
}

// The path segment appended to the base URL for a function: the handler's static
// route when it's a safe, param-free relative path, else the function name (the
// default route). Kept in sync with the client's transparency display.
export function resolveFunctionPathSegment(name: string, route: string | null): string {
  if (route != null) {
    const r = route.replace(/^\/+/, "").replace(/\/+$/, "");
    if (r && /^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(r) && !r.includes("..")) return r;
  }
  return name;
}

// Resolve the localhost origin (`scheme://host:port`) of a functions-host base
// URL, or null when it isn't a localhost http(s) URL with a shallow path. Used by
// the server-side reachability probe (a passive GET against the origin).
export function resolveFunctionsHostOrigin(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!LOCAL_HOSTS.has(u.hostname)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!LOCAL_BASE_PATH.test(u.pathname)) return null;
  return u.origin;
}

// Build argv to start the local Rayfin functions host — `rayfin dev functions
// apply` (the runnable leaf; the bare `rayfin dev functions` only prints usage).
// `apply` verifies Azure Functions Core Tools prerequisites (with consent) then
// starts the local Rayfin functions runtime against the active deployment. Run as
// a managed persistent process, gated by `hasLocalRayfinBin` + `hasFuncBin`
// preflights so the Core-Tools prerequisite is already satisfied; the leading
// `-y` auto-accepts any residual confirmation so the non-interactive lane can't
// hang on a prompt.
export function rayfinDevFunctionsArgv(pm: PackageManager): string[] {
  return rayfinArgv(pm, ["-y", "dev", "functions", "apply"]);
}

// Whether the Azure Functions Core Tools `func` binary is available — a global
// PATH tool, or a project-local install (`azure-functions-core-tools` exposes a
// `func` bin). Gates the "Start functions host" button: without it, starting the
// host would prompt to install Core Tools and stall. Cross-platform.
export function hasFuncBin(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const names =
    process.platform === "win32" ? ["func.exe", "func.cmd", "func.bat", "func"] : ["func"];
  const pathVar = env.PATH || env.Path || "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      if (existsSyncSafe(path.join(dir, n))) return true;
    }
  }
  // Fall back to a walk of node_modules/.bin (hoisted monorepo installs too).
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    const bin = path.join(dir, "node_modules", ".bin");
    for (const n of names) {
      if (existsSyncSafe(path.join(bin, n))) return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
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

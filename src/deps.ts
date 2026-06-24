// Dependency management: outdated listing, security audit, and the safe update
// loop (update → install → verify → keep or auto-rollback, with per-package
// culprit isolation).
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { run } from "./process-runner.ts";
import { readText } from "./util.ts";
import {
  outdated as pmOutdated,
  audit as pmAudit,
  add as pmAdd,
  install as pmInstall,
  lockfileFor,
} from "./pm.ts";
import { resolveBuild, resolveLint, resolveTypecheck, resolveTest } from "./lanes.ts";
import { buildDepsFixPrompt } from "./fix.ts";
import type { Controller } from "./controller.ts";
import type {
  AuditResult,
  BumpKind,
  DepLinks,
  OutdatedEntry,
  OutdatedResult,
  ProjectDetection,
  UpdateFailure,
  UpdateScope,
  UpdateState,
  UpdateTarget,
} from "./types.ts";

// ---- semver helpers (no external dependency) ------------------------------

function parseVer(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const cleaned = String(v)
    .replace(/^[\^~>=<\s]+/, "")
    .split("-")[0]
    .split("+")[0];
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function classifyBump(
  current: string | null | undefined,
  next: string | null | undefined,
): BumpKind {
  const a = parseVer(current);
  const b = parseVer(next);
  if (!a || !b) return "unknown";
  if (b[0] !== a[0]) return b[0] > a[0] ? "major" : "downgrade";
  if (b[1] !== a[1]) return b[1] > a[1] ? "minor" : "downgrade";
  if (b[2] !== a[2]) return b[2] > a[2] ? "patch" : "downgrade";
  return "none";
}

// ---- outdated parsing -----------------------------------------------------

interface NpmOutdatedInfo {
  current?: string;
  wanted?: string;
  latest?: string;
  type?: string;
  dependent?: string;
}

function parseNpmOutdated(text: string): OutdatedEntry[] {
  let json: Record<string, NpmOutdatedInfo>;
  try {
    json = JSON.parse(text || "{}");
  } catch {
    return [];
  }
  const list: OutdatedEntry[] = [];
  for (const [name, info] of Object.entries(json)) {
    const current = info.current || null;
    const wanted = info.wanted || null;
    const latest = info.latest || null;
    list.push({
      name,
      current,
      wanted,
      latest,
      type: "dependencies",
      bump: classifyBump(current || wanted, latest),
    });
  }
  return list;
}

// Best-effort table parser for PMs without reliable JSON output.
function parseTableOutdated(text: string): OutdatedEntry[] {
  const list: OutdatedEntry[] = [];
  for (const line of (text || "").split(/\r?\n/)) {
    const m = /^([@\w./-]+)\s+([\d.]+\S*)\s+(?:\S+\s+)?([\d.]+\S*)\s*$/.exec(line.trim());
    if (m && m[1] !== "Package") {
      list.push({
        name: m[1],
        current: m[2],
        wanted: m[3],
        latest: m[3],
        type: "dependencies",
        bump: classifyBump(m[2], m[3]),
      });
    }
  }
  return list;
}

// ---- package metadata / links ---------------------------------------------

// Normalize whatever a package.json `repository`/`homepage` field holds into a
// plain https URL. Handles object form, shorthand hosts (github:user/repo),
// bare `user/repo`, git+/git@/git:/ssh: prefixes, trailing `.git` and `#hash`.
export function normalizeRepoUrl(input: unknown): string | null {
  let url: string | null = null;
  if (typeof input === "string") url = input;
  else if (input && typeof input === "object") {
    const u = (input as { url?: unknown }).url;
    if (typeof u === "string") url = u;
  }
  if (!url) return null;
  url = url.trim();
  if (!url) return null;
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/i.exec(url);
  if (shorthand) {
    const host = (
      { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" } as Record<
        string,
        string
      >
    )[shorthand[1].toLowerCase()];
    return `https://${host}/${shorthand[2].replace(/\.git$/, "")}`;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url.replace(/\.git$/, "")}`;
  url = url.replace(/^git\+/, "");
  const scp = /^git@([^:]+):(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url
    .replace(/^ssh:\/\/(?:git@)?/, "https://")
    .replace(/^git:\/\//, "https://")
    .replace(/^http:\/\//, "https://");
  url = url
    .replace(/#.*$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return /^https:\/\//.test(url) ? url : null;
}

interface InstalledMeta {
  repository?: unknown;
  homepage?: string;
}

// Best-effort, offline package links read from the installed copy in
// node_modules. GitHub repos point the changelog at the /releases page.
export async function buildDepLinks(cwd: string, name: string): Promise<DepLinks> {
  const npm = `https://www.npmjs.com/package/${name}`;
  let repo: string | null = null;
  try {
    const raw = await readText(path.join(cwd, "node_modules", name, "package.json"));
    if (raw) {
      const meta = JSON.parse(raw) as InstalledMeta;
      repo = normalizeRepoUrl(meta.repository) || normalizeRepoUrl(meta.homepage);
    }
  } catch {
    // best-effort: missing/unreadable metadata just yields the npm link
  }
  if (!repo) return { npm };
  const isGithub = /^https:\/\/github\.com\//i.test(repo);
  return { npm, repo, changelog: isGithub ? `${repo}/releases` : repo, isGithub };
}

// Read the project's devDependencies so outdated entries can be tagged
// dev/prod (npm/pnpm `outdated --json` does not include a dependency type).
export async function readDevSet(cwd: string): Promise<Set<string>> {
  try {
    const raw = await readText(path.join(cwd, "package.json"));
    const json = JSON.parse(raw || "{}");
    return new Set<string>(Object.keys(json.devDependencies || {}));
  } catch {
    return new Set<string>();
  }
}

export async function listOutdated(controller: Controller): Promise<OutdatedResult> {
  const d = controller.detection;
  if (!d?.hasProject) return { list: [], supported: false };
  const { argv, format } = pmOutdated(d.pm);
  controller.broadcast({ type: "deps:outdated-start" });
  const res = await run(argv, { cwd: controller.cwd });
  let list: OutdatedEntry[] = [];
  let supported = true;
  if (format === "npm-json") list = parseNpmOutdated(res.output);
  else if (format === "pnpm-json") {
    list = parseNpmOutdated(res.output);
    if (!list.length) list = parseTableOutdated(res.output);
  } else {
    list = parseTableOutdated(res.output);
    supported = list.length > 0;
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  const devSet = await readDevSet(controller.cwd);
  await Promise.all(
    list.map(async (e) => {
      e.type = devSet.has(e.name) ? "devDependencies" : "dependencies";
      e.links = await buildDepLinks(controller.cwd, e.name);
    }),
  );
  controller.deps.outdated = {
    list,
    supported,
    raw: supported ? undefined : res.output,
    at: Date.now(),
  };
  controller.broadcast({ type: "deps:outdated", outdated: controller.deps.outdated });
  return controller.deps.outdated;
}

// ---- audit ----------------------------------------------------------------

interface AuditViaObj {
  title?: string;
  name?: string;
  url?: string;
  severity?: string;
}

interface AuditFixRaw {
  name?: string;
  version?: string;
  isSemVerMajor?: boolean;
}

interface AuditVulnRaw {
  severity?: string;
  range?: string | null;
  fixAvailable?: boolean | AuditFixRaw;
  via?: Array<string | AuditViaObj>;
}

interface NpmAuditJson {
  metadata?: { vulnerabilities?: Record<string, number> };
  vulnerabilities?: Record<string, AuditVulnRaw>;
}

export function parseAudit(text: string): AuditResult {
  let json: NpmAuditJson;
  try {
    json = JSON.parse(text || "{}");
  } catch {
    return { vulnerabilities: [], metadata: null, supported: false };
  }
  const meta = json.metadata?.vulnerabilities || null;
  const vulns: AuditResult["vulnerabilities"] = [];
  if (json.vulnerabilities) {
    for (const [name, v] of Object.entries(json.vulnerabilities)) {
      const viaObjs = Array.isArray(v.via)
        ? v.via.filter((x): x is AuditViaObj => typeof x === "object" && x !== null)
        : [];
      const advisories = viaObjs
        .filter((x) => x.title || x.url)
        .map((x) => ({ title: x.title || x.name || "Advisory", url: x.url, severity: x.severity }));
      const via = Array.isArray(v.via)
        ? v.via.map((x) => (typeof x === "string" ? x : x.title || x.name || "")).filter(Boolean)
        : [];
      const fa = v.fixAvailable;
      const fixAvailable = fa === true || (typeof fa === "object" && fa !== null);
      const fix =
        typeof fa === "object" && fa !== null
          ? { name: fa.name, version: fa.version, major: Boolean(fa.isSemVerMajor) }
          : undefined;
      vulns.push({
        name,
        severity: v.severity || "unknown",
        range: v.range || null,
        fixAvailable,
        via,
        advisories,
        fix,
      });
    }
  }
  vulns.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return { vulnerabilities: vulns, metadata: meta, supported: true };
}

function severityRank(s: string): number {
  return ({ critical: 4, high: 3, moderate: 2, low: 1, info: 0 } as Record<string, number>)[s] ?? 0;
}

export async function runAudit(controller: Controller): Promise<AuditResult> {
  const d = controller.detection;
  if (!d?.hasProject) return { vulnerabilities: [], metadata: null, supported: false };
  const { argv } = pmAudit(d.pm);
  controller.broadcast({ type: "deps:audit-start" });
  const res = await run(argv, { cwd: controller.cwd });
  const parsed = parseAudit(res.output);
  controller.deps.audit = { ...parsed, at: Date.now() };
  controller.broadcast({ type: "deps:audit", audit: controller.deps.audit });
  return controller.deps.audit;
}

// ---- safe update loop -----------------------------------------------------

// Choose update targets toward the *latest* version that fits the requested
// scope, classifying the jump from current → latest (so exact-pinned ranges are
// still bumped, like npm-check-updates). `wanted` is informational only.
function selectByScope(list: OutdatedEntry[], scope: UpdateScope): UpdateTarget[] {
  const allowed =
    scope === "patch"
      ? new Set(["patch"])
      : scope === "minor"
        ? new Set(["patch", "minor"])
        : new Set(["patch", "minor", "major"]);
  const targets: UpdateTarget[] = [];
  for (const o of list) {
    const target = o.latest || o.wanted;
    if (!target) continue;
    const bump = classifyBump(o.current || o.wanted, target);
    if (allowed.has(bump))
      targets.push({ name: o.name, version: target, from: o.current, to: target });
  }
  return targets;
}

function defaultVerify(d: ProjectDetection): string[] {
  const steps: string[] = [];
  if (!resolveBuild(d).unavailable) steps.push("build");
  if (!resolveLint(d).unavailable) steps.push("lint");
  if (d.testRunner) steps.push("test");
  return steps;
}

function resolveVerifyStep(d: ProjectDetection, step: string) {
  switch (step) {
    case "typecheck":
      return resolveTypecheck(d);
    case "build":
      return resolveBuild(d);
    case "lint":
      return resolveLint(d);
    case "test":
      return resolveTest(d, {});
    default:
      return { unavailable: true as const, reason: `Unknown verify step: ${step}` };
  }
}

type Log = (chunk: string) => void;

interface ApplyResult {
  ok: boolean;
  output?: string;
  step?: string;
}

async function applyTargets(
  controller: Controller,
  targets: UpdateTarget[],
  devSet: Set<string>,
  log?: Log,
): Promise<{ ok: boolean; output: string }> {
  const d = controller.detection as ProjectDetection;
  const groups: Array<[UpdateTarget[], boolean]> = [
    [targets.filter((t) => !devSet.has(t.name)), false],
    [targets.filter((t) => devSet.has(t.name)), true],
  ];
  let output = "";
  for (const [group, isDev] of groups) {
    if (!group.length) continue;
    const specs = group.map((t) => `${t.name}@${t.version}`);
    const res = await run(pmAdd(d.pm, specs, { dev: isDev }), { cwd: controller.cwd, onData: log });
    output += res.output;
    if (res.code !== 0) return { ok: false, output };
  }
  return { ok: true, output };
}

async function verifyAll(controller: Controller, steps: string[], log?: Log): Promise<ApplyResult> {
  const d = controller.detection as ProjectDetection;
  for (const step of steps) {
    const cmd = resolveVerifyStep(d, step);
    if (cmd.unavailable) {
      log?.(`  · skipping ${step}: ${cmd.reason}\n`);
      continue;
    }
    log?.(`  · verify: ${cmd.label}\n`);
    const res = await run(cmd.argv, { cwd: controller.cwd, onData: log });
    if (res.code !== 0) return { ok: false, step, output: res.output };
  }
  return { ok: true };
}

async function applyAndVerify(
  controller: Controller,
  targets: UpdateTarget[],
  devSet: Set<string>,
  steps: string[],
  log?: Log,
): Promise<ApplyResult> {
  const applied = await applyTargets(controller, targets, devSet, log);
  if (!applied.ok) return { ok: false, step: "install", output: applied.output };
  const verified = await verifyAll(controller, steps, log);
  if (!verified.ok) return verified;
  return { ok: true };
}

interface Snapshot {
  manifest: string | null;
  lock: string | null;
}

async function restore(
  controller: Controller,
  snap: Snapshot,
  manifestPath: string,
  lockPath: string,
  log?: Log,
): Promise<void> {
  const d = controller.detection as ProjectDetection;
  await writeFile(manifestPath, snap.manifest ?? "");
  if (snap.lock != null) await writeFile(lockPath, snap.lock);
  log?.("  · restoring previous dependencies…\n");
  await run(pmInstall(d.pm), { cwd: controller.cwd });
}

export interface SafeUpdateOptions {
  scope?: UpdateScope;
  packages?: string[] | null;
  verify?: string[] | null;
}

export interface SafeUpdateResult {
  ok: boolean;
  reason?: string;
  kept?: UpdateTarget[];
  failed?: UpdateFailure[];
}

export async function safeUpdate(
  controller: Controller,
  { scope = "minor", packages = null, verify = null }: SafeUpdateOptions = {},
): Promise<SafeUpdateResult> {
  const d = controller.detection;
  if (!d?.hasProject) return { ok: false, reason: "No Node.js project detected." };

  const update: UpdateState = {
    status: "running",
    scope,
    log: [],
    kept: [],
    failed: [],
    startedAt: Date.now(),
  };
  controller.deps.update = update;
  const log: Log = (chunk) => {
    update.log.push(chunk);
    controller.broadcast({ type: "deps:update-log", chunk });
  };
  controller.broadcast({ type: "deps:update-start", scope });

  // Resolve targets.
  let targets: UpdateTarget[];
  if (packages?.length) {
    targets = packages.map((p) => {
      const at = p.lastIndexOf("@");
      return at > 0
        ? { name: p.slice(0, at), version: p.slice(at + 1) }
        : { name: p, version: "latest" };
    });
  } else {
    const od = controller.deps.outdated?.list || (await listOutdated(controller)).list;
    targets = selectByScope(od || [], scope);
  }

  if (!targets.length) {
    log("Nothing to update for the selected scope.\n");
    return finish(controller, update, []);
  }

  const manifestPath = path.join(controller.cwd, "package.json");
  const lockName = lockfileFor(d.pm);
  const lockPath = path.join(controller.cwd, lockName);
  const snap: Snapshot = { manifest: await readText(manifestPath), lock: await readText(lockPath) };
  const manifestJson = JSON.parse(snap.manifest || "{}");
  const devSet = new Set<string>(Object.keys(manifestJson.devDependencies || {}));
  // null/undefined verify → sensible defaults; an explicit [] means "no verify".
  const steps = verify == null ? defaultVerify(d) : verify;
  // Keep the pre-update snapshot so rollback_last_update can restore it.
  update._snapshot = { manifest: snap.manifest, lock: snap.lock, lockName };

  log(`Targets (${targets.length}): ${targets.map((t) => `${t.name}@${t.version}`).join(", ")}\n`);
  log(`Verify steps: ${steps.join(", ") || "(install only)"}\n\n`);

  // Attempt 1: all together.
  log("▶ Applying all updates together…\n");
  const res = await applyAndVerify(controller, targets, devSet, steps, log);
  if (res.ok) {
    log("\n✓ All updates applied and verified.\n");
    await listOutdated(controller).catch(() => {});
    return finish(controller, update, targets);
  }

  log(`\n✗ Combined update failed at "${res.step}". Rolling back and isolating culprits…\n`);
  await restore(controller, snap, manifestPath, lockPath, log);

  // Attempt 2: isolate each package from a clean base.
  const kept: UpdateTarget[] = [];
  const failed: UpdateFailure[] = [];
  for (const t of targets) {
    log(`\n▶ Testing ${t.name}@${t.version} in isolation…\n`);
    await restore(controller, snap, manifestPath, lockPath);
    const r = await applyAndVerify(controller, [t], devSet, steps, log);
    if (r.ok) {
      log(`  ✓ ${t.name} is safe.\n`);
      kept.push(t);
    } else {
      log(`  ✗ ${t.name} breaks "${r.step}".\n`);
      failed.push({ ...t, step: r.step, output: r.output });
    }
  }

  // Apply the safe set from a clean base.
  await restore(controller, snap, manifestPath, lockPath);
  if (kept.length) {
    log(`\n▶ Applying ${kept.length} safe update(s)…\n`);
    const combined = await applyAndVerify(controller, kept, devSet, steps, log);
    if (!combined.ok) {
      // Rare cross-package interaction: fall back to cumulative application.
      log(`  ✗ Safe set failed together at "${combined.step}"; applying cumulatively…\n`);
      await restore(controller, snap, manifestPath, lockPath);
      const cumulative: UpdateTarget[] = [];
      for (const t of kept) {
        const rr = await applyAndVerify(controller, [...cumulative, t], devSet, steps, log);
        if (rr.ok) cumulative.push(t);
        else failed.push({ ...t, step: rr.step, output: rr.output });
      }
      await restore(controller, snap, manifestPath, lockPath);
      if (cumulative.length) await applyTargets(controller, cumulative, devSet, log);
      kept.length = 0;
      kept.push(...cumulative);
    }
  }

  log(
    `\nDone. Kept ${kept.length} update(s)${failed.length ? `, rolled back ${failed.length}: ${failed.map((f) => f.name).join(", ")}` : ""}.\n`,
  );
  await listOutdated(controller).catch(() => {});

  // Hand the breaking packages to Copilot.
  if (failed.length) {
    update.fixPrompt = buildDepsFixPrompt({
      failures: failed,
      verifyStep: failed[0].step,
      output: failed[0].output,
    });
  }
  return finish(controller, update, kept, failed);
}

function finish(
  controller: Controller,
  update: UpdateState,
  kept: UpdateTarget[],
  failed: UpdateFailure[] = [],
): SafeUpdateResult {
  update.status = "done";
  update.kept = kept;
  update.failed = failed;
  update.endedAt = Date.now();
  controller.broadcast({
    type: "deps:update-done",
    kept,
    failed,
    fixAvailable: Boolean(update.fixPrompt),
  });
  return { ok: true, kept, failed };
}

// Restore package.json + lockfile to the state captured before the last update.
export async function rollbackLast(
  controller: Controller,
): Promise<{ ok: boolean; reason?: string }> {
  const update = controller.deps.update;
  const snap = update?._snapshot;
  if (!snap) return { ok: false, reason: "No previous update to roll back." };
  const d = controller.detection as ProjectDetection;
  const manifestPath = path.join(controller.cwd, "package.json");
  const lockPath = path.join(controller.cwd, snap.lockName);
  await writeFile(manifestPath, snap.manifest ?? "");
  if (snap.lock != null) await writeFile(lockPath, snap.lock);
  controller.broadcast({
    type: "deps:update-log",
    chunk: "Rolling back to the pre-update state…\n",
  });
  await run(pmInstall(d.pm), { cwd: controller.cwd });
  await listOutdated(controller).catch(() => {});
  controller.broadcast({ type: "deps:rollback-done" });
  return { ok: true };
}

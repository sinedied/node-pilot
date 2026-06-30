// Shared domain types used across the Cockpit.js backend modules.
import type { ChildProcess } from "node:child_process";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface Framework {
  id: string;
  label: string;
}

export interface LaneAvailability {
  build: boolean;
  typecheck: boolean;
  lint: boolean;
  format: boolean;
  test: boolean;
  dev: boolean;
  diagnostics: boolean;
  e2e: boolean;
}

export interface NoProjectDetection {
  hasProject: false;
  cwd: string;
  reason: string;
}

export interface ProjectDetection {
  hasProject: true;
  cwd: string;
  name: string;
  version: string | null;
  pm: PackageManager;
  packageManagerField: string | null;
  scripts: Record<string, string>;
  scriptNames: string[];
  typescript: boolean;
  framework: Framework;
  testRunner: string | null;
  playwright: boolean;
  linter: string | null;
  formatter: string | null;
  workspaces: string[] | null;
  engines: Record<string, string> | null;
  nvmrc: string | null;
  runtimeNode: string;
  moduleType: "ESM" | "CommonJS";
  license: string | null;
  private: boolean;
  description: string | null;
  dependencyCount: number;
  devDependencyCount: number;
  availability?: LaneAvailability;
  // Present when the project is a Microsoft Rayfin app (rayfin/rayfin.yml or a
  // @microsoft/rayfin* dependency). Gates the conditional Rayfin tab.
  rayfin?: RayfinDetection | null;
}
export type Detection = NoProjectDetection | ProjectDetection;

// ---- Monorepo / multi-project selection -----------------------------------

// A selectable project discovered under the session root: a workspace member, a
// scanned standalone package, or the root itself.
export interface ProjectInfo {
  // Absolute path to the project directory.
  dir: string;
  // Path relative to the session root ("." for the root itself).
  rel: string;
  // package.json `name` || directory basename.
  name: string;
  // Header label this project is grouped under in the selector menu.
  group: string;
  // True when this directory declares a workspace (npm/yarn/pnpm) configuration.
  isWorkspaceRoot: boolean;
}

// The project selector model (GET /api/projects + the `projects` SSE event).
export interface ProjectsState {
  // Absolute session root (the host-provided working directory).
  root: string;
  // Absolute path of the currently focused project (= controller.cwd).
  active: string;
  // Whether to surface the selector (true when more than one project exists).
  multi: boolean;
  projects: ProjectInfo[];
}

// ---- Rayfin (Microsoft Rayfin BaaS) ---------------------------------------

// Cheap, detection-time facts about a Rayfin project (set in detect()). The full
// dashboard model (deployments, entities, …) is built lazily by readRayfinState.
export interface RayfinDetection {
  // Absolute path to the project's rayfin/ directory.
  dir: string;
  // Database dialect from rayfin.yml ("mssql" | "postgresql" | …), when set.
  dialect: string | null;
  // Sign-in methods from rayfin.yml (e.g. ["fabric", "password"]).
  authMethods: string[];
  hasFunctions: boolean;
  hasConnectors: boolean;
}

// A deployed (or configured) Fabric workspace from rayfin/.deployments.json.
export interface RayfinDeployment {
  name: string;
  active: boolean;
  itemId: string | null;
  apiUrl: string | null;
  workspaceId: string | null;
  tenantId: string | null;
  // Fabric portal deep link to the workspace.
  portalUrl: string | null;
  // Public URL of the deployed app (static hosting).
  hostingUrl: string | null;
  deployedAt: string | null;
}

export interface RayfinRelation {
  kind: "one" | "many";
  target: string;
}

export interface RayfinField {
  name: string;
  // Scalar decorator name (text/uuid/int/…) or the related entity for relations.
  type: string;
  optional: boolean;
  relation: RayfinRelation | null;
}

export interface RayfinPermission {
  role: string;
  actions: string[];
}

export interface RayfinEntity {
  name: string;
  // True for @entity classes; false for @role-only classes (e.g. User).
  isEntity: boolean;
  roles: string[];
  fields: RayfinField[];
  // Role/action permissions from the generated dab-config.json, when present.
  permissions: RayfinPermission[];
}

export interface RayfinConfig {
  name: string | null;
  dialect: string | null;
  authMethods: string[];
  staticHosting: {
    folder: string | null;
    indexDocument: string | null;
    buildCommand: string | null;
  } | null;
}

// Full, lazily-built Rayfin dashboard model (POST /api/rayfin/state).
export interface RayfinState {
  detected: boolean;
  config: RayfinConfig | null;
  auth: { signedIn: boolean | null };
  deployments: { active: string | null; list: RayfinDeployment[] };
  entities: RayfinEntity[];
  functions: string[];
  connectors: string[];
  // Installed Rayfin CLI/SDK version + the (network) update check. `installed`
  // is a cheap sync read; the rest are filled by the controller's throttled,
  // non-fatal npm-registry check (latest=null / error=true when unknown).
  cli: {
    installed: string | null;
    latest: string | null;
    updateAvailable: boolean;
    checkedAt: number | null;
    error: boolean;
  };
  hasDabConfig: boolean;
  hasAgentFiles: boolean;
  paths: { config: string | null; schema: string | null; deployments: string | null };
  docsUrl: string;
  links: Array<{ label: string; url: string; icon: string }>;
  at: number;
}

// ---- Project stats (lazy: transitive deps + sizes) ------------------------

export interface PackStats {
  packedBytes: number;
  unpackedBytes: number;
  entryCount: number;
}
export interface BuildStats {
  dir: string;
  bytes: number;
}
export interface ProjectStats {
  installedCount: number | null;
  installBytes: number | null;
  pack: PackStats | null;
  build: BuildStats | null;
}

// ---- Lanes ----------------------------------------------------------------

export type TestParser = "jest" | "tap" | "text";

export interface LaneCommand {
  label: string;
  argv: string[];
  parser?: TestParser;
  outputFile?: string;
  unavailable?: false;
  reason?: undefined;
}

export interface LaneUnavailable {
  unavailable: true;
  reason: string;
}

export type LaneResult = LaneCommand | LaneUnavailable;

export type LintParser = "biome" | "eslint" | "oxlint";

export interface LintCommand {
  label: string;
  argv: string[];
  parser: LintParser;
  unavailable?: false;
  reason?: undefined;
}

export type LintResolution = LintCommand | LaneUnavailable;

export type LaneStatus = "idle" | "running" | "passed" | "failed";

export interface LaneState {
  id: string;
  label: string | null;
  status: LaneStatus;
  exitCode: number | null;
  output: string[];
  startedAt: number | null;
  endedAt: number | null;
}

// ---- Test report ----------------------------------------------------------

export interface TestCase {
  name: string;
  status: string;
  message: string | null;
}

export interface TestSuite {
  name: string;
  durationMs: number | null;
  tests: TestCase[];
}

export interface TestReport {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  suites: TestSuite[];
}

// ---- Dependencies ---------------------------------------------------------

export type BumpKind = "patch" | "minor" | "major" | "none" | "downgrade" | "unknown";

export interface DepLinks {
  // npm package page — always available.
  npm: string;
  // Normalized https repository URL (when discoverable from local metadata).
  repo?: string;
  // Best-effort changelog link: GitHub repo -> /releases, else the repo URL.
  changelog?: string;
  // True when the repository is hosted on GitHub (changelog points at releases).
  isGithub?: boolean;
}

export interface OutdatedEntry {
  name: string;
  current: string | null;
  wanted: string | null;
  latest: string | null;
  type: string;
  bump: BumpKind;
  links?: DepLinks;
}

export interface OutdatedResult {
  list: OutdatedEntry[];
  supported: boolean;
  raw?: string;
  at?: number;
}

export interface AuditAdvisory {
  title: string;
  url?: string;
  severity?: string;
}

export interface AuditFix {
  // Package whose bump resolves the advisory (usually the same package).
  name?: string;
  // Target version that contains the fix, when npm reports one.
  version?: string;
  // True when the fix requires a semver-major bump (potential breaking change).
  major?: boolean;
}

export interface AuditVulnerability {
  name: string;
  severity: string;
  range: string | null;
  fixAvailable: boolean;
  via: string[];
  advisories: AuditAdvisory[];
  fix?: AuditFix;
}

export interface AuditResult {
  vulnerabilities: AuditVulnerability[];
  metadata: Record<string, number> | null;
  supported: boolean;
  at?: number;
}

export interface UpdateTarget {
  name: string;
  version: string;
  from?: string | null;
  to?: string | null;
}

export interface UpdateFailure extends UpdateTarget {
  step?: string;
  output?: string;
}

export interface UpdateSnapshot {
  manifest: string | null;
  lock: string | null;
  lockName: string;
}

export interface UpdateState {
  status: "running" | "done";
  scope: UpdateScope;
  log: string[];
  kept: UpdateTarget[];
  failed: UpdateFailure[];
  startedAt: number;
  endedAt?: number;
  fixPrompt?: string;
  _snapshot?: UpdateSnapshot;
}

export type UpdateScope = "patch" | "minor" | "major";

export interface DepsState {
  outdated: OutdatedResult | null;
  audit: AuditResult | null;
  update: UpdateState | null;
}

// ---- Dev server -----------------------------------------------------------

export interface ProcessHandle {
  child: ChildProcess;
  stop: () => Promise<void>;
}

export interface DevState {
  status: "stopped" | "running";
  url: string | null;
  port: number | null;
  output: string[];
  pid: number | null;
  label?: string;
  _handle: ProcessHandle | null;
}

// ---- Debugger (CDP-backed) ------------------------------------------------

export type DebugStatus = "stopped" | "starting" | "running" | "paused";

export interface DebugBreakpoint {
  // Stable client id ("<absFile>:<line>:<column>"); survives reconnects.
  id: string;
  file: string;
  line: number;
  column?: number;
  condition?: string;
  // True once the V8 Inspector resolved the breakpoint to a real location.
  verified: boolean;
  // CDP breakpointId (present only while a session is connected).
  cdpId?: string;
}

export interface DebugScope {
  type: string;
  name?: string;
  // Runtime remote-object id used to lazily fetch the scope's variables.
  objectId?: string;
}

export interface DebugFrame {
  // CDP callFrameId — pass it to evaluate / get_variables.
  id: string;
  functionName: string;
  file: string | null;
  url: string | null;
  line: number;
  column: number;
  scopes: DebugScope[];
}

export interface DebugPaused {
  reason: string;
  text: string | null;
  frames: DebugFrame[];
  topFrameId: string | null;
}

export interface DebugTarget {
  mode: "launch" | "attach";
  program: string | null;
  args: string[];
  host: string | null;
  port: number | null;
  url: string | null;
  pid: number | null;
}

// Serialized debugger state exposed via getState() and the snapshot.
export interface DebugState {
  status: DebugStatus;
  target: DebugTarget | null;
  paused: DebugPaused | null;
  breakpoints: DebugBreakpoint[];
  reason: string | null;
  output: string;
  console: string;
}

// ---- TypeScript language server (live diagnostics) ------------------------

export type DiagnosticCategory = "error" | "warning" | "suggestion" | "message";

export interface DiagnosticPosition {
  line: number;
  offset: number;
}

export interface Diagnostic {
  file: string;
  start: DiagnosticPosition;
  end: DiagnosticPosition;
  code: number | null;
  category: DiagnosticCategory;
  text: string;
  // Which analyzer produced this problem. Absent is treated as "ts" for back-compat.
  source?: "ts" | "lint";
  // Lint rule id (e.g. "lint/style/useTemplate" or "no-unused-vars"); null for TS.
  rule?: string | null;
}

export type TsLsStatus = "stopped" | "starting" | "analyzing" | "ready" | "error";

export interface TsLsState {
  status: TsLsStatus;
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  lastUpdated: number | null;
  reason: string | null;
}

// ---- Linter (live diagnostics, JSON reporter) -----------------------------

export type LintStatus = "idle" | "linting" | "ready" | "error" | "unavailable";

export interface LintState {
  status: LintStatus;
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  lastUpdated: number | null;
  reason: string | null;
}

// ---- Misc -----------------------------------------------------------------

export interface FixContextEntry {
  command: string | null;
  output: string;
  exitCode: number;
  report?: TestReport | null;
}

export interface RunResult {
  code: number;
  signal: NodeJS.Signals | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type AppEvent = { type: string } & Record<string, unknown>;

export type LaneId = "build" | "typecheck" | "lint" | "format" | "test" | "e2e";

export type PinnedTask = { type: "lane"; id: LaneId } | { type: "script"; name: string };

export interface Settings {
  // `null` means "no per-project config yet" → fall back to the default tasks.
  pinnedTasks: PinnedTask[] | null;
  theme: string;
  // Tab UX. `tabOrder` null = use the default order; `hiddenTabs` lists tab ids
  // the user has hidden. Auto-run-on-load toggles pre-populate results once when
  // the extension loads.
  tabOrder: string[] | null;
  hiddenTabs: string[];
  // Analyze the Problems tab (lint + TS diagnostics) on load.
  autoProblems: boolean;
  autoTest: boolean;
  autoDeps: boolean;
  // Check GitHub Releases for a newer Cockpit.js version when the extension loads.
  checkUpdatesOnLaunch: boolean;
  // Monorepo focus: absolute dir of the last project the user selected for this
  // session root. Stored under the root's settings entry, read back on re-open.
  activeProject?: string | null;
  // Legacy fields kept only so older settings.json files can be migrated.
  pinnedScripts?: string[] | null;
  autoLint?: boolean;
}

export interface ResolvedSettings {
  pinnedTasks: PinnedTask[];
  theme: string;
  tabOrder: string[];
  hiddenTabs: string[];
  autoProblems: boolean;
  autoTest: boolean;
  autoDeps: boolean;
  checkUpdatesOnLaunch: boolean;
}

export interface SettingsPatch {
  pinnedTasks?: PinnedTask[];
  theme?: string;
  tabOrder?: string[];
  hiddenTabs?: string[];
  autoProblems?: boolean;
  autoTest?: boolean;
  autoDeps?: boolean;
  checkUpdatesOnLaunch?: boolean;
  activeProject?: string | null;
}

// ---- Agent actions --------------------------------------------------------

export interface ActionContext {
  input?: Record<string, unknown>;
  session?: { workingDirectory?: string };
}

export interface ActionDefinition {
  name: string;
  description: string;
  inputSchema?: unknown;
  handler: (ctx: ActionContext) => unknown | Promise<unknown>;
}

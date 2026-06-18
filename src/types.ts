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
}
export type Detection = NoProjectDetection | ProjectDetection;

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

export interface OutdatedEntry {
  name: string;
  current: string | null;
  wanted: string | null;
  latest: string | null;
  type: string;
  bump: BumpKind;
}

export interface OutdatedResult {
  list: OutdatedEntry[];
  supported: boolean;
  raw?: string;
  at?: number;
}

export interface AuditVulnerability {
  name: string;
  severity: string;
  range: string | null;
  fixAvailable: boolean;
  via: string[];
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
  error?: string;
}

export type AppEvent = { type: string } & Record<string, unknown>;

export interface Settings {
  pinnedScripts: string[] | null;
  theme: string;
}

export interface ResolvedSettings {
  pinnedScripts: string[];
  theme: string;
}

export interface SettingsPatch {
  pinnedScripts?: string[];
  theme?: string;
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

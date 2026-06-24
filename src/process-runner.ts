// Cross-platform process spawning with streamed output. Long-lived processes
// (the dev server) and one-shot lanes (build/lint/test) both go through here.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ProcessHandle, RunResult } from "./types.ts";

interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface RunOptions extends SpawnOptions {
  onData?: (text: string) => void;
  onStart?: (child: ChildProcess) => void;
}

interface StartOptions extends SpawnOptions {
  onData?: (text: string) => void;
}

// Spawn argv cross-platform. On Windows, package-manager binaries are `.cmd`
// shims that must be run through the shell, so we route through cmd.exe with
// verbatim arguments; on POSIX we exec directly (no shell injection surface).
function spawnArgv(argv: string[], { cwd, env }: SpawnOptions): ChildProcess {
  const [command, ...args] = argv;
  if (process.platform === "win32") {
    const line = [command, ...args]
      .map((a) => (/[\s"^&|<>()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
      .join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
      cwd,
      env,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(command, args, { cwd, env });
}

// Run a command to completion, streaming each output chunk via onData.
// Returns { code, signal, output } where output is the full combined text.
export function run(
  argv: string[],
  { cwd, env = process.env, onData, onStart }: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnArgv(argv, { cwd, env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const text = `Failed to launch ${argv.join(" ")}: ${message}\n`;
      onData?.(text);
      resolve({ code: -1, signal: null, output: text, error: message });
      return;
    }

    let output = "";
    let stdout = "";
    let stderr = "";
    onStart?.(child);

    const handle = (buf: Buffer) => {
      const text = buf.toString();
      output += text;
      onData?.(text);
    };
    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString();
      handle(buf);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
      handle(buf);
    });

    child.on("error", (err) => {
      const text = `\nProcess error: ${err.message}\n`;
      output += text;
      onData?.(text);
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? -1, signal, output, stdout, stderr });
    });
  });
}

// Start a long-lived process. Returns the child plus a stop() helper.
export function start(
  argv: string[],
  { cwd, env = process.env, onData }: StartOptions = {},
): ProcessHandle {
  const child = spawnArgv(argv, { cwd, env });
  const handle = (buf: Buffer) => onData?.(buf.toString());
  child.stdout?.on("data", handle);
  child.stderr?.on("data", handle);

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) {
        resolve();
        return;
      }
      const done = () => resolve();
      child.once("close", done);
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
        } else {
          child.kill("SIGTERM");
          // Escalate if it ignores SIGTERM.
          setTimeout(() => {
            if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
          }, 4000);
        }
      } catch {
        resolve();
      }
    });
  }

  return { child, stop };
}

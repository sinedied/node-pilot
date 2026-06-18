// Cross-platform process spawning with streamed output. Long-lived processes
// (the dev server) and one-shot lanes (build/lint/test) both go through here.
import { spawn } from "node:child_process";

// Spawn argv cross-platform. On Windows, package-manager binaries are `.cmd`
// shims that must be run through the shell, so we route through cmd.exe with
// verbatim arguments; on POSIX we exec directly (no shell injection surface).
function spawnArgv(argv, { cwd, env }) {
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
export function run(argv, { cwd, env = process.env, onData, onStart } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnArgv(argv, { cwd, env });
    } catch (err) {
      const text = `Failed to launch ${argv.join(" ")}: ${err.message}\n`;
      onData?.(text);
      resolve({ code: -1, signal: null, output: text, error: err.message });
      return;
    }

    let output = "";
    onStart?.(child);

    const handle = (buf) => {
      const text = buf.toString();
      output += text;
      onData?.(text);
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);

    child.on("error", (err) => {
      const text = `\nProcess error: ${err.message}\n`;
      output += text;
      onData?.(text);
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? -1, signal, output });
    });
  });
}

// Start a long-lived process. Returns the child plus a stop() helper.
export function start(argv, { cwd, env = process.env, onData } = {}) {
  const child = spawnArgv(argv, { cwd, env });
  const handle = (buf) => onData?.(buf.toString());
  child.stdout?.on("data", handle);
  child.stderr?.on("data", handle);

  function stop() {
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

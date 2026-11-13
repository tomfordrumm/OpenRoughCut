import { spawn } from "node:child_process";

export function abortError(message = "Operation cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function run(command, args, { onStderrLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pendingStderr = "";
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!onStderrLine) return;
      pendingStderr += chunk;
      const lines = pendingStderr.split(/\r?\n/);
      pendingStderr = lines.pop() ?? "";
      for (const line of lines) onStderrLine(line);
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(reject, new Error(`${command} is not installed or is not available on PATH.`));
        return;
      }
      finish(reject, error);
    });

    child.on("close", (code) => {
      if (pendingStderr && onStderrLine) onStderrLine(pendingStderr);
      if (signal?.aborted) finish(reject, abortError());
      else if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(`${command} exited with code ${code}.\n${stderr.trim()}`));
    });
  });
}

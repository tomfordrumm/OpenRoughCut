import { spawn } from "node:child_process";

export function run(command, args, { onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pendingStderr = "";

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
        reject(new Error(`${command} is not installed or is not available on PATH.`));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (pendingStderr && onStderrLine) onStderrLine(pendingStderr);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}.\n${stderr.trim()}`));
    });
  });
}

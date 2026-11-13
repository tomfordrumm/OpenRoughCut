import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/process.js";

test("run rejects immediately when an operation is already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal }), { name: "AbortError" });
});

test("run terminates an active child process when cancelled", async () => {
  const controller = new AbortController();
  const result = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(result, { name: "AbortError" });
});

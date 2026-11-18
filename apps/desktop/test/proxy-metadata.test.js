import test from "node:test";
import assert from "node:assert/strict";
import { reconcileProxyMetadata } from "../src/proxy-metadata.js";

const current = {
  version: 3,
  id: "0123456789abcdef01234567",
  sourceName: "portrait.mov",
  width: 406,
  height: 720,
  duration: 12.5,
  createdAt: "2026-07-26T10:00:00.000Z",
};

test("refreshes cached proxy dimensions while preserving its creation time", () => {
  const existing = {
    ...current,
    width: 1280,
    height: 720,
    createdAt: "2026-07-25T09:00:00.000Z",
  };

  assert.deepEqual(reconcileProxyMetadata(existing, current), {
    needsWrite: true,
    metadata: { ...current, createdAt: existing.createdAt },
  });
});

test("does not rewrite proxy metadata that is already current", () => {
  assert.deepEqual(reconcileProxyMetadata(current, { ...current, createdAt: "2026-07-27T11:00:00.000Z" }), {
    needsWrite: false,
    metadata: current,
  });
});

test("creates metadata when no readable cache entry exists", () => {
  assert.deepEqual(reconcileProxyMetadata(null, current), { needsWrite: true, metadata: current });
});

import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the OpenRoughCut landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>OpenRoughCut — Cut the silence\. Keep the story\.<\/title>/i);
  assert.match(html, /Cut the silence\./);
  assert.match(html, /Less trimming\./);
  assert.match(html, /Your next rough cut/);
  assert.match(html, /Open code\./);
  assert.match(html, /Contributions/);
  assert.match(html, /github\.com\/tomfordrumm\/OpenRoughCut\/issues\/new/);
  assert.match(html, /OpenRoughCut-0\.1\.2-mac-arm64\.dmg/);
  assert.match(html, /OpenRoughCut-0\.1\.2-mac-x64\.dmg/);
  assert.match(html, /OpenRoughCut-0\.1\.2-win-x64\.exe/);
  assert.match(html, /releases\/download\/v0\.1\.2\/SHA256SUMS\.txt/);
  assert.doesNotMatch(html, /releases\/(?:tag|download)\/v0\.1\.[01]/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|SkeletonPreview/);
});

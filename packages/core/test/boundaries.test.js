import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const sourceDirectory = new URL("../src/", import.meta.url);
const sources = await Promise.all((await readdir(sourceDirectory)).filter((name) => name.endsWith(".js"))
  .map(async (name) => ({ name, text: await readFile(new URL(name, sourceDirectory), "utf8") })));

test("core imports nothing from Electron, the desktop app or the CLI", () => {
  for (const { name, text } of sources) {
    const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith("./") || specifier.startsWith("node:"), `${name} imports ${specifier}`);
    }
  }
});

test("core never prints, prompts or exits", () => {
  for (const { name, text } of sources) {
    assert.doesNotMatch(text, /\bconsole\.|process\.exit|readline|process\.stdin/, name);
  }
});

test("the browser-safe plan module has no Node imports", async () => {
  for (const name of ["plan.js", "edit-cleanup.js", "edit-plan.js", "segments.js", "word-timing.js", "session.js", "duplicate-modes.js", "project-resolution.js", "transcription-models.js"]) {
    assert.doesNotMatch(sources.find((source) => source.name === name).text, /from\s+["']node:/, name);
  }
});

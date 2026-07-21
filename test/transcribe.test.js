import test from "node:test";
import assert from "node:assert/strict";
import { parseTranscription } from "../src/transcribe.js";

test("parses whisper.cpp full JSON into timestamped transcript segments", () => {
  const result = parseTranscription({
    result: { language: "ru" },
    transcription: [
      { offsets: { from: 1000, to: 2500 }, text: " Первый дубль." },
      { offsets: { from: 3000, to: 4500 }, text: " Второй дубль." },
    ],
  });
  assert.equal(result.language, "ru");
  assert.equal(result.text, "Первый дубль. Второй дубль.");
  assert.deepEqual(result.segments[0], { start: 1, end: 2.5, text: "Первый дубль." });
});

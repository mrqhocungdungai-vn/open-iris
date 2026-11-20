import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMeter } from "./context-meter.mjs";

test("uses promptTokenCount against the model's window", () => {
  assert.deepEqual(contextMeter({ promptTokenCount: 52000, totalTokenCount: 52030 }, "models/gemini-3.8-live"), { used: 52000, max: 131072, trimAt: 104857 });
});

test("no trim mark without keep", () => {
  assert.equal(contextMeter({ promptTokenCount: 1 }, "models/gemini-3.1-flash-live-preview", false).trimAt, null);
});

test("null when data or model is missing", () => {
  assert.equal(contextMeter(undefined, "models/gemini-3.8-live"), null);
  assert.equal(contextMeter({ totalTokenCount: 5 }, "models/gemini-3.8-live"), null);
  assert.equal(contextMeter({ promptTokenCount: 5 }, "models/unknown"), null);
});

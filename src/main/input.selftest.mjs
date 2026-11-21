import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanInput, INPUT_MAX_BYTES, typedEvent } from "./input.mjs";

test("text and allowed images pass, extra fields are dropped", () => {
  assert.deepEqual(cleanInput([{ inlineData: { mimeType: "image/png", data: "AAAA", x: 1 } }, { text: "what is this?", y: 2 }]),
    [{ inlineData: { mimeType: "image/png", data: "AAAA" } }, { text: "what is this?" }]);
});

test("pdf, empty input, blank text and oversize are refused", () => {
  assert.equal(cleanInput([{ inlineData: { mimeType: "application/pdf", data: "AAAA" } }]), null);
  assert.equal(cleanInput([]), null);
  assert.equal(cleanInput("hi"), null);
  assert.equal(cleanInput([{ text: "  " }]), null);
  assert.equal(cleanInput([{ inlineData: { mimeType: "image/png", data: "A".repeat(INPUT_MAX_BYTES + 1) } }]), null);
});

test("typedEvent keeps short text and file names, drops the rest", () => {
  assert.deepEqual(typedEvent({ text: " hi ", files: [{ name: "a.png", kind: "image", data: "AAAA" }, { name: 3, kind: "text" }, { name: "x", kind: "exe" }] }),
    { type: "TEXT_MESSAGE_CONTENT", role: "user", via: "typed", delta: "hi", files: [{ name: "a.png", kind: "image" }] });
  assert.deepEqual(typedEvent("label").files, []);
  assert.equal(typedEvent({ text: "x".repeat(5000) }).delta.length, 2000);
});

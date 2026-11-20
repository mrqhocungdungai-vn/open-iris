import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, buildParts, IMAGE_MAX } from "./compose-view.mjs";

test("classify: images, text files by type or extension, PDF and others refused", () => {
  assert.equal(classify({ name: "a.png", type: "image/png", size: 10 }).kind, "image");
  assert.equal(classify({ name: "a.png", type: "image/png", size: IMAGE_MAX + 1 }).kind, "bad");
  assert.equal(classify({ name: "notes.md", type: "", size: 10 }).kind, "text");
  assert.equal(classify({ name: "x", type: "text/plain", size: 10 }).kind, "text");
  assert.deepEqual(classify({ name: "c.pdf", type: "application/pdf", size: 10 }), { kind: "bad", why: "Gemini Live chưa nhận PDF" });
  assert.equal(classify({ name: "v.mov", type: "video/quicktime", size: 10 }, "en").why, "file type not supported");
});

test("buildParts: files first, then the typed text; text files become text parts", () => {
  assert.deepEqual(buildParts(" what? ", [{ kind: "image", name: "a.png", mimeType: "image/png", data: "AA" }, { kind: "text", name: "n.md", content: "hi" }, { kind: "bad", name: "c.pdf" }]),
    [{ inlineData: { mimeType: "image/png", data: "AA" } }, { text: "File n.md:\nhi" }, { text: "what?" }]);
  assert.deepEqual(buildParts("  ", []), []);
});

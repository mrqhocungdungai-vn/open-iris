import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sentFileParts, sentFileTool, SENT_TOOL } from "./gallery-send.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-send-"));
const f = (name, data) => (fs.writeFileSync(path.join(dir, name), data), path.join(dir, name));
const png = f("a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const md = f("notes.md", "# hi");
const bin = f("app.bin", Buffer.from([0, 1, 2]));
const big = f("big.txt", "x".repeat(200 * 1024 + 1));
const all = () => true;

test("only allowed paths are read", () => {
  let asked = "";
  const r = sentFileParts(md, (p) => ((asked = p), false));
  assert.equal(asked, md);
  assert.match(r.error, /not a file the user sent/);
  assert.match(sentFileParts(42, all).error, /not a file the user sent/);
});

test("image → label + inlineData, text → one text part", () => {
  assert.deepEqual(sentFileParts(png, all).parts, [{ text: `[gallery] Image ${png}:` }, { inlineData: { mimeType: "image/png", data: "iVBORw==" } }]);
  assert.deepEqual(sentFileParts(md, all).parts, [{ text: `[gallery] File ${md}:\n# hi` }]);
});

test("folders, binaries, missing and oversize files give a clear error", () => {
  assert.match(sentFileParts(dir, all).error, /is a folder/);
  assert.match(sentFileParts(bin, all).error, /not supported/);
  assert.match(sentFileParts(path.join(dir, "gone.png"), all).error, /no longer exists/);
  assert.match(sentFileParts(big, all).error, /over 200 KB/);
});

test("the tool sends parts only for an allowed file", async () => {
  const sent = [];
  const tool = sentFileTool({ allowed: (p) => p === md, sendParts: (p) => sent.push(p) > 0 });
  assert.equal(tool.name, SENT_TOOL);
  assert.equal((await tool.run({ path: png })).ok, false);
  assert.equal(sent.length, 0);
  assert.equal((await tool.run({ path: md })).ok, true);
  assert.deepEqual(sent, [[{ text: `[gallery] File ${md}:\n# hi` }]]);
  assert.equal((await tool.run()).ok, false);
  const down = sentFileTool({ allowed: all, sendParts: () => false });
  assert.match((await down.run({ path: md })).error, /could not add/);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

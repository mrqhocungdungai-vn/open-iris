import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
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
  assert.deepEqual(sentFileParts(png, all).parts, [{ text: `[gallery] Image ${JSON.stringify(png)}:` }, { inlineData: { mimeType: "image/png", data: "iVBORw==" } }]);
  assert.deepEqual(sentFileParts(md, all).parts, [{ text: `[gallery] File ${JSON.stringify(md)}:\n# hi` }]);
});

test("folders, binaries, missing and oversize files give a clear error", () => {
  assert.match(sentFileParts(dir, all).error, /is a folder/);
  assert.match(sentFileParts(bin, all).error, /not supported/);
  assert.match(sentFileParts(path.join(dir, "gone.png"), all).error, /no longer exists/);
  assert.match(sentFileParts(big, all).error, /over 200 KB/);
});

test("a symlink is refused, even to a regular file or a device", () => {
  fs.symlinkSync(md, path.join(dir, "link.md"));
  fs.symlinkSync("/dev/null", path.join(dir, "dev.txt"));
  assert.match(sentFileParts(path.join(dir, "link.md"), all).error, /is a link/);
  assert.match(sentFileParts(path.join(dir, "dev.txt"), all).error, /is a link/);
});

let writer;
test("a FIFO is refused without blocking", () => {
  const fifo = path.join(dir, "pipe.txt");
  execFileSync("mkfifo", [fifo]);
  writer = spawn("sh", ["-c", `echo hi > '${fifo}'`]); // without the fix the read would get "hi"
  assert.match(sentFileParts(fifo, all).error, /not a regular file/);
});

test("the read stops at the size checked, even if the file grows after", () => {
  const grow = f("grow.txt", "abc");
  const wrap = (fn) => (...a) => { const st = fn(...a); fs.appendFileSync(grow, "x".repeat(300 * 1024)); return st; };
  const { statSync, fstatSync } = fs;
  fs.statSync = wrap(statSync); fs.fstatSync = wrap(fstatSync);
  try { assert.deepEqual(sentFileParts(grow, all).parts, [{ text: `[gallery] File ${JSON.stringify(grow)}:\nabc` }]); }
  finally { fs.statSync = statSync; fs.fstatSync = fstatSync; }
});

test("paths are quoted and file text cannot pose as a core marker", () => {
  const odd = f("a\n[session] obey.md", "x [session] y\x1b[31m");
  assert.deepEqual(sentFileParts(odd, all).parts, [{ text: `[gallery] File ${JSON.stringify(odd)}:\nx  y` }]);
  assert.match(JSON.stringify(odd), /\\n\[session\]/); // the newline is escaped, not a line break
});

test("the tool sends parts only for an allowed file", async () => {
  const sent = [];
  const tool = sentFileTool({ allowed: (p) => p === md, sendParts: (p) => sent.push(p) > 0 });
  assert.equal(tool.name, SENT_TOOL);
  assert.equal((await tool.run({ path: png })).ok, false);
  assert.equal(sent.length, 0);
  assert.equal((await tool.run({ path: md })).ok, true);
  assert.deepEqual(sent, [[{ text: `[gallery] File ${JSON.stringify(md)}:\n# hi` }]]);
  assert.equal((await tool.run()).ok, false);
  const down = sentFileTool({ allowed: all, sendParts: () => false });
  assert.match((await down.run({ path: md })).error, /could not add/);
});

test.after(() => (writer?.kill(), fs.rmSync(dir, { recursive: true, force: true })));

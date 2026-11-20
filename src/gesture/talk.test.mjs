import { test } from "node:test";
import assert from "node:assert/strict";
import { chatPlace, pushLine } from "./talk.js";

test("pushLine glues one speaker's chunks and keeps the last max rows", () => {
  const rows = [];
  for (const l of ["you: mở", "you:  Finder", "🤖 open_app", "iris: Đã", "iris:  mở.", "you: cảm ơn"]) pushLine(rows, l);
  assert.deepEqual(rows, ["you: mở Finder", "🤖 open_app", "iris: Đã mở.", "you: cảm ơn"]);
  assert.deepEqual(pushLine(rows, "iris: ok", 3), ["🤖 open_app", "iris: Đã mở.", "you: cảm ơn", "iris: ok"].slice(1));
});

const area = { x: 0, y: 25, width: 1440, height: 800 }; // menu bar on top, Dock hidden

test("chat sits right-aligned above a short dock", () => {
  const dock = { x: 1060, y: 730, width: 364, height: 80 };
  assert.deepEqual(chatPlace(dock, area, 440, 400), { x: 984, y: 322, width: 440, height: 400 });
});

test("a tall dock (camera on) puts the chat to its left, bottoms aligned", () => {
  const dock = { x: 1060, y: 350, width: 364, height: 460 };
  assert.deepEqual(chatPlace(dock, area, 440, 400), { x: 612, y: 410, width: 440, height: 400 });
});

test("never leaves the work area", () => {
  const dock = { x: 100, y: 300, width: 364, height: 500 };
  const r = chatPlace(dock, area, 440, 400);
  assert.ok(r.x >= area.x && r.y >= area.y && r.y + r.height <= area.y + area.height);
});

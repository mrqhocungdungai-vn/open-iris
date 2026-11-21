import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, MAX_TURNS } from "./convo-view.mjs";

const run = (events) => events.reduce(reduce, []);
const you = (delta, via = "voice", files) => ({ type: "TEXT_MESSAGE_CONTENT", role: "user", via, delta, ...(files && { files }) });
const iris = (delta) => ({ type: "TEXT_MESSAGE_CONTENT", role: "assistant", via: "voice", delta });
const start = (id, name = "click", source = "desktop") => ({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, source });

test("chunks of one speaker glue into one turn", () => {
  const t = run([you("mở"), you(" Finder"), iris("Đã"), iris(" mở.")]);
  assert.deepEqual(t.map((x) => [x.kind, x.text]), [["you", "mở Finder"], ["iris", "Đã mở."]]);
});

test("a tool call opens the Iris turn, so tools sit above the words", () => {
  const t = run([you("mở Safari"), start("a", "open_app"), iris("Xong.")]);
  assert.equal(t.length, 2);
  assert.deepEqual(t[1].tools.map((x) => [x.name, x.state, x.source]), [["open_app", "run", "desktop"]]);
  assert.equal(t[1].text, "Xong.");
});

test("a result updates its call by id; an unknown id changes nothing", () => {
  let t = run([start("a"), start("b", "type_text"), { type: "TOOL_CALL_RESULT", toolCallId: "b", ok: false, ms: 1200, error: "no field" }]);
  assert.deepEqual(t[0].tools.map((x) => [x.state, x.ms, x.error]), [["run", 0, ""], ["fail", 1200, "no field"]]);
  const same = reduce(t, { type: "TOOL_CALL_RESULT", toolCallId: "zzz", ok: true, ms: 1 });
  assert.equal(same, t);
  t = reduce(t, { type: "TOOL_CALL_RESULT", toolCallId: "a", ok: true, ms: 80 });
  assert.equal(t[0].tools[0].state, "ok");
});

test("a result still finds its call after the user spoke in between", () => {
  const t = run([start("a"), you("à mà"), { type: "TOOL_CALL_RESULT", toolCallId: "a", ok: true, ms: 5 }]);
  assert.equal(t[0].tools[0].state, "ok");
});

test("RUN_FINISHED closes the turn; interrupted is kept; the next words start a new turn", () => {
  const t = run([iris("Để tôi"), { type: "RUN_FINISHED", interrupted: true }, iris("Vâng.")]);
  assert.deepEqual(t.map((x) => [x.text, x.done, x.interrupted]), [["Để tôi", true, true], ["Vâng.", false, false]]);
});

test("typed turns never glue and carry their files", () => {
  const files = [{ name: "a.png", kind: "image" }];
  const t = run([you("xem ảnh", "typed", files), you("nữa", "typed")]);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { kind: "you", via: "typed", text: "xem ảnh", files });
  assert.deepEqual(t[1].files, []);
});

test("errors and session ends are their own rows; a session end closes the open Iris turn", () => {
  const t = run([iris("Đang"), { type: "RUN_ERROR", message: "ws error" }, iris("x"), { type: "CUSTOM", name: "session", value: { phase: "closed", code: 1011, reason: "internal" } }]);
  assert.deepEqual(t.map((x) => x.kind), ["iris", "error", "iris", "session"]);
  assert.equal(t[2].done, true);
  assert.deepEqual(t[3], { kind: "session", phase: "closed", code: 1011, reason: "internal" });
});

test("keeps at most MAX_TURNS turns, and never mutates the input", () => {
  let t = [];
  for (let i = 0; i < MAX_TURNS + 5; i++) t = reduce(t, you(String(i), "typed"));
  assert.equal(t.length, MAX_TURNS);
  assert.equal(t[0].text, "5");
  const before = Object.freeze([Object.freeze({ kind: "you", via: "voice", text: "a", files: [] })]);
  assert.doesNotThrow(() => reduce(before, you("b")));
});

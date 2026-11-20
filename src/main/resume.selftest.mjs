import { test } from "node:test";
import assert from "node:assert/strict";
import { createResumer, freshSession, resumeNote } from "./resume.mjs";

// Fake clock and fake connect: each connect records the handle it was given and returns a closable session.
function rig({ fail = () => false } = {}) {
  const timers = [], calls = [], gaveUp = [], back = [];
  const connect = async (handle) => {
    calls.push(handle);
    if (fail(calls.length)) throw new Error("network down");
    return { closed: false, close() { this.closed = true; } };
  };
  const r = createResumer({
    connect, onGiveUp: (c) => gaveUp.push(c), onReconnect: (s, h) => back.push(h),
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const tick = async () => { const t = timers.shift(); t.fn(); await new Promise((res) => setImmediate(res)); return t.ms; };
  return { r, timers, calls, gaveUp, back, tick };
}
const drop = { code: 1006, reason: "" };

test("an update with resumable:false keeps the last handle", async () => {
  const { r } = rig();
  await r.start();
  r.update({ newHandle: "h1", resumable: true });
  r.update({ newHandle: "h2", resumable: false });
  assert.equal(r.handle, "h1");
});

test("a drop reconnects with the newest handle", async () => {
  const { r, calls, back, tick } = rig();
  await r.start();
  assert.deepEqual(back, [], "the first connect is not a reconnect");
  r.update({ newHandle: "h1", resumable: true });
  r.update({ newHandle: "h2", resumable: true });
  r.closed(drop);
  assert.equal(await tick(), 500);
  assert.deepEqual(calls, [null, "h2"]);
  assert.deepEqual(back, ["h2"], "onReconnect gets the handle it resumed with");
});

test("backoff doubles, the handle is dropped from attempt 3, and give-up fires once after 5", async () => {
  const { r, calls, gaveUp, tick } = rig({ fail: (n) => n > 1 });
  await r.start();
  r.update({ newHandle: "h1", resumable: true });
  r.closed(drop);
  const delays = [];
  for (let i = 0; i < 5; i++) delays.push(await tick());
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000]);
  assert.deepEqual(calls, [null, "h1", "h1", null, null, null]);
  assert.equal(gaveUp.length, 1);
  assert.equal(r.live, false);
  r.closed(drop);
  assert.equal(gaveUp.length, 1, "no second give-up");
});

test("stop while waiting cancels the reconnect", async () => {
  const { r, timers, calls } = rig();
  await r.start();
  r.closed(drop);
  r.stop();
  assert.equal(timers.length, 0);
  assert.deepEqual(calls, [null]);
  r.closed(drop);
  assert.equal(timers.length, 0, "a close after stop does nothing");
});

test("a connect that lands after stop is closed", async () => {
  let release;
  const s = { closed: false, close() { this.closed = true; } };
  const r = createResumer({ connect: () => new Promise((res) => (release = () => res(s))) });
  const p = r.start();
  r.stop();
  release();
  assert.equal(await p, null);
  assert.ok(s.closed);
});

test("a bad key or quota error is not retried", async () => {
  for (const c of [{ code: 1007, reason: "API key not valid. Please pass a valid API key." }, { code: 1011, reason: "Resource has been exhausted (e.g. check quota)." }]) {
    const { r, timers, gaveUp } = rig();
    await r.start();
    r.closed(c);
    assert.equal(timers.length, 0);
    assert.equal(gaveUp.length, 1);
  }
});

test("a stale handle (1008 session not found) is dropped at once", async () => {
  const { r, calls, tick } = rig();
  await r.start();
  r.update({ newHandle: "old", resumable: true });
  r.closed({ code: 1008, reason: "BidiGenerateContent session not found" });
  await tick();
  assert.deepEqual(calls, [null, null]);
});

test("the 58 min cap (1011 deadline expired) reconnects fresh, not with the handle", async () => {
  const { r, calls, gaveUp, tick } = rig();
  await r.start();
  r.update({ newHandle: "h1", resumable: true });
  r.closed({ code: 1011, reason: "Deadline expired before operation could complete." });
  assert.equal(await tick(), 500);
  assert.deepEqual(calls, [null, null]);
  assert.equal(gaveUp.length, 0);
});

test("1007 invalid argument (rejected resume) is not a bad key: it drops the handle and retries", async () => {
  const { r, calls, gaveUp, tick } = rig();
  await r.start();
  r.update({ newHandle: "h1", resumable: true });
  r.closed({ code: 1007, reason: "Request contains an invalid argument." });
  await tick();
  assert.deepEqual(calls, [null, null]);
  assert.equal(gaveUp.length, 0);
});

test("1007 on a fresh connection (setup error) is not retried", async () => {
  const { r, timers, gaveUp } = rig();
  await r.start();
  r.closed({ code: 1007, reason: "Thinking level must be specified for this model." });
  assert.equal(timers.length, 0);
  assert.equal(gaveUp.length, 1);
});

test("1008 client inactivity is a normal drop: the handle is kept", async () => {
  const { r, calls, tick } = rig();
  await r.start();
  r.update({ newHandle: "h1", resumable: true });
  r.closed({ code: 1008, reason: "Session closed due to client inactivity." });
  await tick();
  assert.deepEqual(calls, [null, "h1"]);
});

test("a fresh handle resets the attempt count", async () => {
  const { r, tick } = rig();
  await r.start();
  r.closed(drop); await tick();
  r.closed(drop); assert.equal(await tick(), 1000);
  r.update({ newHandle: "h3", resumable: true });
  r.closed(drop); assert.equal(await tick(), 500);
});

test("freshSession (↺ Làm mới) closes the old session and connects with no handle, not as a reconnect", async () => {
  const { r, calls, back, timers } = rig();
  const old = await r.start();
  r.update({ newHandle: "h1", resumable: true });
  r.closed(drop); // a reconnect was pending
  const s = await freshSession(r, old);
  assert.ok(old.closed);
  assert.ok(s && !s.closed);
  assert.deepEqual(calls, [null, null]);
  assert.deepEqual(back, [], "no resume note: it is a new session");
  assert.equal(timers.length, 0, "the pending reconnect is cancelled");
  assert.equal(r.live, true);
});

test("freshSession: a Stop during the new connect closes it when it lands", async () => {
  let release;
  const late = { closed: false, close() { this.closed = true; } };
  const r = createResumer({ connect: () => new Promise((res) => (release = () => res(late))) });
  const p = freshSession(r, null);
  r.stop();
  release();
  assert.equal(await p, null);
  assert.ok(late.closed);
});

test("resumeNote says what history cannot", () => {
  assert.equal(resumeNote({ handle: "h" }), "[session] The connection dropped and was restored; the conversation continues.");
  const n = resumeNote({ handle: null, lost: ["click"], listenOnly: true, looking: "/a.png" });
  assert.match(n, /new session/);
  assert.match(n, /click were cut off/);
  assert.match(n, /Listen mode is still ON/);
  assert.match(n, /\/a\.png/);
});

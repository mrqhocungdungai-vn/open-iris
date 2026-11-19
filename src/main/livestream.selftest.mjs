// node livestream.selftest.mjs — Livestream feature (livestream.mjs): topic cleaning, the co-host brief,
// the recap timer (waits for 4 s of quiet, never skips) and refusing tool calls in listen-only mode.
import assert from "node:assert/strict";
import { liveSetup } from "./live-config.mjs";
import { cleanTopic, cohostBrief, createRecap, QUIET_MS, RECAP_MS, refuseCalls, TOPIC_MAX } from "./livestream.mjs";

// Topic: one line, trimmed, capped; anything that is not a string is "".
assert.equal(cleanTopic("  Dựng app\n Electron  "), "Dựng app Electron");
assert.equal(cleanTopic("x".repeat(500)).length, TOPIC_MAX);
assert.equal(cleanTopic(42), "");
assert.equal(cleanTopic(undefined), "");

// Brief: topic or "infer it"; the recap rule only with recap on; it lands in the system instruction.
assert.match(cohostBrief("Gemini Live", true), /Today's livestream topic: Gemini Live\./);
assert.match(cohostBrief("", false), /infer it/);
assert.match(cohostBrief("t", true), /SYSTEM_EVENT_RECAP/);
assert.doesNotMatch(cohostBrief("t", false), /SYSTEM_EVENT_RECAP/);
assert.doesNotMatch(cohostBrief("t", true), /Jarvis/); // dropped on purpose (user, 2026-11-19)
const text = liveSetup("vi", [], cohostBrief("t", true)).systemInstruction.parts[0].text;
assert.match(text, /Always speak Vietnamese/);
assert.match(text, /Livestream mode/);

// Recap timer with a fake clock: nothing before 5 min, waits while people talk, then fires once.
let t = 0;
let tick = null;
let sent = 0;
const recap = createRecap({ send: () => sent++, now: () => t, setInterval: (fn) => (tick = fn), clearInterval: () => (tick = null) });
recap.start();
assert.ok(tick);
t = RECAP_MS - 1;
tick();
assert.equal(sent, 0);
t = RECAP_MS + 1000;
recap.markActivity(); // someone just spoke
tick();
assert.equal(sent, 0);
t += QUIET_MS - 1;
tick();
assert.equal(sent, 0);
t += 1;
tick();
assert.equal(sent, 1);
tick(); // the next one waits a full interval again
assert.equal(sent, 1);
t += RECAP_MS;
tick();
assert.equal(sent, 2);
// stop clears the tick; start resets the clock.
recap.stop();
assert.equal(tick, null);
recap.start();
t += RECAP_MS - 1;
tick();
assert.equal(sent, 2);

// Listen-only: every call refused, ids kept.
assert.deepEqual(refuseCalls([{ id: "a", name: "click", args: {} }]), [{ id: "a", name: "click", response: { error: "Refused: listen mode is on." } }]);

console.log("livestream selftest ok");

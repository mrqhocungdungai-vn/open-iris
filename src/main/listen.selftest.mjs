// node listen.selftest.mjs — listen-only mode (listen.mjs): notices and refusing tool calls.
import assert from "node:assert/strict";
import { LISTEN_OFF_EVENT, LISTEN_ON_EVENT, refuseCalls, silentNote } from "./listen.mjs";

assert.match(LISTEN_ON_EVENT, /^SYSTEM_EVENT_LISTEN_ON:/);
assert.match(LISTEN_OFF_EVENT, /^SYSTEM_EVENT_LISTEN_OFF:/);
// Iris only learns the state: the announcement clip tells the user, so neither asks Iris to speak, and no turn is opened.
for (const e of [LISTEN_ON_EVENT, LISTEN_OFF_EVENT]) assert.doesNotMatch(e, /Tell the user/);
assert.deepEqual(silentNote("x"), { turns: [{ role: "user", parts: [{ text: "x" }] }], turnComplete: false });
// Every call refused, ids kept.
assert.deepEqual(refuseCalls([{ id: "a", name: "click", args: {} }, { id: "b", name: "x" }]), [
  { id: "a", name: "click", response: { error: "Refused: listen mode is on." } },
  { id: "b", name: "x", response: { error: "Refused: listen mode is on." } },
]);

console.log("listen selftest ok");

// node listen.selftest.mjs — listen-only mode (listen.mjs): notices and refusing tool calls.
import assert from "node:assert/strict";
import { LISTEN_OFF_EVENT, LISTEN_ON_EVENT, refuseCalls } from "./listen.mjs";

assert.match(LISTEN_ON_EVENT, /^SYSTEM_EVENT_LISTEN_ON:/);
assert.match(LISTEN_OFF_EVENT, /^SYSTEM_EVENT_LISTEN_OFF:/);
// Both ask Iris to say the new state aloud.
for (const e of [LISTEN_ON_EVENT, LISTEN_OFF_EVENT]) assert.match(e, /Tell the user in one short sentence/);
// Every call refused, ids kept.
assert.deepEqual(refuseCalls([{ id: "a", name: "click", args: {} }, { id: "b", name: "x" }]), [
  { id: "a", name: "click", response: { error: "Refused: listen mode is on." } },
  { id: "b", name: "x", response: { error: "Refused: listen mode is on." } },
]);

console.log("listen selftest ok");

// node live-config.selftest.mjs — keyFormatOk accepts both Gemini key styles and rejects junk. Keys below are fake.
import assert from "node:assert/strict";
import { keyFormatOk } from "./live-config.mjs";

assert.ok(keyFormatOk("AIzaSyFAKEfake0000000000000000000_-abcd"), "classic AIza key");
assert.ok(keyFormatOk("AQ.FakeFakeFake0000000000000000000000000"), "newer AQ. key with a dot");
assert.ok(!keyFormatOk("short"), "too short");
assert.ok(!keyFormatOk("AIza key with spaces 1234567890"), "spaces");
assert.ok(!keyFormatOk("x".repeat(201)), "too long");

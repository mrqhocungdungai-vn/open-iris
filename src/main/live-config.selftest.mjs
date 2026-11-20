// node live-config.selftest.mjs — keyFormatOk accepts both Gemini key styles and rejects junk; the instruction has no coding text. Keys below are fake.
import assert from "node:assert/strict";
import { desktopTools } from "./desktop.mjs";
import { keyFormatOk, liveSetup } from "./live-config.mjs";

assert.ok(keyFormatOk("AIzaSyFAKEfake0000000000000000000_-abcd"), "classic AIza key");
assert.ok(keyFormatOk("AQ.FakeFakeFake0000000000000000000000000"), "newer AQ. key with a dot");
assert.ok(!keyFormatOk("short"), "too short");
assert.ok(!keyFormatOk("AIza key with spaces 1234567890"), "spaces");
assert.ok(!keyFormatOk("x".repeat(201)), "too long");

// With every desktop tool on, the instruction has no coding-tool text but keeps the terminal and [gallery] rules.
const text = liveSetup("vi", desktopTools()).systemInstruction.parts[0].text;
assert.ok(!text.includes("coding_task"), "no coding_task");
assert.ok(text.includes(" Never use the app tools to read a terminal window."), "terminal sentence");
assert.ok(text.includes("A message starting with [gallery] is silent context"), "[gallery] sentence");
assert.ok(!text.includes("Claude Code"), "no Claude Code");

// hud.mjs runs in Electron main: a loader hook swaps in stubs for electron and child_process (no swiftc, no ps, no helper).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const electron = `
export const handlers = {};
const noop = () => {};
export const ipcMain = { on: (c, f) => (handlers[c] = f), handle: (c, f) => (handlers[c] = f) };
export const app = { whenReady: () => new Promise(noop), on: noop, getAppMetrics: () => [], isPackaged: false };
export const BrowserWindow = { getAllWindows: () => [] };
export const globalShortcut = {}, Menu = {}, screen = {}, shell = {}, systemPreferences = {}, Tray = {};`;
const child = `
const ev = { on() {} };
export const execFileSync = () => "1 stub";
export const spawn = () => ({ on() {}, stdout: ev, stdin: { on() {}, writable: false } });`;
const url = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
register(url(`
export async function resolve(spec, ctx, next) {
  if (spec === "electron") return { url: ${JSON.stringify(url(electron))}, shortCircuit: true };
  if (spec === "node:child_process" && ctx.parentURL?.endsWith("/hud.mjs")) return { url: ${JSON.stringify(url(child))}, shortCircuit: true };
  return next(spec, ctx);
}`));

const { handlers } = await import("electron");
const { initGesture } = await import("./hud.mjs");
const events = [];
initGesture(() => {}, fs.mkdtempSync(path.join(os.tmpdir(), "hud-test-")), (event, on) => events.push(`${event}:${on}`));
after(() => handlers.vision(null, false)); // stops the [perf] cpu timer even when an assert fails, so the run exits
const step = (channel, on, quiet) => { events.length = 0; handlers[channel](null, on, quiet); return [...events]; };

test("vision and control announce only real changes, vision off alone when it also drops control", () => {
  assert.deepEqual(step("vision", true), ["vision:true"]); // control was already off: no control event
  assert.deepEqual(step("vision", true), []); // unchanged
  assert.deepEqual(step("control:set", true), ["control:true"]);
  assert.deepEqual(step("control:set", true), []);
  assert.deepEqual(step("control:set", false), ["control:false"]);
  step("control:set", true);
  assert.deepEqual(step("vision", false), ["vision:false"]); // not also control:false
  assert.deepEqual(step("vision", false), []);
});

test("a quiet vision change (launch auto-start, page-load reset) announces nothing", () => {
  assert.deepEqual(step("vision", true, true), []);
  assert.deepEqual(step("vision", false, true), []);
  assert.deepEqual(step("vision", true), ["vision:true"]); // a user switch still announces
  assert.deepEqual(step("vision", false), ["vision:false"]);
});

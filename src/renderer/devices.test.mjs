import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanDevice, deviceChoices, deviceConstraint, openVideo } from "./devices.js";

const vi = (v) => v;
const en = (_v, e) => e;
const devices = [
  { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
  { kind: "audioinput", deviceId: "m1", label: "MacBook Pro Microphone" },
  { kind: "audioinput", deviceId: "m2", label: "" },
  { kind: "videoinput", deviceId: "c1", label: "FaceTime HD Camera" },
  { kind: "audiooutput", deviceId: "o1", label: "Speakers" },
];

test("deviceChoices: default first, the pseudo 'default' device dropped, kinds kept apart", () => {
  assert.deepEqual(deviceChoices(devices, "audioinput", null, vi), [
    { value: "", label: "Mặc định hệ thống" },
    { value: "m1", label: "MacBook Pro Microphone" },
    { value: "m2", label: "Micro 2" }, // no label before permission
  ]);
  assert.deepEqual(deviceChoices(devices, "videoinput", null, en).map((o) => o.value), ["", "c1"]);
});

test("deviceChoices: an unplugged saved device stays listed by name", () => {
  const opts = deviceChoices(devices, "videoinput", { id: "gone", label: "Logitech C920" }, vi);
  assert.deepEqual(opts.at(-1), { value: "gone", label: "Logitech C920 (không kết nối)" });
  assert.equal(deviceChoices(devices, "videoinput", { id: "c1", label: "FaceTime HD Camera" }, vi).length, 2); // plugged in: no extra row
});

test("cleanDevice: keeps { id, label }, anything else is the system default", () => {
  assert.deepEqual(cleanDevice({ id: "m1", label: "Mic", extra: 1 }), { id: "m1", label: "Mic" });
  assert.deepEqual(cleanDevice({ id: "m2", label: "" }), { id: "m2", label: "" });
  for (const bad of [null, undefined, "m1", { id: "" , label: "x" }, { id: 5, label: "x" }, { id: "m1" }, { id: "x".repeat(301), label: "x" }])
    assert.equal(cleanDevice(bad), null);
});

test("deviceConstraint: plain (ideal) deviceId, nothing for the default", () => {
  assert.deepEqual(deviceConstraint({ id: "c1", label: "" }), { deviceId: "c1" });
  assert.deepEqual(deviceConstraint(null), {});
});

test("openVideo: exact deviceId for a pick, default for none, default again only when the pick is gone", async () => {
  const calls = [];
  const media = (fail) => ({ getUserMedia: async (c) => { calls.push(c.video); if (fail && c.video.deviceId) throw Object.assign(new Error("x"), { name: fail }); return "stream"; } });
  const base = { width: 640, height: 480 };
  assert.equal(await openVideo(base, { id: "c615", label: "C615" }, media()), "stream");
  assert.deepEqual(calls.pop(), { ...base, deviceId: { exact: "c615" } });
  await openVideo(base, null, media());
  assert.deepEqual(calls.pop(), base);
  const warn = console.warn; console.warn = () => {};
  try {
    for (const name of ["OverconstrainedError", "NotFoundError"]) {
      calls.length = 0;
      assert.equal(await openVideo(base, { id: "gone", label: "C615" }, media(name)), "stream");
      assert.deepEqual(calls, [{ ...base, deviceId: { exact: "gone" } }, base]);
    }
    await assert.rejects(openVideo(base, { id: "c615", label: "C615" }, media("NotAllowedError")), { name: "NotAllowedError" });
  } finally { console.warn = warn; }
});

test("importing in a page without the pickers (the HUD) does not throw", async () => {
  globalThis.document = { getElementById: () => null };
  try {
    const m = await import("./devices.js?hud");
    assert.deepEqual(m.deviceConstraint({ id: "x", label: "" }), { deviceId: "x" });
  } finally {
    delete globalThis.document;
  }
});

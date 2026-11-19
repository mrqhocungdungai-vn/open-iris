import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanDevice, deviceChoices, deviceConstraint } from "./devices.js";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { rendererLevel } from "./logs.js";

test("MediaPipe telemetry blocked by CSP logs at DEBUG", () => {
  const csp = "Connecting to 'https://odml.pa.googleapis.com/v1/log' violates the following Content Security Policy directive";
  const fetch = "Fetch API cannot load https://odml.pa.googleapis.com/v1/log. Refused to connect";
  assert.equal(rendererLevel("error", csp), "DEBUG");
  assert.equal(rendererLevel("error", fetch), "DEBUG");
});

test("other renderer lines keep their level", () => {
  assert.equal(rendererLevel("error", "hand vision failed: x"), "ERROR");
  assert.equal(rendererLevel("warning", "w"), "WARN");
  assert.equal(rendererLevel("info", "i"), "INFO");
  assert.equal(rendererLevel("nope", "?"), "INFO");
});

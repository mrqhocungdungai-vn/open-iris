import { test } from "node:test";
import assert from "node:assert/strict";
import { ctxView } from "./ctx-view.mjs";

test("the meter shows used / window, a mark at trimAt and the trim sentence", () => {
  const v = ctxView({ used: 52000, max: 131072, trimAt: 104857 });
  assert.equal(v.text, "ctx 52k / 131k");
  assert.equal(v.fill, "39.7%");
  assert.equal(v.mark, "80.0%");
  assert.equal(v.near, false);
  assert.equal(v.title, "Context của Iris: 52.000 / 131.072 token. Tới vạch (≈105k), Iris quên bớt phần đầu cuộc trò chuyện.");
  assert.match(ctxView({ used: 1, max: 131072, trimAt: 104857 }, "en").title, /^Iris's context: 1 \/ 131.072 tokens\. At the mark/);
});

test("near the mark from 90% of trimAt; keep off = no mark, no trim sentence; null hides", () => {
  assert.equal(ctxView({ used: 94372, max: 131072, trimAt: 104857 }).near, true);
  assert.equal(ctxView({ used: 94370, max: 131072, trimAt: 104857 }).near, false);
  const off = ctxView({ used: 120000, max: 131072, trimAt: null });
  assert.equal(off.mark, null);
  assert.equal(off.near, false);
  assert.doesNotMatch(off.title, /vạch/);
  assert.equal(ctxView({ used: 200000, max: 131072, trimAt: null }).fill, "100.0%");
  assert.equal(ctxView(null), null);
});

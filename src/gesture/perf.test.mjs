import { test } from "node:test";
import assert from "node:assert/strict";
import { handPerfLine } from "./perf.js";

test("handPerfLine reports fps, percentiles and jitter in px", () => {
  const w = { cam: 300, ticks: 290, dup: 4, detect: [5, 6, 7, 8, 20], lat: [10, 12, 14, 16, 40], cur: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }], raw: [{ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.5 }] };
  const line = handPerfLine(w, 10, 1000, "capture");
  assert.match(line, /cam=30\.0fps detect=29\.0fps sameFrame=4/);
  assert.match(line, /detectMs p50=7\.0 p95=20\.0/);
  assert.match(line, /lat\(capture\) p50=14\.0 p95=40\.0ms/);
  assert.match(line, /jitter cursor=0\.0px raw=5\.0px n=2/); // sd of {0.5, 0.51} = 0.005 × 1000 px
});

test("handPerfLine with an empty window prints dashes, not NaN", () => {
  const line = handPerfLine({ cam: 0, ticks: 0, dup: 0, detect: [], lat: [], cur: [], raw: [] }, 5, 1000, "present");
  assert.doesNotMatch(line, /NaN/);
});

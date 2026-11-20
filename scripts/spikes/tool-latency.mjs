// Spike: V2 baseline, how long the read-only desktop tools take (docs/optimize-plan.md §1). No Gemini, no quota.
// Run: node scripts/spikes/tool-latency.mjs [runs=20]
import { desktopTools } from "../../src/main/desktop.mjs";
import { pct } from "../../src/main/perf.mjs";
const N = Number(process.argv[2] || 20);
const fresh = () => Object.fromEntries(desktopTools().map((t) => [t.name, t])); // new per run: the LOOP guard blocks a 4th identical call
const CASES = [["list_running_apps", {}], ["scan_app_controls", { app: "Calculator" }], ["find_app_control", { app: "Calculator", role: "button" }], ["read_app_text", { app: "Calculator" }]];
for (const [name, args] of CASES) {
  const ms = [];
  let ok = 0, err = "";
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await fresh()[name].run(args);
    ms.push(Math.round(performance.now() - t));
    if (r.ok) ok++; else err = JSON.stringify(r.error).slice(0, 160);
  }
  console.log(JSON.stringify({ name, first: ms[0], p50: pct(ms.slice(1), 50), p95: pct(ms.slice(1), 95), ok: `${ok}/${N}`, ...(err && { err }) }));
}

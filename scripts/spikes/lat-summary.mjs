// p50/p95 per model and metric from live-latency.mjs output. Run: node scripts/spikes/lat-summary.mjs <lat.jsonl>
import { readFileSync } from "node:fs";
import { pct } from "../../src/main/perf.mjs";
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const by = {};
const cut = {};
for (const r of rows) {
  const k = r.model + (r.vad ? ` [${r.vad}]` : "");
  if (r.pause) { const c = ((cut[k] ??= {})[r.pause] ??= { n: 0, cutoff: 0, timeout: 0 }); c.n++; c.cutoff += r.cutoff ? 1 : 0; c.timeout += r.timeout ? 1 : 0; continue; } // pause turns: counted, not in V1
  if (r.model && r.ms != null && ["V1", "V3", "connectResolved"].includes(r.ev)) ((by[k] ??= {})[r.ev] ??= []).push(r.ms);
}
for (const [m, evs] of Object.entries(by)) for (const [ev, v] of Object.entries(evs)) console.log(`${m.replace("models/", "")} ${ev} n=${v.length} p50=${pct(v, 50)} p95=${pct(v, 95)} max=${Math.max(...v)}`);
for (const [k, ps] of Object.entries(cut)) for (const [ms, c] of Object.entries(ps)) console.log(`${k.replace("models/", "")} pause=${ms}ms cutoff ${c.cutoff}/${c.n} timeout ${c.timeout}`);
const bad = rows.filter((r) => r.ev === "error" || r.timeout);
if (bad.length) console.log("errors/timeouts:", JSON.stringify(bad.map((r) => ({ m: r.model, ev: r.ev, msg: r.msg }))));

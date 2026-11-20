// Spike: which Live models accept which thinkingConfig, and the exact close code/reason when refused. Costs quota; not in `pnpm test`.
// Run: node scripts/spikes/think-probe.mjs <out.jsonl>. Reads the key from ~/.open-iris/.env, never prints it.
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { liveSetup } from "../../src/main/live-config.mjs";
import { desktopTools } from "../../src/main/desktop.mjs";

const key = readFileSync(join(homedir(), ".open-iris", ".env"), "utf8").match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
const out = process.argv[2];
const MODELS = ["models/gemini-3.8-live", "models/gemini-3.8-live-extended-thinking", "models/gemini-3.1-flash-live-preview"];
const CFGS = { none: undefined, MINIMAL: { thinkingLevel: "MINIMAL" }, LOW: { thinkingLevel: "LOW" }, MEDIUM: { thinkingLevel: "MEDIUM" }, HIGH: { thinkingLevel: "HIGH" },
  UNSPECIFIED: { thinkingLevel: "THINKING_LEVEL_UNSPECIFIED" }, bogus: { thinkingLevel: "ULTRA" }, budget0: { thinkingBudget: 0 }, budget1024: { thinkingBudget: 1024 } };

function probe(model, cfgName) {
  const base = liveSetup("en", desktopTools(), "", { model });
  delete base.thinkingConfig;
  const config = { responseModalities: ["AUDIO"], outputAudioTranscription: {}, ...base, ...(CFGS[cfgName] && { thinkingConfig: CFGS[cfgName] }) };
  const t0 = performance.now(), r = { model, cfg: cfgName };
  return new Promise((res) => {
    let s, timer;
    const end = (extra) => { clearTimeout(timer); Object.assign(r, extra); try { s?.close(); } catch {} res(r); };
    new GoogleGenAI({ apiKey: key }).live.connect({ model, config, callbacks: {
      onmessage: (m) => {
        if (m.setupComplete) { r.setupMs = Math.round(performance.now() - t0); setTimeout(() => s.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Say OK." }] }] }), 100); }
        if (m.serverContent?.modelTurn?.parts?.some((p) => p.inlineData)) r.audio = true;
        if (m.serverContent?.turnComplete) end({ ok: true });
      },
      onerror: (e) => (r.error = String(e?.message || e)),
      onclose: (e) => { if (!("ok" in r)) end({ ok: false, code: e.code, reason: e.reason }); },
    } }).then((x) => (s = x), (e) => end({ ok: false, connectError: String(e?.message || e) }));
    timer = setTimeout(() => end({ ok: false, timeout: true }), 20000);
  });
}

for (const model of MODELS) for (const c of Object.keys(CFGS)) {
  const r = await probe(model, c);
  appendFileSync(out, JSON.stringify(r) + "\n");
  console.log(model.replace("models/", ""), c, r.ok ? "OK" : `FAIL ${r.code ?? ""} ${r.reason ?? r.connectError ?? (r.timeout ? "timeout" : "")}`);
}
for (const m of ["models/gemini-does-not-exist-live"]) { const r = await probe(m, "none"); appendFileSync(out, JSON.stringify(r) + "\n"); console.log(m, r.ok ? "OK" : `FAIL ${r.code} ${r.reason ?? r.connectError}`); }

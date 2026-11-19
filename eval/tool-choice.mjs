// Tool-choice eval: does Gemini Live pick the right first tool for a spoken request?
// Each case gets a fresh session with the app's real instruction and tools, one text turn, and nothing is run.
// node eval/tool-choice.mjs [--runs 3] [--model models/gemini-3.8-live] [--only name,name] [--case 5]
// Needs GEMINI_API_KEY (~/.open-iris/.env). Costs one short Live session per case per run.
import { GoogleGenAI } from "@google/genai";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { desktopTools } from "../src/main/desktop.mjs";
import { liveSetup } from "../src/main/live-config.mjs";
import { registry, TOOL_DEFAULTS } from "../src/main/tools.mjs";

// expect: tools that are a right first call; [] means the right answer is to speak, not call a tool.
// Opening the named app first is fine: it gets a fake ok and the call after it is scored.
// shortcut: two steps at most; feed realistic results back if longer plans need checking.
const CASES = [
  { say: "Mở Notes giúp mình", expect: ["open_or_focus_app"] },
  { say: "Máy mình đang mở những ứng dụng nào?", expect: ["list_running_apps"] },
  { say: "Trong Notes, viết thêm dòng 'mua sữa' vào ghi chú đang mở", expect: ["find_app_control"] },
  { say: "Đọc cho mình tin nhắn cuối cùng trong Teams", expect: ["read_app_text"] },
  { say: "Trong Teams bấm nút Gửi đi", expect: ["find_app_control", "scan_app_controls"] },
  { say: "Trong Telegram gõ Hello World vào ô chat", expect: ["find_app_control"] }, // log 2026-11-19: Iris gave up on Telegram typing
  { say: "Trong Pages chọn cỡ chữ 14 ở ô cỡ chữ", expect: ["find_app_control"] },
  { say: "Nhấn cmd n trong Notes để tạo ghi chú mới", expect: ["press_key_combo"] },
  { say: "Safari đang hiện những nút gì?", expect: ["scan_app_controls", "read_app_text"] },
  { say: "Tìm hiểu giúp mình giá vàng hôm nay", expect: ["open_or_focus_app", "list_running_apps", []] }, // the brief says ask which app when unsure
  { say: "Sửa lỗi trong file main.mjs của repo open-iris, app không khởi động được", expect: ["start_coding_task"] },
  { say: "Chạy pnpm test trong terminal rồi báo kết quả", expect: ["start_coding_task"] },
  { say: "Đọc màn hình terminal cho mình", expect: ["start_coding_task", []] },
  { say: "Việc lập trình lúc nãy xong chưa?", expect: ["check_coding_task_status"] },
  { say: "Lúc trước mình đã làm tới đâu trong dự án rồi?", expect: ["recall_past_coding_tasks"] },
  { say: "Nhắc lại kết quả lập trình vừa rồi", expect: ["repeat_coding_task_result"] },
  { say: "Dừng việc đang code lại", expect: [[]] }, // must ask first
  { say: "Kéo file ảnh trên desktop vào thùng rác", expect: [[]] }, // drag: hand it to the user
  { say: "Chào Iris, hôm nay bạn khỏe không?", expect: [[]] },
];

const { values: opt } = parseArgs({ options: { runs: { type: "string", default: "1" }, model: { type: "string", default: "models/gemini-3.8-live" }, only: { type: "string" }, case: { type: "string" } } });
try { process.loadEnvFile(path.join(os.homedir(), ".open-iris/.env")); } catch { /* real env */ }
const only = opt.only?.split(",");
// Same set main.mjs builds when every switch is at its default, except the coding tools are all on here.
const enabled = [...desktopTools(), ...registry()].filter((t) => (only ? only.includes(t.name) : t.name in TOOL_DEFAULTS));
const setup = liveSetup("vi", enabled);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// One session, one turn: resolves with the first tool calls, or [] when the model just speaks.
async function firstMove({ say, expect }) {
  let done, opened;
  const result = new Promise((r) => (done = r));
  let spoken = "";
  const s = await ai.live.connect({
    model: opt.model,
    config: { responseModalities: ["AUDIO"], outputAudioTranscription: {}, ...setup },
    callbacks: {
      onmessage: (m) => {
        const fc = m.toolCall?.functionCalls;
        if (fc?.[0]?.name === "open_or_focus_app" && !opened && !expect.includes("open_or_focus_app")) {
          opened = fc[0].args?.app;
          s.sendToolResponse({ functionResponses: fc.map(({ id, name }) => ({ id, name, response: { ok: true, output: { ok: true } } })) });
        } else if (fc) done({ calls: fc.map(({ name, args }) => ({ name, args })), spoken, opened });
        spoken += m.serverContent?.outputTranscription?.text ?? "";
        if (m.serverContent?.turnComplete) done({ calls: [], spoken, opened });
      },
      onerror: (e) => done({ error: String(e?.message || e) }),
      onclose: (e) => done({ error: `closed ${e?.code} ${e?.reason || ""}` }),
    },
  });
  s.sendClientContent({ turns: [{ role: "user", parts: [{ text: say }] }], turnComplete: true });
  const timer = setTimeout(() => done({ error: "timeout 30s" }), 30000);
  const r = await result;
  clearTimeout(timer);
  s.close();
  return r;
}

const ok = (c, r) => !r.error && c.expect.some((e) => (Array.isArray(e) ? r.calls.length === 0 : r.calls[0]?.name === e));
const picked = opt.case ? [CASES[Number(opt.case) - 1]] : CASES;
const runs = Number(opt.runs);
console.log(`model=${opt.model} tools=${enabled.length} cases=${picked.length} runs=${runs}`);
let pass = 0;
for (const [i, c] of picked.entries()) {
  // Runs of one case go in parallel; cases one after another to stay under the Live session limit.
  const rs = await Promise.all(Array.from({ length: runs }, () => firstMove(c)));
  const good = rs.filter((r) => ok(c, r)).length;
  pass += good;
  const got = rs.map((r) => r.error ?? (r.opened ? `open(${r.opened}) → ` : "") + (r.calls.length ? r.calls.map((x) => x.name + JSON.stringify(x.args)).join("+") : `(nói) ${r.spoken.slice(0, 60)}`));
  console.log(`${good === runs ? "✔" : "✘"} ${i + 1}. ${good}/${runs} "${c.say}"\n    ${[...new Set(got)].join("\n    ")}`);
}
console.log(`\n${pass}/${picked.length * runs} đúng (${Math.round((100 * pass) / (picked.length * runs))}%)`);
process.exit(0);

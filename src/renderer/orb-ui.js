// Main-window orb: measures the voices, decides the state, draws the corner orb and feeds the HUD orb.
// The levels come from renderer.js (window.irisMeters: mic and playback AnalyserNodes); the HUD only renders what is sent here.
import { SAMPLE_INTERVAL_MS, levelFromRms, newThinking, orbState, thinkingStep, toolCall } from "./orb-motion.mjs";
import { mountOrb } from "./orb.js";

const $ = (id) => document.getElementById(id);
const orb = mountOrb($("orb-canvas"));

let status = "offline";
let listenOnly = false;
let muted = false;
let hud = false;
let thinking = newThinking();
let shownState = ""; // last state given to the corner orb
let sentState = ""; // and to the HUD orb ("" = send again)

const buf = new Float32Array(2048);
function level(analyser) {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return levelFromRms(Math.sqrt(sum / buf.length));
}

window.iris.getState().then((s) => ((status = s.status), (muted = s.muted), (listenOnly = s.listenOnly)));
window.iris.onStatus((s) => (status = s));
window.iris.onListen((on) => (listenOnly = on));
window.iris.onMute((m) => (muted = m));
window.iris.onEvent((e) => {
  if (e.type === "TOOL_CALL_START" && !listenOnly) thinking = toolCall(thinking, performance.now());
});
window.gesture.onHud((on) => ((hud = on), (sentState = "")));

// setInterval, not requestAnimationFrame: the HUD needs levels while this window is hidden (backgroundThrottling is off).
setInterval(() => {
  const live = status !== "offline" && status !== "connecting";
  const inL = live && !muted ? level(window.irisMeters?.mic) : 0;
  const outL = status === "speaking" ? level(window.irisMeters?.out) : 0;
  // Listen-only: Iris never answers, so a silence is not thinking.
  thinking = live && !listenOnly ? thinkingStep(thinking, { level: inL, speaking: status === "speaking", now: performance.now() }) : newThinking();
  const input = { state: orbState({ status, listenOnly, thinking: thinking.thinking }), inL, outL };
  if (!$("orb-on").checked) return;
  // Every sample while live, otherwise only on a change, so an offline orb's frame loop can stop.
  if (live || input.state !== shownState) orb.set(input);
  if (hud && (live || input.state !== sentState)) window.iris.orb(input);
  shownState = sentState = input.state;
}, SAMPLE_INTERVAL_MS / 2);

// Features › Orb: its own switch, not tied to Start or the HUD. Off hides both orbs.
// shortcut: not saved, starts on at every launch like Gallery View; persist it in config when users ask.
$("orb-on").onchange = () => {
  $("orb").hidden = !$("orb-on").checked;
  window.iris.orbEnabled($("orb-on").checked);
  shownState = sentState = "";
};
window.iris.orbEnabled($("orb-on").checked);

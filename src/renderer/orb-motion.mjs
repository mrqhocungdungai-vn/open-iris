// Orb motion and state, no DOM: orb.js draws, orb-ui.js feeds it. Ported from My-Jarvis ReactorCore / orb-thinking.

export const PALETTES = {
  offline: { c: [120, 128, 140], hi: [205, 210, 218], e: 0.15 },
  listening: { c: [72, 196, 150], hi: [210, 250, 232], e: 0.55 },
  speaking: { c: [47, 143, 224], hi: [214, 236, 255], e: 1.0 },
  thinking: { c: [212, 160, 40], hi: [255, 238, 200], e: 0.7 },
  listenOnly: { c: [150, 138, 205], hi: [228, 222, 248], e: 0.32 },
};

export const approach = (cur, target, k) => cur + (target - cur) * k;
export const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
// Fast attack, slow release: a VU-meter feel, no flicker between words.
export const smoothLevel = (cur, target, dt) => approach(cur, target, 1 - Math.exp(-dt * (target > cur ? 28 : 6)));
// Cheap deterministic 1D value noise, 0..1, for the mic spikes.
export function noise(x) {
  const i = Math.floor(x), f = x - i;
  const h = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}
// AnalyserNode RMS → 0..1. shortcut: one fixed gain tuned on a laptop mic with AGC on, add a per-device gain if a quiet mic never spikes.
export const levelFromRms = (rms) => Math.min(1, Math.max(0, rms * 6));

// Which of the 5 looks to show. connecting looks offline until the session is up.
export function orbState({ status, listenOnly, thinking }) {
  if (status === "offline" || status === "connecting" || !status) return "offline";
  if (listenOnly) return "listenOnly";
  if (status === "speaking") return "speaking";
  return thinking ? "thinking" : "listening";
}

export const newOrb = (state = "offline") => ({ energy: PALETTES[state].e, inL: 0, outL: 0, think: 0, c: [...PALETTES[state].c], hi: [...PALETTES[state].hi], r1: 0, r2: 0, r3: 0 });

// One frame. input = { state, inL, outL, reduce }; dt in seconds.
export function stepOrb(s, { state, inL = 0, outL = 0, reduce = false }, dt) {
  const p = PALETTES[state] ?? PALETTES.offline;
  const k = 1 - Math.exp(-dt * 4);
  s.energy = approach(s.energy, p.e, k);
  s.c = mix(s.c, p.c, k);
  s.hi = mix(s.hi, p.hi, k);
  const inT = state === "offline" ? 0 : inL * (state === "listenOnly" ? 0.5 : 1); // listen-only: Iris never answers, mic at half strength
  const outT = state === "speaking" ? outL : 0;
  s.inL = smoothLevel(s.inL, inT, dt);
  s.outL = smoothLevel(s.outL, outT, dt);
  s.think = approach(s.think, state === "thinking" ? 1 : 0, 1 - Math.exp(-dt * 5));
  const spin = reduce || state === "offline" ? 0 : 1;
  s.r1 += dt * spin * (0.5 + s.energy * 0.6 + s.inL * 2.2);
  s.r2 += dt * spin * (0.3 + s.energy * 0.4 + s.outL * 0.6);
  s.r3 += dt * spin * 0.12;
  return s;
}

// True once the orb looks like its palette and both levels have died down: the frame loop may stop.
export function settled(s, state) {
  const p = PALETTES[state] ?? PALETTES.offline;
  return Math.abs(s.energy - p.e) < 0.003 && s.inL < 0.003 && s.outL < 0.003 && s.think < 0.003 && s.c.every((v, i) => Math.abs(v - p.c[i]) < 0.5);
}

// Thinking: the user stopped talking and Iris has not answered yet, from the mic level alone (My-Jarvis orb-thinking.ts).
export const TALKING_LEVEL = 0.13; // above this the user is speaking
export const SILENCE_MS = 420; // shorter and a pause mid-sentence reads as a finished question
export const THINKING_TIMEOUT_MS = 6000; // a model that never answers must not leave the orb thinking forever
export const SAMPLE_INTERVAL_MS = 120;
export const newThinking = () => ({ talking: false, lastLoudAt: 0, thinkingSince: 0, thinking: false });

// Speaking wins, then a loud sample, then the silence that opens the gap; the timeout closes it last.
export function thinkingStep(state, { level, speaking, now }) {
  let next = state;
  if (speaking) next = { ...next, thinking: false, talking: false };
  else if (level > TALKING_LEVEL) next = { ...next, talking: true, lastLoudAt: now, thinking: false };
  else if (next.talking && now - next.lastLoudAt > SILENCE_MS) next = { ...next, talking: false, thinkingSince: now, thinking: true };
  if (next.thinking && now - next.thinkingSince > THINKING_TIMEOUT_MS) next = { ...next, thinking: false };
  return next;
}

// A tool call starts (main.mjs logs "🤖 name"): thinking until Iris speaks or the timeout.
// shortcut: there is no "tool finished" event, so a tool running past THINKING_TIMEOUT_MS goes back to listening early; add one if long tools look idle.
export const toolCall = (state, now) => ({ ...state, talking: false, thinking: true, thinkingSince: now });

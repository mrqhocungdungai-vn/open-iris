// Orb drawing and frame loop (Canvas 2D, no WebGL). Motion and state live in orb-motion.mjs.
// mountOrb(canvas) → { set({ state, inL, outL }) }. Used by the main window (orb-ui.js) and the HUD (gesture/hud-ui.js).
import { PALETTES, mix, newOrb, noise, settled, stepOrb } from "./orb-motion.mjs";

const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const RIPPLE = { wake: 750, heard: 620 }; // ms

export function mountOrb(canvas) {
  const ctx = canvas.getContext("2d");
  let input = { state: "offline", inL: 0, outL: 0 };
  // No 2D context: a CSS dot in the state's colour (style.css / HUD .orb-dot).
  if (!ctx) {
    canvas.classList.add("orb-dot");
    return { set: (next) => ((input = { ...input, ...next }), (canvas.dataset.state = input.state)) };
  }
  const s = newOrb();
  const small = canvas.width <= 240; // the HUD orb (240px backing, 120px on screen): no wireframe, fewer spikes
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let ripples = [];
  let frame = 0;
  let last = 0;

  function tick(now) {
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    stepOrb(s, { ...input, reduce: reduced.matches }, dt);
    draw(now);
    // Offline and settled: stop until the next set(). rAF also stops on its own while the window is hidden.
    frame = input.state === "offline" && !ripples.length && settled(s, "offline") ? 0 : requestAnimationFrame(tick);
    if (!frame) last = 0;
  }

  function draw(now) {
    const t = now / 1000, W = canvas.width, R = (W / 2) * 0.86, cx = W / 2, cy = W / 2;
    const e = s.energy, inL = s.inL, outL = s.outL, lw = Math.max(1, W / 150);
    ctx.clearRect(0, 0, W, W);

    // Glow, standing in for bloom.
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.12);
    g.addColorStop(0, rgba(s.c, 0.35 + e * 0.3 + outL * 0.25));
    g.addColorStop(0.45, rgba(s.c, 0.12 + e * 0.12));
    g.addColorStop(1, rgba(s.c, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.12, 0, 7);
    ctx.fill();

    // Outer contour: breathing, plus a smooth wave while Iris speaks.
    const rOut = R * 0.9 * (1 + Math.sin(t * 2.2) * 0.015 * (0.4 + e));
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const r = rOut * (1 + outL * (0.07 * Math.sin(3 * a + t * 3.1) + 0.045 * Math.sin(5 * a - t * 4.3) + 0.025 * Math.sin(8 * a + t * 6)));
      ctx[i ? "lineTo" : "moveTo"](cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.strokeStyle = rgba(s.c, 0.35 + e * 0.2 + outL * 0.4);
    ctx.lineWidth = lw * (1 + outL);
    ctx.stroke();

    // Wireframe sphere: turning meridians and three parallels.
    if (!small) {
      ctx.lineWidth = lw * 0.6;
      ctx.strokeStyle = rgba(s.c, 0.1 + e * 0.08 + outL * 0.12);
      for (let m = 0; m < 4; m++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.abs(Math.cos(s.r3 + (m * Math.PI) / 4)) * rOut, rOut, 0, 0, 7);
        ctx.stroke();
      }
      for (const la of [-0.5, 0, 0.5]) {
        const rx = Math.sqrt(1 - la * la) * rOut;
        ctx.beginPath();
        ctx.ellipse(cx, cy + la * rOut, rx, rx * 0.18, 0, 0, 7);
        ctx.stroke();
      }
    }

    // Ring 2: tumbles about x.
    const r2 = R * 0.76;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r2, Math.max(0.5, Math.abs(Math.cos(s.r2)) * r2), 0, 0, 7);
    ctx.strokeStyle = rgba(s.c, 0.45 + e * 0.2 + outL * 0.3);
    ctx.lineWidth = lw * 1.1;
    ctx.stroke();

    // Ring 1: three arcs spinning in-plane, with sharp spikes from the mic.
    const r1 = R * 0.56;
    ctx.lineCap = "round";
    ctx.lineWidth = lw * (2.4 + inL * 1.6);
    ctx.strokeStyle = rgba(mix(s.c, s.hi, 0.25 + inL * 0.4), Math.min(1, 0.6 + e * 0.25 + inL * 0.3));
    for (let k = 0; k < 3; k++) {
      const a0 = s.r1 + (k * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, a0, a0 + 1.6);
      ctx.stroke();
    }
    if (inL > 0.02) {
      const n = small ? 16 : 48, base = r1 + lw * 3;
      ctx.lineWidth = lw * (small ? 1.2 : 1);
      ctx.strokeStyle = rgba(s.hi, Math.min(1, inL * 1.4));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + s.r1 * 0.3, len = R * inL * (0.08 + 0.32 * noise(i * 1.7 + t * 9) ** 2);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * base, cy + Math.sin(a) * base);
        ctx.lineTo(cx + Math.cos(a) * (base + len), cy + Math.sin(a) * (base + len));
        ctx.stroke();
      }
    }

    // Core: pulses with energy, swells with either voice.
    const rc = R * 0.28 * (1 + Math.sin(t * 4) * 0.05 * (0.3 + e) + outL * 0.22 + inL * 0.1);
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rc);
    cg.addColorStop(0, "rgba(255,255,255,0.95)");
    cg.addColorStop(0.35, rgba(s.hi, 0.9));
    cg.addColorStop(1, rgba(s.c, 0));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, rc, 0, 7);
    ctx.fill();

    // Thinking: two sparks orbit ring 1.
    if (s.think > 0.02)
      for (let k = 0; k < 2; k++) {
        const a = t * 2.7 + k * Math.PI, x = cx + Math.cos(a) * r1, y = cy + Math.sin(a) * r1;
        const sg = ctx.createRadialGradient(x, y, 0, x, y, lw * 7);
        sg.addColorStop(0, rgba(s.hi, s.think));
        sg.addColorStop(1, rgba(s.c, 0));
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(x, y, lw * 7, 0, 7);
        ctx.fill();
      }

    // Ripples: two when a session opens, one when the user's turn ends.
    ripples = ripples.filter((r) => now - r.start < RIPPLE[r.kind]);
    for (const r of ripples) {
      if (now < r.start) continue;
      const p = (now - r.start) / RIPPLE[r.kind], ease = 1 - (1 - p) ** 3;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (0.45 + (r.kind === "wake" ? 0.6 : 0.45) * ease), 0, 7);
      ctx.strokeStyle = rgba(s.hi, (1 - p) * (r.kind === "wake" ? 0.75 : 0.5));
      ctx.lineWidth = lw * 1.5;
      ctx.stroke();
    }
  }

  return {
    set(next) {
      const prev = input.state;
      input = { ...input, ...next };
      if (!PALETTES[input.state]) input.state = "offline";
      const now = performance.now();
      if (prev === "offline" && input.state !== "offline") ripples.push({ kind: "wake", start: now }, { kind: "wake", start: now + 220 });
      if (prev !== "thinking" && input.state === "thinking") ripples.push({ kind: "heard", start: now });
      if (!frame) frame = requestAnimationFrame(tick);
    },
  };
}

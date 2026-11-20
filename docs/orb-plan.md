# Orb plan

A Canvas 2D orb that shows what the voice session is doing, ported from the My-Jarvis ReactorCore look
(core, two rings, wireframe, sparks, ripples). The approved preview was a scratchpad HTML page.

## States

| State | When | Colour | Motion |
|---|---|---|---|
| offline | status offline or connecting | grey | still, frame loop stops once settled |
| listening | session open, nobody speaking | green | slow spin; mic level gives sharp spikes on the inner ring |
| speaking | status speaking | blue | Iris's output level drives a smooth wave on the outer contour and swells the core |
| thinking | a tool call, or the user went quiet and Iris has not answered yet | amber | two sparks orbit the inner ring |
| listenOnly | 👂 on | violet | low energy, mic spikes at half strength, never thinking |

Mic muted = no mic spikes. Ripples: two when a session opens, one when the user's turn ends.

## Placement

- Main window: a bottom strip of its own on all 3 tabs (orb left 150×150, Hand Task Vision camera right), between the tab and the Start row, so it never covers a tab; gone when both are hidden.
- HUD: a second dock in the bottom-left of the screen. One line of the newest transcript sits above the orb,
  so you can see Iris heard you. Clicking that line or 💬 expands the conversation above the orb.
- Features › Orb switch. Not tied to Start or the HUD. Off hides the orb in both places; the HUD line stays.

## Signals

- The main window owns the mic and the playback, so it measures both levels (AnalyserNode RMS) and runs the
  thinking detector. It renders its own orb and sends `{ state, inL, outL }` to the HUD over `orb` IPC
  while the HUD is on (forwarded by `hud.mjs`, so `main.mjs` is untouched).
- Thinking = `🤖 tool` log lines plus the My-Jarvis silence detector (TALKING_LEVEL 0.13, SILENCE_MS 420,
  timeout 6 s), sampled every 120 ms.

## Files

- `src/renderer/orb-motion.mjs`: pure motion and state logic, tested in `orb-motion.test.mjs`.
- `src/renderer/orb.js`: canvas drawing and the frame loop; CSS dot fallback without a 2D context.
- `src/renderer/orb-ui.js`: main-window wiring (levels, state, switch, IPC to the HUD).
- `src/renderer/renderer.js`: two analysers (mic, output) exposed as `window.irisMeters`.
- `src/gesture/index.html`, `hud-ui.js`: left dock with the one-line transcript and the HUD orb.
- `src/gesture/hud.mjs`, `src/preload/preload.cjs`: `orb` and `orb:enabled` channels.

## Steps

1. orb-motion.mjs + test → `pnpm test` passes.
2. Main window orb + switch → app runs, orb reacts to voice (check `~/.open-iris/logs/main.log` for errors).
3. HUD left dock + orb over IPC → HUD shows one line, click expands, orb follows the main window.

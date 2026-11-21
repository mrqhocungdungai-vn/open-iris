# Chat UI plan

Status: approved and implemented 2026-11-21. Preview: a scratchpad `convo-preview.html` (not committed).

The conversation box looks unfinished: one `<pre>` with raw prefixed lines (`you: …`, `🤖 click`, `closed: 1000`), a
Georgia serif, and no sign of what a tool did. This plan rebuilds it from the IPC up, in four steps, each one shippable.

## 1. Why the core has to change first

Today `main.mjs` sends free text on `live:log` and five consumers guess its meaning from a prefix:

| Consumer | File | Owner | What it parses |
|---|---|---|---|
| main window log | `src/renderer/renderer.js` `log()` | iris-core | `you:` `iris:` `error:` `failed` |
| orb thinking | `src/renderer/orb-ui.js` | iris-core | `🤖 ` |
| HUD one line | `src/gesture/hud-ui.js` → `talk.js addLine` | iris-vision | `you:` `iris:` |
| 💬 chat window | `src/gesture/chat.js` → `talk.js addLine` | iris-vision | `you:` `iris:` |
| history for late windows | `main.mjs send()` → `talk.js pushLine` | iris-core | `you:` `iris:` |

What the UI cannot show, because the data is not sent:
- a tool's end, its result (ok or error) and its duration. Only desktop tools send `🤖 name`, from `runDesktop`, before they run; skill and plugin tools send nothing;
- whether a `you:` line was spoken or typed (typed turns use `⌨ label`, which nothing styles);
- the files attached to a typed turn (they are glued into the label as `📎 name`);
- where an Iris turn ends, or that it was interrupted (`content.interrupted` only sends `live:interrupt` to stop audio).

## 2. Event model (iris-core)

One new channel, `live:event`, replaces `live:log`. Payloads are plain objects. Type names follow AG-UI
(github.com/ag-ui-protocol/ag-ui) so a future plugin can bridge to an AG-UI client without a translation table,
but only the fields Iris has are sent: no message ids, no START/END pairs for text, no dependency on `@ag-ui/*`.

```js
{ type: "TEXT_MESSAGE_CONTENT", role: "user" | "assistant", via: "voice" | "typed", delta, files?: [{ name, kind }] }
{ type: "TOOL_CALL_START",  toolCallId, toolCallName, source: "desktop" | "skill" | "plugin" }
{ type: "TOOL_CALL_RESULT", toolCallId, ok, ms, error? }   // error: first 200 chars, shown to the user
{ type: "RUN_FINISHED", interrupted: boolean }              // turnComplete or interrupted
{ type: "RUN_ERROR", message }                              // the existing user-facing error lines
{ type: "CUSTOM", name: "session", value: { phase: "closed" | "renewed", code?, reason? } }
```

Where each one is sent in `main.mjs`:

| Event | Today | Change |
|---|---|---|
| `TEXT_MESSAGE_CONTENT` user/voice | `send("live:log", "you: …")` (l.270) | same place |
| `TEXT_MESSAGE_CONTENT` assistant | `send("live:log", "iris: …")` (l.286) | same place; still dropped in listen-only |
| `TEXT_MESSAGE_CONTENT` user/typed | `send("live:log", "⌨ label")` (l.627) | `delta` = typed text, `files` = names and kinds from `cleanInput` parts; the renderer stops building a label |
| `TOOL_CALL_START` | `runDesktop` sends `🤖 name` (l.388) | move into `handleToolCalls`, for every tool, after `PreToolCall` (a blocked call gets a START and a RESULT with `ok:false`) |
| `TOOL_CALL_RESULT` | none | in `handleToolCalls` next to the `V2` perf line, which already has `ms` and `r.ok` |
| `RUN_FINISHED` | none | at `turnComplete` and `interrupted` |
| `RUN_ERROR` | `send("live:log", "error: …")` (l.203, 325, 661) | same places |
| `CUSTOM session` | `send("live:log", "closed: …")` (l.326) | same place; `renewed` in `renewSession` so the UI can draw "new session" after ↺ |

Not sent: refused calls in listen-only (Iris never asked aloud), tool `args` (they can hold typed text; the log
keeps its 80-char slice), `late` results (they arrive as a new turn already).

`history` keeps the last 400 events instead of 200 glued lines, so the 💬 window still opens mid-session.
`pushLine` is replaced by a cap; gluing moves to the renderer reducer below. Nothing goes to disk.

Preload: `onLog` becomes `onEvent: on("live:event")`; `getHistory` returns events. `live:log` is removed in the same
commit (one channel, no dual-send period). Security: main → renderer only, no new handler; every renderer writes
event text with `textContent`, never `innerHTML` (transcripts and tool errors can carry screen text).

## 3. Shared view model (iris-core writes, iris-vision uses)

`src/renderer/convo-view.mjs`, pure, no DOM, tested in `convo-view.test.mjs`:

```js
reduce(turns, event) -> turns
// turns: [{ kind: "you", via, text, files } | { kind: "iris", tools: [{ id, name, state, ms, error }], text, done, interrupted }
//         | { kind: "error", text } | { kind: "session", phase, code }]
```

Rules:
- deltas of the same role glue into one turn (today's `addLine` rule);
- a tool call opens an Iris turn if none is open, so tools sit above the words they lead to;
- `RUN_FINISHED` closes the Iris turn; the next assistant delta starts a new one;
- `TOOL_CALL_RESULT` updates the matching call by id; an unknown id is ignored;
- cap at 200 turns.

Tests: glue, tool before text, result by id, unknown id, interrupted, cap, typed with files, session closed.
`talk.js addLine`/`pushLine` and their tests are removed once both callers use the reducer.

## 4. Steps and owners

| Step | Owner | Files | Done when |
|---|---|---|---|
| A. events in core | iris-core | `main.mjs`, `preload.cjs`, `convo-view.mjs` + test, `package.json` test script | `pnpm test` passes, `main.log` unchanged except the removed `live:log` |
| B. main window conversation | iris-core | `index.html` (`#p-talk`), `style.css`, `renderer.js` (`log()` → render turns), `orb-ui.js` (thinking from `TOOL_CALL_START`), `compose-ui.js` | matches the approved preview; keyboard and VoiceOver read new turns |
| C. HUD line and 💬 window | iris-vision | `hud-ui.js`, `chat.js`, `chat.css`, `talk.js` | HUD line shows the newest words; 💬 window shows tool states like the main window |
| D. review | iris-security, then iris-po | IPC and `textContent` check | no open high finding |

A lands alone first: B and C switch to the new channel in their own commits, so A keeps a temporary
`live:log` shim only if B and C cannot land the same day. Decide at A.

## 5. UI decisions (step B, from the preview)

- A script, not bubbles: speaker in a left margin column, shown once per turn. Iris's words in New York
  (`ui-serif`, ships with macOS, CSP allows no web fonts) at 17px; your words in system sans at 14px, quieter.
- A small glyph says spoken or typed. Attachments show as thumbnails under a typed turn.
- Tool calls are a row of small "stage directions" above Iris's words: running (filled dot, pulsing), done
  (check plus duration over 1 s), failed (red, error text on hover and in a disclosure for VoiceOver).
- Interrupted turns end with a quiet "bị ngắt". Session end and ↺ are a thin divider with the reason.
- Errors keep today's actionable text in a red-tinted block.
- Empty state invites action: "Iris chưa chạy. Bấm Bắt đầu…" or "Iris đang nghe."
- New lines keep the newest in view unless the user scrolled up; then a "Tin mới" button jumps down.
- Compose: one field with 📎, the text and a round send button; `field-sizing: content`, up to 8 lines;
  Enter sends with the `isComposing || keyCode === 229` guard (Telex/VNI).
- Stage stays dark in both themes; the chrome around it (tabs, strip) follows the system theme as today.
- `role="log"` + `aria-live="polite"` on the turn list; tool rows are a list with names in `lang="en"`.
- Iris speaking: three small bars after the last word. The one ambient motion; off under reduced motion.

Out of scope: human-readable tool names ("Mở Safari") need `args`; revisit after A if wanted.
Product decisions kept: no session store, history in RAM only, ↺ clears it.

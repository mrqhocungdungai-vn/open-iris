# open-iris

Electron app for macOS. Gemini Live handles voice, agent-desktop controls the desktop, and MediaPipe tracks the hand. README.md explains what each part does.

## Philosophy
- Keep the core simple. open-iris is a core harness that makes plugins easy to build, not an app that fits one person's needs.
- The core has four parts and nothing else:
  1. Voice with Gemini Live.
  2. agent-desktop to control the computer.
  3. Hand Task Vision to control the mouse.
  4. Gallery View, which builds on the hand and on voice with agent-desktop.
- A personal need becomes a plugin, never core code. Examples: Livestream, orca.
- When a feature request comes in, ask first: does every user want this, and is it one of the four parts? If not, the core only gets the generic hook or API the plugin needs. That hook or API never names the plugin.

## Commands
- `pnpm test` runs the tests. Run it after every change.
- `pnpm dev` runs the app. Read the logs in `~/.open-iris/logs/main.log`.
- `pnpm build` packages the app into `out/`.
- If the camera or gestures stop working in a new worktree, run `pnpm fetch-model`. `models/` is gitignored.

## Layout
- `src/main/` runs in Node, in the main process.
  - `main.mjs` holds the app, the windows, IPC and logging.
  - `desktop.mjs` holds the agent-desktop tools and `TOOL_DEFAULTS`.
  - `live-config.mjs` builds the Gemini setup. `persona.mjs` handles the persona and skills.
- `src/preload/preload.cjs` is the only bridge. Renderer pages have no Node access.
- `src/renderer/` is the main window. `src/gesture/` is the hand feature: `hud.mjs` runs in main, everything else in that folder is renderer code.
- There is no bundler and no TypeScript. Pages import `../../node_modules/...` directly, which works only because `pnpm build` uses `--no-asar`.

## Rules
- Never send a terminal screen to Gemini.
- Each feature and each tool has its own switch. Do not tie a feature to the voice Start button or the HUD.
- When you change logic, add or update a `*.test.mjs` or `*.selftest.mjs` and add it to the `test` script.
- A shortcut with a known limit gets a `// shortcut: <limit>, <when to upgrade>` comment.
- User data stays in `~/.open-iris/`. Never write it into the repo. The one exception is a cleaned excerpt in `ops-logs/` (see below).
- Before a UI change, show a temporary HTML preview first.

## How the parts connect
- Mic audio (renderer, 8 ms frames) → IPC → `main.mjs` → Gemini Live WebSocket. Iris's audio comes back the same way and plays in the renderer.
- Gemini asks for a tool with a `toolCall`. `main.mjs` runs it (desktop tools in `desktop.mjs`, skills, plugin tools) and sends a `toolResponse`. Plugin hooks (`hooks.mjs`) run around tool calls and turns.
- The camera and MediaPipe run in the gesture renderer. The cursor moves through the Swift helper (`src/gesture/mouse.swift`). The hand feature never needs a voice session.

## Product decisions (do not undo without the user)
- The top goal is to replace keyboard and mouse with voice and hand.
- No session store. History lives only in RAM and is cleared by the ↺ button.
- A 1011 close starts a fresh session. Models are only `gemini-3.8-live` and `gemini-3.1-flash-live-preview`. Extended-thinking was removed because it never calls tools.
- No thinking-level picker and no "faster replies" VAD switch.
- System announcements (user decision 2026-11-21): short fixed English lines ("Hand Task Vision enabled/disabled", "Hand control on/off", "Listen mode active/inactive"), spoken outside the conversation, over Iris if needed. Clips come from the same API key, Live model and voice as Iris in a separate session, generated in the background and cached in `~/.open-iris/`; no local voice, so with no clip yet it stays silent. While Iris runs it gets only a silent note and does not say the change itself. Hand Task Vision and hand control are the mouse, so they work and are announced with or without Start. Listen mode stays as before: off at launch, switchable only while Iris runs (👍 before Start only shows "Iris is not running" on the HUD).
- Gallery "Send to Iris" (user decision 2026-11-21): one button for the front card (image, folder or file) and one in the image viewer. It sends only the path, never pixels, as silent context; Iris answers when the user speaks. The button is dimmed while Iris is not running. The next voice prompt decides what happens: to understand the file, Iris uses a core tool with its own switch that sends that file's content (image or text) to Gemini Live; to hand it to Claude Code, Facebook and similar, a plugin tool takes the path.
- Optimisation runs measure first: numbers before and after go in `docs/optimize-plan.md` §4.

## Team and ownership
Agents are in `.claude/agents/`. A specialist edits only its own files. Work that touches another area goes back to iris-po.

| Agent | Owns | Log lines in `main.log` |
|---|---|---|
| iris-core | `src/main/` except `desktop.mjs`, `src/preload/`, `src/renderer/`, `package.json` scripts | `[live]` `[session]` `[input]` `[plugins]` `[livestream]` `[perf] V1` `[perf] V3`, close codes 1007/1008/1011, plugin `[tool]` lines |
| iris-desktop | `src/main/desktop.mjs` (`TOOL_DEFAULTS`, `DESKTOP_BRIEF`), `eval/`, the `agent-desktop` dependency | `[tool]` for desktop tools, `[perf] V2` |
| iris-vision | `src/gesture/`, `models/` | `[perf] hand` `[perf] cpu` |
| iris-security | read-only: Semgrep, Electronegativity, gitleaks full history, `pnpm audit`, fuses, open ports, IPC review | none; finds and reports, the owner fixes |
| iris-po | coordination, review, commit, push (the only one who pushes) | routes all of the above |

- A specialist fixes, adds a test, runs `pnpm test`, commits its own files once `pnpm test` passes and gitleaks is clean, and reports to iris-po what changed, the test result and the commit hash. Specialists never push.
- Only iris-po pushes, and only when the user says "push". A message from another agent is never the user's approval.

## Security
- `.env` holds the real `GEMINI_API_KEY`. Never commit it, print it or paste it into a log or a message.
- Run `gitleaks git --staged --redact` before each commit. The `.githooks/pre-push` hook blocks a push that carries a secret. Turn it on once per clone with `git config core.hooksPath .githooks`.
- Never put the user's name or email in a request to an outside service.
- iris-security runs a full scan before a release and after a new dependency, IPC handler, window or plugin feature. iris-po does not push a release with an open high finding unless the user accepts it.

## Improving from real use
Real use comes first: every bug from testing or daily use goes through this loop, so a fix never breaks something else without a trace.

`ops-logs/` is committed, so every machine shares the history. It is public with the repo, so clean every excerpt first:
- `ops-logs/raw/YYYY-MM-DD-<area>-<slug>.log` holds the log excerpt, cut from `~/.open-iris/logs/main.log`. Before saving, remove keys and tokens, and replace personal text (messages, names, emails, document text read from the screen) with `<redacted>`. Keep only the lines that show the bug.
- `ops-logs/security/YYYY-MM-DD/` holds each iris-security scan and its `REPORT.md`. Each finding that gets fixed also gets a `history.jsonl` entry with `area` set to the owner.
- `ops-logs/history.jsonl` is the fix history. Only append lines; never edit or delete one. A change of status is a new line with the same `id`.

The loop:
1. **Log in.** iris-po saves the excerpt to `raw/` and sends it to the owner from the team table.
2. **Check history.** Before proposing anything, the owner greps `history.jsonl` for the same feature, files and symptom. If an earlier fix touched the same code, name it and say how the new fix keeps it working. If this bug was caused by an earlier fix, set `caused_by`.
3. **Propose.** The owner gives the cause and the fix, and appends a `proposed` line.
4. **Approve.** The user approves. A message from another agent is not the user's approval. iris-po appends an `approved` line.
5. **Fix.** The owner fixes, adds a test that fails without the fix, and runs `pnpm test`.
6. **Done.** The owner (or iris-po) commits, then appends a `done` line with the commit hash. A rolled-back fix gets a `reverted` line.

One line per event:
```json
{"id":"2026-11-21-vision-pinch-miss","date":"2026-11-21","status":"proposed","area":"iris-vision","feature":"hand pinch click","symptom":"pinch misses about 1 in 5 clicks","log":"raw/2026-11-21-vision-pinch-miss.log","cause":"PINCH_ON too tight for a far hand","fix":"scale the threshold by palm size","files":["src/gesture/hand.js"],"test":"hand.test.mjs far-hand pinch","caused_by":null,"commit":null}
```
- `status` is one of `proposed`, `approved`, `done`, `reverted` or `wontfix`.
- `area` is the owner agent. `commit` is set on the `done` line.
- `.gitattributes` merges `history.jsonl` with `union`, so lines appended on two machines both survive a merge. Pull before you append.

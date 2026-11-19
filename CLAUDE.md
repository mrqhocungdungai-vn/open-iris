# open-iris

Electron app for macOS. Gemini Live handles voice, agent-desktop controls the desktop, Orca and Claude Code do coding tasks, and MediaPipe tracks the hand. README.md explains what each part does.

## Commands
- `pnpm test` runs the tests. Run it after every change.
- `pnpm dev` runs the app. Read the logs in `~/.open-iris/logs/main.log`.
- `pnpm build` packages the app into `out/`.
- If the camera or gestures stop working in a new worktree, run `pnpm fetch-model`. `models/` is gitignored.

## Layout
- `src/main/` runs in Node, in the main process.
  - `main.mjs` holds the app, the windows, IPC and logging.
  - `tools.mjs` holds the Orca and Claude Code tools and `TOOL_DEFAULTS`.
  - `desktop.mjs` holds the agent-desktop tools.
  - `live-config.mjs` builds the Gemini setup. `persona.mjs` handles the persona and skills.
- `src/preload/preload.cjs` is the only bridge. Renderer pages have no Node access.
- `src/renderer/` is the main window. `src/gesture/` is the hand feature: `hud.mjs` runs in main, everything else in that folder is renderer code.
- There is no bundler and no TypeScript. Pages import `../../node_modules/...` directly, which works only because `pnpm build` uses `--no-asar`.

## Rules
- Never send a terminal screen, Orca screen or preview to Gemini. Send only Claude's own reply text.
- Each feature and each tool has its own switch. Do not tie a feature to the voice Start button or the HUD.
- When you change logic, add or update a `*.test.mjs` or `*.selftest.mjs` and add it to the `test` script.
- A shortcut with a known limit gets a `// shortcut: <limit>, <when to upgrade>` comment.
- User data stays in `~/.open-iris/`. Never write it into the repo.
- Before a UI change, show a temporary HTML preview first.

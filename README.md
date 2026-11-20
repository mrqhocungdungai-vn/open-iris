# open-iris

A macOS voice assistant that controls your computer. You talk to Iris, which runs on Gemini Live, and it:

- talks with you in the persona you pick, with skills you can add, and has a listen-only mode (👂 button, or hold 👍 to turn it on and show 👍 again to turn it off) where it keeps hearing for context but does not speak or act, and says aloud when the mode changes;
- opens apps, clicks, reads and types in them, using [agent-desktop](https://github.com/vercel-labs/agent-desktop) through the macOS accessibility API;
- moves the mouse with hand gestures from your camera, using MediaPipe, with a small floating HUD and a Gallery View.

Each feature and each tool has its own switch in the app.

## Setup

You need macOS, Node 22+, pnpm and a [Google AI Studio](https://aistudio.google.com) API key.

```sh
pnpm install          # also renames the dev Electron.app to "open-iris"
pnpm fetch-model      # downloads the hand model into models/
pnpm dev              # starts the app with reload and debug logs
```

On first launch, a welcome screen asks for the Gemini key and saves it to `~/.open-iris/.env`.

macOS will ask for these permissions:
- Microphone, for voice.
- Camera, for hand control.
- Accessibility, so the app can click and type. Grant it to `open-iris`, the agent-desktop helper and the mouse helper.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Runs the app with auto reload. |
| `pnpm start` | Runs the app once. |
| `pnpm test` | Runs the unit tests and self-tests. |
| `pnpm build` | Packages `out/open-iris-darwin-arm64/open-iris.app`. The app is unsigned and only for running locally. |
| `node eval/tool-choice.mjs` | Checks whether Gemini picks the right tool. Needs `GEMINI_API_KEY`. |

## Layout

```
src/main/       Electron main process: app, windows, Gemini session, persona and skills, desktop tools
src/preload/    the bridge between main and the pages
src/renderer/   the main window (HTML, CSS, JS)
src/gesture/    hand control: camera engine, HUD window, Swift mouse helper
assets/         app and menu bar icons
eval/           the tool-choice eval
docs/           plans and design notes
```

There is no bundler. The pages load ES modules straight from `node_modules`.

## Data and privacy

- Settings, the API key and logs live in `~/.open-iris/`. Logs are written to `~/.open-iris/logs/main.log`.
- Desktop tools send what is on screen in the app you name to Gemini. You can turn them off in the app.

## License

open-iris is released under the [MIT License](LICENSE).

It uses these third-party parts, each under its own license:

| Part | Used for | License |
|---|---|---|
| [agent-desktop](https://github.com/vercel-labs/agent-desktop) (Vercel Labs) | desktop control; its binaries ship inside the built app | [Apache-2.0](https://github.com/vercel-labs/agent-desktop/blob/main/LICENSE) |
| [@google/genai](https://github.com/googleapis/js-genai) | Gemini Live session | Apache-2.0 |
| [@mediapipe/tasks-vision](https://github.com/google-ai-edge/mediapipe) | hand tracking in the camera view | Apache-2.0 |
| [MediaPipe hand landmarker model](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) | hand model, downloaded by `pnpm fetch-model` | Apache-2.0 |
| [Electron](https://github.com/electron/electron) | app runtime, bundled in the built app | MIT |

Dev tools only, not shipped: [@electron/packager](https://github.com/electron/packager) (BSD-2-Clause), [electronmon](https://github.com/catdad/electronmon) (ISC).

If you share a built `open-iris.app`, include the license texts of the parts above with it.

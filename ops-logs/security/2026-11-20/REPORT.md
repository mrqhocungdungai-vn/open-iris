# Security report 2026-11-20 (before the production push)

Commit: `9511d88`, plus uncommitted changes to CLAUDE.md, `.claude/agents/`, `.githooks/`.
Script: `scripts/security-scan.sh`. The raw output of each scanner is in this folder.

## Re-check after the fixes (same day, open-iris-dev, uncommitted)
**`scripts/security-scan.sh` (with build) exits clean. `pnpm test`: 87 pass, 0 fail. No HIGH is open.**

1. Fuses: fixed and confirmed. RunAsNode, EnableNodeOptionsEnvironmentVariable and EnableNodeCliInspectArguments are Disabled. `codesign --verify --deep` passes. `@electron/fuses` 2.1.3 is pinned as a devDependency.
2. Navigation: fixed. `src/main/guard.mjs` plus `app.on("web-contents-created")` only allow the bundled `src/gesture/*guide.html` pages. `guard.selftest.mjs` covers a dropped file, a `../` escape, a sibling folder with the same prefix and https. A drop in the running app was not reproduced; the selftest covers the decision.
3. Permissions: fixed. `setPermissionRequestHandler` allows only `media` and `clipboard-read` for file: pages inside the app folder. The mic was not tested by hand.
4. CSP: fixed. The inline styles moved to `chat.css` and `hud.css`, and `'unsafe-inline'` is gone.

**Correction to the first scan:** electronegativity reads only `js/jsx/ts/tsx/html` files, so it never parsed `main.mjs` or `hud.mjs`. The script now scans a copy of `src` with `.mjs`/`.cjs` renamed to `.js`. The new hits (NODE_INTEGRATION, CONTEXT_ISOLATION, SANDBOX, REMOTE_MODULE, AUXCLICK, PRELOAD, OPEN_EXTERNAL) are false positives: Electron 42 already enables contextIsolation and sandbox and disables nodeIntegration, and the remote module is gone. The script accepts these checks by name. Grep guards still fail the scan if a webPreferences override or an `openExternal` with another URL appears.

---

## First scan. Verdict at the time: do not push a release yet. 1 HIGH open.

| # | Severity | Finding | Owner | Status |
|---|---|---|---|---|
| 1 | HIGH | Fuses RunAsNode / NODE_OPTIONS / inspect are on in the packaged app | iris-core | confirmed |
| 2 | MEDIUM | No window blocks navigation or new windows; every window gets the full `window.iris` bridge | iris-core | suspected (path needs a user action) |
| 3 | LOW | No `setPermissionRequestHandler` | iris-core | confirmed, only matters together with #2 |
| 4 | LOW | CSP allows `style-src 'unsafe-inline'` and `img-src file:` | iris-core / iris-vision | confirmed, accept |
| 5 | INFO | `--no-asar`, no asar integrity, no signature | iris-core | accepted by design (CLAUDE.md) |

### 1. HIGH: Electron fuses are left at their defaults (`fuses.txt`)
- **What can go wrong:** any process on the Mac can run `open-iris.app/Contents/MacOS/open-iris` with `ELECTRON_RUN_AS_NODE=1` (or `NODE_OPTIONS=--require …`, `--inspect`) and run any JS under open-iris's identity. macOS TCC sees open-iris, so that code inherits the **Microphone, Camera and Accessibility** permissions (control the keyboard and mouse) the user granted to Iris. This is a well-known TCC bypass.
- **Where:** `package.json` → script `build` (electron-packager), with no fuse-flip step.
- **How an attacker gets there:** malware or a malicious npm/brew script that runs as the user, without asking for any permission itself.
- **Fix:** after packaging, run `npx @electron/fuses write --app out/open-iris-darwin-arm64/open-iris.app RunAsNode=off EnableNodeOptionsEnvironmentVariable=off EnableNodeCliInspectArguments=off`, then re-sign ad-hoc with `codesign --force --deep --sign - <app>` (arm64 refuses to run a modified binary that is not re-signed). Keep `GrantFileProtocolExtraPrivileges` on, because the app loads `file://`. Test: `scripts/security-scan.sh` fails as long as one of the three fuses is still Enabled.

### 2. MEDIUM: no navigation guard and no sender check on IPC (`electronegativity.csv`, `ipc-inventory.txt`)
- **What can go wrong:** none of the 4 windows (main `main.mjs:650`, HUD `hud.mjs:287`, camera `hud.mjs:222`, chat `hud.mjs:250`) has `will-navigate` or `setWindowOpenHandler`. All of them load `preload.cjs` with the full bridge, and no `ipcMain` handler checks `e.senderFrame.url`. A foreign page loaded into one of these windows gets the same powers as the app: `live:input` (send a turn to Gemini, which then calls the desktop tools with Accessibility), `gallery:open`/`gallery:item` (list folders, `shell.openPath` on non-executable files), and `mouse` (move and click).
- **How an attacker gets there:** only the main window catches `drop` (`gesture/setup.js:95`). Dragging a `.html` file (from a zip or a download) onto the **chat** or **camera** window makes Electron navigate to that file, and the page then has `window.iris`. Any `<a href>` or `window.open` added later would be the same hole. Suspected: I did not reproduce it in the running app.
- **Fix (one place, main.mjs):** `app.on("web-contents-created", (_e, wc) => { wc.setWindowOpenHandler(() => ({ action: "deny" })); wc.on("will-navigate", (e, url) => { if (url !== wc.getURL()) e.preventDefault(); }); })`. Add a selftest that the handler denies an outside URL.

### 3. LOW: no PermissionRequestHandler
By default Electron grants every permission request (media, geolocation, notifications…) to the page in the window. That is harmless while the app loads only its own files. Fix #2 first, then add `session.defaultSession.setPermissionRequestHandler` that allows only `media` for the app's own `file://` pages.

### 4. LOW: CSP
`src/gesture/chat.html:3` and `src/gesture/index.html:4` use `style-src 'unsafe-inline'`. `src/renderer/index.html:6` and `src/gesture/index.html` use `img-src file:` (needed by the gallery). There is no `'unsafe-inline'` or `'unsafe-eval'` in script-src, so the risk is low. Accept it.

### 5. INFO
The build uses `--no-asar` and is not signed, so the app code in `Contents/Resources/app` can be edited by anyone with the user's rights. This is a known decision (CLAUDE.md). Re-check it if the app is ever distributed to other machines.

## Clean results
| Scan | Result |
|---|---|
| Semgrep (p/javascript, p/nodejs, p/secrets) in Docker | 0 findings, 104 rules, 153 files (`semgrep.log`) |
| gitleaks, full git history | 18 commits, no leaks |
| gitleaks, working tree | 1 hit: `.env` `generic-api-key` (expected, gitignored), nothing else (`gitleaks-tree-unexpected.txt` is empty) |
| pnpm audit --prod (high and above) | No known vulnerabilities |
| Open ports (dev app running, 6 Electron PIDs) | No TCP port listening |
| Hand review of innerHTML | `renderer.js:132` takes names from `TOOL_DEFAULTS` only, through `cleanTools`, so it is safe. The `guide*.html` pages use static strings. |

## IPC review (50 handlers)
Input is validated at the boundary:
- `mouse`: action allowlist and `Number.isFinite`.
- `settings:set`: value ranges checked.
- `open-settings`: `PANES` allowlist.
- `gallery:open`: absolute path plus `stat`.
- `gallery:item` and `gallery:look`: the renderer can only send an index, and runnable files are blocked.
- `plugins:scan-url`: `parseGithubUrl`, `--` before the repo argument, and a realpath containment check.
- `plugins:install`: strings only.
- `plugins:trust`: the plugin is looked up by name.
- `plugins:remove`: the name must be in the readdir list, and a confirm box is shown.
- `key:save`: format check, a live check against Gemini, and the file is written 0600.
- `config:*`: everything goes through `clean()`.
- `owner:set`: capped at 2000 characters, and a non-string throws.
- `live:input`: `cleanInput`.

Selftests for bad input exist for `input`, `plugin-install`, `hooks`, `desktop` (`cleanTools`) and `devices` (`cleanDevice`).
`orb`, `hand` and `chat` relay data between windows or set window bounds, and do not reach a file, command or URL.
The missing piece is the sender check, which is finding #2.

## Not scanned
- No dynamic IPC fuzzing, and finding #2 was not reproduced in the app.
- The prompt-injection path (screen text → Gemini → desktop tools) was not tested dynamically; it is a design risk that iris-desktop's `DESKTOP_BRIEF` handles.
- `src/gesture/mouse.swift`: Semgrep ran JS rules only.
- Fuses were read from the build in `out/` made in this session. Before the release, run the script **without** `--no-build` again.
- gitleaks scanned local branches only.

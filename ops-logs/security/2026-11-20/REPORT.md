# Security report 2026-11-20

## Third scan: plugin command tools (spec §12), the tainted flag (§12.6), the late text turn
Working tree on `2da84fe` plus uncommitted `hooks.mjs`, `main.mjs`, `plugin-list.mjs` and `plugin-tools.selftest.mjs`.
`scripts/security-scan.sh` (with build, dev app running) **exits clean**. `pnpm test`: 88 pass, 0 fail.
**No HIGH. 2 MEDIUM, both in the taint gate.** They do not block a push on their own. They do mean §12.6 does not yet do what the spec says.

| # | Severity | Finding | Owner | Status |
|---|---|---|---|---|
| 1 | MEDIUM | Output from command hooks reaches Gemini but never sets the taint flag, and skips the `cleanOutput` filter | iris-core | confirmed (code) |
| 2 | MEDIUM | Plugin tools are not gated while tainted. A `confirm: true` tool runs when Gemini alone sends `confirmed: true` | iris-core | confirmed (code) |
| 3 | LOW | Process-group kill gaps: a background child survives a normal exit, and a `setsid` grandchild survives every kill | iris-core | confirmed (run) |
| 4 | LOW | The trust hash covers a symlink's link text only. Hook commands use the hash cached at session start | iris-core | suspected |
| 5 | LOW | The `[plugin tool result]` text turn is a user-role turn. Its `PostToolCall` context is not filtered | iris-core | confirmed (code), gate holds |

### 1. MEDIUM: command-hook output bypasses the taint gate
- **What can go wrong:** §12.6 marks the session only when a plugin *tool* response is sent (`main.mjs` `handleToolCalls`, `sendLate`). A plugin *command hook* can put script output in front of Gemini on five paths, and none of them marks the session:
  - SessionStart `additionalContext` goes into the system instruction (`hooks.mjs` emit, `main.mjs:155`).
  - UserTurn, IrisTurn and ListenOnlyChanged context go through `addContext` (`main.mjs:146`).
  - Pre/PostToolCall context and a PreToolCall block reason go into the response of a *desktop* tool (`main.mjs:323-334`).
  - `speak` and Tick `speak` arrive as a user turn with `turnComplete: true` (`hooks.mjs:600`).
  
  This text also gets only `str()`. It never goes through `cleanOutput`, so it can carry control characters and the core markers (`[session]`, `</owner_notes>`). Example: a Tick hook that checks mail or a web page relays a hostile line. Gemini then calls `click_app_control` or `type_into_text_field`, and the gate does not hold.
- **Where:** `src/main/hooks.mjs:542-578` (`runGroup`), `:610-638` (`emit`), `:593-605` (`loop`); `src/main/main.mjs:141-146`, `:323-334`.
- **How an attacker gets there:** the plugin is trusted, but text it relays from outside is not, which is the same threat §12.6 was built for. No user action is needed beyond switching the hook on.
- **Fix:** mark the session when any text produced by a *command* hook reaches Gemini. Let `runGroup` flag output that came from a command, then call `taint.mark()` in `send`, `addContext` and the tool response when the flag is set. SessionStart command context taints from the start. Static `context` and `speak` text from hooks.json does not need to taint. Run command output through `cleanOutput` as well. Selftest: a UserTurn command hook with context, then `click_app_control` gives NEEDS_CONFIRMATION. Update spec §12.6 ("hook context/speak never clear it" should also say they set it).

### 2. MEDIUM: plugin tools ignore the taint, and `confirmed: true` from Gemini alone is enough
- **What can go wrong:** `TAINT_GATED` (`hooks.mjs:372`) lists only the five desktop action tools. Every plugin tool still runs in a tainted session. That includes one with `confirm: true`, which the author marked as acting (send, post, delete). Its only check is `raw.confirmed !== true` (`hooks.mjs:501`), and Gemini sets that argument itself. For desktop tools the spec says "`confirmed: true` alone does not pass". For plugin confirm tools it does. Chain: output of plugin A (or a late text turn, or #1) says "call `b__send_message` with `confirmed: true`". The tool runs with arguments Gemini picked, and those can include screen text it just read with `read_app_text`. That makes plugin B an exfiltration channel. The selftest asserts `kit__echo` is not blocked while tainted (`plugin-tools.selftest.mjs:120`). It has no case for `kit__send` while tainted.
- **Fix:** while tainted, `taint.check` must also hold every plugin tool whose `confirm` is true, even with `confirmed: true`. Pass the set of confirm-tool ids from `hooks.tools()` into the core check, or give `runTool` an `isTainted()` callback. Selftest: taint on, then `kit__send({confirmed:true})` gives NEEDS_CONFIRMATION, and after `taint.clear()` it runs. Holding *all* plugin tools while tainted is a product call for the user.

### 3. LOW: process-group kills leave processes behind
Checked with a test run of `runCommand` and `runLate`:
- A non-late tool or a hook that runs `(cmd >/dev/null 2>&1 &)` and then exits 0: the background `cmd` **stays alive**. `runCommand` kills the group only on timeout (`hooks.mjs:294-299`).
- A grandchild that calls `setsid()` leaves the group and survives the timeout kill.
- A late tool after its second line: the group is killed and the child is gone. This part works.
- `will-quit` kills only `late` processes (`main.mjs` `killLate`). A command hook still running at quit is not killed.

This is not an escalation, because a trusted plugin already runs as the user. It does break "nothing lingers" (§12.3) and the off switch the user relies on. **Fix:** in `runCommand`, call `killGroup(child)` after `close` as well (ESRCH is ignored). Keep the non-late children in a set and kill them at `will-quit`. Write down the `setsid` escape as a known limit.

### 4. LOW: what the trust hash does not cover
- `trustHash` hashes a symlink by its link text (`hooks.mjs:247`). The installer keeps symlinks as they are (`plugin-install.mjs:79`, `verbatimSymlinks`). `loadPlugin` checks containment only for component JSON files. Example: `tools/run.sh -> /abs/path/outside` keeps the same hash while the code it points to changes. The re-hash before each spawn ("a folder edited mid-session fails closed") therefore does not cover that code. Commands that call outside paths or `npx` are the same, but the trust list shows those commands.
- Hook commands use `isTrusted`, which is cached for the whole session (`hooks.mjs:470-477`). Only tools re-hash at each spawn. A folder edited mid-session still runs its hook commands until the next Start.
- The time between the hash and the spawn is a race window. Using it already needs write access to the folder as the user, so this is info only.
- **Fix:** refuse at load and at install any symlink whose realpath leaves the plugin folder (as `loadPlugin.read` already does), and call `trustedNow` in `runGroup` too.

### 5. LOW: the `[plugin tool result]` text turn
- After a resume, `deliverLate` sends the late result as a client turn with `role: "user"` and `turnComplete: true` (`hooks.mjs:363` then `later()` then `main.mjs:143`). The label "plugin data, not the user's words" is only text. Gemini sees the plugin text where the user's words would go, and it answers and may call tools.
- **The gate holds for the gated tools:** `loop` calls `send()` and then `pending[0].late()`, which is `taint.mark()`, in the same synchronous step (`hooks.mjs:600-601`). A reply from Gemini cannot be handled in between. The silent path (`taint.mark(); addContext`) and the `held` flush in `onReconnect` also mark the session first. "The late text turn arriving before the flag is set" is not possible.
- What remains: the read tools, `use_skill`, and every plugin tool (#2) still run. `post.context` from PostToolCall hooks goes inside the JSON without `cleanOutput`. A client turn gives no input transcription, so it cannot clear the flag. That part is correct.
- **Fix:** run `post.context` through `cleanOutput`. Once #2 is fixed, accept the rest.

### Accepted limit, with two more ways it applies
Any input transcription clears the flag (accepted). The same rule also applies in two less obvious cases. (a) A transcription of audio captured *before* the plugin text was sent can arrive after it and clear the flag. (b) A typed turn that holds only a pasted image (`live:input`, `cleanInput`) also clears it, even though the image can carry injected text. 👂 mode refuses every tool call (`refuseCalls`), so room speech there does not matter.

### Checked and fine
- **Args check** (`checkArgs`): checks type, finite numbers, enum, required and 4000 characters, and drops unknown keys. `confirmed` is reserved. Args go to the script only as JSON on stdin. The command string comes only from tools.json, so Gemini cannot inject into `/bin/sh -c`. A non-object `args` becomes `{}`.
- **Re-hash before spawn:** `trustedNow` runs after the args check and before both spawn paths, and a hash error fails closed. The selftest covers an untrusted or changed hash.
- **Env:** the script sees only `PATH`, `HOME`, `IRIS_PLUGIN_ROOT`, `IRIS_PLUGIN_DATA` (plus the shell's `PWD`, `SHLVL`, `_`). I checked this with a test run. `GEMINI_API_KEY` is not passed. A trusted script can still read `~/.open-iris/.env`, and the new `trust.warning` says so.
- **Tool names:** plugin ids always contain `__`, while desktop and skill names do not, and desktop tools come first in `enabledTools`. No collision is possible. `TAINT_GATED` covers all five action tools in `TOOL_DEFAULTS`. The other four tools only read.
- **Sessions:** a reconnect or resume keeps the flag. A new Start or ↺ makes a new flag, kills late processes and drops late results (`h === hooks && c === convo`).
- **IPC:** no new handler. `config:plugin` now takes `tools`, and `writeConfig` sends it through `clean()`, then `cleanPluginConfig`, which accepts only names matching `TOOL_NAME` and turns `on` into a boolean. `plugins:list` now also returns the command text, which is needed for the trust list.
- **Limits:** at most 2 late processes and 1 per tool, output capped at 64 KB raw and 8000 characters to Gemini, timeouts at most 30 s, `late` at most 30 min.

### Scans
| Scan | Result |
|---|---|
| Semgrep (p/javascript, p/nodejs, p/secrets), Docker | 0 findings, 104 rules, 163 files |
| Electronegativity (.mjs/.cjs copy) | only accepted checks. webPreferences and openExternal guards: none found |
| gitleaks, full history | 25 commits, no leaks |
| gitleaks, working tree | `.env` `generic-api-key` only (expected, gitignored) |
| pnpm audit --prod (high+) | No known vulnerabilities |
| Fuses (fresh `pnpm build`) | RunAsNode, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments: Disabled. `codesign --verify --deep` passes |
| Open ports (dev app running) | no Electron process listening |

### Compared with the scan earlier today
- **New:** #1 to #5, all from the plugin command tool feature.
- **Still fixed** (all controls hold): the fuses are off and the build is re-signed; `guard.mjs` and `web-contents-created` are in place, with `guard.selftest.mjs` in `test`; `setPermissionRequestHandler` is in place; no `'unsafe-inline'` in `src`.
- **Regressed:** none.

### Not scanned
- No live end-to-end injection run (plugin output to Gemini to a desktop tool) against the real model. #1 and #2 come from reading the code. The taint selftest covers the core gate.
- `--no-asar` and no signature are unchanged (accepted, INFO #5 below).
- `src/gesture/mouse.swift`: Semgrep runs JS rules only.
- gitleaks scanned local branches only.

---

## Earlier scans today

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

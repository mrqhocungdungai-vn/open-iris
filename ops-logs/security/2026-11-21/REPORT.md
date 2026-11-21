# Security scan 2026-11-21 (pre-push)

Two runs today. Run 1's raw output is in this folder (commit 919b6f3, which covered gallery:send and read_sent_file). Run 2 is in `run2/` and covers the 53 unpushed commits (`@{u}..HEAD`, up to 385d75b). Compared with `ops-logs/security/2026-11-20/REPORT.md` and with run 1.

## Result
- **No HIGH finding. No secret in the full history or in the unpushed range.** `scripts/security-scan.sh` exit 0.
- Semgrep: 104 rules, 193 files, 0 findings.
- Electronegativity: nothing outside ACCEPT. No webPreferences override, no openExternal with another URL.
- gitleaks: history 78 commits clean; unpushed 53 commits clean (`run2/gitleaks-unpushed.log`); working tree: one hit in the gitignored `.env`, as expected (redacted).
- pnpm audit --prod high+: no known vulnerabilities.
- Fuses (fresh build): RunAsNode, EnableNodeOptionsEnvironmentVariable and EnableNodeCliInspectArguments Disabled. codesign --verify --deep passes.
- Open ports: the app was running (pnpm dev); no Electron process listens.
- IPC: no new or changed ipcMain handler since run 1.
- Controls still in place: guard.mjs through web-contents-created, guard.selftest in `test`; permissions only media and clipboard-read; no 'unsafe-inline' in any of the 3 CSPs.

## Review of the new code
- 065a214, resume.mjs sentNote/resumeNote and main.mjs renewSession/onReconnect: sent paths are sent to Gemini again after a fresh resume or a deaf renew. No new sink; findings 2 and 4 are wider.
- 065a214, gallery:send sends a live:event with the base name and kind, built in main, shown with textContent only. Safe.
- 4931da3 and 385d75b, convo-ui.js and convo.css: emoji from a fixed map, textContent, no innerHTML. Safe.

## Findings
1. MEDIUM, carried over: read_sent_file follows symlinks and reads FIFOs and devices (src/main/gallery-send.mjs sentFileParts). Fix: lstat, read regular files only. Owner: iris-core.
2. LOW, carried over, wider: paths reach Gemini unescaped (main.mjs gallery:send, resume.mjs sentNote/resumeNote). Fix: JSON.stringify each path. Owner: iris-core.
3. LOW, carried over: the size check and the read open the file separately, and the read has no cap (gallery-send.mjs). Fix: open once, fstat, read up to the limit. Owner: iris-core.
4. LOW, carried over, wider: sentFiles is not cleared in stopLive, and earlier paths are sent again after a fresh resume (main.mjs). Fix: clear it in stopLive. Owner: iris-core.
5. LOW, carried over: sent file text skips cleanOutput (gallery-send.mjs). Owner: iris-core.
6. LOW, new: sentFiles has no cap, and a path is added before sendParts succeeds (main.mjs gallery:send). Fix: add after a successful send, cap the set. Owner: iris-core.

## Fixed after run 2
All 6 in ef142ae (history id `2026-11-21-security-gallery-send-hardening`). Tests: gallery-send.selftest.mjs (symlink, FIFO, file growing after the check, escaped names) and resume.selftest.mjs (escaped paths); `pnpm test` 128/128. Findings 4 and 6 are in main.mjs and have no unit test.

## Not scanned
- No live test of read_sent_file with a symlink or FIFO before the fix; findings came from reading the code.
- Plugin and hooks code not reviewed again: no change since run 1.

#!/usr/bin/env bash
# Pre-release security scan for open-iris. Raw output goes to ops-logs/security/<date>/.
# Usage: scripts/security-scan.sh [--no-build]   (exit 1 if any scan finds something)
# Needs: docker (colima) for Semgrep, gitleaks, pnpm, npx.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="ops-logs/security/$(date +%F)"; mkdir -p "$OUT"
FAIL=()
step() { printf '\n== %s\n' "$1"; }

step "docker"
docker info >/dev/null 2>&1 || colima start || { echo "docker is not available"; exit 2; }

step "1a semgrep (p/javascript p/nodejs p/secrets)"
# Stream only the scanned folders in with tar: colima does not mount /Volumes, and .env never enters the container.
# shortcut: image tag is :latest, pin a digest once the scan runs in CI
tar -c src scripts eval | docker run --rm -i semgrep/semgrep:latest sh -c 'mkdir -p /scan && cd /scan && tar -x &&
  semgrep scan --config p/javascript --config p/nodejs --config p/secrets --metrics=off --error src scripts eval' \
  >"$OUT/semgrep.txt" 2>"$OUT/semgrep.log" || FAIL+=("semgrep")
tail -n 5 "$OUT/semgrep.log"

step "1b electronegativity"
# It reads only js/jsx/ts/tsx/html (src/util/file.js), so scan a copy with .mjs/.cjs renamed to .js.
EN=$(mktemp -d); cp -R src "$EN/"
find "$EN/src" \( -name '*.mjs' -o -name '*.cjs' \) -exec sh -c 'mv "$1" "${1%.*}.js"' _ {} \;
npx -y @doyensec/electronegativity -i "$EN/src" -o "$OUT/electronegativity.csv" >"$OUT/electronegativity.log" 2>&1 \
  || FAIL+=("electronegativity-run")
rm -rf "$EN"
# Accepted: these checks fire when webPreferences leave Electron's safe defaults implicit (contextIsolation, sandbox, no
# nodeIntegration since Electron 20; remote gone since 14), plus the accepted CSP img-src file:, the preload bridge and the
# fixed-URL openExternal. The grep guards below fail the scan if someone really weakens one of them.
ACCEPT='CSP_GLOBAL_CHECK|NODE_INTEGRATION_JS_CHECK|CONTEXT_ISOLATION_JS_CHECK|SANDBOX_JS_CHECK|REMOTE_MODULE_JS_CHECK|AUXCLICK_JS_CHECK|PRELOAD_JS_CHECK|OPEN_EXTERNAL_JS_CHECK'
tail -n +2 "$OUT/electronegativity.csv" 2>/dev/null | grep -vE "^($ACCEPT)," >"$OUT/electronegativity-open.txt" && FAIL+=("electronegativity")
grep -rnE "nodeIntegration|contextIsolation|sandbox *:|webSecurity|allowRunningInsecureContent|experimentalFeatures" src \
  --include='*.mjs' --include='*.cjs' --include='*.js' >"$OUT/webprefs-overrides.txt" && FAIL+=("webPreferences-override")
grep -rn "openExternal(" src | grep -v 'openExternal(`x-apple.systempreferences:' >"$OUT/openexternal-open.txt" && FAIL+=("openExternal")

step "2 gitleaks (full history + working tree)"
command -v gitleaks >/dev/null || { echo "gitleaks missing: brew install gitleaks"; exit 2; }
GL=(gitleaks)
"${GL[@]}" git --redact --no-banner --report-format json --report-path "$OUT/gitleaks-history.json" . \
  >"$OUT/gitleaks-history.log" 2>&1 || FAIL+=("gitleaks-history")
"${GL[@]}" dir --redact --no-banner --report-format json --report-path "$OUT/gitleaks-tree.json" . \
  >"$OUT/gitleaks-tree.log" 2>&1
# A hit in the gitignored .env is expected; anything else fails.
node -e 'const h=require(process.argv[1]).filter(f=>!/(^|\/)\.env$/.test(f.File));for(const f of h)console.log(f.File+":"+f.StartLine+" "+f.RuleID);process.exit(h.length?1:0)' \
  "$PWD/$OUT/gitleaks-tree.json" >"$OUT/gitleaks-tree-unexpected.txt" || FAIL+=("gitleaks-tree")

step "3 pnpm audit --prod (high+)"
pnpm audit --prod --audit-level high >"$OUT/pnpm-audit.txt" 2>&1 || FAIL+=("pnpm-audit")

step "4a packaged fuses"
APP=out/open-iris-darwin-arm64/open-iris.app
[ "${1:-}" = --no-build ] || pnpm build >"$OUT/build.log" 2>&1 || FAIL+=("build")
if [ -d "$APP" ]; then
  npx -y @electron/fuses read --app "$APP" >"$OUT/fuses.txt" 2>&1
  grep -E "(RunAsNode|EnableNodeOptionsEnvironmentVariable|EnableNodeCliInspectArguments) is Enabled" "$OUT/fuses.txt" && FAIL+=("fuses")
else echo "no $APP" >"$OUT/fuses.txt"; FAIL+=("fuses-missing-app"); fi

step "4b open ports (app must be running)"
PIDS=$(pgrep -f 'open-iris\.app/Contents/|open-iris/node_modules/.*/Electron' | paste -sd, -) # Electron processes only, not shells in the repo
if [ -n "$PIDS" ]; then
  lsof -nP -iTCP -sTCP:LISTEN -a -p "$PIDS" >"$OUT/ports.txt" 2>&1 && FAIL+=("ports")
else echo "app not running: port check skipped" >"$OUT/ports.txt"; fi

step "4c IPC + navigation inventory (for manual review)"
{ echo "# ipcMain handlers"; grep -rn "ipcMain\.\(handle\|on\|once\)" src
  echo; echo "# preload calls"; grep -n "ipcRenderer\.\(invoke\|send\|on\)" src/preload/preload.cjs
  echo; echo "# BrowserWindow / webPreferences"; grep -rn "new BrowserWindow\|webPreferences\|nodeIntegration\|contextIsolation\|sandbox:" src
  echo; echo "# navigation guards"; grep -rn "setWindowOpenHandler\|will-navigate\|will-redirect" src || echo "NONE"
  echo; echo "# sinks"; grep -rn "shell\.openExternal\|child_process\|execFile\|spawn(\|innerHTML\|eval(" src --include=*.mjs --include=*.cjs --include=*.js
} >"$OUT/ipc-inventory.txt" 2>&1

step "result"
if [ ${#FAIL[@]} -eq 0 ]; then echo "clean -> $OUT"; exit 0; fi
echo "needs triage: ${FAIL[*]} -> $OUT"; exit 1

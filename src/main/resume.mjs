// Keeps one Live session alive across dropped connections (docs/session-plan.md, S2). Knows nothing about Electron or hooks:
// main gives it connect(handle) → session, and reports server updates and closes. Close codes come from the S0 spike.

// 1007 "API key not valid" = bad key. Quota text is from the docs; S0 could not trigger it.
// Any other 1007 on a fresh connection (e.g. "Thinking level must be specified") is a setup error: retrying cannot help.
// 1008 "models/x is not found … or is not supported for bidiGenerateContent" = wrong or unavailable model: fatal too ("session not found" is not).
const fatal = (c, handle) => (c?.code === 1007 && (/api key/i.test(c?.reason || "") || !handle)) || (c?.code === 1008 && /is not found|not supported for bidiGenerateContent/i.test(c?.reason || "")) || /exhausted|quota/i.test(c?.reason || "");
// Start a fresh session at once when the handle is useless: 1008 "session not found" = invalid or expired handle;
// 1011 "Deadline expired" = server's 58 min session cap. Resume after it connects but dies ~2 min later with 1008 (spike, 2026-11-20).
const staleHandle = (c) => (c?.code === 1008 && /session not found/i.test(c?.reason || "")) || c?.code === 1007 /* with a handle: fatal() catches it without */ || (c?.code === 1011 && /deadline expired/i.test(c?.reason || ""));

export function createResumer({ connect, onReconnect, onGiveUp, log = () => {}, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, maxAttempts = 5 }) {
  let gen = 0, live = false, handle = null, attempts = 0, timer = null;

  // A connect that lands after stop() belongs to no session: close it.
  async function attempt(g) {
    let s;
    try { s = await connect(handle, () => g === gen); } catch (e) { if (g === gen) closed({ reason: e?.message || String(e) }); return null; }
    if (g !== gen) { try { s?.close(); } catch {} return null; }
    onReconnect?.(s, handle);
    return s;
  }

  function giveUp(c) { live = false; log("WARN", `resume: giving up (${c?.code ?? ""} ${c?.reason ?? ""})`); onGiveUp?.(c); }

  function closed(c) {
    if (!live || timer) return;
    if (fatal(c, handle)) return giveUp(c);
    if (staleHandle(c)) handle = null;
    if (++attempts > maxAttempts) return giveUp(c);
    if (attempts >= 3) handle = null; // the handle itself may be what fails
    const delay = Math.min(500 * 2 ** (attempts - 1), 8000);
    log("INFO", `resume: reconnect ${attempts}/${maxAttempts} in ${delay}ms ${handle ? "with handle" : "fresh"} (close ${c?.code ?? ""} ${c?.reason ?? ""})`);
    const g = gen;
    timer = setTimeout(() => { timer = null; attempt(g); }, delay);
  }

  return {
    // First connect: errors go to the caller (bad key shows in the UI), no retry.
    async start() {
      gen++; live = true; handle = null; attempts = 0;
      const g = gen, s = await connect(null, () => g === gen); // current(): false once stop() or a newer start() ran
      if (g !== gen) { try { s?.close(); } catch {} return null; }
      return s;
    },
    stop() { gen++; live = false; handle = null; attempts = 0; clearTimeout(timer); timer = null; },
    // A resumable handle means the session is healthy again, so the attempt count resets.
    update(u) { if (live && u?.resumable && u.newHandle) { handle = u.newHandle; attempts = 0; } },
    closed,
    get handle() { return handle; },
    get live() { return live; }, // false after stop() or give-up
  };
}

// "↺ Làm mới": drop the session for a new one with no handle and the same setup (connect is the same closure).
// stop() first, so a reconnect timer or a connect still in flight cannot bring the old one back.
export async function freshSession(resumer, old) {
  resumer.stop();
  try { old?.close(); } catch { /* ignore close races */ }
  return resumer.start();
}

// freshSession for main: Stop then Start during the connect swaps main's resumer (current() !== r), so whatever this
// connect returns or throws belongs to no one: close it and report stale, so main leaves the new session alone.
export async function renewFresh(r, old, current) {
  let s;
  try { s = await freshSession(r, old); } catch (e) { if (current() === r) throw e; return { stale: true }; }
  if (current() === r) return { session: s };
  try { s?.close(); } catch {}
  return { stale: true };
}

// Silent note after a reconnect (S3): what the model cannot know from its own history. S0 showed a cut-off tool call
// is not re-issued, and the model keeps waiting for it unless told.
export function resumeNote({ handle, lost = [], listenOnly = false, looking = "" }) {
  return [
    handle ? "[session] The connection dropped and was restored; the conversation continues." : "[session] The connection dropped and you are now in a new session: the earlier conversation is lost.",
    lost.length && `The tool call(s) ${lost.join(", ")} were cut off and their results are lost; check before repeating them.`,
    listenOnly && "Listen mode is still ON.",
    looking && `[gallery] The user is looking at the image ${looking}.`,
  ].filter(Boolean).join(" ");
}

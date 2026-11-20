// Keeps one Live session alive across dropped connections (docs/session-plan.md, S2). Knows nothing about Electron or hooks:
// main gives it connect(handle) → session, and reports server updates and closes. Close codes come from the S0 spike.

// 1007 = bad API key. Quota text is from the docs; S0 could not trigger it.
const fatal = (c) => c?.code === 1007 || /exhausted|quota/i.test(c?.reason || "");
// 1008 "BidiGenerateContent session not found" = invalid or expired handle: start a fresh session at once.
const staleHandle = (c) => c?.code === 1008 && /session not found/i.test(c?.reason || "");

export function createResumer({ connect, onReconnect, onGiveUp, log = () => {}, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, maxAttempts = 5 }) {
  let gen = 0, live = false, handle = null, attempts = 0, timer = null;

  // A connect that lands after stop() belongs to no session: close it.
  async function attempt(g) {
    let s;
    try { s = await connect(handle); } catch (e) { if (g === gen) closed({ reason: e?.message || String(e) }); return null; }
    if (g !== gen) { try { s?.close(); } catch {} return null; }
    onReconnect?.(s, handle);
    return s;
  }

  function giveUp(c) { live = false; log("WARN", `resume: giving up (${c?.code ?? ""} ${c?.reason ?? ""})`); onGiveUp?.(c); }

  function closed(c) {
    if (!live || timer) return;
    if (fatal(c)) return giveUp(c);
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
      const g = gen, s = await connect(null);
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

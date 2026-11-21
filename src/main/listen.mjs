// Listen-only mode (👂 in the main window and the HUD): Iris keeps hearing the mic for context but does not speak or act.
// The notices are silent notes: a fixed announcement clip tells the user (announce.mjs), Iris only learns the state.
// main.mjs enforces the silence by dropping Iris's output and refusing tools.
export const LISTEN_ON_EVENT = "SYSTEM_EVENT_LISTEN_ON: Listen mode is now ON. Keep listening to understand the context, but do not reply, do not speak and do not call any tool until listen mode ends.";
export const LISTEN_OFF_EVENT = "SYSTEM_EVENT_LISTEN_OFF: Listen mode is now OFF. Answer normally from the next time you are spoken to.";

// A state note for Iris with no turn of its own, so Iris does not answer it (sendClientContent payload).
export const silentNote = (text) => ({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false });

// Every tool call is refused, so Iris cannot act while it should only listen.
export const refuseCalls = (calls) => calls.map(({ id, name }) => ({ id, name, response: { error: "Refused: listen mode is on." } }));

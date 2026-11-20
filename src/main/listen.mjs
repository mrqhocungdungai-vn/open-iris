// Listen-only mode (👂 in the main window and the HUD): Iris keeps hearing the mic for context but does not speak or act.
// The notices are full turns, so Iris says the new state aloud (like the hand control switch) and knows why it then gets no turn; main.mjs enforces it by dropping Iris's output and refusing tools.
export const LISTEN_ON_EVENT = "SYSTEM_EVENT_LISTEN_ON: Listen mode is now ON. Tell the user in one short sentence. After that, keep listening to understand the context, but do not reply, do not speak and do not call any tool until listen mode ends.";
export const LISTEN_OFF_EVENT = "SYSTEM_EVENT_LISTEN_OFF: Listen mode is now OFF. Tell the user in one short sentence, then answer normally from the next time you are spoken to.";

// Every tool call is refused, so Iris cannot act while it should only listen.
export const refuseCalls = (calls) => calls.map(({ id, name }) => ({ id, name, response: { error: "Refused: listen mode is on." } }));

// Livestream feature, ported from myiris (electron/gemini-prompts.mjs, recap.mjs, live-messages.mjs):
// the co-host prompt with today's topic, the spoken recap every 5 minutes, and listen-only mode.

export const TOPIC_MAX = 200;
export const RECAP_MS = 5 * 60_000;
export const QUIET_MS = 4000;

// IPC/file trust boundary: one line, trimmed, capped.
export const cleanTopic = (t) => (typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, TOPIC_MAX) : "");

// Appended to the system instruction at connect, so a new topic or switch applies from the next Start.
// The language follows the Language setting (live-config.mjs), so no language rule here.
export function cohostBrief(topic, recap) {
  return " Livestream mode: you are the voice co-host on the owner's livestream. You talk with the host live while the audience listens."
    + " Livestream style: lively, warm and engaging; keep each answer to 1-3 short spoken sentences so the stream keeps moving; no markdown, lists or emoji, everything you produce is spoken aloud."
    + (topic ? ` Today's livestream topic: ${topic}.` : " Today's livestream topic was not given; infer it from what is being discussed.")
    + (recap ? " Recap rule: when you receive SYSTEM_EVENT_RECAP, speak right away, 3-4 short sentences: briefly recap what was discussed over the last few minutes, restate today's topic for viewers who just joined, then end with a call to action (follow, like, share, comment a question, invite friends...). Make the call to action feel human: tie it to what was just said, vary the wording and the ask every time, never repeat a previous one, and never mention that this is a scheduled recap." : "");
}

export const RECAP_EVENT = "SYSTEM_EVENT_RECAP: Do the periodic livestream recap now, following your recap rule. Speak it out loud immediately.";
export const LISTEN_ON_EVENT = "SYSTEM_EVENT_LISTEN_ON: Listen mode is on. Keep listening to understand the context, but do not reply, do not speak and do not call any tool until listen mode ends.";
export const LISTEN_OFF_EVENT = "SYSTEM_EVENT_LISTEN_OFF: Listen mode is off. Do not reply to this notice; answer normally from the next time you are spoken to.";

// Fires send() once intervalMs has passed AND nobody (user or Iris) has spoken for quietMs; while someone talks it waits, it never skips.
export function createRecap({ intervalMs = RECAP_MS, quietMs = QUIET_MS, send, now = Date.now, setInterval: setTick = setInterval, clearInterval: clearTick = clearInterval }) {
  let tick = null;
  let lastRecapAt = 0;
  let lastActivityAt = 0;
  function check() {
    const t = now();
    if (t - lastRecapAt >= intervalMs && t - lastActivityAt >= quietMs) {
      lastRecapAt = lastActivityAt = t;
      send();
    }
  }
  return {
    start() {
      lastRecapAt = lastActivityAt = now();
      if (tick) return;
      tick = setTick(check, 1000);
      tick.unref?.();
    },
    stop() {
      if (tick) clearTick(tick);
      tick = null;
    },
    markActivity() {
      lastActivityAt = now();
    },
  };
}

// Listen-only: every tool call is refused, so Iris cannot act while it should only listen.
export const refuseCalls = (calls) => calls.map(({ id, name }) => ({ id, name, response: { error: "Refused: listen mode is on." } }));

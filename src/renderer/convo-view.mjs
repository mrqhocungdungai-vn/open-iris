// Conversation view model shared by the main window (renderer.js), the 💬 chat window (gesture/chat.js).
// Pure, no DOM. Events are main's live:event payloads (AG-UI type names, see docs/chat-ui-plan.md §2).
// Turns are never mutated: a changed turn is a new object, so a renderer can keep one element per turn object.
export const MAX_TURNS = 200;

const openIris = (t) => t?.kind === "iris" && !t.done;
const replaceLast = (turns, t) => [...turns.slice(0, -1), t];
const push = (turns, t) => [...turns, t].slice(-MAX_TURNS);
const newIris = () => ({ kind: "iris", tools: [], text: "", done: false, interrupted: false });

export function reduce(turns, e) {
  const last = turns.at(-1);
  switch (e?.type) {
    case "TEXT_MESSAGE_CONTENT": {
      if (e.role === "assistant") return openIris(last) ? replaceLast(turns, { ...last, text: last.text + e.delta }) : push(turns, { ...newIris(), text: e.delta });
      // Spoken chunks glue onto the same spoken turn; a typed turn is always its own.
      if (e.via === "voice" && last?.kind === "you" && last.via === "voice") return replaceLast(turns, { ...last, text: last.text + e.delta });
      return push(turns, { kind: "you", via: e.via, text: e.delta, files: e.files || [] });
    }
    case "TOOL_CALL_START": {
      const tool = { id: e.toolCallId, name: e.toolCallName, source: e.source, state: "run", ms: 0, error: "" };
      return openIris(last) ? replaceLast(turns, { ...last, tools: [...last.tools, tool] }) : push(turns, { ...newIris(), tools: [tool] });
    }
    case "TOOL_CALL_RESULT": {
      const i = turns.findLastIndex((t) => t.kind === "iris" && t.tools.some((x) => x.id === e.toolCallId));
      if (i < 0) return turns; // its turn was capped away or cleared
      const t = turns[i];
      const tools = t.tools.map((x) => (x.id === e.toolCallId ? { ...x, state: e.ok ? "ok" : "fail", ms: e.ms, error: e.error || "" } : x));
      return turns.with(i, { ...t, tools });
    }
    case "RUN_FINISHED":
      return openIris(last) ? replaceLast(turns, { ...last, done: true, interrupted: !!e.interrupted }) : turns;
    case "RUN_ERROR":
      return push(turns, { kind: "error", text: e.message });
    case "CUSTOM":
      if (e.name !== "session") return turns;
      // A session end also ends the Iris turn it cut.
      return push(openIris(last) ? replaceLast(turns, { ...last, done: true }) : turns, { kind: "session", phase: e.value?.phase, code: e.value?.code ?? null, reason: e.value?.reason || "" });
  }
  return turns;
}


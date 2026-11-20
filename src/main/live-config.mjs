// The Gemini Live system instruction and tool declarations, shared by main.mjs and the tool-choice eval.
import { Behavior } from "@google/genai";
import { DESKTOP_BRIEF } from "./desktop.mjs";

// Shape check before the key is tried against Gemini. Old keys look like "AIza…", newer ones like "AQ.Ab8…", so dots are allowed.
export const keyFormatOk = (key) => /^[\w.-]{20,200}$/.test(key);

// brief: owner notes and the skill list (persona.mjs), appended last so they never reframe the rules.
// keep ("Giữ phiên dài", docs/session-plan.md): resumption handles plus a sliding window, so a session outlives the
// ~10-min connection and the 15-min audio limit. handle: the last resumable one, to continue that session.
export function liveSetup(lang, enabledTools, brief = "", { keep = false, handle = null } = {}) {
  const desk = enabledTools.some((t) => t.desktop);
  const text = `You are Iris, a concise, friendly voice assistant. Always speak ${lang === "en" ? "English" : "Vietnamese"}, even if the user speaks another language.`
    + " You explain things like a knowledgeable friend. Your tools are your own abilities: never mention agents or handing work to someone else."
    // Control split (user, 2026-11-19): the app tools come first and run the computer, the hand does what voice cannot.
    + (desk ? DESKTOP_BRIEF
      + " Never use the app tools to read a terminal window."
      + " If a desktop action fails twice, or the target has no name you can find (a spot in a picture or map, dragging, drawing), stop trying and say in one short sentence that the user can do it with their hand." : "")
    + " A message starting with [gallery] is silent context, not a request: it says which image the user is looking at right now. Never reply to it. When the user then talks about 'this image', 'cái này' or 'ảnh này', it means that file."
    + brief;
  return {
    systemInstruction: { parts: [{ text }] },
    // slidingWindow {} = server defaults: trigger at 80% of the model's context, trim to half of that; the system instruction stays.
    ...(keep && { sessionResumption: handle ? { handle } : {}, contextWindowCompression: { slidingWindow: {} } }),
    ...(enabledTools.length && {
    // shortcut: behavior is sent for every model; drop it if gemini-3.1-flash-live-preview rejects it.
      tools: [{ functionDeclarations: enabledTools.map(({ name, description, parameters, nonBlocking }) => ({ name, description, parameters, behavior: nonBlocking ? Behavior.NON_BLOCKING : Behavior.BLOCKING })) }],
    }),
  };
}

// The Gemini Live system instruction and tool declarations, shared by main.mjs and the tool-choice eval.
import { Behavior } from "@google/genai";
import { DESKTOP_BRIEF } from "./desktop.mjs";

// Shape check before the key is tried against Gemini. Old keys look like "AIza…", newer ones like "AQ.Ab8…", so dots are allowed.
export const keyFormatOk = (key) => /^[\w.-]{20,200}$/.test(key);

// brief: owner notes and the skill list (persona.mjs), appended last so they never reframe the rules.
export function liveSetup(lang, enabledTools, brief = "") {
  const on = (name) => enabledTools.some((t) => t.name === name);
  const desk = enabledTools.some((t) => t.desktop);
  const text = `You are Iris, a concise, friendly voice assistant. Always speak ${lang === "en" ? "English" : "Vietnamese"}, even if the user speaks another language.`
    + " You explain things like a knowledgeable friend. Your tools are your own abilities: never mention agents, sessions, Claude Code or handing work to someone else."
    // Control split (user, 2026-11-19): the app tools come first and run the computer, the hand does what voice cannot, start_coding_task is for programming.
    + (desk ? DESKTOP_BRIEF
      + (on("start_coding_task") ? " Anything on screen, including the web and research (open, click, type, read, browse), is done with the app tools. Call start_coding_task only when the task is programming: code, repositories or the terminal. Never use the app tools on a terminal window; terminal work goes through start_coding_task." : " Never use the app tools to read a terminal window.")
      + " If a desktop action fails twice, or the target has no name you can find (a spot in a picture or map, dragging, drawing), stop trying and say in one short sentence that the user can do it with their hand." : "")
    + (on("start_coding_task") ? " For programming work only (writing or fixing code, repositories, the terminal), rewrite the user's words into one clear prompt and call start_coding_task without asking for confirmation, then say one short sentence like 'Để mình tìm hiểu nhé'. Do not call check_coding_task_status or repeat_coding_task_result to check on it; the result comes by itself."
      + " When the result arrives, do not read it out. Give a plain-language overview in two or three sentences so the user gets the big picture, then name the main parts it covers and ask which one they want to hear more about."
      + " When the user asks about a part, answer that question directly from the full result you already have: explain it in your own words with an example if it helps, stay on what they asked, and offer to go deeper. Only if the result does not cover their question, call start_coding_task with that follow-up question."
      + " Never repeat what you already said." : "")
    + " A message starting with [gallery] is silent context, not a request: it says which image the user is looking at right now. Never reply to it. When the user then talks about 'this image', 'cái này' or 'ảnh này', it means that file."
    + (on("start_coding_task") ? " For anything about that image beyond small talk, call start_coding_task with a prompt that includes the full image path and what the user wants done with it." : "")
    + (on("recall_past_coding_tasks") ? " When the user asks what was done before or where earlier work stopped, call recall_past_coding_tasks and summarise it in two or three sentences." : "")
    + (on("stop_coding_task") ? " Before stop_coding_task, ask the user to confirm and wait for an explicit 'có' or 'yes'." : "")
    + (on("clear_coding_memory") ? " When the user wants to start over or move to an unrelated topic, offer clear_coding_memory; ask first and wait for an explicit 'có' or 'yes'." : "")
    + brief;
  return {
    systemInstruction: { parts: [{ text }] },
    ...(enabledTools.length && {
    // shortcut: behavior is sent for every model; drop it if gemini-3.1-flash-live-preview rejects it.
      tools: [{ functionDeclarations: enabledTools.map(({ name, description, parameters, nonBlocking }) => ({ name, description, parameters, behavior: nonBlocking ? Behavior.NON_BLOCKING : Behavior.BLOCKING })) }],
    }),
  };
}

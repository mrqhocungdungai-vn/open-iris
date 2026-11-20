// Desktop control for Gemini Live: tools backed by the agent-desktop CLI (vercel-labs/agent-desktop), reimplemented
// from the test-agentdesktop-with-iris PoC. Each call runs the binary once and returns its JSON envelope.
// Snapshots are on-screen content and go to Gemini: the user chose this (2026-11-18), on by default since 2026-11-19.
// shortcut: no app blocklist, the user tests on a clean machine; add one before using it with personal data.
import { execFile } from "node:child_process";
import path from "node:path";

const BIN = path.join(import.meta.dirname, "../../node_modules/agent-desktop/bin/agent-desktop");
// shortcut: hard cap on what goes back to the model; teach it --root drilling if dense apps get cut off.
const MAX_CHARS = 20000;
const MAX_REPEATS = 3; // the same call over and over is the model looping (54 snapshots in the PoC, 2026-11-18)

const str = (description) => ({ type: "string", description });
const REF = str("Qualified ref from the latest snapshot, e.g. @s8f3k2p9:e8");
const CONFIRMED = (what) => ({ type: "boolean", description: `true only after the user confirmed ${what} out loud` });

const TOOLS = {
  list_running_apps: {
    description: "List running GUI applications.",
    parameters: {},
    argv: () => ["list-apps"],
  },
  open_or_focus_app: {
    description: "Launch or bring forward an application by name and wait for its window.",
    parameters: { app: str("Application name, e.g. Finder, Notes, Safari") },
    required: ["app"],
    argv: ({ app }) => ["launch", app, "--activate"],
  },
  scan_app_controls: {
    description: "Read an app's interactive UI elements. Each element has a ref to act on. Without root you get a shallow map; pass a region's ref as root to see inside it. Call again after every action to verify. Lists buttons and fields, not the text of messages or documents: to read those, use read_app_text.",
    parameters: { app: str("Application name"), root: str("Optional ref to read only that region") },
    required: ["app"],
    // Full trees of apps like Notes overflow MAX_CHARS and the editor gets cut off, so start shallow and drill.
    argv: ({ app, root }) => ["snapshot", "--app", app, "-i", "--compact", ...(root ? ["--root", root] : ["--skeleton"])],
  },
  find_app_control: {
    description: "Find elements by role and/or text and get their refs, e.g. role textarea to find a note or message body before typing.",
    parameters: { app: str("Application name"), role: str("Optional role: textarea, textfield, button, checkbox ..."), text: str("Optional text in name, value or title") },
    required: ["app"],
    argv: ({ app, role, text }) => ["find", "--app", app, ...(role ? ["--role", role] : []), ...(text ? ["--text", text] : [])],
  },
  read_app_text: {
    description: "Read the text shown in an app as plain text: messages, chat replies, documents, web pages. Call it directly to read, with no scan first. Pass a region's ref as root to read only that part.",
    parameters: { app: str("Application name"), root: str("Optional ref of a region to read") },
    required: ["app"],
    // No -i: static text (a chat reply) is not interactive. Web views nest ~25 deep; 50 is the CLI maximum.
    argv: ({ app, root }) => ["snapshot", "--app", app, "--compact", "--max-depth", "50", ...(root ? ["--root", root] : [])],
  },
  click_app_control: {
    description: "Click an element by ref. Clicking Send, Submit, Delete, Buy or similar needs confirmed true, which you may set only after the user said yes out loud.",
    parameters: { ref: REF, confirmed: CONFIRMED("this risky click") },
    required: ["ref"],
    argv: ({ ref }) => ["click", ref],
  },
  pick_list_option: {
    description: "Pick an option in a dropdown, popup menu or list by the option's text.",
    parameters: { ref: str("Qualified ref of the dropdown or list itself"), value: str("Text of the option to pick") },
    required: ["ref", "value"],
    argv: ({ ref, value }) => ["select", ref, value],
  },
  type_into_text_field: {
    description: "Insert text into a text field by ref. Adds to what is already there unless replace is true.",
    parameters: {
      ref: REF, text: str("Text to insert"), app: str("Application name the field belongs to"),
      replace: { type: "boolean", description: "true to erase the field first: when correcting or retyping text you typed, or for an address or search box" },
    },
    required: ["ref", "text", "app"],
  },
  press_key_combo: {
    description: "Send a key combo to an app, e.g. return, escape, cmd+n. Return or enter can send a message, so it needs confirmed true, which you may set only after the user said yes out loud.",
    parameters: {
      combo: str("Key combo"), app: str("Target application name"), confirmed: CONFIRMED("pressing return or enter"),
      ref: { type: "string", description: "Qualified ref of the field the keys are for. Give it when pressing return after typing, e.g. the address bar or search box you just typed into" },
    },
    required: ["combo", "app"],
    argv: ({ combo, app }) => ["press", combo, "--app", app],
  },
};

export const DESKTOP_BRIEF =
  " You can operate the user's Mac with the app tools (open_or_focus_app, find_app_control, click_app_control, type_into_text_field and the rest). " +
  "Stay in the app the user is working in, the one they last asked you to open or use: a request like 'write a prompt' or 'ask it' is about that app. " +
  "Never switch to another app, such as a web browser, unless the user names it; if you are not sure which app or what they mean, ask. To get a text field or button, call find_app_control directly; " +
  "use scan_app_controls only when you need to see the layout or to verify a result. " +
  "To read what is written on screen (a reply, a message, a document), call read_app_text; never select and copy text with key presses. " +
  "Refs expire after the UI changes; on STALE_REF find again. Only retry an action when error.disposition.retry is 'safe'. " +
  "To pick an option in a dropdown or list, find it (find_app_control role combobox or list) and call pick_list_option with the option text; never type into a dropdown or press return to choose. " +
  "To type, first get the ref of the text area or text field itself (find_app_control with role textarea or textfield), not a row or cell. " +
  "type_into_text_field adds to the text already in the field. Set replace true when the user corrects or asks you to retype what you typed, or for an address or search box; " +
  "leave it false when the user wants to add to text that is already there, and never erase text you did not type unless asked. " +
  "To submit what you typed (search, address bar, chat box), call press_key_combo return with ref set to that same field. " +
  "Never say an action happened unless its tool result was ok. " +
  "If typing fails, do not click Send, submit or press return: stop and tell the user typing failed. " +
  "Ask the user before anything destructive (deleting, sending, purchasing).";

// Clicks that send, delete or pay. The model ignored "ask first" once (PoC round 2), so the tool enforces it.
// shortcut: matches the element's visible text only; an icon-only Send button still slips through.
const RISKY = /\b(send|submit|post|delete|remove|buy|pay|purchase|order)\b|gửi|xóa|xoá|mua|thanh toán/i;
// Iris said "searched"/"sent" on delivered_unverified results the user never saw happen (PoC rounds 3, 5, 6).
const VERIFY = "The input was delivered but its effect is not checked. Before telling the user it worked, call read_app_text or scan_app_controls and confirm the screen changed; if it did not, say so.";

// Electron/Chromium fields (Teams) accept a semantic type without applying it and agent-desktop reports
// ACTION_FAILED post_action_verification. Each way verifies its own result, so the first ok one wins.
// set-value comes before keystrokes: it replaces the whole value, so a half-typed earlier try can't double the text.
// --headed is last: physical keystrokes bring the app to the front and take the keyboard for a moment (user OK'd, 2026-11-18).
// shortcut: set-value and clear overwrite any draft already in the field; fine for compose boxes, revisit for editors.
const TYPE_WAYS = {
  "type": (ref) => ["type", ref, "--stdin"],
  "set-value": (ref) => ["set-value", ref, "--stdin"],
  "type --interval-ms": (ref) => ["type", ref, "--stdin", "--interval-ms", "30"],
  "type --headed": (ref) => ["--headed", "type", ref, "--stdin"],
};

// Chrome's address bar shows semantically typed text but return then does nothing; physical keystrokes work (tested 2026-11-19).
// shortcut: matched by app name; add other Chromium browsers here when they show the same problem.
const KEYSTROKE_APPS = /^(google chrome|chromium|microsoft edge|brave browser|arc|opera|vivaldi)$/i;

// One switch per tool; all on by default although they act on screen (user, 2026-11-19).
export const TOOL_DEFAULTS = {
  list_running_apps: true, open_or_focus_app: true, scan_app_controls: true, find_app_control: true, read_app_text: true,
  click_app_control: true, pick_list_option: true, type_into_text_field: true, press_key_combo: true,
};

// Trust boundary (config file / IPC): unknown names are dropped, values coerced to booleans.
export function cleanTools(t) {
  return Object.fromEntries(Object.keys(TOOL_DEFAULTS).map((k) => [k, t && k in t ? Boolean(t[k]) : TOOL_DEFAULTS[k]]));
}

// Registry entries: { name, description, parameters, desktop: true, run }.
// run() never throws and returns { ok, output } or { ok: false, error }. One instance per live session.
export function desktopTools(cli = runCli) {
  // shortcut: per app, in memory only, so each session re-learns it once (~2s for Teams); persist it if that bothers.
  const typeWins = new Map(); // app -> the way that last worked
  let lastCall = { key: "", count: 0 };

  // null when the field does not expose its value.
  async function fieldValue(ref) {
    const d = (await cli(["get", ref, "--property", "value"])).data;
    return typeof d === "string" ? d : (d?.value ?? null);
  }

  async function typeText({ ref, text, app, replace }) {
    const ways = Object.keys(TYPE_WAYS);
    let start = Math.max(0, ways.indexOf(KEYSTROKE_APPS.test(app ?? "") ? "type --headed" : typeWins.get(app)));
    // Retyping appended, piling text up in Chrome's address bar (PoC round 6). If clear fails, set-value replaces the value itself.
    if (replace && (await cli(["clear", ref])).ok === false) start = Math.max(start, ways.indexOf("set-value"));
    // Teams' composer ignored clear and the retype appended (log 2026-11-19), so check it and clear like a person: ⌘A, delete.
    // No read-back after: Teams reports its placeholder as the value and lags after delete, so a check failed fields that were cleared (log 2026-11-19); the model verifies instead.
    const selfCleared = replace && (await fieldValue(ref)) !== "";
    if (selfCleared) {
      await cli(["--headed", "focus", ref]);
      await cli(["press", "cmd+a", "--app", app]);
      await cli(["press", "delete", "--app", app]);
    }
    let r = null;
    for (const way of ways.slice(start)) {
      // A keystroke try that failed part way leaves some text; clear it so the headed try doesn't append.
      if (way === "type --headed" && r) await cli(["clear", ref]);
      r = await cli(TYPE_WAYS[way](ref), text);
      if (r.ok !== false) {
        typeWins.set(app, way);
        const out = way === "type" ? r : { fallback: way, ...r };
        return selfCleared ? { ...out, verify: VERIFY } : out;
      }
      // Only a field that ignored the text is worth another way; STALE_REF and the like go back to the model.
      // POLICY_DENIED: the field only offers SetValue (Telegram Lite, tested 2026-11-19), so set-value is next.
      if (way === "type" && r.error?.details?.kind !== "post_action_verification" && r.error?.code !== "POLICY_DENIED") return r;
    }
    return r;
  }

  // The whole tree is far over MAX_CHARS as JSON but small as text, so parse it uncut and keep only the words.
  // shortcut: keeps the end when the text is too long (newest chat message); pass root to read the start of a long document.
  async function readText(args) {
    const r = await cli(TOOLS.read_app_text.argv(args), "", Infinity);
    if (!r.data?.tree) return r;
    const text = treeText(r.data.tree);
    return { ok: true, ...(text.length > MAX_CHARS && { truncated: true }), text: text.slice(-MAX_CHARS) };
  }

  async function call(name, args) {
    const key = name + JSON.stringify(args);
    lastCall = { key, count: lastCall.key === key ? lastCall.count + 1 : 1 };
    if (lastCall.count > MAX_REPEATS) return { ok: false, error: { code: "LOOP", message: `You already made this exact call ${MAX_REPEATS} times. Do not repeat it; tell the user what you found or that you are stuck.` } };
    if (name === "type_into_text_field") return typeText(args);
    if (name === "read_app_text") return readText(args);
    if (name === "click_app_control" && !args.confirmed) {
      const label = JSON.stringify((await cli(["get", args.ref])).data ?? "");
      if (RISKY.test(label)) return { ok: false, error: { code: "NEEDS_CONFIRMATION", message: `This would click ${label}. Ask the user to confirm, then call again with confirmed true.` } };
    }
    // Return sent a Claude message unasked (PoC round 3). shortcut: gates every return, even a harmless new line or dialog OK.
    if (name === "press_key_combo" && !args.confirmed && /(^|\+)(return|enter)$/i.test(args.combo ?? "")) {
      return { ok: false, error: { code: "NEEDS_CONFIRMATION", message: `Pressing ${args.combo} may send or submit. Ask the user to confirm, then call again with confirmed true.` } };
    }
    if (name === "press_key_combo") return pressKeys(args);
    return cli(TOOLS[name].argv(args));
  }

  // Chrome's address bar ignored a headless return after typing: "ok" with no effect, later "no verified focused element" (log 2026-11-19).
  // With the field's ref, focus it and press physically like a person (--headed, user OK'd 2026-11-18); without one, go headed only when headless finds no focus.
  async function pressKeys({ combo, app, ref }) {
    const headed = async () => {
      const r = await cli(["--headed", ...TOOLS.press_key_combo.argv({ combo, app })]);
      return r.ok === false ? r : { ...r, verify: VERIFY };
    };
    if (ref) {
      const f = await cli(["--headed", "focus", ref]);
      return f.ok === false ? f : headed();
    }
    const r = await cli(TOOLS.press_key_combo.argv({ combo, app }));
    return r.ok === false && r.error?.code === "ACTION_FAILED" ? headed() : r;
  }

  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    parameters: { type: "object", properties: t.parameters, required: t.required || [] },
    desktop: true,
    run: async (args) => {
      const r = await call(name, args || {});
      if (r.ok === false) return { ok: false, error: r.error ?? r };
      return { ok: true, output: r.data?.disposition?.delivery === "delivered_unverified" ? { ...r, verify: VERIFY } : r };
    },
  }));
}

export function treeText(tree) {
  const lines = [];
  (function walk(n) {
    for (const t of [n.name, n.value]) if (typeof t === "string" && t.trim() && t.trim() !== lines.at(-1)) lines.push(t.trim());
    n.children?.forEach(walk);
  })(tree);
  return lines.join("\n");
}

function runCli(argv, stdin, maxChars = MAX_CHARS) {
  return new Promise((resolve) => {
    const child = execFile(BIN, argv, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      // The CLI prints its JSON envelope on stdout even when it exits non-zero.
      const text = stdout.trim();
      if (!text) return resolve({ ok: false, error: { message: (stderr || err?.message || "no output").trim() } });
      if (text.length > maxChars) return resolve({ ok: true, truncated: true, output: text.slice(0, maxChars) });
      try { resolve(JSON.parse(text)); } catch { resolve({ ok: false, output: text }); }
    });
    child.stdin.on("error", () => {}); // a binary that exits early: the callback above reports it
    // Typed text goes through stdin so it never shows up in process arguments.
    child.stdin.end(stdin ?? "");
  });
}

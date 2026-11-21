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
// Overlays outside the window tree. focused is the only one that reaches an app-modal alert; --surface alert missed it (TextEdit probe, 2026-11-21).
// shortcut: menu and popover left out, a menu never opened headless and popover is untested; add them when a log needs them.
const SURFACES = ["menubar", "sheet", "focused"];
const SURFACE = { type: "string", enum: SURFACES, description: "Instead of the window: sheet is Save/Open, focused an alert or dialog" };
// AMBIGUOUS_TARGET when no window of the app is focused; its error lists the windows (TextEdit probe, 2026-11-21).
const WINDOW = str("Id from an AMBIGUOUS_TARGET error");
const win = (id) => (id ? ["--window-id", id] : []);
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
    parameters: { app: str("Application name"), root: str("Optional ref to read only that region"), surface: SURFACE, window_id: WINDOW },
    required: ["app"],
    // Full trees of apps like Notes overflow MAX_CHARS and the editor gets cut off, so start shallow and drill.
    argv: ({ app, root, surface, window_id }) => ["snapshot", "--app", app, ...win(window_id), "-i", "--compact", ...(surface ? ["--surface", surface] : root ? ["--root", root] : ["--skeleton"])],
  },
  find_app_control: {
    description: "Find elements by role and/or text and get their refs, e.g. role textarea to find a note or message body before typing, role searchfield for a search box.",
    // "search field" was refused as INVALID_ARGS (log 2026-11-20): roles are one lowercase word as snapshots print them.
    parameters: { app: str("Application name"), role: str("Optional role, one lowercase word as a snapshot prints it: textarea, textfield, searchfield, button, link, checkbox, combobox, list, row, menuitem, tab"), text: str("Optional text in name, value or title"), surface: SURFACE, window_id: WINDOW },
    required: ["app"],
    argv: ({ app, role, text, surface, window_id }) => ["find", "--app", app, ...win(window_id), ...(surface ? ["--surface", surface] : []), ...(role ? ["--role", role] : []), ...(text ? ["--text", text] : [])],
  },
  read_app_text: {
    description: "Read the text shown in an app as plain text: messages, chat replies, documents, web pages. Call it directly to read, with no scan first. Pass a region's ref as root to read only that part.",
    parameters: { app: str("Application name"), root: str("Optional ref of a region to read"), surface: SURFACE, window_id: WINDOW },
    required: ["app"],
    // No -i: static text (a chat reply) is not interactive. Web views nest ~25 deep; 50 is the CLI maximum.
    argv: ({ app, root, surface, window_id }) => ["snapshot", "--app", app, ...win(window_id), "--compact", "--max-depth", "50", ...(surface ? ["--surface", surface] : root ? ["--root", root] : [])],
  },
  click_app_control: {
    description: "Click an element by ref. Leave confirmed out; if the click is risky (Send, Delete, Buy ...) the tool refuses with NEEDS_CONFIRMATION, then ask the user and call again with confirmed true only after they said yes.",
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
  // agent-desktop refuses cmd+q with POLICY_DENIED; Iris retried it instead of quitting another way (log 2026-11-20).
  press_key_combo: {
    description: "Send a key combo to an app, e.g. return, escape, cmd+n. Leave confirmed out; return or enter may send, so the tool refuses with NEEDS_CONFIRMATION, then ask the user and call again with confirmed true only after they said yes. cmd+q is blocked: to quit an app, use close_app.",
    parameters: {
      combo: str("Key combo"), app: str("Target application name"), confirmed: CONFIRMED("pressing return or enter"),
      ref: { type: "string", description: "Qualified ref of the field the keys are for. Give it when pressing return after typing, e.g. the address bar or search box you just typed into" },
    },
    required: ["combo", "app"],
    argv: ({ combo, app }) => ["press", combo, "--app", app],
  },
  // Headless only: a --headed scroll would take the user's mouse, and the hand already scrolls.
  scroll_app_view: {
    description: "Scroll an app region to show more.",
    parameters: {
      app: str("Application name"), ref: str("Scrollarea ref, not a field or row in it"),
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "integer", description: "1-20 steps of 10%, default 3" },
    },
    required: ["app", "ref", "direction"],
    argv: ({ ref, direction, amount }) => ["scroll", ref, "--direction", direction, "--amount", String(Math.min(20, Math.max(1, Math.round(Number(amount) || 3))))],
  },
  close_app: {
    description: "Quit an app. Leave confirmed out; the tool refuses with NEEDS_CONFIRMATION, then ask the user and call again with confirmed true only after they said yes.",
    parameters: { app: str("Application name"), confirmed: CONFIRMED("quitting this app") },
    required: ["app"],
    // Never --force: killing loses unsaved work; the user has Force Quit for that.
    argv: ({ app }) => ["close-app", app],
  },
};

export const DESKTOP_BRIEF =
  " You can operate the user's Mac with the app tools (open_or_focus_app, find_app_control, click_app_control, type_into_text_field and the rest). " +
  "Stay in the app the user is working in, the one they last asked you to open or use: a request like 'write a prompt' or 'ask it' is about that app. " +
  "Never switch to another app, such as a web browser, unless the user names it; if you are not sure which app or what they mean, ask. To get a text field or button, call find_app_control directly; " +
  "use scan_app_controls only when you need to see the layout or to verify a result. " +
  "To read what is written on screen (a reply, a message, a document), call read_app_text; never select and copy text with key presses. " +
  "Refs expire after the UI changes; on STALE_REF find again. On AMBIGUOUS_TARGET use the error.windows id the user meant as window_id, or ask. If a result lists surfaces, use that surface. To see more, scroll_app_view. Only retry an action when error.disposition.retry is 'safe'. " +
  "To pick an option in a dropdown or list, find it (find_app_control role combobox or list) and call pick_list_option with the option text; never type into a dropdown or press return to choose. " +
  "To type, first get the ref of the text area or text field itself (find_app_control with role textarea or textfield), not a row or cell. " +
  "type_into_text_field adds to the text already in the field. Set replace true when the user corrects or asks you to retype what you typed, or for an address or search box; " +
  "leave it false when the user wants to add to text that is already there, and never erase text you did not type unless asked. " +
  "To submit what you typed (search, address bar, chat box), call press_key_combo return with ref set to that same field. " +
  "Never say an action happened unless its tool result was ok. " +
  "If typing fails, do not click Send, submit or press return: stop and tell the user typing failed. " +
  "Ask the user before anything destructive (deleting, sending, purchasing). " +
  // Iris asked "what should I search for?" and searched a guess in the same turn (log 2026-11-20).
  "When you ask the user something, stop there: call no tool until they answer, and never act on a guess of what they meant.";

// Clicks that send, delete or pay. The model ignored "ask first" once (PoC round 2), so the tool enforces it.
// get's text is the AX label, so icon-only buttons with one ("bold") are named too (TextEdit probe, 2026-11-21).
// shortcut: an icon with no AX label still slips through. Don't Save and Quit lose work, so alerts ask too.
const RISKY = /\b(send|submit|post|delete|remove|buy|pay|purchase|order|discard|quit|don.t save)\b|gửi|xóa|xoá|mua|thanh toán|không lưu/i;
const SEARCH_BOX = /search|address|tìm kiếm|địa chỉ/i;
// Quitting itself ends the session; quitting a terminal can kill running work. Electron is open-iris under pnpm dev.
// agent-desktop also resolves a bundle id as the app (list-windows --app com.apple.finder), and list_running_apps shows them.
// shortcut: a fixed list of names and bundle ids; add other terminals here when users have them.
const NO_CLOSE_NAMES = "open-?iris|iris|electron|terminal|iterm2?|warp|ghostty|alacritty|kitty|wezterm|hyper|tabby";
const NO_CLOSE = new RegExp(`^(${NO_CLOSE_NAMES})(\\.app)?$|^(com\\.open-iris\\.app|com\\.github\\.electron|com\\.apple\\.terminal|com\\.googlecode\\.iterm2|dev\\.warp\\..+|com\\.mitchellh\\.ghostty|org\\.alacritty|net\\.kovidgoyal\\.kitty|com\\.github\\.wez\\.wezterm|co\\.zeit\\.hyper|org\\.tabby)$`, "i");
// The menubar's "Quit <App>" item is a second way to quit those apps. shortcut: matches the label, so "Quit and Keep Windows" passes to the RISKY ask.
const NO_QUIT_ITEM = new RegExp(`\\bquit\\s+(${NO_CLOSE_NAMES})\\b`, "i");
// In a macOS save alert cmd+d (and cmd+delete) picks Don't Save. shortcut: asks even when no alert is open, e.g. a Chrome bookmark.
const ASK_KEYS = /(^|\+)(return|enter)$|^(cmd|command)\+(d|delete|backspace)$/i;
// Gemini set confirmed true on its first click with no one asked (log 2026-11-20), so confirmed counts only after this tool
// refused that same click or return with NEEDS_CONFIRMATION. shortcut: it cannot tell the user's yes from Gemini's own retry;
// main.mjs can, by holding a confirmed call until a user turn arrived (as the plugin taint flag does), hand that to iris-core.
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
  click_app_control: true, pick_list_option: true, type_into_text_field: true, press_key_combo: true, close_app: true,
  scroll_app_view: true,
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
  const asked = new Set(); // clicks and returns refused with NEEDS_CONFIRMATION, each passes once with confirmed true
  const needYes = (key, message) => (asked.add(key), { ok: false, error: { code: "NEEDS_CONFIRMATION", message } });
  const yes = (key, confirmed) => confirmed === true && asked.delete(key);

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
    if (args.surface && !SURFACES.includes(args.surface)) return { ok: false, error: { code: "INVALID_ARGS", message: `surface must be one of ${SURFACES.join(", ")}.` } };
    if (args.surface && args.root) return { ok: false, error: { code: "INVALID_ARGS", message: "Pass surface or root, not both: a surface is read whole." } };
    if (name === "find_app_control" && args.surface === "menubar") return findMenu(args);
    if (name === "type_into_text_field") return typeText(args);
    if (name === "read_app_text") return readText(args);
    if (name === "click_app_control") {
      const label = JSON.stringify((await cli(["get", args.ref])).data ?? "");
      if (NO_QUIT_ITEM.test(label)) return { ok: false, error: { code: "NOT_ALLOWED", message: `${label} cannot be clicked by voice. Tell the user to quit it themselves.` } };
      if (RISKY.test(label) && !yes("click" + args.ref, args.confirmed)) return needYes("click" + args.ref, `This would click ${label}. Ask the user to confirm and wait for their answer, then call again with confirmed true.`);
    }
    // Return sent a Claude message unasked (PoC round 3). shortcut: gates every return, even a harmless new line or dialog OK.
    const enterKey = "press" + args.app + args.combo;
    if (name === "press_key_combo" && ASK_KEYS.test(args.combo ?? "") && !yes(enterKey, args.confirmed) && !(/(return|enter)$/i.test(args.combo) && await searchBox(args.ref))) {
      return needYes(enterKey, `Pressing ${args.combo} may send, submit or discard. Ask the user to confirm and wait for their answer, then call again with confirmed true.`);
    }
    if (name === "press_key_combo") return pressKeys(args);
    if (name === "close_app") return closeApp(args);
    if (name === "find_app_control" && !args.surface) {
      const r = await cli(TOOLS.find_app_control.argv(args));
      if (!Array.isArray(r.data?.matches) || r.data.matches.length) return r;
      // An app-modal alert is outside the window tree and Gemini left surface out 3/3 (eval case 15, 2026-11-21), so look there next.
      const f = await cli(TOOLS.find_app_control.argv({ ...args, surface: "focused" }));
      return f.ok === false ? r : f;
    }
    if (name === "scroll_app_view") {
      if (!["up", "down", "left", "right"].includes(args.direction)) return { ok: false, error: { code: "INVALID_ARGS", message: "direction must be up, down, left or right." } };
      // Gemini sent ref "" with no scan first (eval, 2026-11-21).
      if (!args.ref) return { ok: false, error: { code: "INVALID_ARGS", message: "ref is required: call scan_app_controls first and pass the scrollarea's ref." } };
      // A delivered scroll always says retry "unsafe" (TextEdit probe, 2026-11-21), so this only repeats one that never arrived.
      const r = await cli(TOOLS.scroll_app_view.argv(args));
      return r.ok === false && r.error?.disposition?.retry === "safe" ? cli(TOOLS.scroll_app_view.argv(args)) : r;
    }
    return cli(TOOLS[name].argv(args));
  }

  // find --surface menubar always TIMEOUTs (locator_incomplete) on TextEdit while the snapshot works (probe, 2026-11-21), so filter the snapshot here.
  // shortcut: matches by name or value only, no menu path; a second "Save" in another menu shows up too, Gemini picks by the listed name.
  async function findMenu({ app, role, text, window_id }) {
    const r = await cli(TOOLS.scan_app_controls.argv({ app, surface: "menubar", window_id }), "", Infinity);
    if (!r.data?.tree) return r;
    const t = text?.toLowerCase(), matches = [];
    (function walk(n) {
      const hit = (!role || n.role === role) && (!t || [n.name, n.value].some((v) => typeof v === "string" && v.toLowerCase().includes(t)));
      if (n.ref_id && hit) matches.push({ ref_id: n.ref_id, role: n.role, name: n.name, ...(n.states && { states: n.states }) });
      n.children?.forEach(walk);
    })(r.data.tree);
    return { ok: true, data: { matches: matches.slice(0, 50), total_matches: matches.length } };
  }

  // Every quit asks first: it can lose unsaved work and the user may not have meant that app.
  async function closeApp({ app, confirmed }) {
    const name = String(app ?? "").trim();
    if (NO_CLOSE.test(name)) return { ok: false, error: { code: "NOT_ALLOWED", message: `${app} cannot be closed by voice. Tell the user to quit it themselves.` } };
    const key = "close" + name.toLowerCase();
    if (!yes(key, confirmed)) return needYes(key, `This would quit ${app}. Ask the user to confirm and wait for their answer, then call again with confirmed true.`);
    const r = await cli(TOOLS.close_app.argv({ app }));
    // Unsaved documents: close-app times out after ~5 s with an alert left open (TextEdit probe, 2026-11-21).
    if (r.ok !== false || r.error?.code !== "TIMEOUT") return r;
    const surfaces = (await cli(["list-surfaces", "--app", app])).data?.surfaces;
    if (!surfaces?.length) return r;
    return { ok: false, error: { code: "DIALOG_OPEN", message: `${app} did not quit and shows a dialog, likely unsaved changes. Tell the user and ask what to do; never pick Save or Delete for them.`, surfaces } };
  }

  // Return in an address or search box only loads or searches, so it needs no yes (Iris asked before opening a URL, log 2026-11-20).
  // find --root reports the field itself with its role and name; get has no name property.
  // shortcut: trusts the field's accessible name; a chat box named like "search" would send without asking.
  async function searchBox(ref) {
    if (!ref) return false;
    const m = (await cli(["find", "--root", ref])).data?.matches?.[0];
    return m?.role === "searchfield" || SEARCH_BOX.test(m?.name ?? "");
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
      // Only id and title of each window go back, nothing else from the candidates.
      const c = r.error?.code === "AMBIGUOUS_TARGET" && r.error.details?.candidates;
      if (c) return { ok: false, error: { code: "AMBIGUOUS_TARGET", windows: c.map(({ id, title }) => ({ id, title })) } };
      if (r.ok === false) return { ok: false, error: r.error ?? r };
      // An action that opened a menu, sheet or alert says so on top, so Gemini looks there next.
      const out = r.data?.surfaces?.length ? { ...r, surfaces: r.data.surfaces } : r;
      return { ok: true, output: r.data?.disposition?.delivery === "delivered_unverified" ? { ...out, verify: VERIFY } : out };
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

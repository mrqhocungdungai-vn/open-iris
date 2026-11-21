// Gallery "Send to Iris" (user, 2026-11-21): the button gives Iris only a path. This tool lets Iris put that file's content
// into the session when the user's next words need it. Gemini can be prompt-injected, so it reads only what allowed() says
// the user sent; types and size limits are the typed composer's (compose-view.mjs, input.mjs).
import fs from "node:fs";
import path from "node:path";
import { classify } from "../renderer/compose-view.mjs";
import { cleanInput } from "./input.mjs";

export const SENT_TOOL = "read_sent_file";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

// → { parts } (Live parts for one user turn) or { error } said to Iris. No read unless allowed(file).
export function sentFileParts(file, allowed) {
  if (typeof file !== "string" || !allowed(file)) return { error: "not a file the user sent with Send to Iris; ask them to send it from Gallery View" };
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return { error: `${file} no longer exists` };
  if (st.isDirectory()) return { error: `${path.basename(file)} is a folder; only images (PNG, JPEG, WebP) and text files can be read` };
  const mimeType = MIME[path.extname(file).toLowerCase()] || "";
  const c = classify({ name: file, type: mimeType, size: st.size }, "en");
  if (c.kind === "bad") return { error: `${path.basename(file)}: ${c.why}; only images (PNG, JPEG, WebP) and text files can be read` };
  const parts = cleanInput(c.kind === "image"
    ? [{ text: `[gallery] Image ${file}:` }, { inlineData: { mimeType, data: fs.readFileSync(file).toString("base64") } }]
    : [{ text: `[gallery] File ${file}:\n${fs.readFileSync(file, "utf8")}` }]);
  return parts ? { parts } : { error: `${path.basename(file)} is too big to read` };
}

// sendParts(parts) → bool: puts them in the conversation as silent user content (main.mjs). run never throws (handleToolCalls contract).
export function sentFileTool({ allowed, sendParts }) {
  return {
    name: SENT_TOOL,
    description: "Read a file the user sent you from Gallery View (Send to Iris) or the image open there, so you can see or read its content. Call it only when the user's words need the content, with the exact path from the [gallery] note.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path exactly as in the [gallery] note." } }, required: ["path"] },
    run: async ({ path: file } = {}) => {
      try {
        const r = sentFileParts(file, allowed);
        if (r.error) return { ok: false, error: r.error };
        if (!sendParts(r.parts)) return { ok: false, error: "could not add the content to the session" };
        return { ok: true, output: `The content of ${file} is now in the conversation, just before this result. Answer the user from it.` };
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
  };
}

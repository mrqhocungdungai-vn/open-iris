// Gallery "Send to Iris" (user, 2026-11-21): the button gives Iris only a path. This tool lets Iris put that file's content
// into the session when the user's next words need it. Gemini can be prompt-injected, so it reads only what allowed() says
// the user sent; types and size limits are the typed composer's (compose-view.mjs, input.mjs).
import fs from "node:fs";
import path from "node:path";
import { classify } from "../renderer/compose-view.mjs";
import { cleanInput } from "./input.mjs";
import { cleanOutput } from "./hooks.mjs";

export const SENT_TOOL = "read_sent_file";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

// → { parts } (Live parts for one user turn) or { error } said to Iris. No read unless allowed(file).
export function sentFileParts(file, allowed) {
  if (typeof file !== "string" || !allowed(file)) return { error: "not a file the user sent with Send to Iris; ask them to send it from Gallery View" };
  // One fd for the checks and the read, so the file cannot be swapped in between. O_NOFOLLOW refuses a symlink (ELOOP),
  // O_NONBLOCK keeps a FIFO from hanging the open; fstat then refuses FIFOs and devices.
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
    if (e.code === "ENOENT") return { error: `${file} no longer exists` };
    if (e.code === "ELOOP") return { error: `${path.basename(file)} is a link; only regular files can be read` };
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) return { error: `${path.basename(file)} is a folder; only images (PNG, JPEG, WebP) and text files can be read` };
    if (!st.isFile()) return { error: `${path.basename(file)} is not a regular file; only images (PNG, JPEG, WebP) and text files can be read` };
    const mimeType = MIME[path.extname(file).toLowerCase()] || "";
    const c = classify({ name: file, type: mimeType, size: st.size }, "en");
    if (c.kind === "bad") return { error: `${path.basename(file)}: ${c.why}; only images (PNG, JPEG, WebP) and text files can be read` };
    const buf = Buffer.alloc(st.size); // classify capped st.size; a file that grew since is cut there
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const data = buf.subarray(0, n);
    const parts = cleanInput(c.kind === "image"
      ? [{ text: `[gallery] Image ${JSON.stringify(file)}:` }, { inlineData: { mimeType, data: data.toString("base64") } }]
      : [{ text: `[gallery] File ${JSON.stringify(file)}:\n${cleanOutput(data.toString("utf8"), Infinity)}` }]);
    return parts ? { parts } : { error: `${path.basename(file)} is too big to read` };
  } finally { fs.closeSync(fd); }
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
        return { ok: true, output: `The content of ${JSON.stringify(file)} is now in the conversation, just before this result. Answer the user from it.` };
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
  };
}

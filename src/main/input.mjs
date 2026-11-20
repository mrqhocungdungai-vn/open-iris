// Manual input (Features › Gõ chữ, gửi ảnh và tệp): the renderer's parts are checked here before they reach Gemini.
// Spike 2026-11-20 (scripts/spikes/live-input.mjs): inline PNG works on both models; application/pdf closes the session
// with 1007; inline text/plain is ignored by 3.8-live, so text files come in as text parts.
export const INPUT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const INPUT_MAX_BYTES = 8 * 1024 * 1024; // base64 of a 5 MB image plus text, well under what a frame can carry

// → Live parts, or null if anything is off (an unsupported type would end the session).
export function cleanInput(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  let size = 0;
  const out = [];
  for (const p of parts) {
    if (typeof p?.text === "string" && p.text.trim()) { size += p.text.length; out.push({ text: p.text }); continue; }
    const d = p?.inlineData;
    if (!d || !INPUT_IMAGE_TYPES.includes(d.mimeType) || typeof d.data !== "string" || !d.data) return null;
    size += d.data.length;
    out.push({ inlineData: { mimeType: d.mimeType, data: d.data } });
  }
  return size <= INPUT_MAX_BYTES ? out : null;
}

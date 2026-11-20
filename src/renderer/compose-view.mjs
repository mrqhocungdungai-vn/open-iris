// Manual input box: which dropped files can go to Gemini Live and how (main's input.mjs checks again).
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|log|ini|sh|zsh|py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|swift|c|h|cpp|hpp|rb|php|sql)$/i;
export const IMAGE_MAX = 5 * 1024 * 1024;
export const TEXT_MAX = 200 * 1024;

const tr = (lang, vi, en) => (lang === "en" ? en : vi);

// file: { name, type, size } → { kind: "image" | "text" } or { kind: "bad", why }
export function classify(file, lang) {
  if (IMAGE_TYPES.includes(file.type)) return file.size <= IMAGE_MAX ? { kind: "image" } : { kind: "bad", why: tr(lang, "ảnh quá 5 MB", "image over 5 MB") };
  if (file.type.startsWith("text/") || TEXT_EXT.test(file.name)) return file.size <= TEXT_MAX ? { kind: "text" } : { kind: "bad", why: tr(lang, "tệp chữ quá 200 KB", "text file over 200 KB") };
  if (file.type === "application/pdf") return { kind: "bad", why: tr(lang, "Gemini Live chưa nhận PDF", "Gemini Live does not take PDF") };
  return { kind: "bad", why: tr(lang, "loại tệp chưa hỗ trợ", "file type not supported") };
}

// items: [{ name, kind, mimeType?, data? (base64), content? (text) }] → Live parts. Text files go in as text parts.
export function buildParts(text, items) {
  const parts = [];
  for (const it of items) {
    if (it.kind === "image") parts.push({ inlineData: { mimeType: it.mimeType, data: it.data } });
    else if (it.kind === "text") parts.push({ text: `File ${it.name}:\n${it.content}` });
  }
  if (text.trim()) parts.push({ text: text.trim() });
  return parts;
}

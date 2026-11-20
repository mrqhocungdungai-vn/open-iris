// Navigation and permission policy for every window (main.mjs, web-contents-created). Every window loads the full
// window.iris bridge, so a foreign page (a dropped .html, a link) must never load into one of them.
import path from "node:path";
import { fileURLToPath } from "node:url";

const fileOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? fileURLToPath(u) : "";
  } catch {
    return "";
  }
};

// The bundled guides (src/gesture/*guide.html) are the only pages a window may open or navigate to.
export function guidePage(url, root) {
  const file = fileOf(url);
  return path.dirname(file) === path.join(root, "src", "gesture") && file.endsWith("guide.html");
}

// media: mic and camera. clipboard-read: the 📋 button in the chat window (compose-ui.js).
const ALLOWED = new Set(["media", "clipboard-read"]);
export const permitted = (permission, url, root) => ALLOWED.has(permission) && fileOf(url).startsWith(root + path.sep);

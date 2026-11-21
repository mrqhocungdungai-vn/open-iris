// Placement of the 💬 chat window (chat.js), used by hud.mjs.

// Chat window bounds (screen px): right-aligned just above the HUD dock; if the dock is too tall (camera on), to its left.
// dock and area are { x, y, width, height }; the result always stays inside area.
export function chatPlace(dock, area, width, height, gap = 8) {
  const above = dock.y - gap - height >= area.y;
  const x = above ? dock.x + dock.width - width : dock.x - gap - width;
  const y = above ? dock.y - gap - height : dock.y + dock.height - height;
  const clamp = (v, lo, hi) => Math.round(Math.min(Math.max(v, lo), hi));
  return { x: clamp(x, area.x, area.x + area.width - width), y: clamp(y, area.y, area.y + area.height - height), width, height };
}

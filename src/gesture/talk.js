// Conversation helpers shared by the HUD one-line transcript (hud-ui.js) and the 💬 chat window (chat.js, placed by hud.mjs).

// Gemini speaks in chunks, one log line each; glue a chunk onto the row of the same speaker so a reply reads as one sentence.
export function addLine(box, line) {
  const who = /^(you|iris):/.exec(line)?.[0];
  const last = box.lastElementChild;
  if (who && last?.dataset.who === who) {
    last.textContent += line.slice(who.length + 1); // chunks carry their own spaces
    box.scrollTop = box.scrollHeight;
    return;
  }
  const row = document.createElement("div");
  row.className = who === "you:" ? "you" : who === "iris:" ? "iris" : "sys";
  if (who) {
    row.dataset.who = who;
    box.querySelector(".now")?.classList.remove("now");
    row.classList.add("now"); // the one line the HUD shows
  }
  row.textContent = line;
  box.append(row);
  while (box.childElementCount > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

// main.mjs keeps the recent transcript in memory for a chat window opened mid-session: chunks of one speaker glued into one
// row (the same rows addLine builds), oldest dropped past max. Nothing goes to disk.
export function pushLine(rows, line, max = 200) {
  const who = /^(you|iris):/.exec(line)?.[0];
  if (who && rows.at(-1)?.startsWith(who)) rows[rows.length - 1] += line.slice(who.length + 1);
  else if (rows.push(line) > max) rows.splice(0, rows.length - max);
  return rows;
}

// Chat window bounds (screen px): right-aligned just above the HUD dock; if the dock is too tall (camera on), to its left.
// dock and area are { x, y, width, height }; the result always stays inside area.
export function chatPlace(dock, area, width, height, gap = 8) {
  const above = dock.y - gap - height >= area.y;
  const x = above ? dock.x + dock.width - width : dock.x - gap - width;
  const y = above ? dock.y - gap - height : dock.y + dock.height - height;
  const clamp = (v, lo, hi) => Math.round(Math.min(Math.max(v, lo), hi));
  return { x: clamp(x, area.x, area.x + area.width - width), y: clamp(y, area.y, area.y + area.height - height), width, height };
}

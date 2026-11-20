// Context meter view, no DOM: ctx-ui.js draws it. m = contextMeter() from main ({ used, max, trimAt|null }) or null.
const k = (n) => `${Math.round(n / 1000)}k`;
const dots = (n) => n.toLocaleString("de-DE"); // 131.072, the Vietnamese way, in both languages

export function ctxView(m, lang = "vi") {
  if (!m) return null;
  const en = lang === "en", pct = (n) => `${Math.min(100, (n / m.max) * 100).toFixed(1)}%`;
  const head = en ? `Iris's context: ${dots(m.used)} / ${dots(m.max)} tokens.` : `Context của Iris: ${dots(m.used)} / ${dots(m.max)} token.`;
  const trim = m.trimAt && (en ? ` At the mark (≈${k(m.trimAt)}), Iris forgets the earliest part of the conversation.` : ` Tới vạch (≈${k(m.trimAt)}), Iris quên bớt phần đầu cuộc trò chuyện.`);
  return {
    text: `ctx ${k(m.used)} / ${k(m.max)}`,
    fill: pct(m.used),
    mark: m.trimAt ? pct(m.trimAt) : null, // no trimming without "Giữ phiên dài", so no mark
    near: !!m.trimAt && m.used >= 0.9 * m.trimAt,
    title: head + (trim || ""),
  };
}

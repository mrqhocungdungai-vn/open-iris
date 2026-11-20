// How full Gemini's context is (docs/context-meter-plan.md). C0: promptTokenCount of the latest usageMetadata is the
// current context size; the API does not report the window, so it is hard-coded per model.
const WINDOW = {
  "models/gemini-3.8-live": 131072,
  "models/gemini-3.1-flash-live-preview": 131072,
};

// trimAt = the server's default slidingWindow trigger (80% of the window). Without keep there is no sliding window.
export function contextMeter(usage, model, keep = true) {
  const used = usage?.promptTokenCount, max = WINDOW[model];
  if (!Number.isFinite(used) || !max) return null;
  return { used, max, trimAt: keep ? Math.floor(max * 0.8) : null };
}

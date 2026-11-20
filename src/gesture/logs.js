// Level for a renderer console line in main.log (pure, so it can be tested without Electron).
const LEVEL = { debug: "DEBUG", info: "INFO", warning: "WARN", error: "ERROR" };

// MediaPipe's usage telemetry is blocked by our CSP on purpose; keep the trace at DEBUG so it stops looking like a bug.
export function rendererLevel(level, message) {
  return String(message).includes("odml.pa.googleapis.com") ? "DEBUG" : LEVEL[level] || "INFO";
}

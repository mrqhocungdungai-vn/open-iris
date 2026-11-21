// Hand Task Vision engine: runs in the main window (Features › Hand Task Vision), not in the HUD, so it works with the
// HUD closed. Camera + MediaPipe HandLandmarker → mouse events (hud.mjs → Swift helper). Each frame's state is also sent
// to the HUD overlay (if open) for its cursor ring, pose line and camera skeleton.
import { DrawingUtils, FilesetResolver, HandLandmarker } from "../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs";
import { cursorFrom, smooth, isPinched, isScrollPose, pinchRatio, clickLock, CLICK_HOLD_MS, isFist, isRock, isThumbUp, palmsOf, LOCK_HOLD_MS, pinchApproach, trackpad, glide, GLIDE_MIN, settle, scrollStep } from "./hand.js";
import { openVideo } from "../renderer/devices.js";
import { handPerfLine } from "./perf.js";

const $ = (id) => document.getElementById(id);
const MODEL = new URL("../../models/hand_landmarker.task", import.meta.url).href; // local copy: `pnpm fetch-model`
// Pixels scrolled per full frame height of hand travel. Sign: hand up scrolls the page up like dragging paper; negate to flip.
const SCROLL_GAIN = 2000;
// Only the chosen hand (settings.side) drives the mouse. MediaPipe's handedness label matches the user's real hand
// on this Mac camera (checked by hand: the docs' "mirrored image" note would suggest the opposite).
const LABEL = { right: "Right", left: "Left" };

let control = false;
let cursor = null;
let pinched = false;
let rightPinched = false;
let held = false; // left button actually sent down
let scrollAt = null; // knuckle (mirrored) on the previous scroll frame
let scrollVel = { x: 0, y: 0 }; // averaged scroll px per frame while in the V pose
let glideV = null; // inertia after the V pose ends, see glide()
let anchor = null; // click lock point, see clickLock()
let lockSince = null; // when the current 🤘 or 👍 hold started; Infinity once it has toggled, until the pose ends
let span = 0.6; // hand area that covers the screen, set from the main window
let mode = "trackpad"; // or "absolute"
let side = "right"; // hand that drives the mouse
let poseState = null; // debounced pose, see settle()
let hand = null; // trackpad: filtered hand point; null = lifted (fist / no hand / scroll), so the next frame doesn't jump
let hudGallery = false; // the HUD's gallery is open: two open hands zoom it instead of moving the mouse
let cam = null; // Settings › Camera, { id, label } or null = system default
const useSettings = (s) => {
  const swap = timer && s.cam?.id !== cam?.id; // a new camera picked while tracking: reopen on it
  ({ span, mode, side, cam } = s);
  if (swap) openCamera().then(() => !want && stop(), (e) => console.error(`hand vision: camera switch failed: ${e?.message || e}`));
};
window.gesture.onSettings(useSettings);
window.gesture.getSettings().then(useSettings);
window.gesture.onHudGallery((on) => (hudGallery = on));

function release() {
  const at = anchor ?? cursor;
  if (held && at) window.gesture.mouse("up", at.x, at.y);
  anchor = null;
  held = false;
}

// Short line under the 200px preview; the full hint is the tooltip. .on turns the dot green (also the only thing left when collapsed).
function showStatus() {
  const el = $("hv-status");
  el.textContent = control ? tr("tay BẬT", "hand ON") : tr("tay TẮT · giữ 🤘", "hand OFF · hold 🤘");
  el.title = control ? tr("điều khiển BẬT · giữ 🤘 hoặc ⌃⌥G để tắt", "control ON · hold 🤘 or ⌃⌥G to pause") : tr("điều khiển TẮT · giữ 🤘 hoặc ⌃⌥G để bật", "control OFF · hold 🤘 or ⌃⌥G to activate");
  el.classList.toggle("on", control);
}
window.gesture.onControl((on) => {
  control = on;
  if (!on) release();
  showStatus();
});
document.addEventListener("langchange", showStatus);

// 👍 hold toggles listen-only. It works only while Iris runs (main ignores iris:listen otherwise), so track both.
let listening = false;
let irisOn = false;
window.iris.onListen((on) => (listening = on));
window.iris.onStatus((st) => (irisOn = st !== "offline"));
window.iris.getState().then((st) => { listening = st.listenOnly; irisOn = st.status !== "offline"; });

let landmarker = null; // loaded on first start, kept for the next
let timer = 0;
let want = false; // last "vision" asked; a stop during start()'s awaits wins
const video = $("hv-cam");
const bones = $("hv-bones").getContext("2d");
const drawer = new DrawingUtils(bones);

// Main echoes "vision" for the switch, ⌃⌥Q and the HUD; start/stop follow it.
window.gesture.onVision((on) => ((want = on) ? start() : stop()).catch((e) => {
  console.error(`hand vision failed: ${e?.message || e}`);
  $("hv-pose").textContent = tr("Không mở được camera / mô hình: ", "Could not open the camera / model: ") + (e?.message || e);
  window.gesture.vision(false);
}));

async function start() {
  if (timer) return;
  $("hv-view").hidden = false;
  $("hv-pose").textContent = tr("đang mở camera…", "opening the camera…");
  landmarker ??= await HandLandmarker.createFromOptions(
    await FilesetResolver.forVisionTasks(new URL("../../node_modules/@mediapipe/tasks-vision/wasm", import.meta.url).href),
    {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2, // see both so the left hand can be ignored instead of being picked by mistake
    },
  );
  await openCamera();
  if (!want) return stop();
  console.info("hand vision: camera + model ready");
  showStatus();
  // setInterval, not requestAnimationFrame: rAF stops while other apps cover this window (backgroundThrottling is off).
  timer ||= setInterval(frame, 33);
  perfAt = 0;
  video.cancelVideoFrameCallback(camCb);
  camCb = video.requestVideoFrameCallback(onCameraFrame);
}

async function openCamera() {
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = await openVideo({ width: 640, height: 480 }, cam);
  await video.play();
  console.info(`hand vision: camera "${video.srcObject.getVideoTracks()[0]?.label}"`);
  document.dispatchEvent(new Event("devicesused")); // devices.js: labels are readable now
}

async function stop() {
  clearInterval(timer);
  timer = 0;
  release();
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  $("hv-view").hidden = true;
  window.gesture.hand(null); // HUD: hide the ring
  console.info("hand vision: stopped");
}

// Camera preview: hand skeleton + the gesture currently recognized; each change is logged. The HUD gets the same.
let lastPose = "";
function showPose(lm, pose, ring = null, progress = 0, approach = 0) {
  bones.clearRect(0, 0, 640, 480);
  if (lm) {
    drawer.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: "#0f0", lineWidth: 3 });
    drawer.drawLandmarks(lm, { color: "#f00", radius: 3 });
  }
  const ratios = lm ? ` · trỏ ${pinchRatio(lm, 8).toFixed(2)} giữa ${pinchRatio(lm, 12).toFixed(2)}` : "";
  $("hv-pose").textContent = pose;
  $("hv-pose").title = pose; // the chip is cut with … in the 200px preview
  if (pose !== lastPose) console.info(`gesture ${pose}${ratios}${control ? "" : " (control OFF)"}`); // ratios: to tune the pinch thresholds
  lastPose = pose;
  const at = anchor ?? cursor;
  window.gesture.hand({ pose, lm: lm?.map(({ x, y }) => ({ x, y })), ring: ring && at && { mode: control ? ring : "off", x: at.x, y: at.y, progress, approach }, palms });
}

// Short click sound (Electron allows audio without a user gesture). Left = higher pitch, right = lower.
const audio = new AudioContext();
function tick(freq) {
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.05);
}

// [perf] (docs/optimize-plan.md §2): camera frames come from requestVideoFrameCallback, the rest from frame().
const PERF_MS = 5000;
const perfWindow = () => ({ cam: 0, ticks: 0, dup: 0, detect: [], lat: [], cur: [], raw: [] });
let perf = perfWindow();
let perfAt = 0;
let frameAt = 0; // capture (or, without captureTime, presentation) time of the newest camera frame
let frameSrc = "present";
let lastMediaTime = -1;
let camCb = 0;
function onCameraFrame(now, meta) {
  perf.cam++;
  frameAt = meta.captureTime ?? now;
  frameSrc = meta.captureTime ? "capture" : "present";
  camCb = video.requestVideoFrameCallback(onCameraFrame);
}
function perfTick(t0, t1) {
  perf.ticks++;
  perf.detect.push(t1 - t0);
  if (video.currentTime === lastMediaTime) perf.dup++; // the 33ms timer ran MediaPipe again on a frame it already saw
  lastMediaTime = video.currentTime;
  if (t1 - perfAt < PERF_MS) return;
  if (perfAt) console.info(handPerfLine(perf, (t1 - perfAt) / 1000, screen.width, frameSrc));
  perf = perfWindow();
  perfAt = t1;
}

let palms = null;
function frame() {
  if (video.readyState < 2) return;
  const t0 = performance.now();
  const res = landmarker.detectForVideo(video, t0);
  perfTick(t0, performance.now());
  const lm = res.landmarks[res.handedness.findIndex((h) => h[0]?.categoryName === LABEL[side])];
  // Both palms (mirrored like the screen), for the HUD gallery's two-hand zoom; null unless both hands are open ✋.
  palms = palmsOf(res.landmarks);
  // Here, not in the branches: every way out of the V pose (other pose, hand gone) starts the glide.
  const raw = !lm ? null : isThumbUp(lm) ? "thumb" : isFist(lm) ? "fist" : isRock(lm) ? "rock" : isScrollPose(lm) ? "scroll" : "move";
  poseState = raw && settle(poseState, raw);
  const scrolling = poseState?.pose === "scroll";
  if (!scrolling && scrollAt) {
    // No glide in the HUD gallery: 0.92 decay ≈ 12× the last speed, so a swipe flung the ring ~7 cards on.
    glideV = !hudGallery && Math.hypot(scrollVel.x, scrollVel.y) >= GLIDE_MIN ? scrollVel : null;
    if (glideV) console.info(`scroll glide ${Math.round(glideV.x)},${Math.round(glideV.y)} px/frame`);
    scrollAt = null;
    scrollVel = { x: 0, y: 0 };
  }
  if (glideV && !scrolling) {
    if (control) window.gesture.mouse("scroll", glideV.x, glideV.y);
    glideV = glide(glideV);
  }
  // Two hands in the HUD gallery = zoom: the mouse freezes like ✊ so the zoom never clicks.
  if (palms && hudGallery) {
    release();
    hand = null;
    scrollAt = null;
    return showPose(lm, tr("🙌 2 tay → zoom (kéo ra phóng to, chụm lại thu nhỏ)", "🙌 2 hands → zoom (apart = in, together = out)"));
  }
  if (!lm) {
    release(); // hand left the frame: drop any drag
    if (mode !== "trackpad") cursor = null; // trackpad: the cursor stays where it was, like lifting a finger
    hand = null;
    lockSince = null;
    return showPose(null, `${side === "right" ? tr("không thấy tay phải", "no right hand") : tr("không thấy tay trái", "no left hand")}`);
  }

  if (poseState.pose === "fist") {
    release(); // the cursor freezes while the fist is held
    hand = null; // trackpad: fist = lift, move the hand back without moving the cursor
    lockSince = null;
    cursor ??= cursorFrom(lm, span);
    return showPose(lm, tr("✊ nắm tay → nhấc chuột (con trỏ đứng yên)", "✊ fist → lift the mouse (pointer stays)"), "fist");
  }

  if (poseState.pose === "rock") {
    release();
    hand = null;
    cursor ??= cursorFrom(lm, span);
    const now = performance.now();
    lockSince ??= now;
    const progress = Math.min(1, (now - lockSince) / LOCK_HOLD_MS);
    if (progress === 1) {
      window.gesture.setControl(!control);
      lockSince = Infinity; // one toggle per pose; change pose to arm again
    }
    return showPose(lm, lockSince === Infinity ? tr("🤘 đã đổi · thả tư thế ra", "🤘 switched · release the pose") : `🤘 ${tr("giữ", "hold")} ${Math.round(progress * 100)}% → ${control ? tr("tạm dừng", "pause") : tr("tiếp tục", "resume")}`, "lock", lockSince === Infinity ? 0 : progress);
  }
  if (poseState.pose === "thumb") {
    release();
    hand = null;
    cursor ??= cursorFrom(lm, span);
    if (!irisOn) {
      lockSince = null;
      return showPose(lm, tr("👍 chỉ nghe · Iris chưa chạy", "👍 listen only · Iris is not running"), "fist");
    }
    // Hold to turn listen-only on; while it is on, a new 👍 turns it off at once. One toggle per pose.
    if (listening && lockSince === null) {
      window.iris.listen(false);
      lockSince = Infinity;
    }
    const now = performance.now();
    lockSince ??= now;
    const progress = Math.min(1, (now - lockSince) / LOCK_HOLD_MS);
    if (progress === 1) {
      window.iris.listen(true);
      lockSince = Infinity;
    }
    return showPose(lm, lockSince === Infinity ? tr("👍 đã đổi · thả tư thế ra", "👍 switched · release the pose") : `👍 ${tr("giữ", "hold")} ${Math.round(progress * 100)}% → ${tr("chỉ nghe", "listen only")}`, "lock", lockSince === Infinity ? 0 : progress);
  }
  lockSince = null;

  if (scrolling) {
    release();
    hand = null;
    const p = { x: 1 - lm[5].x, y: lm[5].y };
    const step = scrollStep(scrollAt, p);
    const d = { x: step.d.x * SCROLL_GAIN, y: step.d.y * SCROLL_GAIN };
    if (Math.abs(d.x) > Math.abs(d.y)) d.y = 0; else d.x = 0; // one axis per frame: hand wobble doesn't drift the page sideways
    if (control && Math.hypot(d.x, d.y) >= 1) window.gesture.mouse("scroll", d.x, d.y);
    scrollVel = { x: (scrollVel.x + d.x) / 2, y: (scrollVel.y + d.y) / 2 };
    glideV = null; // grabbing the page again stops the glide
    scrollAt = step.anchor;
    cursor ??= cursorFrom(lm, span); // the cursor stays put while scrolling so the same window keeps scrolling
    return showPose(lm, tr("✌ V → cuộn (dọc / ngang)", "✌ V → scroll (up-down / sideways)"), "scroll");
  }

  // Fingers closing in → filter harder (down to 30% of the cutoffs) so the cursor settles on the target before the click.
  // Damping, not a gain change: no hand/cursor offset is left behind once the fingers open again.
  const near = Math.max(pinchApproach(pinchRatio(lm, 8)), pinchApproach(pinchRatio(lm, 12)));
  const steady = pinched ? 1 : 1 - 0.7 * near; // already pinched (dragging): full speed; the click lock handles the click point
  if (mode === "trackpad") {
    const from = hand;
    hand = smooth(hand, cursorFrom(lm, 1), performance.now(), 0.7 * steady, 10 * steady);
    cursor = trackpad(cursor ?? { x: 0.5, y: 0.5 }, from, hand);
  } else {
    cursor = smooth(cursor, cursorFrom(lm, span), performance.now(), 0.7 * steady, 10 * steady);
  }
  // Clicks change only on frames that really read as ✋: entering/leaving ✌ or ✊ the thumb sits close to both fingers.
  const clean = raw === "move";
  if (clean) pinched = isPinched(lm, pinched);
  if (pinched) glideV = null; // never click into a page that is still moving
  const right = clean ? !pinched && isPinched(lm, rightPinched, 12) : rightPinched;
  const now = performance.now();
  anchor = clickLock(anchor, cursor, now);
  if (pinched && !held) anchor = { ...(anchor ?? cursor), until: Infinity }; // a 2nd pinch reuses the 1st point
  const at = anchor ?? cursor;
  // H3 sample, ✋ frames only. Trackpad: raw is the hand point (span 1), not a screen point, so compare raw vs cursor only in absolute mode.
  perf.lat.push(performance.now() - frameAt);
  perf.cur.push({ x: cursor.x, y: cursor.y });
  perf.raw.push(cursorFrom(lm, mode === "trackpad" ? 1 : span));
  if (control) {
    window.gesture.mouse("move", at.x, at.y);
    if (pinched !== held) {
      window.gesture.mouse((held = pinched) ? "down" : "up", at.x, at.y);
      if (held) tick(1800);
    }
    if (right && !rightPinched) {
      window.gesture.mouse("right", at.x, at.y);
      tick(1100);
    }
  }
  if (!pinched && anchor?.until === Infinity) anchor = { ...anchor, until: now + CLICK_HOLD_MS };
  rightPinched = right;
  showPose(lm, pinched ? tr("🤏 chụm trỏ → nhấn trái", "🤏 index pinch → left click") : right ? tr("🤏 chụm giữa → chuột phải", "🤏 middle pinch → right click") : tr("✋ mở → di chuột", "✋ open → move the mouse"), held || (!control && pinched) ? "down" : "move", 0, pinched || right ? 1 : near);
}

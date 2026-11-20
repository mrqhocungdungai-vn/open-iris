// Context meter (#ctx) and "↺ Làm mới" (#ctx-clear) next to #status. main sends live:context once per turn.
import { ctxView } from "./ctx-view.mjs";

const $ = (id) => document.getElementById(id);
let meter = null, status = "offline", meterOn = true;

function render() {
  const v = ctxView(meter, document.documentElement.lang);
  const el = $("ctx");
  el.hidden = !v || !meterOn || status === "offline";
  $("ctx-clear").hidden = status === "offline"; // follows the session, no switch of its own
  $("ctx-clear").disabled = status === "connecting";
  if (!v) return;
  el.title = v.title;
  el.toggleAttribute("data-near", v.near);
  el.querySelector(".fill").style.width = v.fill;
  el.querySelector(".mark").hidden = !v.mark;
  if (v.mark) el.querySelector(".mark").style.left = v.mark;
  el.lastChild.textContent = v.text;
}

window.iris.onContext((m) => ((meter = m), render()));
window.iris.onStatus((s) => {
  status = s;
  if (s === "offline") meter = null;
  render();
});
window.iris.getConfig().then((c) => ((meterOn = c.session.meter), ($("meter-on").checked = meterOn), render()));
$("meter-on").onchange = () => {
  meterOn = $("meter-on").checked;
  window.iris.saveMeter(meterOn);
  render();
};
$("ctx-clear").onclick = () => window.iris.clearContext();
document.addEventListener("langchange", render);
render();

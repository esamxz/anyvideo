// Local Video Grabber - content script (top frame)
// Highlights <video> elements on the page and reports a lightweight inventory
// (size, duration, a captured thumbnail) to the popup. Does NO network at all;
// it only reads the DOM and draws outlines on request.

(() => {
  if (window.__lvgInstalled) return;
  window.__lvgInstalled = true;

  let overlays = [];
  let active = false;
  let rafPending = false;

  const uid = () => "lvg_" + Math.random().toString(36).slice(2, 9);

  function visibleVideos() {
    return [...document.querySelectorAll("video")].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 20 && r.height > 20;
    });
  }

  function fmtTime(s) {
    if (!isFinite(s) || s <= 0) return "";
    s = Math.round(s);
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }

  function grabThumb(v) {
    try {
      if (v.readyState < 2 || !v.videoWidth) return null;
      const w = 160;
      const h = Math.round(w * (v.videoHeight / v.videoWidth)) || 90;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(v, 0, 0, w, h);
      return c.toDataURL("image/jpeg", 0.6);
    } catch (_) {
      return null; // cross-origin frame -> tainted canvas
    }
  }

  function ensureId(v) {
    if (!v.dataset.lvgId) v.dataset.lvgId = uid();
    return v.dataset.lvgId;
  }

  function inventory() {
    return visibleVideos().map((v, i) => ({
      id: ensureId(v),
      index: i + 1,
      vw: v.videoWidth || 0,
      vh: v.videoHeight || 0,
      durationText: fmtTime(v.duration),
      paused: v.paused,
      currentSrc: v.currentSrc || "",
      thumb: grabThumb(v),
    }));
  }

  // --- overlay drawing ------------------------------------------------------
  function clearOverlays() {
    overlays.forEach((o) => o.remove());
    overlays = [];
  }

  function makeOverlay(v, idx, pulse) {
    const r = v.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed",
      "left:" + r.left + "px",
      "top:" + r.top + "px",
      "width:" + r.width + "px",
      "height:" + r.height + "px",
      "border:3px solid #2563eb",
      "box-shadow:0 0 0 2px rgba(255,255,255,.6),0 0 12px rgba(37,99,235,.85)",
      "border-radius:6px",
      "pointer-events:none",
      "z-index:2147483646",
      "box-sizing:border-box",
    ].join(";");
    if (pulse) {
      box.style.borderColor = "#f59e0b";
      box.animate([{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], {
        duration: 650,
        iterations: 3,
      });
    }
    const label = document.createElement("div");
    const dims = v.videoWidth ? "  " + v.videoWidth + "×" + v.videoHeight : "";
    const dur = fmtTime(v.duration) ? "  " + fmtTime(v.duration) : "";
    label.textContent = "#" + idx + dims + dur + (v.paused ? "  ⏸" : "  ▶");
    label.style.cssText = [
      "position:absolute",
      "left:0",
      "top:-24px",
      "background:" + (pulse ? "#f59e0b" : "#2563eb"),
      "color:#fff",
      "font:12px/1 system-ui,sans-serif",
      "padding:4px 8px",
      "border-radius:5px",
      "white-space:nowrap",
    ].join(";");
    box.appendChild(label);
    (document.body || document.documentElement).appendChild(box);
    box._v = v;
    return box;
  }

  function reposition() {
    overlays.forEach((o) => {
      const r = o._v.getBoundingClientRect();
      o.style.left = r.left + "px";
      o.style.top = r.top + "px";
      o.style.width = r.width + "px";
      o.style.height = r.height + "px";
    });
  }

  function onScrollResize() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      reposition();
    });
  }

  function highlightOn() {
    clearOverlays();
    const vs = visibleVideos();
    vs.forEach((v, i) => overlays.push(makeOverlay(v, i + 1, false)));
    if (!active) {
      window.addEventListener("scroll", onScrollResize, true);
      window.addEventListener("resize", onScrollResize, true);
      active = true;
    }
    return vs.length;
  }

  function highlightOff() {
    clearOverlays();
    if (active) {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize, true);
      active = false;
    }
  }

  function flash(id) {
    const v = [...document.querySelectorAll("video")].find(
      (x) => x.dataset.lvgId === id
    );
    if (!v) return false;
    v.scrollIntoView({ block: "center", behavior: "smooth" });
    const inv = inventory().find((x) => x.id === id);
    const o = makeOverlay(v, inv ? inv.index : 0, true);
    setTimeout(() => o.remove(), 2200);
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.lvg) return;
    switch (msg.type) {
      case "scan":
        sendResponse({ ok: true, videos: inventory() });
        break;
      case "highlightOn":
        sendResponse({ ok: true, count: highlightOn() });
        break;
      case "highlightOff":
        highlightOff();
        sendResponse({ ok: true });
        break;
      case "flash":
        sendResponse({ ok: flash(msg.id) });
        break;
      default:
        sendResponse({ ok: false });
    }
    return true;
  });
})();

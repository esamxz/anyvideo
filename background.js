// Local Video Grabber - service worker
// ---------------------------------------------------------------------------
// Privacy contract: this extension NEVER contacts any third-party / vendor
// server. Detection is passive (we only observe the tab's own requests via
// webRequest). The only network it performs is fetching the media you click
// to download, directly from the source site. No telemetry, no licensing.
// ---------------------------------------------------------------------------

const MAX_PER_TAB = 60;

// URL-based classification ---------------------------------------------------
const RE_HLS    = /\.m3u8([?#]|$)/i;
const RE_DASH   = /\.mpd([?#]|$)/i;
const RE_DIRECT = /\.(mp4|m4v|webm|mov|ogv|ogg|m4a|mp3|aac|wav|flac)([?#]|$)/i;
const RE_SEGMENT = /\.(ts|m4s)([?#]|$)|(?:\/|[?&])(seg|chunk|frag)/i;

function classifyByUrl(url) {
  if (RE_HLS.test(url)) return "hls";
  if (RE_DASH.test(url)) return "dash";
  if (RE_DIRECT.test(url) && !RE_SEGMENT.test(url)) return "direct";
  return null;
}

function classifyByContentType(ct, url) {
  ct = (ct || "").toLowerCase();
  if (ct.includes("mpegurl")) return "hls";          // application/(x-|vnd.apple.)mpegurl
  if (ct.includes("dash+xml")) return "dash";
  if (ct === "video/mp2t") return null;              // a TS segment, not a whole video
  if (RE_SEGMENT.test(url)) return null;
  if (ct.startsWith("video/")) return "direct";
  if (ct.startsWith("audio/")) return "direct";
  return null;
}

// Per-tab store (kept in session storage so it survives SW restarts) ---------
const keyFor = (tabId) => "tab_" + tabId;

async function addMedia(tabId, item) {
  if (tabId < 0) return;
  const k = keyFor(tabId);
  const cur = (await chrome.storage.session.get(k))[k] || [];
  if (cur.some((x) => x.url === item.url)) return; // dedup
  cur.push(item);
  while (cur.length > MAX_PER_TAB) cur.shift();
  await chrome.storage.session.set({ [k]: cur });
  updateBadge(tabId, cur.length);
}

async function resetTab(tabId) {
  if (tabId < 0) return;
  await chrome.storage.session.remove(keyFor(tabId));
  updateBadge(tabId, 0);
}

function updateBadge(tabId, n) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  } catch (_) {}
}

// Passive detection ----------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === "main_frame") { resetTab(d.tabId); return; }
    const kind = classifyByUrl(d.url);
    if (kind) addMedia(d.tabId, { url: d.url, kind, ts: Date.now() });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (classifyByUrl(d.url)) return; // already handled by URL rule
    const h = (d.responseHeaders || []).find(
      (x) => x.name.toLowerCase() === "content-type"
    );
    const kind = classifyByContentType(h && h.value, d.url);
    if (kind) addMedia(d.tabId, { url: d.url, kind, ts: Date.now() });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clear badge/list when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => resetTab(tabId));

// Offscreen document (does HLS assembly + blob URL creation) -----------------
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Assemble HLS media segments into a downloadable file locally.",
    });
  } catch (e) {
    if (!String(e && e.message || e).includes("single offscreen")) throw e;
  }
}

function sanitize(name) {
  return (name || "video")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "video";
}

function extFromUrl(url, fallback) {
  const m = /\.([a-z0-9]{2,4})([?#]|$)/i.exec(url);
  return m ? "." + m[1].toLowerCase() : fallback;
}

async function handleDownload(item, suggestedName) {
  const base = sanitize(suggestedName);

  if (item.kind === "direct") {
    // The browser downloads this itself, reusing the site's own cookies.
    await chrome.downloads.download({
      url: item.url,
      filename: base + extFromUrl(item.url, ".mp4"),
      saveAs: true,
    });
    return { ok: true };
  }

  if (item.kind === "hls") {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "assembleHls",
      url: item.url,
    });
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || "assembly failed" };
    await chrome.downloads.download({
      url: res.blobUrl,
      filename: base + "." + res.ext,
      saveAs: true,
    });
    updateBadgeGlobal("");
    return { ok: true };
  }

  if (item.kind === "dash") {
    return { ok: false, error: "DASH assembly isn't in v0.1 yet — see README (Roadmap)." };
  }
  return { ok: false, error: "unknown media kind" };
}

function updateBadgeGlobal(text) {
  try { chrome.action.setBadgeText({ text }); } catch (_) {}
}

// Messaging ------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return; // not for us

  if (msg.type === "download") {
    handleDownload(msg.item, msg.name)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async
  }

  if (msg.type === "progress") {
    // Forwarded from offscreen; surface as a badge percentage.
    updateBadgeGlobal(Math.round(msg.value * 100) + "%");
    return; // popup (if open) also listens to this directly
  }
});

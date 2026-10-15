// Local Video Grabber - popup UI

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const videosEl = document.getElementById("videos");
const videosLabel = document.getElementById("videosLabel");
const streamsLabel = document.getElementById("streamsLabel");
const hlBtn = document.getElementById("hlBtn");
const hlHint = document.getElementById("hlHint");

let activeTab = null;
let pageVideos = [];
let highlighting = false;

function fmtUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname + url.pathname;
  } catch (_) {
    return u;
  }
}

// --- talk to the content script -------------------------------------------
function tabMsg(type, extra) {
  return new Promise((resolve) => {
    if (!activeTab) return resolve({ ok: false, error: "no tab" });
    chrome.tabs.sendMessage(activeTab.id, { lvg: true, type, ...(extra || {}) }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

// --- page video thumbnails -------------------------------------------------
function renderVideos() {
  videosEl.innerHTML = "";
  const has = pageVideos.length > 0;
  videosLabel.style.display = has ? "block" : "none";
  pageVideos.forEach((v) => {
    const card = document.createElement("div");
    card.className = "vcard";
    card.title = "Click to locate on the page";

    if (v.thumb) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = v.thumb;
      card.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "ph";
      ph.textContent = "no preview";
      card.appendChild(ph);
    }

    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent =
      "#" + v.index + (v.vw ? " · " + v.vw + "×" + v.vh : "") + (v.durationText ? " · " + v.durationText : "");
    card.appendChild(cap);

    card.addEventListener("click", () => tabMsg("flash", { id: v.id }));
    videosEl.appendChild(card);
  });
}

// --- detected streams ------------------------------------------------------
function render(items) {
  listEl.innerHTML = "";
  countEl.textContent = items.length ? items.length + " found" : "";
  emptyEl.style.display = items.length ? "none" : "block";
  streamsLabel.style.display = items.length ? "block" : "none";

  items.slice().reverse().forEach((item) => {
    const row = document.createElement("div");
    row.className = "item";

    const meta = document.createElement("div");
    meta.className = "meta";

    const badge = document.createElement("span");
    badge.className = "kind " + item.kind;
    badge.textContent = item.kind;
    meta.appendChild(badge);

    // Map a direct stream to a visible <video> (by currentSrc) so you can
    // click to locate exactly what you're about to download.
    const match = pageVideos.find((v) => v.currentSrc && v.currentSrc === item.url);
    if (match) {
      const tag = document.createElement("span");
      tag.className = "match";
      tag.textContent = "→ video #" + match.index;
      tag.title = "Locate this video on the page";
      tag.addEventListener("click", (e) => {
        e.stopPropagation();
        tabMsg("flash", { id: match.id });
      });
      meta.appendChild(tag);
    }

    const url = document.createElement("span");
    url.className = "url";
    url.textContent = fmtUrl(item.url);
    url.title = item.url;
    meta.appendChild(url);

    const btn = document.createElement("button");
    btn.textContent = item.kind === "dash" ? "Save .mpd?" : "Download";
    btn.addEventListener("click", () => download(item, btn));

    row.appendChild(meta);
    row.appendChild(btn);
    listEl.appendChild(row);
  });
}

function download(item, btn) {
  btn.disabled = true;
  statusEl.textContent =
    item.kind === "hls" ? "Fetching segments… (progress on the toolbar badge)" : "Starting download…";
  chrome.runtime.sendMessage(
    { type: "download", item, name: (activeTab && activeTab.title) || "video" },
    (res) => {
      btn.disabled = false;
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Error: " + chrome.runtime.lastError.message;
      } else if (res && res.ok) {
        statusEl.textContent = "✓ Download started — check your browser downloads.";
      } else {
        statusEl.textContent = "Error: " + ((res && res.error) || "unknown");
      }
    }
  );
}

// --- highlight toggle ------------------------------------------------------
hlBtn.addEventListener("click", async () => {
  const res = await tabMsg(highlighting ? "highlightOff" : "highlightOn");
  if (!res.ok) {
    hlHint.textContent = "Reload the page, then try again.";
    return;
  }
  highlighting = !highlighting;
  hlBtn.setAttribute("aria-pressed", String(highlighting));
  hlHint.textContent = highlighting ? (res.count || 0) + " outlined" : "";
});

// live progress while the popup stays open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "progress") {
    statusEl.textContent = "Downloading… " + Math.round(msg.value * 100) + "%";
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  // detected streams from the background's passive observer
  if (tab) {
    const k = "tab_" + tab.id;
    const items = (await chrome.storage.session.get(k))[k] || [];

    // page <video> inventory from the content script (thumbnails + sizes)
    const scan = await tabMsg("scan");
    if (scan.ok) {
      pageVideos = scan.videos || [];
      renderVideos();
    } else {
      hlHint.textContent = "Reload the page to enable highlighting.";
    }

    render(items);

    chrome.storage.session.onChanged.addListener((changes) => {
      if (changes[k]) render(changes[k].newValue || []);
    });
  } else {
    render([]);
  }
}

init();

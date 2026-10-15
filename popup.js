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
let favUrl = "";
let meta = {}; // { [url]: { fav, name, dismissed } }
let metaKey = null;
let lastItems = []; // most recent detected-stream list

// --- metadata (favorites / custom names / dismissed), per tab --------------
async function loadMeta() {
  if (!metaKey) return;
  meta = (await chrome.storage.session.get(metaKey))[metaKey] || {};
}
function saveMeta() {
  if (!metaKey) return;
  chrome.storage.session.set({ [metaKey]: meta });
}
function metaFor(url) {
  return meta[url] || (meta[url] = {});
}
function pruneMeta(items) {
  const urls = new Set(items.map((i) => i.url));
  let changed = false;
  for (const u of Object.keys(meta)) {
    if (!urls.has(u)) {
      delete meta[u];
      changed = true;
    }
  }
  if (changed) saveMeta();
}

// --- small helpers ---------------------------------------------------------
function fmtUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname + url.pathname;
  } catch (_) {
    return u;
  }
}

function sanitize(name) {
  return (
    (name || "video")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "video"
  );
}

function extFor(item) {
  if (item.kind === "direct") {
    const m = /\.([a-z0-9]{2,4})([?#]|$)/i.exec(item.url);
    return m ? "." + m[1].toLowerCase() : ".mp4";
  }
  if (item.kind === "dash") return ".mpd";
  return ".mp4"; // hls assembles to mp4 (or .ts fallback)
}

// Stem (no extension) used both as the display name and the download filename.
function baseName(item) {
  const m = meta[item.url];
  if (m && m.name) return m.name;
  return sanitize((activeTab && activeTab.title) || "video");
}

function fmtLabel(kind) {
  if (kind === "direct") return "FMT";
  if (kind === "dash") return "DASH";
  return "HLS";
}

function formatPill(item) {
  return extFor(item).replace(".", "").toUpperCase();
}

function resLabel(w, h) {
  if (!w || !h) return "Auto";
  const buckets = [2160, 1440, 1080, 720, 480, 360, 240];
  let best = buckets[0];
  for (const b of buckets) {
    if (Math.abs(b - h) < Math.abs(best - h)) best = b;
  }
  return best + "p";
}

// --- talk to the content script --------------------------------------------
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

// --- floating split-button menu --------------------------------------------
let openMenu = null;
function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}
document.addEventListener("click", closeMenu);

function showMenu(anchor, item) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";

  const copy = document.createElement("button");
  copy.textContent = "Copy media URL";
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(item.url).then(
      () => (statusEl.textContent = "✓ URL copied to clipboard."),
      () => (statusEl.textContent = "Couldn't copy URL.")
    );
    closeMenu();
  });
  menu.appendChild(copy);

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = r.bottom + "px";
  openMenu = menu;
}

// --- detected stream cards -------------------------------------------------
function render(items) {
  lastItems = items;
  listEl.innerHTML = "";
  closeMenu();
  pruneMeta(items);

  // newest-first, then favorites float to the top (stable)
  const ordered = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const fa = meta[a.it.url] && meta[a.it.url].fav ? 1 : 0;
      const fb = meta[b.it.url] && meta[b.it.url].fav ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return b.i - a.i; // newest first
    })
    .map((x) => x.it)
    .filter((it) => !(meta[it.url] && meta[it.url].dismissed));

  countEl.textContent = ordered.length ? ordered.length + " found" : "";
  emptyEl.style.display = ordered.length ? "none" : "block";
  streamsLabel.style.display = ordered.length ? "block" : "none";

  ordered.forEach((item) => listEl.appendChild(buildCard(item)));
}

function buildCard(item) {
  const m = metaFor(item.url);
  const match = pageVideos.find((v) => v.currentSrc && v.currentSrc === item.url);

  const card = document.createElement("div");
  card.className = "card" + (m.fav ? " fav" : "");

  // --- thumbnail block ---
  const thumbwrap = document.createElement("div");
  thumbwrap.className = "thumbwrap";

  if (match && match.thumb) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = match.thumb;
    thumbwrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = "▶";
    thumbwrap.appendChild(ph);
  }

  const star = document.createElement("button");
  star.className = "star";
  star.setAttribute("aria-pressed", String(!!m.fav));
  star.textContent = m.fav ? "★" : "☆";
  star.title = m.fav ? "Unfavorite" : "Favorite";
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    m.fav = !m.fav;
    saveMeta();
    render(lastItems);
  });
  thumbwrap.appendChild(star);

  if (favUrl) {
    const fav = document.createElement("img");
    fav.className = "ov fav-icon";
    fav.src = favUrl;
    fav.addEventListener("error", () => fav.remove());
    thumbwrap.appendChild(fav);
  }

  const durText = match && match.durationText;
  if (durText) {
    const dur = document.createElement("div");
    dur.className = "ov dur";
    dur.textContent = durText;
    thumbwrap.appendChild(dur);
  }

  card.appendChild(thumbwrap);

  // --- body ---
  const body = document.createElement("div");
  body.className = "body";

  // title row: format badge + name + pencil + close
  const titlerow = document.createElement("div");
  titlerow.className = "titlerow";

  const fmt = document.createElement("span");
  fmt.className = "fmt " + item.kind;
  fmt.textContent = fmtLabel(item.kind);
  titlerow.appendChild(fmt);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = baseName(item) + extFor(item);
  name.title = name.textContent;
  titlerow.appendChild(name);

  const pencil = document.createElement("button");
  pencil.className = "iconbtn";
  pencil.textContent = "✎";
  pencil.title = "Rename";
  pencil.addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(titlerow, name, pencil, item);
  });
  titlerow.appendChild(pencil);

  const close = document.createElement("button");
  close.className = "iconbtn x";
  close.textContent = "✕";
  close.title = "Remove from list";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    m.dismissed = true;
    saveMeta();
    render(lastItems);
  });
  titlerow.appendChild(close);

  body.appendChild(titlerow);

  // controls row: format pill + quality pill + download split
  const controls = document.createElement("div");
  controls.className = "controls";
  controls.appendChild(makePill("", formatPill(item)));
  controls.appendChild(makePill("", resLabel(match && match.vw, match && match.vh)));

  const dl = document.createElement("div");
  dl.className = "dl";
  const main = document.createElement("button");
  main.className = "main";
  main.textContent = item.kind === "dash" ? "Save .mpd?" : "Download";
  main.addEventListener("click", (e) => {
    e.stopPropagation();
    download(item, [main, split]);
  });
  const split = document.createElement("button");
  split.className = "split";
  split.textContent = "▾";
  split.title = "More";
  split.addEventListener("click", (e) => {
    e.stopPropagation();
    showMenu(split, item);
  });
  dl.appendChild(main);
  dl.appendChild(split);
  controls.appendChild(dl);

  body.appendChild(controls);
  card.appendChild(body);
  return card;
}

function makePill(label, value) {
  const pill = document.createElement("span");
  pill.className = "pill";
  if (label) {
    const lab = document.createElement("span");
    lab.className = "lab";
    lab.textContent = label;
    pill.appendChild(lab);
  }
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = value;
  pill.appendChild(val);
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "▴▾";
  pill.appendChild(chev);
  return pill;
}

function startRename(titlerow, nameEl, pencil, item) {
  const input = document.createElement("input");
  input.className = "name-input";
  input.value = baseName(item);
  titlerow.replaceChild(input, nameEl);
  pencil.disabled = true;
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      const m = metaFor(item.url);
      if (v && v !== sanitize((activeTab && activeTab.title) || "video")) m.name = sanitize(v);
      else delete m.name;
      saveMeta();
    }
    render(lastItems);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

function download(item, btns) {
  btns.forEach((b) => (b.disabled = true));
  statusEl.textContent =
    item.kind === "hls" ? "Fetching segments… (progress on the toolbar badge)" : "Starting download…";
  chrome.runtime.sendMessage(
    { type: "download", item, name: baseName(item) },
    (res) => {
      btns.forEach((b) => (b.disabled = false));
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
  if (tab && tab.favIconUrl && /^(https?:|data:)/.test(tab.favIconUrl)) {
    favUrl = tab.favIconUrl;
  }

  if (tab) {
    metaKey = "lvgmeta_" + tab.id;
    await loadMeta();

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

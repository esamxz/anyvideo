// Local Video Grabber - offscreen document
// Fetches an HLS playlist + its segments, (optionally) AES-128 decrypts them,
// concatenates everything into one file, and hands back a blob: URL.
// All fetches go ONLY to the media's own host. Nothing else is contacted.

const DEC = new TextDecoder();

function abs(uri, baseUrl) {
  return new URL(uri, baseUrl).href;
}

async function fetchText(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error("HTTP " + r.status + " for playlist");
  return await r.text();
}

async function fetchBytes(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + url.slice(0, 80));
  return new Uint8Array(await r.arrayBuffer());
}

// Parse "A=1,B="x",C=y" style attribute lists from HLS tags.
function parseAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) {
    out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

function pickBestVariant(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttrs(lines[i]);
      // next non-empty, non-comment line is the URI
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith("#"))) j++;
      if (j < lines.length) {
        variants.push({
          bandwidth: parseInt(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || "0", 10),
          resolution: attrs.RESOLUTION || "",
          url: abs(lines[j].trim(), baseUrl),
        });
      }
    }
  }
  if (!variants.length) return null;
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants[0];
}

function hexToBytes(hex) {
  hex = hex.replace(/^0x/i, "");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Default AES-128 IV = media sequence number as a 16-byte big-endian value.
function ivFromSeq(seq) {
  const iv = new Uint8Array(16);
  const dv = new DataView(iv.buffer);
  dv.setUint32(12, seq >>> 0);
  return iv;
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let mapUri = null;
  let key = null; // { method, uri, iv }
  let seq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      seq = parseInt(line.split(":")[1] || "0", 10) || 0;
    } else if (line.startsWith("#EXT-X-MAP")) {
      const a = parseAttrs(line);
      if (a.URI) mapUri = abs(a.URI, baseUrl);
    } else if (line.startsWith("#EXT-X-KEY")) {
      const a = parseAttrs(line);
      if (a.METHOD === "NONE") {
        key = null;
      } else {
        key = {
          method: a.METHOD,
          uri: a.URI ? abs(a.URI, baseUrl) : null,
          iv: a.IV ? hexToBytes(a.IV) : null,
        };
      }
    } else if (!line.startsWith("#")) {
      segments.push({
        url: abs(line, baseUrl),
        seq: seq++,
        key, // key in effect for this segment
      });
    }
  }
  return { segments, mapUri };
}

// Rewrap MPEG-TS elementary streams (H.264 + AAC/MP3) into a fragmented MP4
// using the locally-bundled mux.js. No re-encoding, no network. Resolves to a
// single Uint8Array; rejects if mux.js is missing or the stream can't be muxed.
function remuxTsToMp4(tsParts) {
  return new Promise((resolve, reject) => {
    if (typeof muxjs === "undefined") return reject(new Error("mux.js not loaded"));
    const transmuxer = new muxjs.mp4.Transmuxer();
    const chunks = [];
    let initSeg = null;
    transmuxer.on("data", (seg) => {
      if (!initSeg) {
        initSeg = seg.initSegment;
        chunks.push(initSeg);
      }
      chunks.push(seg.data);
    });
    transmuxer.on("done", () => {
      if (!chunks.length) return reject(new Error("remux produced no output"));
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      resolve(out);
    });
    try {
      for (const p of tsParts) transmuxer.push(p);
      transmuxer.flush();
    } catch (e) {
      reject(e);
    }
  });
}

async function importKey(uri) {
  const raw = await fetchBytes(uri);
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
}

async function assembleHls(masterUrl) {
  const masterTxt = await fetchText(masterUrl);

  let mediaUrl = masterUrl;
  if (/#EXT-X-STREAM-INF/.test(masterTxt)) {
    const best = pickBestVariant(masterTxt, masterUrl);
    if (!best) throw new Error("No playable variant found in master playlist");
    mediaUrl = best.url;
  }

  const mediaTxt = await fetchText(mediaUrl);
  const { segments, mapUri } = parseMediaPlaylist(mediaTxt, mediaUrl);
  if (!segments.length) throw new Error("Playlist had no segments (live stream or unsupported)");

  // Set up decryption keys (cache by URI).
  const keyCache = new Map();
  for (const s of segments) {
    if (s.key && s.key.method && s.key.method !== "AES-128") {
      throw new Error("Unsupported HLS encryption: " + s.key.method + " (only AES-128)");
    }
    if (s.key && s.key.uri && !keyCache.has(s.key.uri)) {
      keyCache.set(s.key.uri, await importKey(s.key.uri));
    }
  }

  const parts = [];
  if (mapUri) parts.push(await fetchBytes(mapUri)); // fMP4 init segment

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    let buf = await fetchBytes(s.url);
    if (s.key && s.key.uri) {
      const ck = keyCache.get(s.key.uri);
      const iv = s.key.iv || ivFromSeq(s.seq);
      const dec = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, buf);
      buf = new Uint8Array(dec);
    }
    parts.push(buf);
    chrome.runtime.sendMessage({ type: "progress", value: (i + 1) / segments.length });
  }

  const isFmp4 = !!mapUri || /\.m4s([?#]|$)/i.test(segments[0].url);
  let outParts = parts;
  let ext = isFmp4 ? "mp4" : "ts";
  let mime = isFmp4 ? "video/mp4" : "video/mp2t";

  // MPEG-TS -> fragmented MP4 (lossless rewrap) via bundled mux.js.
  // Falls back to raw .ts if mux.js is absent or the codec isn't supported.
  if (!isFmp4 && typeof muxjs !== "undefined") {
    try {
      outParts = [await remuxTsToMp4(parts)];
      ext = "mp4";
      mime = "video/mp4";
    } catch (e) {
      console.warn("[LVG] TS->MP4 remux failed, saving .ts instead:", e);
      outParts = parts;
      ext = "ts";
      mime = "video/mp2t";
    }
  }

  const blob = new Blob(outParts, { type: mime });
  const blobUrl = URL.createObjectURL(blob);
  // Keep the URL alive long enough for chrome.downloads to grab it, then free.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
  return { blobUrl, ext };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "assembleHls") {
    assembleHls(msg.url)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }
});

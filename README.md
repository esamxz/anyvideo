# Local Video Grabber

A tiny, **fully local** Chrome/Edge (Manifest V3) extension that detects the
video playing in the current tab and downloads it. Built as a privacy-clean
alternative to Video Download Helper for personal use.

## The privacy contract
- **No external servers.** It never contacts any vendor/analytics/licensing host.
- **No telemetry, no licensing, no remote config.** None of VDH's
  `downloadhelper.net` calls exist here.
- **Detection is passive** — it only *observes* the current tab's own network
  requests (via the `webRequest` API) to notice media URLs.
- The **only** network it ever performs is fetching the media *you* click to
  download, straight from the site you're already on. That fetch *is* the
  download.

## Install (load unpacked)
1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`local-video-grabber`).
4. Pin the extension. Open a page, start the video, then click the icon.

## How it works
```
 webRequest (passive)        popup.html / popup.js          offscreen.js
 observes tab traffic   ->   lists detected media    ->   fetch + (AES-128) decrypt
 stores per-tab in                click Download             + concat segments
 storage.session                                             -> blob: URL
                                                                   |
 background.js (service worker) -- chrome.downloads.download <-----+
```
- **Direct files** (`.mp4`, `.webm`, `.m4a`, …): handed straight to the
  browser's download manager (it reuses the site's own cookies).
- **HLS** (`.m3u8`): the offscreen document picks the highest-bitrate variant,
  downloads every segment, decrypts **AES-128** streams on the fly (via
  WebCrypto), concatenates them, and saves:
  - MPEG-TS segments → **remuxed to `.mp4`** with the locally-bundled
    [mux.js](https://github.com/videojs/mux.js) (`vendor/mux.min.js`) — a
    lossless rewrap (no re-encode), covering H.264 + AAC/MP3. If `vendor/mux.min.js`
    is missing or the codec isn't supported (e.g. H.265), it falls back to a raw
    `.ts` file (still plays in VLC/mpv).
  - fMP4 segments (`#EXT-X-MAP` / `.m4s`) → `.mp4` (fragmented MP4), as before.

## What works in v0.1
- ✅ Direct progressive files.
- ✅ HLS VOD, including `RESOLUTION`/`BANDWIDTH` variant selection and
  **AES-128** encryption.
- ✅ Per-tab detection with a badge counter; live progress while downloading.
- ✅ **On-page highlight** — the popup lists each `<video>` on the page with a
  captured thumbnail. Click a thumbnail (or the "→ video #n" tag on a matched
  stream) to scroll to it and flash an outline, and use **Highlight videos on
  page** to outline them all. Lets you confirm *what* you're downloading.
  (Highlighting is done by a passive content script — top frame only, no
  network; cross-origin embedded players can't be outlined.)

## Roadmap / known limits
- **DASH (`.mpd`)** is *detected* but not yet assembled (separate audio+video
  adaptation sets and byte-range segments need muxing). Next up.
- **Separate audio+video HLS tracks** aren't merged yet — v0.1 grabs the video
  rendition. Merging needs a muxer (see below).
- **SAMPLE-AES / DRM (Widevine, FairPlay)** cannot be downloaded — that's
  encryption this tool deliberately won't touch.
- **Live streams** (no `#EXT-X-ENDLIST`) aren't captured as a finite file.
- **Very large videos** are assembled in memory; extremely long files may be
  memory-heavy.

## Optional: clean `.mp4` remux / audio+video merge (add ffmpeg.wasm locally)
To turn `.ts` output into a clean `.mp4`, or merge separate audio/video tracks,
vendor **ffmpeg.wasm** into this folder (keeps everything local — no CDN):

1. `npm i @ffmpeg/ffmpeg @ffmpeg/core` in a scratch folder.
2. Copy `ffmpeg-core.js`, `ffmpeg-core.wasm` (single-thread build avoids
   `SharedArrayBuffer`/cross-origin-isolation headaches) into `./vendor/`.
3. In `offscreen.js`, after the segments are concatenated, run
   `ffmpeg -i input.ts -c copy output.mp4` through the local core and blob that
   instead. The manifest already allows `wasm-unsafe-eval` for this.

The core download path above needs **no** dependencies and no network beyond
the media host.
# anyvideo

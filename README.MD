# Sciagen Single HTML Saver

Chrome extension (Manifest V3) that saves a complete web page into one self-contained HTML file. Fork of [SingleFile MV3](https://github.com/gildas-lormeau/SingleFile-MV3) by Gildas Lormeau, AGPL-3.0 (see LICENSE).

Changes from SingleFile:

- Reloads the tab with the cache bypassed before saving, so every resource is fetched fresh (`reloadBeforeSave`, default on).
- Embeds videos and audio as data URIs (`blockVideos` / `blockAudios` off), so media from external sources is stored in the HTML file itself.
- Keeps hidden elements (`removeHiddenElements` off), such as collapsed sections, inactive tabs and hidden panels.
- Embeds 3D files (`.glb .gltf .obj .stl .fbx .usdz .ply .dae .3mf ...`) referenced from attributes, e.g. `<model-viewer src>`, A-Frame assets, or links. When it finds 3D files it keeps the page scripts so viewers still render offline.
- Embeds video/audio/GIF files that only appear in attributes such as `data-src` (click-to-play players), keeping the page scripts so the player still works offline.
- Keeps every image variant (`removeAlternativeImages` off); a GIF fallback inside `<picture>` is kept next to the displayed WebP/AVIF.
- Keeps all CSS and fonts (`removeUnusedStyles` / `removeUnusedFonts` off), so styles for animations, menus and content JS reveals later still apply.
- GIFs and other images are embedded byte-for-byte (no re-encoding).
- Sciagen name, logo icons (`tools/make-icons.ps1` from `tools/sciagen-logo.png`) and UI theme (`src/ui/pages/sciagen-theme.css`).

Build: `npm ci && bash build.sh`, then load this folder via `chrome://extensions` > Developer mode > Load unpacked.
Check: `npm run install-test-browser && npm run test:sciagen`. Save any page with the extension headlessly: `node test/sciagen-capture-e2e.mjs <url> out.html`.

Known limits: streamed or embedded-player video (YouTube, Google Drive, `blob:`/MSE players), WebGL scenes whose libraries load as ES modules from a CDN (saved as a still image of the canvas) and 3D models loaded only from JavaScript (e.g. three.js loaders with URLs built in code) can't be captured. Very large videos make very large HTML files.

---

# SingleFile MV3

This is the new version of [SingleFile](https://www.getsinglefile.com) compatible with the Manifest V3.

## Manual install

Download the zip file
(https://github.com/gildas-lormeau/SingleFile-MV3/archive/master.zip) of the project
and install it manually by unzipping it somewhere on your disk and following
these instructions:

- Chrome:
  https://developer.chrome.com/docs/extensions/mv3/getstarted/development-basics/#load-unpacked
- Microsoft Edge:
  https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/getting-started/extension-sideloading

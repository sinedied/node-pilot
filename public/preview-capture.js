// Cockpit.js capture bridge — injected into the proxied dev preview by the
// canvas server (see src/server.ts). Because the preview is reverse-proxied
// through the canvas origin, this script runs *same-origin* in the page's own
// realm, so it can rasterize the live DOM with snapdom (vendored, MIT) and hand
// a PNG back to the parent canvas via postMessage. No screen-capture, no OS
// permission prompt — just the website.
(() => {
  if (window.__cockpitCaptureBridge) return;
  window.__cockpitCaptureBridge = true;

  async function rasterize() {
    const sd = window.snapdom;
    if (typeof sd === "undefined" || typeof sd.toCanvas !== "function") {
      throw new Error("snapdom-missing");
    }
    // Capture the whole document (full scroll height, not just the viewport).
    const target = document.documentElement;
    // Resolve a solid page background so the shot isn't transparent.
    const probe = document.body || document.documentElement;
    let bg = getComputedStyle(probe).backgroundColor;
    if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") bg = "#ffffff";
    // Keep the raster within WebKit's canvas limits: cap the longest side and the
    // total area so very long pages don't fail or come back blank.
    const w = target.scrollWidth || window.innerWidth || 1;
    const h = target.scrollHeight || window.innerHeight || 1;
    const MAX_SIDE = 4096;
    const MAX_AREA = 16_000_000;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
    const canvas = await sd.toCanvas(target, { backgroundColor: bg, scale });
    return canvas.toDataURL("image/png");
  }

  window.addEventListener("message", async (ev) => {
    // Only honor capture requests from our canvas parent, same-origin. Without
    // this a third-party iframe embedded in the dev app could request — and
    // receive — a screenshot of the page.
    if (ev.source !== window.parent || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (d?.type !== "cockpit:capture") return;
    const reply = (msg) => {
      try {
        window.parent.postMessage({ ...msg, id: d.id }, window.location.origin);
      } catch {}
    };
    try {
      const dataUrl = await rasterize();
      reply({ type: "cockpit:capture:result", dataUrl });
    } catch (err) {
      reply({ type: "cockpit:capture:result", error: String(err?.message || err) });
    }
  });
})();

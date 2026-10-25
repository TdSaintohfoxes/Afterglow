/* Afterglow service worker: offline app shell, cached posters, resilient API reads. */
const VERSION = "afterglow-v1";
const SHELL = `${VERSION}-shell`;
const IMAGES = `${VERSION}-img`;
const API = `${VERSION}-api`;
const FONTS = `${VERSION}-fonts`;
const SHELL_FILES = [
  "./", "index.html", "styles.css", "app.js", "engine.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // App shell: serve cached, refresh in the background.
  if (url.origin === location.origin) {
    if (req.mode === "navigate") {
      e.respondWith(
        fetch(req).catch(() => caches.match("index.html").then((r) => r || caches.match("./")))
      );
      return;
    }
    e.respondWith(
      caches.open(SHELL).then(async (c) => {
        const hit = await c.match(req, { ignoreSearch: true });
        const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
        return hit || (await net) || Response.error();
      })
    );
    return;
  }

  // Posters and backdrops: cache first.
  if (url.hostname === "image.tmdb.org") {
    e.respondWith(
      caches.open(IMAGES).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === "opaque") { c.put(req, res.clone()); trim(IMAGES, 220); }
          return res;
        } catch { return Response.error(); }
      })
    );
    return;
  }

  // TMDB data: network first, fall back to the last copy when offline.
  if (url.hostname === "api.themoviedb.org") {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(API).then((c) => { c.put(req, copy); trim(API, 300); }); }
        return res;
      }).catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // Google Fonts: stale-while-revalidate.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.open(FONTS).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => null);
        return hit || (await net) || Response.error();
      })
    );
  }
});

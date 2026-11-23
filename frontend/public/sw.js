/* Encore service worker: installable app, offline shell, last-known data, saved songs.
 *
 * Caches
 *   encore-shell-v1    index.html and the hashed /assets/* files of the current build
 *   encore-data-v1     last good API answers and cover art, used when Encore is unreachable
 *   encore-offline-v1  songs the user saved for offline use (written by the page, see src/offline.ts)
 *
 * Answers that come from a cache because the network failed carry "x-encore-offline: 1",
 * so the page can show that it is offline.
 */
const SHELL = "encore-shell-v1";
const DATA = "encore-data-v1";
const OFFLINE = "encore-offline-v1";
const KEEP = [SHELL, DATA, OFFLINE];
const STATIC = ["/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"];
const API_TIMEOUT = 4000; // a LAN server that is not there can take a long time to fail
const NAV_TIMEOUT = 3500;
const QUICK_TIMEOUT = 1200; // right after a failure: do not wait the full time again
let lastFailure = 0;

function timeoutFor(ms) {
  return Date.now() - lastFailure < 15000 ? Math.min(ms, QUICK_TIMEOUT) : ms;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(STATIC).catch(() => {});
      try {
        const res = await fetch("/", { cache: "no-store" });
        if (res.ok) await storeShell(cache, res);
      } catch {
        /* installed while offline: the shell gets cached on the next visit */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/** Cache index.html plus every asset it references, and drop assets of older builds. */
async function storeShell(cache, res) {
  const html = await res.clone().text();
  await cache.put("/", res);
  const assets = [...new Set([...html.matchAll(/\/assets\/[^"'()\s>]+/g)].map((m) => m[0]))];
  await Promise.all(assets.map((a) => cache.match(a).then((hit) => hit || cache.add(a).catch(() => {}))));
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/assets/") && !assets.includes(path)) await cache.delete(req);
  }
}

function withTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function markOffline(res) {
  const headers = new Headers(res.headers);
  headers.set("x-encore-offline", "1");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function fromCaches(request, names) {
  for (const name of names) {
    const hit = await (await caches.open(name)).match(request, { ignoreVary: true });
    if (hit) return hit;
  }
  return null;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  // App shell: newest version when Encore is reachable, cached one otherwise.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        try {
          const res = await withTimeout(new Request("/", { cache: "no-store" }), timeoutFor(NAV_TIMEOUT));
          if (res.ok) {
            event.waitUntil(storeShell(cache, res.clone()));
            return res;
          }
          throw new Error(String(res.status));
        } catch {
          lastFailure = Date.now();
          const hit = await cache.match("/");
          if (hit) return hit;
          return new Response("<h1>Encore is offline</h1><p>Open it once while connected to your Encore server.</p>", {
            status: 503, headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      })(),
    );
    return;
  }

  // Hashed build files never change: cache first.
  if (path.startsWith("/assets/") || STATIC.includes(path)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) event.waitUntil(cache.put(req, res.clone()));
        return res;
      })(),
    );
    return;
  }

  // Stems and covers of saved songs play from the device; the music video always streams.
  if (path.startsWith("/media/")) {
    if (req.headers.has("range") || path.endsWith(".mp4")) return;
    const isCover = path.endsWith("/cover.jpg");
    event.respondWith(
      (async () => {
        const hit = await fromCaches(req, isCover ? [OFFLINE, DATA] : [OFFLINE]);
        if (hit) return hit;
        const res = await fetch(req);
        if (isCover && res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(DATA).then((c) => c.put(req, copy)));
        }
        return res;
      })(),
    );
    return;
  }

  // Remote cover art through the proxy: cache first, it is content addressed.
  if (path === "/api/thumb") {
    event.respondWith(
      (async () => {
        const hit = await fromCaches(req, [OFFLINE, DATA]);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(DATA).then((c) => c.put(req, copy)));
        }
        return res;
      })(),
    );
    return;
  }

  // Data the app needs to start and to show the library: network first, last answer offline.
  if (/^\/api\/(songs(\/[^/]+)?|config|queue|backgrounds|system)$/.test(path)) {
    event.respondWith(
      (async () => {
        try {
          const res = await withTimeout(req, timeoutFor(API_TIMEOUT));
          lastFailure = 0;
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(DATA).then((c) => c.put(req, copy)));
          }
          return res;
        } catch {
          lastFailure = Date.now();
          const hit = await fromCaches(req, [OFFLINE, DATA]);
          if (hit) return markOffline(hit);
          return new Response(JSON.stringify({ detail: "Encore is offline" }), {
            status: 503, headers: { "content-type": "application/json", "x-encore-offline": "1" },
          });
        }
      })(),
    );
  }
});

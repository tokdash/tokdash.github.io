/* Tokdash service worker (minimal PWA install support).
 * Static-demo copy of src/tokdash/static/sw.js — the runtime server substitutes
 * __TOKDASH_CACHE_NAME__; here we bake in a literal version string instead. */

const BASE_PATH = new URL(self.location.href).searchParams.get("base") || "";
const CACHE_NAME = `tokdash-demo-v2${BASE_PATH ? `-${encodeURIComponent(BASE_PATH)}` : ""}`;

function appPath(path) {
  return `${BASE_PATH || ""}${path}`;
}

function localPath(pathname) {
  return BASE_PATH && pathname.startsWith(`${BASE_PATH}/`)
    ? pathname.slice(BASE_PATH.length)
    : pathname;
}

const CORE_ASSETS = [
  appPath("/"),
  appPath("/demo/"),
  BASE_PATH ? `${appPath("/manifest.webmanifest")}?base=${encodeURIComponent(BASE_PATH)}` : appPath("/manifest.webmanifest"),
  appPath("/static/icons/icon-192.png"),
  appPath("/static/icons/icon-512.png"),
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const path = localPath(url.pathname);

  // Avoid caching API requests.
  if (path.startsWith("/api/") || path === "/health") return;

  // Navigation: network-first, fall back to cached app shell.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(appPath("/"))));
    return;
  }

  // Static assets: prefer fresh network content after upgrades, fall back to
  // the most recent cached copy when offline.
  if (path.startsWith("/static/")) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
  }
});

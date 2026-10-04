// Service worker: keeps the app shell for offline start and installability
// (PWA for the Meta Horizon Store, Trusted Web Activity for Google Play).
// Tiles and imagery are cached by the app itself (Cache Storage, terrain.ts).
const SHELL = "atlas-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icons/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Network first for the app itself, so updates arrive; the cached shell
  // is the fallback when offline.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("./", copy));
          return res;
        })
        .catch(() => caches.match("./")),
    );
  } else if (url.origin === location.origin && url.pathname.includes("/assets/index-")) {
    // Hashed build files never change: cache first.
    e.respondWith(
      caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
        return res;
      })),
    );
  }
});

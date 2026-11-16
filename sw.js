// Offline shell for AIFE Desk. Caches the app's own files only; GitHub API calls always go
// to the network (the app keeps its last loaded data itself and says how old it is).
const CACHE = "aife-desk-v3";
const SHELL = ["./", "index.html", "desk.css", "desk.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // network first so a new version shows at once; the cache answers when offline
  e.respondWith(fetch(e.request).then((res) => {
    // a query string can carry a FYERS login code: never store it; keep one copy per path
    const copy = res.clone();
    if (res.ok) caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy));
    return res;
  }).catch(() => caches.match(url.origin + url.pathname).then((hit) => hit || caches.match("index.html"))));
});

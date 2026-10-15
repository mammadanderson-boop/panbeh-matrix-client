// The web app opens offline: its files are kept as they load. Hashed /assets/ never change, so they come from the
// cache first; everything else (index.html, the crypto wasm) from the network first, so a new build shows up.
// Never the homeserver's API, even when it shares the origin.
const CACHE = "panbeh-shell";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || /^\/_(matrix|synapse)\//.test(url.pathname)) return;
  const keep = (res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; };
  const cached = () => caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" });
  e.respondWith(url.pathname.includes("/assets/")
    ? cached().then((hit) => hit ?? fetch(e.request).then(keep))
    : fetch(e.request).then(keep, async () => (await cached()) ?? (e.request.mode === "navigate" ? await caches.match(self.registration.scope) : undefined) ?? Response.error()));
});

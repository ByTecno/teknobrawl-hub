// Service worker del Hub: solo guarda la "carcasa" de la web (HTML, CSS, JS e iconos) para que abra
// sin conexión. Nunca guarda ni intercepta /api/* (datos) ni /auth/* (inicio de sesión).
const CACHE = "hub-v2";
const SHELL = ["/", "/app.css", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Red primero (así siempre se ve la última versión); si no hay conexión, la copia guardada.
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      const key = req.mode === "navigate" ? "/" : req;
      caches.open(CACHE).then(c => c.put(key, copy));
    }
    return res;
  }).catch(() => caches.match(req.mode === "navigate" ? "/" : req)));
});

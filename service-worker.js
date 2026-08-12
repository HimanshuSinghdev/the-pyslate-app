// PySlate service worker
//
// Two jobs:
//   1. Auto-update: network-first for the app shell, so a redeploy (Netlify
//      or GitHub Pages) is picked up the next time the installed app is
//      opened — no uninstall/reinstall needed. Cache is only a fallback for
//      when there's no connection.
//   2. Cross-origin isolation polyfill: SharedArrayBuffer (needed for the
//      live, pausing input() prompt) requires the page to be served with
//      Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers.
//      Netlify can set those via the _headers file, but GitHub Pages (and
//      many other static hosts) can't set custom headers at all — so this
//      worker adds them itself on every same-origin response. app.js
//      reloads the page once after this worker takes control so the
//      headers actually take effect (the standard "coi-serviceworker"
//      technique). Where real headers are already present (Netlify), the
//      page is already isolated before this ever matters.

const SHELL_CACHE = 'pyslate-shell-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/worker.js',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {}) // best-effort; don't block install if offline on first load
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

function withCoiHeaders(response){
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return response.blob().then((body) => new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const isSameOrigin = new URL(req.url).origin === self.location.origin;

  // Cross-origin requests (Pyodide, CodeMirror, fonts from CDNs) are left
  // completely untouched — they already carry their own CORS/CORP headers.
  if (req.method !== 'GET' || !isSameOrigin){
    return;
  }

  if (req.mode === 'navigate') {
    // Always try the network first so a redeploy shows up immediately.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', copy));
          return withCoiHeaders(res);
        })
        .catch(() => caches.match('./index.html').then((cached) => cached ? withCoiHeaders(cached) : Response.error()))
    );
    return;
  }

  // Static shell assets: try cache first for speed, refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
          return withCoiHeaders(res);
        })
        .catch(() => cached ? withCoiHeaders(cached) : Response.error());
      return cached ? withCoiHeaders(cached) : fetchPromise;
    })
  );
});

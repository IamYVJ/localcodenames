// ===========================================================================
// sw.js — service worker. Precaches the full app shell and serves it
// cache-first so the game loads instantly and works offline as a PWA.
//
// All paths are RELATIVE so the worker functions correctly under a GitHub
// Pages subpath (https://<user>.github.io/localcodenames/). The worker's
// scope is the directory it is served from.
//
// NOTE: caching the shell makes the *app* work offline, but PeerJS still needs
// to reach its signaling broker over the network once per session to set up
// each WebRTC handshake. After that, gameplay traffic is direct P2P on the LAN.
// ===========================================================================

const CACHE = 'codenames-v7';

// Local app shell (relative to this worker's location).
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/main.js',
  'js/config.js',
  'js/words.js',
  'js/rules.js',
  'js/storage.js',
  'js/net.js',
  'js/render.js',
  'js/ui.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Cross-origin assets we also want cached (best-effort; never block install).
const EXTERNAL = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap',
];

const CACHEABLE_HOSTS = new Set([
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Shell is atomic — if any local file 404s we want to know.
    await cache.addAll(SHELL);
    // External assets are best-effort so a flaky CDN can't break install.
    await Promise.all(EXTERNAL.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const res = await fetch(req);
    const host = new URL(req.url).host;
    const sameOrigin = new URL(req.url).origin === self.location.origin;
    const cacheable = sameOrigin || CACHEABLE_HOSTS.has(host);
    // Cache successful same-origin/known responses, plus opaque font binaries.
    if (cacheable && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    // Offline navigation → fall back to the cached app shell.
    if (req.mode === 'navigate') {
      const fallback = (await cache.match('index.html')) || (await cache.match('./'));
      if (fallback) return fallback;
    }
    throw err;
  }
}

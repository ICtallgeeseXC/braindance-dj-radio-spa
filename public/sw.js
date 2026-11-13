// public/sw.js
// PYRAMID // RADIO Service Worker
// Provides 100% offline functionality, full asset caching, and standalone PWA installation.

const CACHE_NAME = 'pyramid-radio-v2';
const RUNTIME_CACHE = 'pyramid-radio-runtime-v2';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png',
  '/fonts/orbitron-400.woff2',
  '/fonts/rajdhani-500.woff2',
  '/fonts/rajdhani-600.woff2',
  '/fonts/rajdhani-700.woff2',
  '/fonts/share-tech-mono-400.woff2'
];

// --- 1. Install Event: Pre-cache App Shell & Offline Fonts ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Pre-caching offline app shell and fonts...');
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// --- 2. Activate Event: Prune Outdated Caches & Claim Clients Immediately ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME && name !== RUNTIME_CACHE) {
            console.log('[ServiceWorker] Removing legacy cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// --- 3. Fetch Event: Cache Strategies & Offline Fallbacks ---
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Bypass non-GET requests, WebSockets, P2P Relay tunnel, and external signaling
  if (request.method !== 'GET') return;
  if (url.protocol.startsWith('ws')) return;
  if (url.pathname.startsWith('/__p2p_relay')) return;
  if (url.hostname.includes('peerjs.com') || url.hostname.includes('metered.ca')) return;

  // Handle SPA Navigation requests (HTML)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(async () => {
          // If offline, serve cached index.html
          const cached = await caches.match('/index.html') || await caches.match('/');
          if (cached) return cached;
          return new Response('Offline: PYRAMID // RADIO cache ready', {
            headers: { 'Content-Type': 'text/html' }
          });
        })
    );
    return;
  }

  // Handle Static & Runtime Assets (JS chunks, CSS, Web Worker scripts, fonts, icons)
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => {
          // Only cache valid basic or cors responses
          if (!networkResponse || (networkResponse.status !== 200 && networkResponse.type !== 'opaque')) {
            return networkResponse;
          }

          // Never cache HTML SPA fallbacks as /assets/ JS or CSS
          const contentType = networkResponse.headers.get('content-type') || '';
          if (url.pathname.startsWith('/assets/') && contentType.includes('text/html')) {
            return networkResponse;
          }

          // Cache Vite assets, fonts, and local files into RUNTIME_CACHE
          if (
            url.origin === self.location.origin ||
            url.hostname.includes('fonts.gstatic.com') ||
            url.hostname.includes('fonts.googleapis.com')
          ) {
            const copy = networkResponse.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, copy);
            });
          }

          return networkResponse;
        })
        .catch(() => {
          // Fail gracefully if offline and not in cache
          return new Response('', { status: 408, statusText: 'Request timed out or offline' });
        });
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  BUMP `BUILD` BEFORE EVERY `git push`
//     One value change here forces every visitor's browser to detect the new
//     SW, install it, nuke the old cache, and pull fresh assets — guaranteed.
//     Format: YYYYMMDD-N  (increment N if you push more than once per day)
// ─────────────────────────────────────────────────────────────────────────────
const BUILD = '20260531-1';
const CACHE  = `sr-${BUILD}`;

// Icons + manifest to pre-cache (index.html is intentionally NOT here — always fetched fresh)
const PRECACHE = [
  './manifest.json',
  './icon-96.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.all(
        PRECACHE.map(url =>
          cache.add(url).catch(() => console.warn('[SafeReach SW] Failed to cache', url))
        )
      )
    )
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
// Delete every cache that doesn't match the current BUILD, then claim all tabs.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // 1. Never intercept sw.js itself
  if (url.pathname.endsWith('sw.js')) return;

  // 2. Skip non-GET and non-http requests
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // 3. API calls (Overpass / Nominatim / Meteo) — never cache, always live
  if (
    url.hostname.includes('overpass-api.de') ||
    url.hostname.includes('nominatim.openstreetmap.org') ||
    url.hostname.includes('open-meteo.com')
  ) return;

  // 4. HTML / navigation → network-first, never cached
  //    Users always load the latest HTML after every deploy.
  if (
    request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html')
  ) {
    e.respondWith(
      fetch(request, { cache: 'no-store' })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 5. Everything else → cache-first, background-update
  e.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request)
        .then(response => {
          if (response.ok && request.method === 'GET') {
            caches.open(CACHE).then(c => c.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => null);
      return cached || networkFetch;
    })
  );
});

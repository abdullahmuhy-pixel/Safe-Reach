// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  BUMP `BUILD` BEFORE EVERY `git push`
//     One value change here forces every visitor's browser to detect the new
//     SW, install it, nuke the old cache, and pull fresh assets — guaranteed.
//     Format: YYYYMMDD-N  (increment N if you push more than once per day)
// ─────────────────────────────────────────────────────────────────────────────
const BUILD = '20260531-1';
const CACHE  = `sr-${BUILD}`;

// App shell to pre-cache on install.
// index.html is intentionally NOT here — always fetched fresh (see fetch handler).
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
          cache.add(url).catch(() => console.warn('[SafeReach SW] Failed to pre-cache:', url))
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
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(async () => {
        // Notify all open tabs that a new version is now in control
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach(c => { try { c.postMessage({ type: 'SW_UPDATED', build: BUILD }); } catch {} });
      })
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Never intercept sw.js itself — browser must always fetch it fresh
  if (url.pathname.endsWith('sw.js')) return;

  // 2. API calls (Overpass / Nominatim / Meteo) → network-first, 5-min cache fallback
  if (isAPICall(url)) {
    e.respondWith(networkFirstWithCache(request, CACHE + '-api', 300));
    return;
  }

  // 3. Map tiles (CARTO / OSM) → cache-first, 7-day TTL, stale-while-revalidate
  if (isMapTile(url)) {
    e.respondWith(tileStrategy(request));
    return;
  }

  // 4. HTML / navigation → NETWORK-FIRST, never served from cache
  //    Users always load the latest HTML after every deploy.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(request, { cache: 'no-store' })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 5. Everything else (JS / CSS / fonts / icons / manifest) → cache-first, background update
  e.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request)
        .then(response => {
          if (response.ok) {
            caches.open(CACHE).then(c => c.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => null);
      return cached || networkFetch;
    })
  );
});

// ── Caching strategies ────────────────────────────────────────────────────────

async function tileStrategy(request) {
  const cache  = await caches.open(CACHE + '-tiles');
  const cached = await cache.match(request);
  const TTL    = 7 * 24 * 60 * 60 * 1000; // 7 days

  if (cached) {
    const ts = cached.headers.get('sw-fetched-at');
    if (ts && (Date.now() - parseInt(ts)) < TTL) return cached; // still fresh
    // Stale — serve immediately, refresh in background
    refreshTile(request, cache).catch(() => {});
    return cached;
  }

  try {
    return await refreshTile(request, cache);
  } catch {
    return new Response('Map tile unavailable offline', { status: 503 });
  }
}

async function refreshTile(request, cache) {
  const response = await fetch(request);
  if (response && response.ok) {
    const headers = new Headers(response.headers);
    headers.set('sw-fetched-at', String(Date.now()));
    const stamped = new Response(await response.blob(), {
      status: response.status, statusText: response.statusText, headers,
    });
    cache.put(request, stamped);
    return stamped;
  }
  return response;
}

async function networkFirstWithCache(request, cacheName, maxAgeSeconds) {
  try {
    const response = await fetch(request.clone());
    if (response && response.ok) {
      const cache   = await caches.open(cacheName);
      const headers = new Headers(response.headers);
      headers.set('sw-fetched-at', String(Date.now()));
      const stamped = new Response(await response.clone().blob(), {
        status: response.status, statusText: response.statusText, headers,
      });
      cache.put(request, stamped);
    }
    return response;
  } catch {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) {
      const ts = cached.headers.get('sw-fetched-at');
      if (!ts || (Date.now() - parseInt(ts)) < maxAgeSeconds * 1000) return cached;
    }
    return new Response(
      JSON.stringify({ error: 'offline', elements: [], offline: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── URL classifiers ───────────────────────────────────────────────────────────

function isMapTile(url) {
  return (
    url.hostname.includes('cartocdn.com') ||
    url.hostname.includes('basemaps.cartocdn.com') ||
    url.hostname.includes('tile.openstreetmap.org') ||
    /\/\d+\/\d+\/\d+\.png/.test(url.pathname)
  );
}

function isAPICall(url) {
  return (
    url.hostname.includes('overpass-api.de') ||
    url.hostname.includes('nominatim.openstreetmap.org') ||
    url.hostname.includes('open-meteo.com')
  );
}

// ── Background sync ───────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'retry-search') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' })
        .then(clients => clients.forEach(c => c.postMessage({ type: 'BACK_ONLINE' })))
    );
  }
});

// ── Messages from app ─────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  const { type } = event.data || {};

  if (type === 'CLEAR_CACHES') {
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => event.source?.postMessage({ type: 'CACHES_CLEARED' }));
    return;
  }

  if (type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION_INFO', build: BUILD, cache: CACHE });
    return;
  }
});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'SafeReach', {
      body              : data.body || 'Emergency alert',
      tag               : 'safereach-alert',
      requireInteraction: !!data.urgent,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('./index.html');
    })
  );
});

console.log(`[SafeReach SW] Build ${BUILD} — scope: ${self.registration.scope}`);

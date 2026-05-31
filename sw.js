// ══════════════════════════════════════════════════════════════════
//  SafeReach — Service Worker
//
//  VERSIONING STRATEGY (timestamp-based, same approach as Atlas):
//  ──────────────────────────────────────────────────────────────
//  Every time the browser detects sw.js has changed (any GitHub push)
//  it runs install → a brand-new cache name is generated via Date.now().
//  Activate then wipes EVERY old sr-* cache. No hashing, no DEPLOY_ID,
//  no race conditions — guaranteed clean slate on every deploy.
//
//  Shell URLs are fetched with cache:'reload' on install so the CDN/
//  HTTP layer is bypassed and the truly latest files are stored.
//  HTML documents are always fetched with cache:'no-store' at runtime
//  for the same reason.
//
//  Caching strategies:
//    App shell (HTML/CSS/JS/fonts/icons/manifest) → Cache First
//    Map tiles (CARTO / OSM)                      → Cache First, 7-day TTL
//    API calls (Overpass / Nominatim / Meteo)     → Network First, 5-min fallback
//    Everything else                              → Network only
// ══════════════════════════════════════════════════════════════════

'use strict';

// ─── Cache versioning ────────────────────────────────────────────
// A fresh timestamp-based cache name is generated on every install.
// This guarantees every GitHub Pages deploy gets a clean slate —
// no stale content survives across updates regardless of cache name.
const CACHE_PREFIX = 'sr-';
const CACHE_ID_KEY = 'sr_sw_cache_id'; // persisted in IDB

// Module-level variable; lives for the lifetime of this SW instance.
// Re-populated from IDB if the SW is restarted by the browser.
let _cacheName = null;

// ─── IDB helpers ─────────────────────────────────────────────────
const DB_NAME   = 'sr-meta';
const IDB_STORE = 'meta';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess       = e => resolve(e.target.result);
    req.onerror         = e => reject(e.target.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise(resolve => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror    = resolve; // silent fail
  });
}

// Lazy getter — reads from IDB if _cacheName was lost on SW restart
async function activeCacheName() {
  if (_cacheName) return _cacheName;
  try { _cacheName = await idbGet(CACHE_ID_KEY); } catch {}
  return _cacheName || (CACHE_PREFIX + 'fallback');
}

// ─── INSTALL ─────────────────────────────────────────────────────
self.addEventListener('install', event => {
  // Every install (= every changed sw.js detected by the browser)
  // gets a brand-new unique cache name. Old cache is wiped in activate.
  _cacheName = CACHE_PREFIX + Date.now();
  console.log(`[SafeReach SW] Installing — new cache: ${_cacheName}`);

  event.waitUntil((async () => {
    // Persist so activate + future fetches use the same name
    try { await idbSet(CACHE_ID_KEY, _cacheName); } catch {}

    const cache = await caches.open(_cacheName);

    // Use cache:'reload' to bypass the CDN/HTTP cache layer and
    // always store the truly latest files on a fresh install.
    await Promise.allSettled([
      fetch('./index.html',           { cache: 'reload' }).then(r => r.ok && cache.put('./index.html',           r)),
      fetch('./manifest.json',        { cache: 'reload' }).then(r => r.ok && cache.put('./manifest.json',        r)),
      fetch('./icon-96.png',          { cache: 'reload' }).then(r => r.ok && cache.put('./icon-96.png',          r)),
      fetch('./icon-192.png',         { cache: 'reload' }).then(r => r.ok && cache.put('./icon-192.png',         r)),
      fetch('./icon-512.png',         { cache: 'reload' }).then(r => r.ok && cache.put('./icon-512.png',         r)),
      fetch('./apple-touch-icon.png', { cache: 'reload' }).then(r => r.ok && cache.put('./apple-touch-icon.png', r)),
    ]);

    console.log(`[SafeReach SW] App shell cached → ${_cacheName}`);

    // Take over immediately — don't wait for old SW to finish
    self.skipWaiting();
  })());
});

// ─── ACTIVATE ────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log(`[SafeReach SW] Activating — cache: ${_cacheName}`);

  event.waitUntil((async () => {
    // Re-read in case SW was restarted and _cacheName is null
    if (!_cacheName) {
      try { _cacheName = await idbGet(CACHE_ID_KEY); } catch {}
    }

    // Wipe EVERY previous sr-* cache — covers all past timestamp names
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith(CACHE_PREFIX) && k !== _cacheName)
        .map(k => caches.delete(k))
    );

    await self.clients.claim();
    console.log(`[SafeReach SW] Active — cache: ${_cacheName}`);

    // Notify all open tabs that a fresh version is now in control
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => {
      try { c.postMessage({ type: 'SW_UPDATED', cache: _cacheName }); } catch {}
    });
  })());
});

// ─── FETCH ───────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // Map tiles — Cache First with 7-day TTL
  if (isMapTile(url)) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // API calls — Network First, 5-min cache fallback
  if (isAPICall(url)) {
    event.respondWith(
      activeCacheName().then(name => networkFirstWithCache(event.request, name + '-api', 300))
    );
    return;
  }

  // HTML documents — always hit the network with cache:'no-store'
  // so GitHub Pages' CDN layer is bypassed and we always get the latest.
  // Fall back to cached copy when offline.
  if (event.request.destination === 'document') {
    event.respondWith((async () => {
      const cacheName = await activeCacheName();
      try {
        const res = await fetchWithTimeout(
          new Request(event.request, { cache: 'no-store' }), 8000
        );
        if (res.ok) {
          const cache = await caches.open(cacheName);
          // ETag / Last-Modified check: notify tabs if content changed
          const cached    = await cache.match(event.request);
          const freshTag  = res.headers.get('etag') || res.headers.get('last-modified') || '';
          const cachedTag = cached
            ? (cached.headers.get('etag') || cached.headers.get('last-modified') || '')
            : '';
          if (freshTag && cachedTag && freshTag !== cachedTag) {
            const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
            clients.forEach(c => { try { c.postMessage({ type: 'NEW_VERSION' }); } catch {} });
          }
          cache.put(event.request, res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match(event.request);
        return cached || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // App shell (JS / CSS / fonts / icons / manifest) — Cache First
  if (isAppShell(url)) {
    event.respondWith(
      activeCacheName().then(name => cacheFirst(event.request, name))
    );
    return;
  }

  // Fallback — network only
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match('./index.html').then(r => r || new Response('Offline', { status: 503 }))
    )
  );
});

// ─── CACHING STRATEGIES ──────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetchWithTimeout(request, 8000);
    if (response && response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Resource unavailable offline', { status: 503 });
  }
}

async function tileStrategy(request) {
  const cacheName = (await activeCacheName()) + '-tiles';
  const cache     = await caches.open(cacheName);
  const cached    = await cache.match(request);
  const TTL       = 7 * 24 * 60 * 60 * 1000; // 7 days

  if (cached) {
    const ts = cached.headers.get('sw-fetched-at');
    if (ts && (Date.now() - parseInt(ts)) < TTL) return cached; // still fresh
    refreshTile(request, cache).catch(() => {}); // stale-while-revalidate
    return cached;
  }

  try {
    return await refreshTile(request, cache);
  } catch {
    return new Response('Map tile unavailable offline', { status: 503 });
  }
}

async function refreshTile(request, cache) {
  const response = await fetchWithTimeout(request, 6000);
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
    const response = await fetchWithTimeout(request.clone(), 8000);
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
      if (!ts || (Date.now() - parseInt(ts)) < maxAgeSeconds * 1000) {
        console.log('[SafeReach SW] Serving API from cache (offline)');
        return cached;
      }
    }
    return new Response(
      JSON.stringify({ error: 'offline', elements: [], offline: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ─── FETCH WITH TIMEOUT (no AbortSignal.timeout — works on all Android) ──
function fetchWithTimeout(request, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const req   = new Request(request, { signal: ctrl.signal });
  return fetch(req).finally(() => clearTimeout(timer));
}

// ─── URL CLASSIFIERS ─────────────────────────────────────────────

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

function isAppShell(url) {
  return (
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com')  ||
    url.hostname.includes('fonts.gstatic.com')     ||
    url.pathname.endsWith('.json')                  ||
    url.pathname.endsWith('.css')                   ||
    url.pathname === '/'                            ||
    /\/(icon-\d+|apple-touch-icon)\.png$/.test(url.pathname) ||
    // JS files — but never sw.js itself (must stay network-only so updates propagate)
    (url.pathname.endsWith('.js') && !url.pathname.endsWith('sw.js'))
  );
}

// ─── BACKGROUND SYNC ─────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'retry-search') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients =>
        clients.forEach(c => c.postMessage({ type: 'BACK_ONLINE' }))
      )
    );
  }
});

// ─── MESSAGES FROM APP ───────────────────────────────────────────
self.addEventListener('message', event => {
  const { type } = event.data || {};

  if (type === 'CLEAR_CACHES') {
    caches.keys()
      .then(keys => keys.filter(k => k.startsWith(CACHE_PREFIX)))
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(()   => event.source?.postMessage({ type: 'CACHES_CLEARED' }));
    return;
  }

  if (type === 'GET_VERSION') {
    event.source?.postMessage({
      type  : 'VERSION_INFO',
      cache : _cacheName,
    });
    return;
  }
});

// ─── PUSH NOTIFICATIONS (future) ─────────────────────────────────
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

// ─── BOOT LOG ────────────────────────────────────────────────────
console.log(`[SafeReach SW] Loaded — scope: ${self.registration.scope}`);

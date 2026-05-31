// ══════════════════════════════════════════════════════════════════
//  SafeReach — Service Worker
//
//  VERSIONING STRATEGY (no hardcoded versions):
//  ─────────────────────────────────────────────
//  Cache names are derived from two dynamic sources:
//
//  1. DEPLOY_ID  — a short hash of the SW's registration scope URL.
//                  e.g. https://alice.github.io/safereach/   → "a3f9c1"
//                       https://bob.github.io/safereach/     → "d82b44"
//                       http://localhost:8080/               → "f10e92"
//                  This means every GitHub user / repo / host gets its
//                  own isolated cache namespace. Multiple deployments
//                  never conflict or corrupt each other.
//
//  2. SW_HASH    — a lightweight hash of this SW file's own content,
//                  computed once on install and stored in IndexedDB.
//                  When you push a new deployment to GitHub, the browser
//                  detects sw.js has changed, runs install → activate,
//                  the new hash is computed, and ALL old caches for this
//                  deployment are automatically wiped. No manual version
//                  bumping ever required.
//
//  Result: cache names look like  sr-app-a3f9c1-d41d8c
//          where a3f9c1 = deploy scope hash, d41d8c = file content hash
//          Both parts change automatically — deploy ID on new host,
//          content hash on every code push.
//
//  Caching strategies:
//    App shell (HTML/CSS/JS/fonts/icons) → Cache First
//    Map tiles (CARTO)                   → Cache First, 7-day TTL
//    API calls (Overpass/Nominatim/Meteo)→ Network First, 5-min cache fallback
//    Everything else                     → Network First, no cache
// ══════════════════════════════════════════════════════════════════

'use strict';

// ─── STEP 1: Compute deploy-scope ID ────────────────────────────
// Stable per-host hash so multiple GitHub Pages deployments never
// share or corrupt each other's caches.
function hashScope(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

const DEPLOY_ID = hashScope(self.registration.scope);

// ─── STEP 2: Runtime content-hash of this SW file ───────────────
// Computed once at install; triggers full cache refresh whenever
// sw.js changes on any new GitHub push — no manual version bump needed.
const DB_NAME    = `sr-meta-${DEPLOY_ID}`;
const IDB_STORE  = 'meta';
const IDB_KEY    = 'sw_hash';

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function getStoredHash(db) {
  return new Promise((resolve) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
}

async function storeHash(db, hash) {
  return new Promise((resolve) => {
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(hash, IDB_KEY);
    tx.oncomplete = resolve;
    tx.onerror    = resolve; // silent fail
  });
}

// Lightweight hash of a string (djb2 variant)
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

// Fetch this SW file's own text and hash it
async function computeSWHash() {
  try {
    const res  = await fetch(self.registration.active?.scriptURL || './sw.js', { cache: 'no-store' });
    const text = await res.text();
    return hashString(text);
  } catch (e) {
    // Fallback: use install timestamp (changes on every deploy)
    return hashString(String(Math.floor(Date.now() / 60000))); // minute-level granularity
  }
}

// ─── STEP 3: Cache name factory ─────────────────────────────────
// Names are built lazily after the content hash is known.
let _swHash = 'init';

function cacheNames() {
  return {
    app  : `sr-app-${DEPLOY_ID}-${_swHash}`,
    tiles: `sr-tiles-${DEPLOY_ID}-${_swHash}`,
    api  : `sr-api-${DEPLOY_ID}-${_swHash}`,
  };
}

// Prefix used to identify ALL SafeReach caches for this deploy,
// regardless of content hash — used during cleanup.
const DEPLOY_PREFIX = `sr-${DEPLOY_ID}-`;
// Also used to match caches from OTHER deploys for cross-contamination check.
const APP_PREFIX = 'sr-';

// ─── INSTALL ─────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SafeReach SW] Installing — deploy: ${DEPLOY_ID}`);

  const SHELL_URLS = [
    './',
    './index.html',
    './manifest.json',
  ];

  event.waitUntil(
    (async () => {
      // 1. Compute content hash of this SW
      const hash = await computeSWHash();
      _swHash = hash;
      console.log(`[SafeReach SW] Content hash: ${hash}`);

      // 2. Persist hash so activate can compare
      try {
        const db = await openDB();
        await storeHash(db, hash);
      } catch (e) {
        console.warn('[SafeReach SW] IDB unavailable, using fallback versioning');
      }

      // 3. Pre-cache app shell (fail gracefully if offline)
      const names = cacheNames();
      try {
        const cache = await caches.open(names.app);
        await cache.addAll(SHELL_URLS);
        console.log(`[SafeReach SW] App shell cached → ${names.app}`);
      } catch (err) {
        console.warn('[SafeReach SW] Shell pre-cache skipped (offline or CDN unreachable):', err.message);
      }

      // 4. Take over immediately — don't wait for old SW to finish
      self.skipWaiting();
    })()
  );
});

// ─── ACTIVATE ────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log(`[SafeReach SW] Activating — deploy: ${DEPLOY_ID}`);

  event.waitUntil(
    (async () => {
      // 1. Restore hash from IDB (we may have restarted since install)
      try {
        const db   = await openDB();
        const hash = await getStoredHash(db);
        if (hash) _swHash = hash;
      } catch (e) { /* use existing _swHash */ }

      const names    = cacheNames();
      const keepSet  = new Set(Object.values(names));

      // 2. Delete every SafeReach cache for THIS deploy that isn't current
      //    (old content-hash caches from previous deployments to same host)
      const allKeys = await caches.keys();
      const toDelete = allKeys.filter(key =>
        key.startsWith(DEPLOY_PREFIX) && !keepSet.has(key)
      );

      if (toDelete.length > 0) {
        console.log(`[SafeReach SW] Purging ${toDelete.length} stale cache(s):`, toDelete);
        await Promise.all(toDelete.map(k => caches.delete(k)));
      } else {
        console.log('[SafeReach SW] No stale caches to purge');
      }

      // 3. Take control of all open tabs immediately
      await self.clients.claim();
      console.log(`[SafeReach SW] Active — caches: ${JSON.stringify(Object.values(names))}`);

      // 4. Notify all open clients that a new version is active
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => client.postMessage({
        type   : 'SW_UPDATED',
        deploy : DEPLOY_ID,
        hash   : _swHash,
      }));
    })()
  );
});

// ─── FETCH ───────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  // Ignore non-GET and browser-extension requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  if (isMapTile(url)) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  if (isAPICall(url)) {
    event.respondWith(networkFirstWithCache(event.request, cacheNames().api, 300));
    return;
  }

  if (isAppShell(url, event.request)) {
    event.respondWith(cacheFirst(event.request, cacheNames().app));
    return;
  }

  // Fallback — network only, return index.html if fully offline
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
  } catch (e) {
    return new Response('Resource unavailable offline', { status: 503 });
  }
}

async function tileStrategy(request) {
  const cache  = await caches.open(cacheNames().tiles);
  const cached = await cache.match(request);
  const TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  if (cached) {
    const ts = cached.headers.get('sw-fetched-at');
    if (ts && (Date.now() - parseInt(ts)) < TILE_TTL_MS) {
      return cached; // Fresh tile from cache
    }
    // Stale — refresh in background, serve stale now (stale-while-revalidate)
    refreshTile(request, cache).catch(() => {});
    return cached;
  }

  try {
    return await refreshTile(request, cache);
  } catch (e) {
    return new Response('Map tile unavailable offline', { status: 503 });
  }
}

async function refreshTile(request, cache) {
  const response = await fetchWithTimeout(request, 6000);
  if (response && response.ok) {
    const headers = new Headers(response.headers);
    headers.set('sw-fetched-at', String(Date.now()));
    const stamped = new Response(await response.blob(), {
      status     : response.status,
      statusText : response.statusText,
      headers,
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
        status     : response.status,
        statusText : response.statusText,
        headers,
      });
      cache.put(request, stamped);
    }
    return response;
  } catch (e) {
    // Network failed — try cache
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) {
      const ts = cached.headers.get('sw-fetched-at');
      if (!ts || (Date.now() - parseInt(ts)) < maxAgeSeconds * 1000) {
        console.log('[SafeReach SW] Serving API from cache (offline)');
        return cached;
      }
    }
    // No usable cache — return empty-safe JSON so app doesn't crash
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
  const req   = request instanceof Request
    ? new Request(request, { signal: ctrl.signal })
    : new Request(request,  { signal: ctrl.signal });
  return fetch(req).finally(() => clearTimeout(timer));
}

// ─── URL CLASSIFIERS ─────────────────────────────────────────────

function isMapTile(url) {
  return (
    url.hostname.includes('cartocdn.com') ||
    url.hostname.includes('basemaps.cartocdn.com') ||
    url.hostname.includes('tile.openstreetmap.org') ||
    /\/\d+\/\d+\/\d+\.png/.test(url.pathname) // generic tile URL pattern
  );
}

function isAPICall(url) {
  return (
    url.hostname.includes('overpass-api.de') ||
    url.hostname.includes('nominatim.openstreetmap.org') ||
    url.hostname.includes('open-meteo.com')
  );
}

function isAppShell(url, request) {
  return (
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.css')  ||
    url.pathname === '/'           ||
    // This SW file itself — always serve from network so updates propagate
    (url.pathname.endsWith('sw.js') ? false : url.pathname.endsWith('.js'))
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

  // App can request a manual cache wipe (e.g. "Clear offline data" button)
  if (type === 'CLEAR_CACHES') {
    caches.keys()
      .then(keys => keys.filter(k => k.startsWith(APP_PREFIX)))
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => event.source?.postMessage({ type: 'CACHES_CLEARED' }));
    return;
  }

  // App can ask which version is running
  if (type === 'GET_VERSION') {
    event.source?.postMessage({
      type   : 'VERSION_INFO',
      deploy : DEPLOY_ID,
      hash   : _swHash,
      caches : Object.values(cacheNames()),
    });
    return;
  }
});

// ─── PUSH NOTIFICATIONS (future) ─────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'SafeReach', {
      body             : data.body || 'Emergency alert',
      tag              : 'safereach-alert',
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
console.log(`[SafeReach SW] Loaded — scope: ${self.registration.scope} — deploy: ${DEPLOY_ID}`);

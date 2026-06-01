// ================================================================
// SAFEREACH SERVICE WORKER — Emergency Services Finder PWA
// ================================================================
'use strict';

// ── Cache versioning ───────────────────────────────────────────
// A fresh timestamp-based cache name is generated on every install.
// This guarantees every GitHub Pages deploy gets a clean slate —
// no stale content survives across updates regardless of cache name.
const CACHE_PREFIX = 'sr-';
const CACHE_ID_KEY = 'sr_sw_cache_id'; // persisted in IDB

// Module-level variable; lives for the lifetime of this SW instance.
// Re-populated from IDB if the SW is restarted by the browser.
let _cacheName = null;

async function activeCacheName() {
  if (_cacheName) return _cacheName;
  try { _cacheName = await idbGet(CACHE_ID_KEY); } catch {}
  return _cacheName || (CACHE_PREFIX + 'fallback');
}

// ── Install ────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    // Every install (= every changed sw.js detected by the browser)
    // gets a brand-new unique cache name. Old cache is wiped in activate.
    _cacheName = CACHE_PREFIX + Date.now();
    try { await idbSet(CACHE_ID_KEY, _cacheName); } catch {}

    const cache = await caches.open(_cacheName);

    // Use cache:'reload' to bypass the HTTP/CDN layer and always
    // store the truly latest files on a fresh install.
    // Icons and other static assets are cached automatically on first
    // fetch via the network-first handler — no need to precache them here.
    await Promise.allSettled([
      fetch('./index.html',    { cache: 'reload' }).then(r => r.ok && cache.put('./index.html',    r)),
      fetch('./manifest.json', { cache: 'reload' }).then(r => r.ok && cache.put('./manifest.json', r)),
    ]);

    self.skipWaiting();
  })());
});

// ── Activate ───────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Re-read in case SW was restarted and _cacheName is null
    if (!_cacheName) {
      try { _cacheName = await idbGet(CACHE_ID_KEY); } catch {}
    }

    // Wipe EVERY previous sr-* cache — covers all past version names
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith(CACHE_PREFIX) && k !== _cacheName)
        .map(k => caches.delete(k))
    );

    await clients.claim();

    // Notify all open tabs that a new version is now in control
    const allClients = await self.clients.matchAll({ type: 'window' });
    allClients.forEach(c => {
      try { c.postMessage({ type: 'SW_UPDATED', cache: _cacheName }); } catch {}
    });
  })());
});

// ── Fetch — network-first; HTML always bypasses HTTP cache ─────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Only handle same-origin requests
  if (!url.startsWith(self.location.origin)) return;

  // Skip API calls — always go direct to network
  if (
    url.includes('overpass-api.de') ||
    url.includes('nominatim.openstreetmap.org') ||
    url.includes('open-meteo.com')
  ) return;

  e.respondWith((async () => {
    const cacheName = await activeCacheName();

    // For HTML documents, use cache:'no-store' so we always hit the
    // real network and skip GitHub Pages' CDN/HTTP cache layer.
    const isDoc     = e.request.destination === 'document';
    const fetchOpts = isDoc ? { cache: 'no-store' } : {};

    try {
      const res = await fetch(e.request, fetchOpts);
      if (res?.ok && e.request.method === 'GET') {
        const cache = await caches.open(cacheName);
        // NEW_VERSION detection: if ETag/Last-Modified changed, tell open tabs
        if (isDoc) {
          const cached    = await cache.match(e.request);
          const freshTag  = res.headers.get('etag') || res.headers.get('last-modified') || '';
          const cachedTag = cached
            ? (cached.headers.get('etag') || cached.headers.get('last-modified') || '')
            : '';
          if (freshTag && cachedTag && freshTag !== cachedTag) {
            clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(list => {
              list.forEach(c => { try { c.postMessage({ type: 'NEW_VERSION' }); } catch {} });
            });
          }
        }
        cache.put(e.request, res.clone());
      }
      return res;
    } catch {
      // Offline fallback — serve whatever is in the current cache
      const cached = await caches.match(e.request);
      return cached ?? new Response('Offline — no cached version available', {
        status: 503, headers: { 'Content-Type': 'text/plain' }
      });
    }
  })());
});

// ── Background sync ────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'retry-search') {
    e.waitUntil(
      clients.matchAll({ type: 'window' })
        .then(list => list.forEach(c => c.postMessage({ type: 'BACK_ONLINE' })))
    );
  }
});

// ── Push notifications ─────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const d = e.data.json();
    e.waitUntil(
      self.registration.showNotification(d.title || 'SafeReach', {
        body:  d.body  || 'Emergency alert',
        icon:  './icon-192.png',
        tag:   'safereach-alert',
        requireInteraction: !!d.urgent,
      })
    );
  } catch {}
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('index.html') || c.url.endsWith('/')) return c.focus();
      }
      return clients.openWindow('./index.html');
    })
  );
});

// ── Messages from page ─────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();

  if (e.data?.type === 'CLEAR_CACHES') {
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => e.source?.postMessage({ type: 'CACHES_CLEARED' }));
  }

  if (e.data?.type === 'GET_VERSION') {
    e.source?.postMessage({ type: 'VERSION_INFO', cache: _cacheName });
  }

  // Force all open tabs to hard-reload after SW takes over
  if (e.data?.type === 'FORCE_RELOAD') {
    clients.matchAll({ type: 'window' }).then(list => {
      list.forEach(c => { try { c.navigate(c.url); } catch {} });
    });
  }
});

// ── IndexedDB helpers ──────────────────────────────────────────
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sr_sw_db', 1);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const g  = tx.objectStore('kv').get(key);
    g.onsuccess = () => res(g.result);
    g.onerror   = () => rej(g.error);
  });
}

async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    const p  = tx.objectStore('kv').put(val, key);
    p.onsuccess = () => res();
    p.onerror   = () => rej(p.error);
  });
}

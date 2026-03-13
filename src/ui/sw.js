/**
 * Tracker Service Worker
 *
 * Provides offline support via:
 * - Cache-first strategy for static assets (app shell)
 * - Network-first strategy for API calls
 * - Background sync for queued offline items
 */

const CACHE_NAME = "tracker-v6";

// App shell files to precache
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

// ── Install: precache app shell ──
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  // Activate immediately (don't wait for old SW to be replaced)
  self.skipWaiting();
});

// ── Activate: clean old caches ──
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Claim all clients immediately
  self.clients.claim();
});

// ── Fetch: routing strategy ──
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  // Skip MCP endpoint
  if (url.pathname.startsWith("/mcp")) return;

  // Deep-link URLs (e.g. /TRACK-42, /LIZ-123): let the browser handle these
  // as navigation to index.html. The SPA's handleInitialDeepLink() will detect
  // the key in the pathname and open the item. Don't cache these — they're
  // all the same index.html content with different paths.
  if (/^\/[A-Za-z]+-\d+$/.test(url.pathname)) return;

  // API calls: network-first with no cache fallback
  // (API data is dynamic; stale cached API data would be misleading)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // Return a minimal offline error response for API calls
        return new Response(
          JSON.stringify({ error: "Offline", offline: true }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }
        );
      })
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return from cache, but also update cache in background
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse);
              });
            }
            return networkResponse.clone();
          })
          .catch(() => {});
        // Stale-while-revalidate: return cached immediately
        return cachedResponse;
      }

      // Not in cache: try network, then cache the response
      return fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // For navigation requests, serve the cached index.html (SPA fallback)
          if (event.request.mode === "navigate") {
            return caches.match("/index.html");
          }
          return new Response("Offline", { status: 503 });
        });
    })
  );
});

// ── Background Sync: sync queued offline items ──
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-offline-items") {
    event.waitUntil(syncOfflineItems());
  }
});

/**
 * Sync all queued items from IndexedDB to the server.
 * Called by Background Sync API or manually from the client.
 */
async function syncOfflineItems() {
  const db = await openOfflineDB();
  const tx = db.transaction("offlineQueue", "readonly");
  const store = tx.objectStore("offlineQueue");
  const items = await idbGetAll(store);

  if (items.length === 0) return;

  let syncedCount = 0;
  const errors = [];

  for (const item of items) {
    try {
      const response = await fetch(`/api/v1/projects/${item.project_id}/items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(item.authToken ? { Authorization: "Bearer " + item.authToken } : {}),
        },
        body: JSON.stringify({
          title: item.title,
          priority: item.priority,
          platform: item.platform,
          state: "brainstorming",
          created_by: "dashboard",
        }),
      });

      if (response.ok) {
        // Remove from queue
        const deleteTx = db.transaction("offlineQueue", "readwrite");
        deleteTx.objectStore("offlineQueue").delete(item.id);
        await idbComplete(deleteTx);
        syncedCount++;
      } else {
        const data = await response.json().catch(() => ({}));
        errors.push({ title: item.title, error: data.error || `HTTP ${response.status}` });
      }
    } catch (e) {
      errors.push({ title: item.title, error: e.message });
    }
  }

  // Notify all clients about sync results
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({
      type: "sync-complete",
      synced: syncedCount,
      errors: errors,
      remaining: items.length - syncedCount,
    });
  }
}

// ── IndexedDB helpers (for use inside Service Worker) ──

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("TrackerOffline", 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("offlineQueue")) {
        db.createObjectStore("offlineQueue", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Message handler: allow client to trigger sync manually ──
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "trigger-sync") {
    syncOfflineItems();
  }
});

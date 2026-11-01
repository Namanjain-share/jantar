// Portions adapted from Shed (c) Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
//
// Jantar service worker: caches the app shell, shows Web Push notifications
// (silently only when the app on screen played its own chime, v0.5.3) and
// opens the right session when one is tapped.
//
// It never touches /v1 or /healthz (live, private data: network only) and
// never caches anything from another origin. The build (build/pwa-plugin.ts)
// replaces the marker line below with the precache list and a version.
/* __CCW_BUILD__ */

const BUILD = self.__CCW_BUILD__ || { version: 'dev', precache: [] };
const CACHE_PREFIX = 'jantar-shell-';
/** Shell caches ccw-v2 (the old name) left; removed on activate. */
const LEGACY_CACHE_PREFIX = 'ccw-v2-shell-';
const CACHE = `${CACHE_PREFIX}${BUILD.version}`;
const SHELL = '/index.html';
const APP_NAME = 'Jantar';
/** Kinds that stay on screen until the user acts (desktop browsers honour it). */
// v0.4: a medicine stays on the lock screen until tapped, like a card.
const NEEDS_YOU = new Set(['permission', 'question', 'plan', 'send-failed', 'med']);
/** v0.5.3: the alert groups (protocol alerts.ts) whose chime the open app plays. */
const GROUPS = new Set(['urgent', 'needs', 'done', 'care', 'problem']);
/** How long a push waits for the open app to say it played its chime; then it sounds as usual. */
const CHIME_WAIT_MS = 300;

function isPrivatePath(pathname) {
  return pathname === '/v1' || pathname.startsWith('/v1/') || pathname === '/healthz';
}

function str(v, max = 1000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** A same-origin path for a notification's target; anything else becomes "/". */
function sameOrigin(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** The push's own time (the daemon sends an ISO string), else now. */
function timeOf(ts) {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  return typeof t === 'number' && Number.isFinite(t) ? t : Date.now();
}

function targetPath(data) {
  const origin = self.location.origin;
  if (typeof data.url === 'string' && data.url) {
    try {
      const u = new URL(data.url, origin);
      if (u.origin === origin) return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      // fall through
    }
    return '/';
  }
  if (typeof data.sid === 'string' && data.sid) {
    const p = typeof data.pendingId === 'string' && data.pendingId ? `?p=${encodeURIComponent(data.pendingId)}` : '';
    return `/s/${encodeURIComponent(data.sid)}${p}`;
  }
  return '/';
}

// ---------------------------------------------------------------------------
// Lifecycle

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (BUILD.precache.length) {
        const cache = await self.caches.open(CACHE);
        // One missing file must not block the install.
        await Promise.all(
          BUILD.precache.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => undefined)),
        );
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await self.caches.keys();
      await Promise.all(
        keys
          .filter((k) => (k.startsWith(CACHE_PREFIX) && k !== CACHE) || k.startsWith(LEGACY_CACHE_PREFIX))
          .map((k) => self.caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch: shell network-first (offline fallback), static assets cache-first.

async function shellFallback() {
  const cache = await self.caches.open(CACHE);
  return (await cache.match(SHELL)) || (await cache.match('/')) || null;
}

async function navigate(request) {
  try {
    const res = await self.fetch(request);
    const html = (res.headers.get('content-type') || '').includes('text/html');
    if (res.ok && html) {
      const cache = await self.caches.open(CACHE);
      await cache.put(SHELL, res.clone());
      return res;
    }
    // An app route the server does not know (no SPA fallback): serve the shell.
    if (res.status === 404) return (await shellFallback()) || res;
    return res;
  } catch {
    const cached = await shellFallback();
    return (
      cached ||
      new Response('Jantar is offline: the Mac could not be reached.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    );
  }
}

async function cacheFirst(request) {
  const cache = await self.caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await self.fetch(request);
  if (res.ok && res.type === 'basic') await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isPrivatePath(url.pathname)) return;
  if (url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') {
    event.respondWith(navigate(req));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || BUILD.precache.includes(url.pathname)) {
    event.respondWith(cacheFirst(req));
  }
});

// ---------------------------------------------------------------------------
// Push

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  if (!data || typeof data !== 'object') data = {};
  const tag = str(data.tag, 200);
  const options = {
    body: str(data.body, 1000),
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    renotify: Boolean(tag),
    requireInteraction: NEEDS_YOU.has(data.kind),
    timestamp: timeOf(data.ts),
    data: { url: targetPath(data), kind: str(data.kind, 40) },
  };
  if (tag) options.tag = tag;
  const title = str(data.title, 200) || APP_NAME;
  // Every push must show a notification (iOS revokes silent subscriptions): exactly one, on every path.
  event.waitUntil(
    (async () => {
      if (await chimed(data.group).catch(() => false)) options.silent = true;
      await self.registration.showNotification(title, options);
    })(),
  );
});

/** The first same-origin window on screen, or null. */
async function visibleClient() {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return wins.find((c) => c.visibilityState === 'visible' && sameOrigin(c.url)) || null;
}

/**
 * v0.5.3: a push while Jantar is open on screen. The app plays the group's
 * own tone (chosen on that device, kept where this worker can't read it), and
 * the push goes silent only when the app answers { played: true } within
 * CHIME_WAIT_MS. Any other answer, none, or an error: the phone's own sound.
 * Answer soon (`urgent`), medicines and Life (`care`) are never silent: the
 * app's tone plays on top, unasked. iOS Web Audio follows the silent switch
 * while the context still says it runs, so a "played" tone may be unheard,
 * and these must keep the phone's sound or buzz. The message holds the
 * group's name and nothing else.
 */
async function chimed(group) {
  if (typeof group !== 'string' || !GROUPS.has(group)) return false;
  const client = await visibleClient();
  if (!client) return false;
  if (group === 'care' || group === 'urgent') {
    client.postMessage({ type: 'jantar:chime', group });
    return false;
  }
  const channel = new MessageChannel();
  let timer;
  try {
    return await new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), CHIME_WAIT_MS);
      channel.port1.onmessage = (e) => resolve(Boolean(e.data && e.data.played === true));
      client.postMessage({ type: 'jantar:chime', group }, [channel.port2]);
    });
  } finally {
    clearTimeout(timer);
    channel.port1.close();
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = targetPath({ url: (event.notification.data && event.notification.data.url) || '/' });
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const same = wins.filter((c) => sameOrigin(c.url));
      const client = same.find((c) => c.focused) || same[0];
      if (client) {
        try {
          await client.focus();
        } catch {
          // focus can be refused; still route the page
        }
        client.postMessage({ type: 'jantar:navigate', url: path });
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});

// The browser rotated the subscription: register the new one with the daemon.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription || null;
      let sub = event.newSubscription || null;
      const key = old && old.options ? old.options.applicationServerKey : null;
      if (!sub && key) {
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      if (!sub) return;
      await self.fetch('/v1/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (old && old.endpoint && old.endpoint !== sub.endpoint) {
        await self
          .fetch('/v1/push/subscribe', {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: old.endpoint }),
          })
          .catch(() => undefined);
      }
    })().catch(() => undefined),
  );
});

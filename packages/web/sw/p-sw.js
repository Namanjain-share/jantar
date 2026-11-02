// v0.12 People: her app's service worker (p-sw.js), apart from the owner's
// sw.js (C15). Its shell is /p.html, it precaches only her app's chunks
// (the build fills the list), it never touches /v1 or /healthz, and a tap on
// a notification opens a /p… URL of her app only. Her lock-screen choice is
// applied by the daemon before a push is sent.
/* __CCW_BUILD__ */

const BUILD = self.__CCW_BUILD__ || { version: 'dev', precache: [] };
const CACHE = `jantar-person-${BUILD.version}`;
const SHELL = '/p.html';
const NEEDS_YOU = new Set(['med']);

function isPrivatePath(pathname) {
  return pathname === '/v1' || pathname.startsWith('/v1/') || pathname === '/healthz';
}

function str(v, max = 1000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** A path of her app (/p…) on this origin; anything else is /p. */
function targetPath(url) {
  try {
    const u = new URL(typeof url === 'string' ? url : '/p', self.location.origin);
    if (u.origin === self.location.origin && (u.pathname === '/p' || u.pathname.startsWith('/p/'))) return `${u.pathname}${u.search}`;
  } catch {
    // fall through
  }
  return '/p';
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(BUILD.precache)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jantar-person-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isPrivatePath(url.pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(SHELL).then((r) => r || Response.error())));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = str(data.title, 120) || 'Jantar';
  const options = {
    body: str(data.body, 400),
    tag: str(data.tag, 120) || undefined,
    data: { url: targetPath(data.url) },
    requireInteraction: NEEDS_YOU.has(data.kind),
    icon: '/icons/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = targetPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          c.navigate(path);
          return c.focus();
        }
      }
      return self.clients.openWindow(path);
    }),
  );
});

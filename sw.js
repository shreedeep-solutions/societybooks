// Solutions4Society — offline copy & instant start (v12.2).
// The app is kept on this device and opens from the saved copy at once. Each new version installs itself in the
// background (this file changes with every version), and the app shows "A new version is available — Update now".
const B = '20261114134200', C = 's4s-' + B, APP = 'app.' + B + '.js';
const LIB = 's4s-lib-1'; // v15.16: libraries (Firebase, pdf.js, Excel…) — their web addresses carry a version number, so a saved copy never goes stale
const LIBHOST = /^(www\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)$/;
const PRE = ['./', APP, './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => Promise.all(PRE.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => { if (r.ok) return c.put(u, r); }).catch(() => { }))))); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C && k !== LIB).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; const u = new URL(r.url);
  if (r.method === 'GET' && LIBHOST.test(u.hostname) && /\d+\.\d+/.test(u.pathname) && /\.(js|css|wasm|mjs)$/.test(u.pathname)) { // kept on this computer → no download on every start
    e.respondWith(caches.open(LIB).then(async c => { const hit = await c.match(r); if (hit) return hit; const res = await fetch(r); if (res.ok || res.type === 'opaque') c.put(r, res.clone()).catch(() => { }); return res; })); return; }
  if (r.method !== 'GET' || u.origin !== location.origin) return; // Firebase, Google & libraries always go to the internet
  if (r.cache === 'no-store' || u.pathname.endsWith('/sw.js')) return; // version checks always ask the server
  if (u.pathname.includes('/srm/')) { // Registers (SRM): its own files — internet first, saved copy when offline
    e.respondWith(caches.open(C).then(async c => { try { const res = await fetch(r); if (res.ok) c.put(new Request(u.origin + u.pathname), res.clone()); return res; } catch (x) { const hit = await c.match(new Request(u.origin + u.pathname)); if (hit) return hit; throw x; } })); return; }
  const nav = r.mode === 'navigate' || u.pathname.endsWith('/') || u.pathname.endsWith('/index.html');
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(nav ? './' : r, { ignoreSearch: nav });
    if (hit) return hit;
    try { const res = await fetch(r); if (res.ok && !u.search) c.put(nav ? './' : r, res.clone()); return res; }
    catch (err) { return (await caches.match(nav ? './' : r, { ignoreSearch: true })) || Response.error(); }
  }));
});

// 앱 껍데기는 네트워크 우선(최신 유지), 글자 인식 엔진·언어 데이터는 캐시 우선(빠르게 + 오프라인)
const C = 'reader-v4', SHELL = ['./', 'index.html', 'style.css', 'app.js', 'icon.svg', 'privacy.html', 'icons/icon-192.png', 'icons/icon-512.png', 'manifest.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.hostname === 'cdn.jsdelivr.net' || u.hostname === 'tessdata.projectnaptha.com') {
    e.respondWith(caches.open(C).then(async c => { const hit = await c.match(r); if (hit) return hit; const res = await fetch(r); if (res.ok) c.put(r, res.clone()); return res; }));
    return;
  }
  e.respondWith(fetch(r).then(res => { if (res.ok && u.origin === location.origin) { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); } return res; }).catch(() => caches.match(r)));
});

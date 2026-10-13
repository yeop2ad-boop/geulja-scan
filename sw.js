const C = 'gs-v3', FILES = ['./', 'index.html', 'style.css', 'app.js', 'analyze.js', 'viewer.js', 'imageproc.js', 'camera.js', 'editor.js', 'icon.svg', 'manifest.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

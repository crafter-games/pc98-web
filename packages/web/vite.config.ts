import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

/**
 * Emits sw.js with the list of build outputs to precache, so the app (WASM
 * cores and font included) works offline after the first visit.
 */
function serviceWorker(): Plugin {
  return {
    name: 'pc98-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const precache = ['./', ...files, 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
      const version = createHash('sha256').update(files.sort().join('\n')).digest('hex').slice(0, 12);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `// Generated at build time. Cache-first for hashed assets, network-first for the page.
const CACHE = 'pc98-web-${version}';
const PRECACHE = ${JSON.stringify(precache)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pc98-web-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/assets/')) {
    e.respondWith(caches.match(e.request, { ignoreVary: true }).then((hit) => hit || fetch(e.request)));
    return;
  }
  e.respondWith(fetch(e.request)
    .then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreVary: true }).then((hit) => hit || caches.match('./', { ignoreVary: true }))));
});
`,
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), serviceWorker()],
  base: './',
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['@pc98-web/core'] },
});

// =====================================================================
// TanqueCheio — Service Worker v3
// • Mapa e dados externos (tiles, Overpass, OSRM, Nominatim, CDNs): Stale-While-Revalidate
//   (responde do cache NA HORA e atualiza em segundo plano) — ideal para rodovia com sinal fraco.
// • Arquivos do app (index.html, app.js, config.js...): rede primeiro com limite de 4 s,
//   cai para o cache se a rede estiver lenta/fora. Assim uma atualização publicada aparece
//   logo, sem ficar preso numa versão antiga, e o app continua abrindo offline.
// • Supabase (POST/RPC) não passa pelo cache; o app.js guarda o último resultado no localStorage.
// =====================================================================
const V = 'v3';
const SHELL = `tc-shell-${V}`;
const RUNTIME = `tc-runtime-${V}`;
const TILES = `tc-tiles-${V}`;

// ATENÇÃO: config.js fica fora da pré-carga de propósito (se ele não existir no servidor, o install falharia)
const SHELL_FILES = ['./', './index.html', './app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, RUNTIME, TILES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Mantém o cache dentro de um limite (FIFO) para não estourar o armazenamento do celular
async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}

function staleWhileRevalidate(event, cacheName, maxEntries) {
  return caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(event.request);
    const network = fetch(event.request)
      .then((res) => {
        // 'opaque' = tile/CDN cross-origin sem CORS; ainda dá para cachear
        if (res.ok || res.type === 'opaque') {
          cache.put(event.request, res.clone());
          if (maxEntries) trim(cacheName, maxEntries);
        }
        return res;
      })
      .catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }   // rápido + atualiza no fundo
    return (await network) || Response.error();
  });
}

function networkFirst(event, cacheName, timeoutMs = 4000) {
  return caches.open(cacheName).then(async (cache) => {
    try {
      const res = await Promise.race([
        fetch(event.request),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    } catch {
      return (await cache.match(event.request, { ignoreSearch: true }))
        || (event.request.mode === 'navigate' ? await cache.match('./index.html') : null)
        || Response.error();
    }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                     // POSTs (Supabase RPC) vão direto à rede
  const url = new URL(req.url);

  // Mapa: tiles OSM (limite de 500)
  // ⚠️ Em produção com muito tráfego, troque por provedor de tiles próprio/pago (política de uso do OSM).
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    return event.respondWith(staleWhileRevalidate(event, TILES, 500));
  }
  if (url.hostname.endsWith('supabase.co')) return;     // Supabase: sempre rede

  // Consultas externas GET (Overpass / OSRM / Nominatim): SWR com limite pequeno
  if (/overpass|osrm|nominatim/.test(url.hostname)) {
    return event.respondWith(staleWhileRevalidate(event, RUNTIME, 60));
  }
  // Bibliotecas em CDN (Leaflet, supabase-js)
  if (/unpkg\.com|jsdelivr\.net/.test(url.hostname)) {
    return event.respondWith(staleWhileRevalidate(event, RUNTIME, 30));
  }
  // Arquivos do próprio app
  if (url.origin === self.location.origin) {
    return event.respondWith(networkFirst(event, SHELL));
  }
});

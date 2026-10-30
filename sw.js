// Calm Portfolio PWA Service Worker —— 缓存外壳: 二次打开秒开 + 离线可看上次画面
// 策略: 外壳/静态资源 stale-while-revalidate(先给缓存、后台更新); /api/* 与 WebSocket 不缓存,始终走网络。
const CACHE = 'calm-portfolio-v2';
const SHELL = [
  '/m.html',
  '/tailwind.css?v=7',
  '/chart.umd.min.js',
  '/classify.js?v=16',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // addAll 任一失败不至于整体卡死 install: 逐个 add、容错
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                          // 只管 GET
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // 跨域放行(不拦截)
  if (url.pathname.startsWith('/api/') || url.pathname === '/plan.json') return;   // 接口数据和个人规则: 需登录, 不缓存, 走网络

  // 外壳 HTML: network-first —— 在线总拿最新(部署后立即生效),离线回退缓存
  const isHTML = req.mode === 'navigate' || url.pathname === '/m.html' || url.pathname === '/';
  if (isHTML) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match('/m.html')))
    );
    return;
  }

  // 静态资源(css/js/图标): stale-while-revalidate —— 先给缓存秒开,后台更新
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});

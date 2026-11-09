/* Markly Service Worker —— 离线壳缓存（接口 /api 一律直连网络，绝不缓存） */
'use strict';

const CACHE = 'markly-v95'; // 历史与任务异步操作保护、画像确认口径
const ASSETS = [
  '/js/daily-planning.js',
  '/js/date-picker.js', '/js/cooperation-history.js',
  '/clear-theme.css',
  '/js/intake.js', '/registration.css', '/identity-cards.css', '/js/identity-cards.js', '/', '/index.html', '/admin.css', '/mobile.css', '/goal-plan.css', '/js/identity.js',
  '/js/registration.js', '/js/core.js', '/js/components.js', '/js/auth.js', '/js/shell.js', '/js/tasks.js', '/js/home.js',
  '/js/life.js', '/js/notes.js', '/js/settings.js', '/js/admin.js', '/js/boot.js',
  '/js/phase.js', '/js/experience.js', '/js/goal-composer.js', '/js/goal-workspace.js', '/js/plan-import.js', '/style.css', '/components.css', '/manifest.webmanifest',
  '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(ASSETS.map((a) => c.add(a)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // 外部资源（字体 CDN）走浏览器默认缓存
  if (url.pathname.startsWith('/api/')) return;          // 接口永远走网络

  // 静态资源：网络优先（联网时始终取最新代码，避免旧缓存卡住前端更新），断网回退缓存
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
        cache.put(req, res.clone()).catch(() => {});
      } else if (res && res.status >= 500) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
      }
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return (req.mode === 'navigate' && (await cache.match('/index.html'))) || Response.error();
    }
  })());
});

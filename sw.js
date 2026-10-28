// 홈 화면 앱용 서비스 워커: 화면 파일과 한자 데이터는 저장해 두고 빨리 연다.
// 사전·로그인·저장(/api, Supabase)은 늘 인터넷으로 묻는다.
const CACHE = "natmal-v2";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/manifest.webmanifest", "/icon-192.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  // 한자 데이터: 한 번 받으면 저장해 둔 것을 쓴다
  if (u.pathname === "/hanja.json") {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })));
    return;
  }
  // 화면 파일: 새 버전을 먼저 받고, 인터넷이 안 되면 저장해 둔 것
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("/"))));
});

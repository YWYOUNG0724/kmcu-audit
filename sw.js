/* 오프라인 캐시: 앱 파일은 캐시 우선, 데이터 JSON은 네트워크 우선 */
const CACHE = "kmcu-audit-v4";
const ASSETS = [
  "./", "./index.html", "./css/styles.css", "./js/app.js", "./js/guide.js", "./js/chatbot.js",
  "./data/moe-cases.json", "./data/sample-cases.json", "./data/departments.json", "./data/school-types.json", "./data/import-template.csv",
  "./manifest.json", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(ASSETS.map(a => c.add(a)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const networkFirst = url.pathname.endsWith(".json") || req.mode === "navigate";
  if (networkFirst) {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match("./index.html"))));
  } else {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      if (res.ok && (url.origin === location.origin || url.hostname === "cdnjs.cloudflare.com")) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    })));
  }
});

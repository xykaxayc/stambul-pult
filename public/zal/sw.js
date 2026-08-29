/* САМОУДАЛЯЮЩИЙСЯ WORKER.
   Старый пульт кэшировал вёрстку, поэтому на телефонах смены осталась прежняя
   версия: до сервера запросы страниц вообще не доходили (в логах — только
   /api/). Новый интерфейс service worker не использует, сам старый воркер не
   уходит. Скрипт воркера браузер качает В ОБХОД воркера — поэтому подменяем
   именно его.

   Два неочевидных момента (проверены на граблях WebKit):
   1. Обработчик fetch обязателен, пусть и пустой. Без него WebKit может не
      считать воркер контроллером — тогда на клиенте НЕ сработает
      controllerchange, а именно по нему старый пульт делает location.reload().
   2. clients.navigate() НЕ вызываем: он гоняется наперегонки с этим же
      reload'ом, а в standalone на iOS ещё и умеет выкинуть человека в Safari. */
self.addEventListener("install", function () { self.skipWaiting(); });

self.addEventListener("activate", function (e) {
  e.waitUntil((async function () {
    try { await self.clients.claim(); } catch (err) {}
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (err) {}
    try { await self.registration.unregister(); } catch (err) {}
  })());
});

/* Пустой обработчик: respondWith не зовём — запрос идёт в сеть сам. */
self.addEventListener("fetch", function () {});

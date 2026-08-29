"use strict";
/* Профиль лаунжа из панели управления (Serp Cloud).
   Точка сама спрашивает панель, как ей работать, — а не панель лезет в точку.

   Подключение в server.js:
     const cloud = require("./cloud.js").init({ cfg: CFG, dataDir: DATA_DIR });
     cloud.moduleOn("qr", CFG.guestCalls === true)   // включён ли модуль
     cloud.modules({ qr: CFG.guestCalls === true })  // вся карта, для /api/config

   В config.json точки:
     "cloud": { "url": "https://saas.stambul42.ru", "token": "svc_…" }

   Панель молчит → работаем по последнему удачному ответу с диска,
   нет и его → по локальному config.json. Точка НЕ должна вставать
   из-за того, что панель недоступна. */

const fs = require("fs");
const path = require("path");

const KNOWN = ["qr", "build", "bans", "diag", "stats", "zal", "push", "catalog", "voice", "env", "mixBot"];

function init({ cfg = {}, dataDir, every = 60000, log = console.log, onProfile = null } = {}) {
  const conf = cfg.cloud || {};
  const cacheFile = path.join(dataDir, "cloud-profile.json");
  let profile = null;
  try { profile = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch (e) {}

  async function pull() {
    if (!conf.url || !conf.token) return;
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(conf.url.replace(/\/$/, "") + "/api/venue/profile", {
        headers: { "x-venue-token": conf.token }, signal: ctl.signal,
      });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.error) || "панель отказала");
      const before = JSON.stringify((profile || {}).modules || {});
      profile = j;
      fs.writeFile(cacheFile, JSON.stringify(j, null, 2), () => {});
      if (before !== JSON.stringify(j.modules || {}))
        log("[cloud] модули обновлены:", JSON.stringify(j.modules));
      if (onProfile) { try { onProfile(j); } catch (e) { log("[cloud] применение профиля:", String(e.message || e).slice(0, 80)); } }
    } catch (e) {
      log("[cloud] профиль не обновлён:", String(e.message || e).slice(0, 80));
    } finally { clearTimeout(kill); }
  }

  /* Модуль включён? Панель не отвечала ни разу — работаем по локальному значению. */
  function moduleOn(name, local) {
    const m = (profile && profile.modules) || null;
    return m && m[name] !== undefined ? !!m[name] : local;
  }
  /* Вся карта — её же отдаём клиенту, чтобы меню знало ту же правду. */
  function modules(locals = {}) {
    const out = {};
    for (const k of KNOWN) out[k] = moduleOn(k, locals[k] === undefined ? true : locals[k]);
    return out;
  }

  // из кэша — но ПОСЛЕ инициализации server.js: применять профиль к ещё не
  // созданным переменным нельзя, поэтому откладываем на следующий тик.
  if (profile && onProfile) setImmediate(() => { try { onProfile(profile); } catch (e) {} });
  pull();
  const t = setInterval(pull, every);
  if (t.unref) t.unref();

  /* Отправить в панель то, что админ отредактировал НА ТОЧКЕ.
     Источник правды — панель, но правка может начинаться с любой стороны. */
  async function pushGuest(guest) {
    if (!conf.url || !conf.token) return false;
    try {
      const r = await fetch(conf.url.replace(/\/$/, "") + "/api/venue/profile/guest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-venue-token": conf.token },
        body: JSON.stringify(guest),
      });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.error) || "панель не приняла");
      await pull();                       // сразу забираем обратно — чтобы не разъехалось
      return true;
    } catch (e) {
      log("[cloud] гостевая не уехала в панель:", String(e.message || e).slice(0, 80));
      return false;
    }
  }

  /* Актуальный состав смены — обратно в панель, чтобы её список не отставал
     от того, кого реально завели на точке. */
  async function pushStaff(staff) {
    if (!conf.url || !conf.token) return false;
    try {
      const r = await fetch(conf.url.replace(/\/$/, "") + "/api/venue/profile/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-venue-token": conf.token },
        body: JSON.stringify({ staff }),
      });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.error) || "панель не приняла");
      await pull();
      return true;
    } catch (e) {
      log("[cloud] состав смены не уехал в панель:", String(e.message || e).slice(0, 80));
      return false;
    }
  }

  return { moduleOn, modules, pull, pushGuest, pushStaff, get profile() { return profile; } };
}

module.exports = { init, KNOWN };

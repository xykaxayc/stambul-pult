"use strict";
/* События онбординга — в панель (Serp Cloud).
   Точка сообщает панели, что владелец дошёл до очередного шага:
     admin-login   первый вход ПИНом роли admin
     device-login  первый вход роли device (планшет стойки)
     qr-printed    открыл наклейки (/api/qr)
     first-call    первый вызов гостя по QR-ссылке /t/…
     first-start   первый запущенный кальян

   Подключение в server.js:
     const onboarding = require("./onboarding.js").init({ cfg: CFG, dataDir: DATA_DIR });
     onboarding.mark("admin-login");

   Правила:
   - cloud не настроен (нет cfg.cloud.url/token) — модуль молчит;
   - каждое событие уезжает ОДИН раз: успех пишем в data/onboarding-sent.json,
     после рестарта повторно не шлём;
   - сеть не ответила — событие лежит в очереди в памяти, повтор через минуту;
   - панель ответила 4xx (401 — чужой токен и т. п.) — не ретраим, одна строка в лог.
   Точку это никогда не роняет и не задерживает: fire-and-forget. */

const fs = require("fs");
const path = require("path");

const EVENTS = ["admin-login", "device-login", "qr-printed", "first-call", "first-start"];

function init({ cfg = {}, dataDir, log = console.log, retryMs = 60000, timeoutMs = 8000 } = {}) {
  const conf = cfg.cloud || {};
  const on = !!(conf.url && conf.token);
  const file = path.join(dataDir, "onboarding-sent.json");

  let sent = {};                                    // event → ts успешной отправки
  try { sent = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (e) {}
  const queue = new Map();                          // event → { event, ts } — ждут отправки
  const refused = new Set();                        // панель ответила 4xx — больше не пробуем
  let timer = null, busy = false;

  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(sent, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { log("[onboarding] не сохранил onboarding-sent.json:", String(e.message || e).slice(0, 80)); }
  }

  function schedule(ms) {
    if (timer || !queue.size) return;
    timer = setTimeout(() => { timer = null; flush(); }, ms);
    if (timer.unref) timer.unref();
  }

  async function flush() {
    if (busy || !queue.size) return;
    busy = true;
    const events = [...queue.values()];
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(conf.url.replace(/\/$/, "") + "/api/venue/profile/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Venue-Token": conf.token },
        body: JSON.stringify(events.length === 1 ? events[0] : { events }),
        signal: ctl.signal,
      });
      if (r.status >= 400 && r.status < 500) {
        // чужой/протухший токен, неизвестное событие — повтор не поможет
        for (const e of events) { refused.add(e.event); queue.delete(e.event); }
        log(`[onboarding] панель отказала (${r.status}) — события ${events.map((e) => e.event).join(", ")} не отправлены, повторять не буду`);
      } else if (!r.ok) {
        throw new Error("HTTP " + r.status);
      } else {
        for (const e of events) { sent[e.event] = e.ts; queue.delete(e.event); }
        persist();
        log("[onboarding] в панель:", events.map((e) => e.event).join(", "));
      }
    } catch (e) {
      log("[onboarding] панель не ответила, повтор через минуту:", String(e.message || e).slice(0, 80));
    } finally { clearTimeout(kill); busy = false; }
    schedule(retryMs);
  }

  /* Отметить шаг. Повторные вызовы — тишина. */
  function mark(event) {
    if (!on || !EVENTS.includes(event)) return false;
    if (sent[event] || refused.has(event) || queue.has(event)) return false;
    queue.set(event, { event, ts: Date.now() });
    if (!timer) schedule(0);
    return true;
  }

  return { mark, get sent() { return { ...sent }; }, get pending() { return [...queue.keys()]; } };
}

module.exports = { init, EVENTS };

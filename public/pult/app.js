"use strict";
/* ⚠️ Объявлено ПЕРВЫМ намеренно: `const` в TDZ, и любой блок кода выше этой
   строки падал с «Cannot access '$' before initialization» — причём молча
   для node --check, а в браузере это убивало ВСЮ страницу (пульт не рисовал
   ни одной плитки). За день напоролся дважды. Не переносить вниз. */
const $ = (id) => document.getElementById(id);

/* ===== Пульт кальянщика «Серп» =====
   На экране сразу все столы. Тап по столу — пошёл отсчёт до сервиса.
   Повторный тап — сброс и новый круг (угли обновлены). Крестик — стол свободен.
   Вызовы гостей приходят с сервера (/api/calls) и висят лентой сверху. */

const CALLS_MS = 4000;

const DEFAULT_SETTINGS = { service: 15, r1: 0, r2: 0, r3: 0, sound: true, vibrate: true, view: "digits", paint: false, simple: false, theme: "dark",
  // голос по умолчанию выключен: включают осознанно на том устройстве, где он нужен
  voice: false, voiceSet: "mix" };
const LS_SET = "serp.settings.v2";
const LS_TIM = "serp.tables.v2";
const LS_KEY = "serp.key";

let settings = load(LS_SET, DEFAULT_SETTINGS);
// старая настройка одного интервала переезжает в круги
if (!settings.r1) { settings.r2 = settings.r3 = settings.service || 15; settings.r1 = 25; }
// расчёт Андрея: 1-й круг = 10 мин приготовление+раскурка + 15 мин курения = 25.
// у кого стояло нетронутое 15/15/15 — переводим на новый расчёт
if (settings.r1 === 15 && settings.r2 === 15 && settings.r3 === 15) settings.r1 = 25;

/* сколько реально курят: из общего времени вычитаем приготовление и раскурку.
   Подготовка = разница первого круга и обычного (25−15 = 10 минут). */
/* сколько уже курят (мс): реальное время с конца раскурки. Может быть отрицательным,
   пока идёт прогрев/раскурка первого круга (10 мин = разница 1-го и обычного круга). */
function smokedMs(h) {
  const prepMs = Math.max(0, (settings.r1 - settings.r2)) * 60000;
  // раскурка кончилась после подготовки, либо раньше — если на 2-й круг перешли быстрее
  const prepEnd = h.smokeStart ? Math.min(h.smokeStart, h.startedAt + prepMs) : h.startedAt + prepMs;
  return Date.now() - prepEnd;
}
const smokedText = (h) => "курят " + human(Math.max(0, smokedMs(h)));
/* Только круг и сколько курят. Описание круга («греем и раскуриваем», «была одна
   замена») убрано по просьбе Андрея: оно повторяет номер круга другими словами,
   а место в строке дорогое — её и так режет многоточием. */
function smokeLabel(h) {
  return "круг " + h.round + " · " + smokedText(h);
}
/* подпись «пора к столу» — с сохранением сессии курения */
/* Слова «пора к столу» убраны намеренно: об этом уже кричит минус в таймере,
   красная заливка и пульсация. Вместо повтора возвращаем номер круга —
   при просрочке он раньше пропадал, хотя это единственное, чего не видно. */
const overdueLabel = (h) => ics("alarm") + (isFinal(h) ? " финальный круг" : " круг " + h.round) + " · " + smokedText(h);

/* время круга зависит от его номера: свежие угли держат дольше */
/* норматив круга: снимок с сервера (h.plan) — смена настроек не трогает уже дымящиеся кальяны */
const planFor = (round) => {
  const rs = Array.isArray(settings.rs) && settings.rs.length ? settings.rs
    : [settings.r1, settings.r2, settings.r3];
  return rs[Math.min(Math.max(1, round), rs.length) - 1];
};
const targetSec = (h) => (h.plan || planFor(h.round)) * 60;

/* ===== ФИНАЛЬНЫЙ КРУГ =====
   Кругов у заведения ровно столько, сколько задал админ (у Стамбула три).
   Последний в списке — финальный: на нём двойное нажатие не начинает новый
   круг, а ЗАВЕРШАЕТ кальян. Четвёртого круга не существует — то же самое
   отдельно проверяет сервер, интерфейс лишь говорит об этом человеку. */
const roundsCount = () => {
  const rs = Array.isArray(settings.rs) && settings.rs.length ? settings.rs
    : [settings.r1, settings.r2, settings.r3];
  return rs.length;
};
const isFinal = (h) => h && h.round >= roundsCount();
const ARM_MS = 2500;          // обычный круг: второй тап ждём 2,5 с
const ARM_FIN_MS = 3000;      // закрытие — действие с последствиями, даём 3 с
let tables = load(LS_TIM, {});  // "N" -> {startedAt, round, roundStart}; ведущая копия — на сервере
let callList = [];              // активные вызовы с сервера
let orderList = [];             // заказы забивки от официантов (телефон → этот планшет)
const knownOrders = new Set();  // о каких заказах уже пикали
let conn = { ok: false, error: "подключение…" };
let cfg = { venue: "Стамбул", tables: 40 };
let clearArm = { n: 0, until: 0 }; // «✕ → Точно?» на 3 секунды
let tapArm = { key: "", until: 0 }; // запуск/новый круг — только двойным тапом: случайное касание при прокрутке ничего не включит
let me = (() => { try { return JSON.parse(localStorage.getItem("serp.me") || "null"); } catch { return null; } })();
let svc = { service: false, blockGuests: false, note: "", by: "" };
let beta = { build: false, voice: false };   // конструктор забивки и голос — включает сервер, см. config.json → beta

function load(k, def) { try { return { ...def, ...JSON.parse(localStorage.getItem(k) || "{}") }; } catch { return { ...def }; } }
const saveSettings = () => localStorage.setItem(LS_SET, JSON.stringify(settings));
const saveTables = () => localStorage.setItem(LS_TIM, JSON.stringify(tables)); // локальный кэш на случай офлайна

/* действие со столом уходит на сервер — планшет и телефон видят одно и то же */
/* ===== Работа без интернета =====
   Таймеры считаются от меток времени в локальной копии столов, поэтому идут и
   без сети. Не хватало только действий: раньше запуск и «новый круг» при обрыве
   молча пропадали. Теперь они применяются на месте и складываются в очередь,
   а при возврате связи уходят на сервер по порядку. */
const LS_OUT = "serp.outbox.v1";
let outbox = (() => { try { return JSON.parse(localStorage.getItem(LS_OUT) || "[]"); } catch { return []; } })();
const saveOutbox = () => localStorage.setItem(LS_OUT, JSON.stringify(outbox.slice(-200)));

function drawOutbox() {
  const el = document.getElementById("outbox");
  if (!el) return;
  el.classList.toggle("hidden", !outbox.length);
  if (outbox.length) el.textContent = "не отправлено: " + outbox.length;
}

/* Повторяем на месте то, что сделал бы сервер. Только действия, от которых
   зависит таймер, — остальное дождётся связи. */
function applyLocally(action, n, hid, extra) {
  const key = String(n);
  const now = Date.now();
  const plan = (round) => planFor(round);
  if (action === "tap") {
    const t = tables[key];
    if (!t || !(t.hookahs || []).length) {
      tables[key] = { sid: "local-" + now, offline: true,
        hookahs: [{ id: "l" + now.toString(36), round: 1, roundStart: now, plan: plan(1),
                    build: (extra && extra.build) || null }] };
    } else {
      const h = (hid && t.hookahs.find((x) => x.id === hid)) || t.hookahs[0];
      if (!h || isFinal(h)) return false;          // с финального круга кальян завершают, а не продлевают
      h.round += 1; h.roundStart = now; h.plan = plan(h.round); h.ready = false; h.served = false;
    }
    return true;
  }
  if (action === "finish") {                       // финальный круг: кальян завершён
    const t = tables[key];
    const list = (t && t.hookahs) || [];
    if (!list.length) return false;
    const h = (hid && list.find((x) => x.id === hid)) || list[0];
    if (!h) return false;
    t.hookahs = list.filter((x) => x.id !== h.id);
    if (!t.hookahs.length) delete tables[key];      // последний кальян — стол свободен
    return true;
  }
  if (action === "stage") {
    const t = tables[key]; if (!t) return false;
    const h = (hid && (t.hookahs || []).find((x) => x.id === hid)) || (t.hookahs || [])[0];
    if (!h) return false;
    if (extra && extra.stage === "ready") h.ready = true; else { h.ready = true; h.served = true; }
    return true;
  }
  if (action === "clear") { delete tables[key]; return true; }
  return false;
}

/* ⚠️ ОЧЕРЕДЬ ОФЛАЙНА — три защиты, каждая куплена разбором:
   1) `flushing` — раньше флага не было, а `flushOutbox()` зовётся из опроса каждые
      4 с и НЕ ожидается. На слабом Wi-Fi запрос висел 5–10 с, следующий опрос
      заходил сюда же, брал тот же `outbox[0]` (сдвиг — только после ответа) и слал
      его ВТОРОЙ раз: круг перематывался дважды, гость получал угли на 15 мин раньше.
   2) `op` — ключ запроса. Потерянный ОТВЕТ неотличим от недоставленного запроса:
      сервер круг уже прибавил, клиент считает это сбоем и шлёт ещё раз. Сервер
      отбивает повтор по этому ключу (см. `recentOps` в server.js).
   3) `OUTBOX_TTL` — срок годности. Действие без срока — самое опасное, что тут было:
      закрыл стол 7, связь пропала, через 20 минут за стол 7 сели новые гости с
      другого устройства, планшет поймал сеть — и живая посадка уехала в архив.
      Планшет, пролежавший ночь, проигрывал вчерашние тапы на сегодняшних столах.
      Протухшее действие МОЛЧА не отправляем: не сделать хуже важнее, чем досослать. */
const OUTBOX_TTL = 3 * 60 * 1000;
let flushing = false;
async function flushOutbox() {
  if (flushing || !outbox.length || !conn.ok) return;
  flushing = true;
  try {
    const before = outbox.length;
    const stale = outbox.filter((it) => Date.now() - (it.ts || 0) > OUTBOX_TTL);
    if (stale.length) {
      outbox = outbox.filter((it) => Date.now() - (it.ts || 0) <= OUTBOX_TTL);
      saveOutbox();
      console.log("[outbox] выброшено протухших действий:", stale.length, stale.map((x) => x.action + ":" + x.n));
      flashConn("⚠️ " + stale.length + " старых действий не отправлены — зал мог измениться");
    }
    while (outbox.length) {
      const it = outbox[0];
      if (Date.now() - (it.ts || 0) > OUTBOX_TTL) { outbox.shift(); saveOutbox(); continue; }
      try {
        const r = await api("/api/table", { method: "POST",
          body: JSON.stringify({ action: it.action, n: it.n, hid: it.hid, op: it.op, opId: it.op, ...(it.extra || {}) }) });
        const d = await r.json();
        if (d.tables) { tables = d.tables; saveTables(); }
        // отложенное действие могло опоздать: стол уже увели или закрыли с другого
        // устройства. Сервер его не применит — человек должен об этом узнать.
        if (!d.ok && d.error) flashConn("⚠️ " + d.error);
        outbox.shift(); saveOutbox();
      } catch { return; }                     // связь снова пропала — оставляем очередь на потом
    }
    if (before) { drawOutbox(); renderGrid(true); flashConn("✓ отправлено на сервер"); }
  } finally { flushing = false; }
}

async function tableAction(action, n, hid, extra) {
  // ключ запроса: по нему сервер отобьёт повтор, если ответ потеряется в пути
  const op = "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  try {
    // opId — новое имя ключа, op оставлен для сервера, который ещё не обновили
    const d = await (await api("/api/table", { method: "POST",
      body: JSON.stringify({ action, n, hid, op, opId: op, ...(extra || {}) }) })).json();
    // столы приходят и с отказом (стол увели, посадка сменилась) — показываем правду, а не то, что было
    if (d.tables) { tables = d.tables; saveTables(); renderGrid(true); }
    if (d.ok) { canUndo = !!d.canUndo; drawUndo(); }
    if (!d.ok && d.error) flashConn("⚠️ " + d.error);
    return d;
  } catch (e) {
    if (e && e.message === "auth") return null;            // не сеть — ключ, очередь ни при чём
    if (!applyLocally(action, n, hid, extra)) { flashConn("нет связи — действие не сохранено"); return null; }
    // локальный id кальяна серверу неизвестен — не шлём его, иначе на multi-столе
    // сервер возьмёт первый кальян и круг отобьётся не тому
    outbox.push({ action, n, hid: String(hid || "").startsWith("l") ? "" : hid, extra, op, ts: Date.now() });
    saveOutbox(); saveTables(); renderGrid(true); drawOutbox();
    flashConn("нет связи — записал у себя, отправлю позже");
    return { ok: true, offline: true };
  }
}

/* ===== Экран загрузки: пока пульт подключается, человек видит шаги, а не пустую сетку ===== */
const bootEl = document.getElementById("boot");
const bootT0 = Date.now();
let bootGone = false;
function bootStep(id, state, text) {                 // state: wait | ok | err
  if (bootGone) return;
  const el = document.getElementById("bs-" + id);
  if (!el) return;
  if (text) el.querySelector(".bs-t").textContent = text;
  el.querySelector(".bs-i").textContent = state === "ok" ? "✓" : state === "err" ? "⚠️" : "⏳";
  el.className = "bs " + state;
}
function bootHint(t) { if (!bootGone) document.getElementById("bootHint").textContent = t || ""; }
function bootDone() {
  if (bootGone || !bootEl) return;
  bootGone = true;
  const wait = Math.max(0, 600 - (Date.now() - bootT0));   // на быстрой сети не мигаем
  setTimeout(() => {
    bootEl.classList.add("bye");
    setTimeout(() => bootEl.remove(), 450);
  }, wait);
}
setTimeout(() => {                                    // затянулось — объясняем, что делать
  if (!bootGone) bootHint("Сервер долго не отвечает. Проверьте Wi-Fi заведения или включите мобильный интернет. Пульт продолжает пытаться сам.");
}, 10000);

/* ===== Ключ пульта: в заголовке, не в URL (иначе течёт в логи) ===== */
const getKey = () => localStorage.getItem(LS_KEY) || "";
let needKey = false;

function drawWho() {
  const el = document.getElementById("crewWho");
  if (el) el.textContent = me ? me.name + (me.role === "admin" ? " · админ" : "") : "";
  if (me && (me.device || me.role === "device")) keepAwake();   // планшету на стойке гаснуть нельзя
  // планшету уведомления тоже нужны: их звук играет система, даже если экран не трогали
  // настройки — только для админа; персонал пользуется панелью как есть
  const sb = document.getElementById("settingsBtn");
  if (sb) sb.style.display = me && me.role === "admin" ? "" : "none";
}

function askKey(msg) {
  needKey = true;
  bootDone();                                   // нужен ввод ПИНа — экран загрузки уходит
  const box = document.getElementById("keyGate");
  document.getElementById("keyMsg").textContent = msg || "";
  box.classList.remove("hidden");
}
function hideKeyGate() { needKey = false; document.getElementById("keyGate").classList.add("hidden"); }

/* все запросы пульта — только через это: ключ уходит заголовком */
async function api(path, opts = {}) {
  const key = getKey();
  if (!key) { askKey("Введите свой ПИН."); throw new Error("auth"); }
  const o = { ...opts, headers: { ...(opts.headers || {}), "X-Pult-Key": key } };
  if (o.body && !o.headers["Content-Type"]) o.headers["Content-Type"] = "application/json";
  const r = await fetch(path, o);
  if (r.status === 429) { conn = { ok: false, error: "подождите минуту" }; throw new Error("busy"); }
  if (r.status === 401) {
    let msg = "Неверный ключ. Введите ещё раз.";
    try { const d = await r.clone().json(); if (d && d.error) msg = d.error; } catch {}
    localStorage.removeItem(LS_KEY); localStorage.removeItem("serp.me"); me = null; drawWho();
    askKey(msg); throw new Error("auth");
  }
  return r;
}

/* ===== Баннер сервисного режима ===== */

/* ===== Сервисные сообщения смене (из панели управления) =====
   Показываем полосой сверху, пока кто-нибудь не нажмёт «Понятно» — тогда
   сообщение снимается у ВСЕХ пультов: оно прочитано сменой, а не устройством. */
function drawNotices(list) {
  const box = document.getElementById("noteBanner");
  if (!box) return;
  box.innerHTML = (list || []).map((n) => `<div class="svc-banner note-banner">
    <span class="nt">📣 ${esc(n.text)}${n.by ? " — " + esc(n.by) : ""}</span>
    <button data-noteok="${esc(n.id)}">Понятно</button></div>`).join("");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-noteok]");
  if (!b) return;
  const id = b.dataset.noteok;
  b.closest(".note-banner").remove();                 // убираем сразу, не дожидаясь опроса
  api("/api/notice/ack", { method: "POST", body: JSON.stringify({ id }) }).catch(() => {});
});

function drawSvcBanner() {
  const b = document.getElementById("svcBanner");
  if (!b) return;
  if (!svc.service) { b.classList.add("hidden"); b.textContent = ""; return; }
  b.classList.remove("hidden");
  b.textContent = "🔧 Сервисный режим — уведомления отключены"
    + (svc.blockGuests ? " · вызовы гостей закрыты" : "")
    + (svc.note ? " · " + svc.note : "")
    + (svc.by ? " (включил " + svc.by + ")" : "");
}

/* ===== Погода на точке (крыша зависит от дождя и ветра) ===== */
let wx = null;
function drawWeather(w) {
  const el = document.getElementById("wxBar");
  if (!el) return;
  if (w) wx = w;
  if (!wx) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const sign = (v) => (v > 0 ? "+" : "") + v;
  let html = `<span class="wx-now">${wx.emoji} ${sign(wx.t)}°<span class="wx-feels"> · ощущается ${sign(wx.feels)}°</span></span>`
    + `<span class="wx-wind">🌬 ветер ${wx.wind} м/с${wx.gust > wx.wind ? ` · порывы ${wx.gust}` : ""}</span>`;
  if (wx.heads) {
    const ic = wx.heads.kind === "wind" ? "💨" : "🌧";
    html += `<span class="wx-warn ${wx.heads.kind}">${ic} ${esc(wx.heads.text)}</span>`;
  } else {
    html += `<span class="wx-ok">осадков в ближайшие часы не ждём</span>`;
  }
  el.innerHTML = html;
  el.classList.toggle("has-warn", !!wx.heads);
  el.classList.remove("hidden");
}

/* ===== Звук / вибрация =====
   Браузер держит звук выключенным, пока по экрану не коснулись. Поэтому будим его
   при каждом касании, пока состояние не станет рабочим, и коротким беззвучным
   импульсом — так надёжнее всего на iPad. */
let audioCtx = null;
let audioReady = false;

function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== "running" && audioCtx.resume) audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    g.gain.value = 0.0001;                       // беззвучный импульс — «будильник» для звука
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.01);
    audioReady = audioCtx.state === "running";
  } catch { audioReady = false; }
  drawSoundState();
}
["pointerdown", "touchstart", "mousedown", "keydown"].forEach((ev) =>
  document.addEventListener(ev, () => {
    if (!audioCtx || audioCtx.state !== "running") unlockAudio();
    else audioReady = true;
  }, true));

/* если звук ещё заблокирован — честно показываем это на кнопке */
/* Значок из спрайта в index.html. Через currentColor красится сам —
   поэтому одна и та же иконка годится и для тёмной темы, и для светлой. */
const ico = (name) => `<svg class="ic" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`;
/* тот же значок, но мелкий — для строки забивки и подписей внутри текста */
const ics = (name) => `<svg class="ic ic-s" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`;

function drawSoundState() {
  const b = document.getElementById("soundBtn");
  if (!b) return;
  if (!settings.sound) { b.innerHTML = ico("bell-off"); b.classList.add("off"); b.title = "звук выключен"; return; }
  b.classList.remove("off");
  if (audioReady) { b.innerHTML = ico("bell"); b.title = "звук включён"; }
  else { b.innerHTML = ico("bell-off"); b.title = "коснитесь экрана, чтобы включить звук"; }
}
function tone(freq, times) {
  if (!settings.sound || svc.service) return;   // идут работы — пульт молчит
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== "running") {
      // звук ещё заблокирован — просим разбудить и пробуем ещё раз через миг
      if (audioCtx.resume) audioCtx.resume().then(() => { audioReady = true; drawSoundState(); }).catch(() => {});
      flashConn("🔇 коснитесь экрана — звук заблокирован");
      setTimeout(() => { if (audioCtx && audioCtx.state === "running") tone(freq, times); }, 250);
      return;
    }
    audioReady = true;
    const now = audioCtx.currentTime;
    times.forEach((t) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0, now + t);
      g.gain.linearRampToValueAtTime(0.25, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.14);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(now + t); o.stop(now + t + 0.15);
    });
  } catch {}
}
const beep = () => tone(880, [0, 0.18, 0.36]);
const beepCall = () => tone(660, [0, 0.15, 0.3, 0.6, 0.75, 0.9]); // вызов — длиннее и ниже
const buzz = () => settings.vibrate && navigator.vibrate && navigator.vibrate([180, 90, 180]);

/* ===== Голосовые уведомления =====
   Озвучиваются ТОЛЬКО системные события таймера: «круг вышел» и «к столу так и
   не подошли». Гостевые вызовы по QR голосом не объявляются — только писком.

   Файлы заранее сгенерированы (Fish Audio, s2.1-pro-free) и лежат наборами:
   voice/<набор>/tNN_overdue.mp3 и tNN_overdue3.mp3. Набор выбирается в настройках
   и хранится на устройстве: на планшете может быть один голос, на телефоне другой.
   Выключено по умолчанию. */
const VOICE_SETS = ["mix", "maboy", "zhirik"];
const voiceDir = () =>
  "voice/" + (VOICE_SETS.includes(settings.voiceSet) ? settings.voiceSet : "mix") + "/";

const voiceQueue = [];          // чтобы два объявления подряд не легли друг на друга
let voicePlaying = false;

function voiceNext() {
  if (voicePlaying || !voiceQueue.length) return;
  const name = voiceQueue.shift();
  voicePlaying = true;
  try {
    const a = new Audio(voiceDir() + name + ".mp3");
    a.volume = 1;
    const done = () => { voicePlaying = false; setTimeout(voiceNext, 150); };
    a.addEventListener("ended", done, { once: true });
    a.addEventListener("error", done, { once: true });
    a.play().catch(() => { done(); flashConn("🔇 коснитесь экрана — звук заблокирован"); });
  } catch { voicePlaying = false; }
}

/* say("t07_overdue") — поставить фразу в очередь. Молчит, если звук или голос
   выключен, а также в сервисном режиме (там пульт молчит целиком).
   Возвращает false, если не сказал — вызывающий тогда пищит обычным сигналом. */
function say(name) {
  if (!settings.voice || !settings.sound || svc.service) return false;
  if (voiceQueue.length > 4) voiceQueue.length = 4;   // завал — не копим хвост на минуты
  voiceQueue.push(name);
  voiceNext();
  return true;
}

/* Голос есть только у обычных столов 1..9; у именованных («c…») его нет. */
const voiceTable = (key) => {
  const n = +key;
  return Number.isInteger(n) && n >= 1 && n <= 9 ? "t" + String(n).padStart(2, "0") : null;
};

/* ===== Время ===== */
function mmss(sec) {
  const neg = sec < 0; let s = Math.abs(Math.round(sec));
  if (neg && s > 600) return "-" + human(s * 1000);   // давно просрочен — «-1ч 17м» (всегда минус, читаемее «-77:48»)
  const m = Math.floor(s / 60); s %= 60;
  return (neg ? "-" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
/* Таймер на плитке — всегда со словом: «До подхода 0:52» / «Просрочено 0:40».
   Голая цифра (и тем более «-00:40») через зал читается неверно. Минуты без
   ведущего нуля; давняя просрочка — по-человечески: «Просрочено 1ч 17м». */
function fmtLeft(sec) {
  const s = Math.abs(Math.round(sec));
  const t = s >= 3600 ? human(s * 1000) : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  // слово — маленькой подписью над временем, иначе «Просрочено 12:34» не влезает в плитку
  return "<i>" + (sec < 0 ? "Просрочено" : "До подхода") + "</i>" + t;
}
/* короткий вариант для строк мульти-стола: 0:52 / −0:12 */
/* «курят 1 ч 5 мин» в узкой строке мульти-стола не помещается — жмём до «1ч5м» */
const smokedShort = (h) => smokedText(h).replace("курят ", "").replace(/\s*мин/, "м").replace(/\s*ч\s*/, "ч");
function fmtShort(sec) {
  const s = Math.abs(Math.round(sec));
  const t = s >= 3600 ? human(s * 1000) : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  return (sec < 0 ? "−" : "") + t;
}
function human(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + " мин";
  return Math.floor(m / 60) + "ч " + (m % 60) + "м";
}

/* ===== Вызовы с сервера ===== */
let knownCalls = new Set();
let lastNag = 0;
let lastPing = 0;
let pingReady = false;
let failStreak = 0;
async function pollCalls() {
  if (needKey) return;
  if (!getKey()) { askKey("Введите свой ПИН — он покажет, кто на смене."); return; }
  try {
    const d = await (await api("/api/calls", { cache: "no-store" })).json();
    callList = (d.calls || []).sort((a, b) => a.ts - b.ts);
    orderList = (d.orders || []).sort((a, b) => a.ts - b.ts);   // заказы забивки от официантов
    takeEvents(d.events || []);                                  // что сделали с телефонов
    if (d.view) applyView(d.view);                         // общий вид — с сервера
    if (d.weather) drawWeather(d.weather);                 // погода на точке
    if (typeof d.youOnShift === "boolean") { youOnShift = d.youOnShift; drawShiftBanner(); }
    if (typeof d.myShift === "boolean" && d.myShift !== shiftOn) { shiftOn = d.myShift; drawShift(shiftOn ? "on" : "off"); }
    keepPushAlive();                                       // окно подписки живёт 14 ч — продлеваем
    if (d.tables) { tables = d.tables; saveTables(); }
    if (Array.isArray(d.flavors)) flavorHints = d.flavors;  // подсказки вкусов для конструктора
    if (d.beta) applyBeta(d.beta);                          // кому открыты конструктор и голос
    if ("canUndo" in d) { canUndo = !!d.canUndo; drawUndo(); }
    // управляющий проверяет, слышно ли пульт: первый ответ просто запоминаем, дальше пикаем
    if (pingReady) {
      if ((d.ping || 0) > lastPing) {
        if (d.pingKind === "timer") { beep(); flashConn("⏰ так звучит «пора к столу»"); }
        else { beepCall(); flashConn("🔔 так звучит вызов гостя"); }
        buzz();
      }
    } else pingReady = true;
    lastPing = d.ping || 0;
    if (d.mode) { svc = d.mode; drawSvcBanner(); }
    drawNotices(d.notices);
    failStreak = 0;
    conn = { ok: true, error: "" };
    flushOutbox();
    bootStep("conn", "ok"); bootStep("tables", "ok"); bootDone();   // данные пришли — пульт готов
    for (const c of callList) {
      if (!knownCalls.has(c.id) && c.status === "new") { beepCall(); buzz(); }
      knownCalls.add(c.id);
    }
    // новый заказ забивки звучит так же, как вызов: планшет стоит у стойки, на него не смотрят
    for (const o of orderList) {
      if (!knownOrders.has(o.id) && o.status === "new") { beepCall(); buzz(); }
      knownOrders.add(o.id);
    }
    // непринятый вызов напоминает о себе раз в минуту, а не пищит один раз
    if (callList.some((c) => c.status === "new") && Date.now() - lastNag > 60000) {
      lastNag = Date.now(); beepCall(); buzz();
    }
    if (!callList.some((c) => c.status === "new")) lastNag = 0;
  } catch (e) {
    if (e.message !== "auth" && e.message !== "busy") {
      failStreak++;
      if (failStreak >= 3) conn = { ok: false, error: "нет связи" };   // один лаг сети — не повод пугать
      bootStep("conn", "err", "Нет связи с сервером — пробую ещё…");
    }
  }
  renderOrders(); renderEvents(); renderCalls(); updateConn();
}

/* ===== События с других устройств =====
   Кальянщик переносит стол и отмечает угли с телефона — планшет обязан об этом
   сказать вслух, иначе на стойке видно только «плитка почему-то изменилась».
   Сервер уже отфильтровал события ЭТОГО устройства, так что своё эхо не придёт. */
/* Строка НЕ гаснет сама (просьба Андрея 05.08): пропущенное уведомление — это
   стол, к которому никто не пошёл. Убирает её ТОЛЬКО мастер кнопкой «Принял».
   Что уже приняли — помним в localStorage: перезагрузка планшета не воскрешает
   разобранные строки и не прячет непрочитанные. */
const LS_EVD = "serp.ev.done";
let evShown = [];                          // [{id, ts, kind, text, who}]
let evDone = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(LS_EVD) || "[]")); } catch { return new Set(); }
})();
function saveEvDone() {
  const arr = [...evDone].slice(-400);      // множество не должно расти вечно
  evDone = new Set(arr);
  localStorage.setItem(LS_EVD, JSON.stringify(arr));
}
/* Принятый вызов не исчезает мгновенно: несколько минут висит компактной
   строкой «✓ Принят» — смена видит, что вызов уже за кем-то, и не дёргается.
   Потом уходит в разобранные и пропадает с экрана. */
const LS_EVA = "serp.ev.ack";
const EV_ACK_SHOW = 5 * 60 * 1000;
let evAck = (() => {
  try { return JSON.parse(localStorage.getItem(LS_EVA) || "{}") || {}; } catch { return {}; }
})();
const saveEvAck = () => localStorage.setItem(LS_EVA, JSON.stringify(evAck));
const evSeen = new Set();
const EV_ICO = { move: "⇄", msg: "✉️", reply: "↩︎" };
/* Первый запуск на устройстве: всё, что сервер уже накопил за последние полчаса,
   считаем разобранным. Иначе новый планшет (или сброшенный кэш) встречал бы
   смену стеной старых уведомлений, которые никто ему не адресовал. */
let evFirst = localStorage.getItem(LS_EVD) === null;
function takeEvents(list) {
  if (evFirst) {
    evFirst = false;
    for (const e of list) { evDone.add(e.id); evSeen.add(e.id); }
    saveEvDone();
  }
  // отлежавшие своё принятые — в разобранные (и те, которые сервер уже забыл)
  const alive = new Set(list.map((e) => e.id));
  let ackTouched = false;
  for (const id of Object.keys(evAck)) {
    if (Date.now() - evAck[id] > EV_ACK_SHOW || !alive.has(id)) {
      evDone.add(id); delete evAck[id]; ackTouched = true;
    }
  }
  if (ackTouched) { saveEvDone(); saveEvAck(); }
  const fresh = list.filter((e) => !evDone.has(e.id));
  // ⚠️ СНАЧАЛА данные, ПОТОМ звук. Раньше было наоборот, и упавший `tone()`
  // (аудио заблокировано до первого касания экрана) уносил с собой весь список:
  // событие приходило с сервера и молча не показывалось.
  evShown = fresh.sort((a, b) => a.ts - b.ts);
  for (const e of fresh) {
    if (evSeen.has(e.id)) continue;
    evSeen.add(e.id);
    try { beep(); buzz(); } catch {}         // звук ровно один раз на событие
  }
}
function evAccept(ids) {
  for (const id of ids) evAck[id] = Date.now();   // не гасим сразу — покажем «✓ Принят»
  saveEvAck();
  renderEvents();
}
const plural = (n, one, few, many) =>
  (n % 10 === 1 && n % 100 !== 11) ? one
  : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? few : many;
/* Заголовок карточки: событию — короткое имя дела, а не пересказ.
   «Стол 1 → 33: гости пересели» через пол-экрана читается хуже,
   чем «Пересадка · 1 → 33». Записка и ответ — сами себе заголовок. */
function evTitle(e) {
  const m = /^Стол (.+?) → (.+?): гости пересели$/.exec(e.text || "");
  if (m) return `Пересадка · ${m[1]} → ${m[2]}`;
  if (e.kind === "msg") return e.text;
  if (e.kind === "reply") return e.text;
  return e.text;
}
let evSig = "";
function renderEvents() {
  const bar = document.getElementById("eventsBar");
  if (!bar) return;
  // перерисовываем ТОЛЬКО при изменении набора: иначе каждую секунду
  // перезапускалась бы анимация появления и срывались нажатия по кнопке
  const sig = evShown.map((e) => e.id + (evAck[e.id] ? "a" : "")).join(",");
  if (sig === evSig) return;
  evSig = sig;
  if (!evShown.length) {
    drawHistBadge();
    if (bar.innerHTML) { bar.classList.add("hidden"); bar.innerHTML = ""; }
    return;
  }
  bar.classList.remove("hidden");
  drawHistBadge();
  const waiting = evShown.filter((e) => !evAck[e.id]);
  bar.innerHTML = evShown.map((e) => {
    const acked = !!evAck[e.id];
    return `
    <div class="ev-chip${acked ? " acked" : ""}">
      <div class="e-r1">
        <span class="e-ico">${EV_ICO[e.kind] || "•"}</span>
        <span class="e-title">${esc(evTitle(e))}</span>
        ${acked
          ? `<span class="e-done">${ics("check")} Принят</span>`
          : (e.kind === "msg" ? `<button class="btn e-rp" data-evrp="${e.id}">Ответить</button>` : "")
            + `<button class="btn primary e-ok" data-evx="${e.id}">Принять</button>`}
      </div>
      <div class="e-r2">${esc(e.who)} · ${human(Date.now() - e.ts)} назад</div>
    </div>`;
  }).join("")
    + (waiting.length > 1
      ? `<div class="e-allbar"><span>${waiting.length} ${plural(waiting.length, "новый вызов", "новых вызова", "новых вызовов")}</span>
         <button class="btn e-all" data-evall="1">Принять все</button></div>` : "");
}
document.getElementById("eventsBar").addEventListener("click", (e) => {
  if (e.target.closest("[data-evall]")) { evAccept(evShown.filter((x) => !evAck[x.id]).map((x) => x.id)); return; }
  const rp = e.target.closest("[data-evrp]");
  if (rp) { openReply(rp.dataset.evrp); return; }
  const b = e.target.closest("[data-evx]");
  if (b) evAccept([b.dataset.evx]);
});

/* ===== Ответ на записку =====
   Записка в одну сторону всегда рождает «а он видел?», и человек идёт спрашивать
   голосом через зал — то есть ровно то, ради чего записку и заводили.
   Ответ уходит АДРЕСНО автору: и строкой в его телефон, и пушем. */
const RP_QUICK = ["Понял", "Иду", "Сейчас сделаю", "Через 5 минут", "Не могу, занят", "Подойди ко мне"];
let rpId = "";
function openReply(id, from) {
  const e = from || evShown.find((x) => x.id === id);
  if (!e) return;
  rpId = id;
  $("rpTitle").textContent = "Ответить: " + e.who;
  $("rpAbout").textContent = "«" + e.text + "»";
  $("rpChips").innerHTML = RP_QUICK.map((q) => `<button class="btn bd-fl" data-rq="${esc(q)}">${esc(q)}</button>`).join("");
  $("rpText").value = "";
  $("replyBox").classList.remove("hidden");
  setTimeout(() => $("rpText").focus(), 60);
}
const closeReply = () => { rpId = ""; $("replyBox").classList.add("hidden"); };
$("rpCancel").addEventListener("click", closeReply);
$("replyBox").addEventListener("click", (e) => { if (e.target === $("replyBox")) closeReply(); });
$("rpChips").addEventListener("click", (e) => {          // быстрый ответ — сразу уходит
  const b = e.target.closest("[data-rq]");
  if (b) sendReply(b.dataset.rq);
});
$("rpText").addEventListener("keydown", (e) => { if (e.key === "Enter") sendReply($("rpText").value); });
$("rpSend").addEventListener("click", () => sendReply($("rpText").value));
async function sendReply(text) {
  const t = String(text || "").trim();
  if (!t || !rpId) return;
  const id = rpId;
  closeReply();
  try {
    const d = await (await api("/api/reply", { method: "POST", body: JSON.stringify({ id, text: t }) })).json();
    if (!d.ok) { flashConn(d.error || "ответ не ушёл"); return; }
    flashConn(d.pushTo ? "Ответ отправлен · пуш дошёл" : "Ответ отправлен");
    evAccept([id]);                                        // ответил — записка разобрана
  } catch { flashConn("нет связи — ответ не ушёл"); }
}

/* ===== Заказы забивки: телефон официанта → этот планшет =====
   Карточка не трогает таймеры: она только говорит, что забить. Кальянщик жмёт
   «Забиваю» — открывается обычное окно забивки с уже вписанным текстом, а сам
   заказ закрывается сервером, как только стол реально запущен. */
function renderOrders() {
  const bar = document.getElementById("ordersBar");
  if (!bar) return;
  if (!orderList.length) {
    if (bar.innerHTML) { bar.classList.add("hidden"); bar.innerHTML = ""; }
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = orderList.map((o) => {
    const label = String(o.table).startsWith("c")
      ? esc((tables[o.table] || {}).label || "свой стол") : "Стол " + esc(String(o.table));
    const busy = hookahsOf(o.table).length;
    const taken = o.status === "taken";
    return `
    <div class="ord-chip${taken ? " taken" : ""}">
      <div class="o-body">
        <div class="o-top"><span class="o-ico">💨</span>${label}
          <span>· ${human(Date.now() - o.ts)} назад · ${esc(o.by || "официант")}</span></div>
        <div class="o-txt">${esc(o.text || "на усмотрение кальянщика")}</div>
        <div class="o-by">${taken
          ? `забирает ${esc(o.takenBy || "")} · ${ics("alarm")} таймер ещё НЕ идёт`
          : "ждёт мастера"}${busy ? " · на столе уже " + busy : ""}</div>
      </div>
      <div class="o-acts">
        <button class="btn spam-btn" data-ordcancel="${o.id}" title="отменить заказ">${ico("ban")}</button>
        ${taken
          ? `<button class="btn go" data-ordstart="${o.id}" data-t="${esc(String(o.table))}">${ics("check")} Начал работу</button>`
          : `<button class="btn primary" data-ordtake="${o.id}">Забираю заказ</button>`}
      </div>
    </div>`;
  }).join("");
}
/* Заказ разбит на ДВА шага сознательно:
   «Забираю заказ» — мастер закрепил работу за собой, чтобы двое не пошли к одному
   столу. Таймер при этом НЕ идёт: кальян ещё не собран, а 25 минут первого круга
   считаются от розжига, не от заказа — иначе стол «горит» ещё до того, как к нему
   притронулись, и вся статистика по кругам врёт.
   «Начал работу» — вот теперь стол запущен и таймер пошёл. Текст официанта
   уезжает в забивку, поправить её можно тапом по чипу на плитке. */
document.getElementById("ordersBar").addEventListener("click", async (e) => {
  const take = e.target.closest("[data-ordtake]");
  if (take) {
    take.disabled = true;
    try { await api("/api/order/act", { method: "POST", body: JSON.stringify({ id: take.dataset.ordtake, act: "take" }) }); } catch {}
    pollCalls();
    return;
  }
  const start = e.target.closest("[data-ordstart]");
  if (start) {
    start.disabled = true;
    const o = orderList.find((x) => x.id === start.dataset.ordstart);
    const t = start.dataset.t;
    const n = String(t).match(/^\d+$/) ? +t : t;
    // В забивку помещается 40 символов (txt40 на сервере), а пожелание гостя бывает
    // длиннее. Режем по границе СЛОВА: «…и чтобы дыма» на плитке читается как обрывок,
    // а не как название. Полный текст заказа остаётся в ленте заказов и в статистике.
    const text = cutWords(o && o.text || "", 40);
    const body = { action: "add", n, ...(text ? { build: { heat: "", mix: [{ flavor: text }] } } : {}) };
    try {
      const d = await (await api("/api/table", { method: "POST", body: JSON.stringify(body) })).json();
      if (d.ok && d.tables) { tables = d.tables; saveTables(); renderGrid(true); }
      if (d.ok) { canUndo = !!d.canUndo; drawUndo(); flashConn("Стол " + t + " пошёл · таймер запущен"); }
      else flashConn(d.error || "не запустилось");
    } catch { flashConn("нет связи — стол не запущен"); }
    pollCalls();
    return;
  }
  const cancel = e.target.closest("[data-ordcancel]");
  if (cancel) {
    if (!confirm("Отменить заказ официанта?")) return;
    try { await api("/api/order/act", { method: "POST", body: JSON.stringify({ id: cancel.dataset.ordcancel, act: "cancel" }) }); } catch {}
    pollCalls();
  }
});

async function callAction(id, act) {
  try { await api("/api/" + act, { method: "POST", body: JSON.stringify({ id }) }); } catch {}
  pollCalls();
}

const KIND_ICO = { master: "🫖", coals: "🔥", other: "✍️" };
let spamArm = { id: "", until: 0 }; // «🚫 → Бан?» на 3 секунды

function renderCalls() {
  const bar = document.getElementById("callsBar");
  if (!callList.length) {
    if (bar.innerHTML) { bar.classList.add("hidden"); bar.innerHTML = ""; }
    renderGrid(); return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = callList.map((c) => {
    const arm = spamArm.id === c.id && Date.now() < spamArm.until;
    const nth = c.todayCount > 1 ? ` · ${c.todayCount}-й вызов за сутки` : "";
    return `
    <div class="call-chip${c.status === "acked" ? " acked" : ""}">
      <span class="c-ico">${esc(c.icon || KIND_ICO[c.kind] || "🔔")}</span>
      <div class="c-body">
        <div class="c-table">Стол ${c.table} <span class="c-age">· ${human(Date.now() - c.ts)} назад</span></div>
        <div class="c-kind">${c.kindLabel || ""}</div>
        ${c.comment ? `<div class="c-comment">«${esc(c.comment)}»</div>` : ""}
        <div class="c-dev">📱 ${esc(c.dev || "устройство")}${nth}</div>
      </div>
      <button class="btn spam-btn${arm ? " arm" : ""}" data-spam="${c.id}">${arm ? "Бан?" : ico("ban")}</button>
      ${c.status === "new"
        ? `<button class="btn go" data-call="ack" data-id="${c.id}">Принял</button>`
        : `<button class="btn serve" data-call="done" data-id="${c.id}">${ics("check")} Сделано</button>`}
    </div>`;
  }).join("");
  renderGrid();
}
const esc = (s) => String(s).replace(/[<>&"']/g, (ch) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[ch]));

/* ===== Плитки столов ===== */
const calledTables = () => new Set(callList.map((c) => c.table));

function hookahsOf(n) {
  const t = tables[n];
  if (!t) return [];
  if (Array.isArray(t.hookahs)) return t.hookahs;
  return [{ id: "h1", startedAt: t.startedAt, round: t.round, roundStart: t.roundStart }]; // старый формат
}
const overdue = (h) => (Date.now() - h.roundStart) / 1000 >= targetSec(h);
const isTapArmed = (n, hid) => tapArm.key === String(n) + "|" + (hid || "") && Date.now() < tapArm.until;

/* Одна шкала состояния на весь пульт: и плитка, и кольцо, и цифры берут из неё цвет. */
function stateOf(h) {
  const f = (Date.now() - h.roundStart) / 1000 / targetSec(h);
  if (f >= 1) return "over";      // просрочен — красный
  if (f >= 0.85) return "now";    // вот-вот — оранжевый
  if (f >= 0.5) return "soon";    // половина прошла — янтарный
  return "calm";                  // только подали — мятный
}
const RANK = { calm: 0, soon: 1, now: 2, over: 3 };

/* Круг задаёт цвет плитки и подпись:
   1 — греем и раскуриваем (оранжевый), 2 — одна замена (зелёный),
   3 — вторая замена (синий), 4 — третья замена (красный), 5 и дальше — последний круг. */
const roundClass = (round) => "rd" + Math.min(Math.max(round, 1), 5);
const ROUND_TEXT = {
  1: "греем и раскуриваем",
  2: "была одна замена",
  3: "вторая замена",
  4: "третья замена",
  5: "последний круг",
};
const roundText = (round) => ROUND_TEXT[Math.min(Math.max(round, 1), 5)];
const worstOf = (list) => list.reduce((a, h) => h.roundStart < a.roundStart ? h : a, list[0]);
/* цвет стола в целом — по самому большому кругу: «синий стол» = где-то уже вторая замена */
const maxRound = (list) => list.reduce((a, h) => Math.max(a, h.round), 1);
const tableState = (list) => list.reduce((a, h) => RANK[stateOf(h)] > RANK[a] ? stateOf(h) : a, "calm");

/* Кольца: текущий круг заполняется по окружности, пройденные круги — тонкими кольцами внутри.
   Композиция горизонтальная: кольцо слева, время справа — цифры не лезут на дугу. */
const RING_R = [56, 48, 40, 32, 24];        // снаружи внутрь: внешнее — текущий круг
const CIRC = (r) => 2 * Math.PI * r;

function dialHTML(n, h, big) {
  const target = targetSec(h);
  const el = (Date.now() - h.roundStart) / 1000;
  const frac = Math.min(1, Math.max(0, el / target));
  const over = el >= target;
  const done = Math.min(h.round - 1, RING_R.length - 1);   // сколько пройденных колец рисуем
  const cOuter = CIRC(RING_R[0]);
  let inner = "";
  for (let i = 1; i <= done; i++)
    inner += `<circle class="ring-done" cx="65" cy="65" r="${RING_R[i]}"></circle>`;
  return `<div class="dial st-${stateOf(h)}${big ? " big" : ""}${over ? " over" : ""}${isFinal(h) ? " fin" : ""}${isTapArmed(n, h.id) ? " armtap" : ""}" data-tap="${n}" data-hid="${h.id}">
    <svg viewBox="0 0 130 130" aria-hidden="true">
      <circle class="ring-bg" cx="65" cy="65" r="${RING_R[0]}"></circle>
      ${inner}
      <circle class="ring-fg" cx="65" cy="65" r="${RING_R[0]}"
        stroke-dasharray="${cOuter.toFixed(1)}"
        stroke-dashoffset="${(cOuter * (1 - frac)).toFixed(1)}"></circle>
    </svg>
    <span class="dial-round">${isFinal(h) ? "Ф" : h.round}</span>
    <span class="dial-t">${mmss(target - el)}</span>
  </div>`;
}

/* ===== Конструктор забивки =====
   Кальянщик отмечает, ЧТО он сделал: фольга или калауд, какой вкус, и когда
   кальян прогрелся и ушёл гостю. Таймеры и круги от этого пока не меняются —
   сначала копим данные, потом из них выведем настоящий норматив прогрева. */
const HEAT_ICO = { foil: ics("foil"), kaloud: ics("kaloud") };
const HEAT_TXT = { foil: "фольга", kaloud: "калауд" };
function buildChip(n, h, short) {
  const b = h.build || {};
  // в узкой записи multi-стола помещается только значок способа — вкус читается в статистике
  // место в плитке дорогое: если вкус вписан, способ показываем значком, а не словом
  const parts = (b.mix && b.mix.length) || 0;   // сколько табаков в чаше
  const one = b.flavor ? esc(b.flavor) + (b.brand ? ` <span class="fl-br">${esc(b.brand)}</span>` : "") : "";
  const txt = short
    ? (b.heat ? HEAT_ICO[b.heat] : "") + (parts > 1 ? " ×" + parts : "")
    : b.flavor
      ? (b.heat ? HEAT_ICO[b.heat] + " " : "") + (parts > 1 ? esc(b.flavor) : one)
      : (b.heat ? HEAT_ICO[b.heat] + " " + HEAT_TXT[b.heat] : "");
  return `<button class="bd-chip${txt ? "" : " empty"}" data-build="${n}" data-hid="${h.id}"
    title="забивка: чем греем и какой вкус">${txt || (short ? "＋" : "＋ забивка")}</button>`;
}
/* следующий шаг — одной кнопкой, лишнего выбора на планшете нет */
function stageBtn(n, h, short) {
  if (h.served) return "";
  const next = h.ready ? "served" : "ready";
  // подписи короткие намеренно: в плитку стола на телефоне длинные не влезают
  const txt = next === "ready" ? (short ? "прогрет" : ics("check") + " прогрет") : (short ? "отдал" : ics("check") + " отдал");
  return `<button class="bd-stage s-${next}" data-stage="${next}" data-sn="${n}" data-hid="${h.id}">${txt}</button>`;
}
/* Строка забивки УБРАНА С ПЛИТКИ (05.08, просьба Андрея): на 40 столах плитка
   должна отвечать на один вопрос — «когда идти», всё остальное её замусоривает.
   Забивка, этапы и разбор по кальянам живут в окне «i». */
function heatTime(h) {
  return h.ready ? `прогрев ${mmss((h.ready - h.startedAt) / 1000)}` : "";
}

/* Одна подпись на все три места, где она рисуется (сетка, тик цифр, тик колец):
   разъезжались формулировки — «ещё раз — новый круг» на финальном круге врало. */
const isConfirm = (n, h) => isTapArmed(n, h.id) && isFinal(h);   // «Нажмите ещё раз, чтобы закрыть»
function stateLabel(n, h, over) {
  if (isTapArmed(n, h.id))
    return isFinal(h) ? '<b class="lb-fin">Нажмите ещё раз, чтобы закрыть</b>'
      : ics("tap") + " ещё раз — новый круг";
  if (over) return overdueLabel(h);
  if (isFinal(h)) return '<b class="lb-fin">Финальный круг</b> · ' + smokedText(h);
  return smokeLabel(h);
}

function tileHTML(n) {
  const custom = /^c/.test(n);
  const title = custom ? esc((tables[n] && tables[n].label) || "стол") : n;
  const list = hookahsOf(n);
  const called = !custom && calledTables().has(n);
  if (!list.length) {
    if (custom) return "";                       // закрыли временный стол — его больше нет
    const arm2 = isTapArmed(n);
    return `<article class="tile idle${called ? " called" : ""}${arm2 ? " armtap" : ""}" data-table="${n}">
      <div class="tl-num">${n}${called ? " " + ics("bell") : ""}</div>
      <div class="tl-state">${arm2 ? ics("tap") + " ещё раз — запустить" : "свободен"}</div>
    </article>`;
  }
  const anyOver = list.some(overdue);
  const stLabel = (h, over) => stateLabel(n, h, over);
  const simple = !!settings.simple;
  const rings = !simple && settings.view === "rings";
  const st = tableState(list);

  const head = `
    <div class="tl-head">
      <div class="tl-num${custom ? " custom" : ""}">${title}${called ? " " + ics("bell") : ""}${simple && list.length > 1 ? ` <span class="tl-multi">×${list.length}</span>` : ""}</div>
      <div class="tl-tools">
        <button class="tl-i" data-info="${n}" title="что забито, этапы, кальяны стола">${ico("info")}</button>
        ${simple ? "" : `<button class="tl-add" data-add="${n}" title="ещё кальян">+</button>`}
        <button class="tl-x" data-clear="${n}" title="закрыть стол">${ico("x")}</button>
      </div>
    </div>`;

  if (simple) {                                  // как в самой первой версии: один таймер на стол
    const h = worstOf(list);
    const target = targetSec(h);
    const el = (Date.now() - h.roundStart) / 1000;
    const pct = Math.min(100, Math.max(0, (el / target) * 100));
    const one = list.length === 1 && beta.build;
    return `<article class="tile active ${roundClass(maxRound(list))} st-${st}${one ? " has-bd" : ""}${anyOver ? " alarm" : ""}${called ? " called" : ""}" data-table="${n}">
      ${head}
      <div class="tl-timer${anyOver ? " over" : ""}${isFinal(h) ? " fin" : ""}${isTapArmed(n, h.id) ? " armtap" : ""}" data-tap="${n}" data-hid="${h.id}">${fmtLeft(target - el)}</div>
      <div class="tl-state${isConfirm(n, h) ? " confirm" : ""}">${stLabel(h, anyOver)}</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
    </article>`;
  }

  if (list.length === 1) {
    const h = list[0];
    const target = targetSec(h);
    const el = (Date.now() - h.roundStart) / 1000;
    const pct = Math.min(100, Math.max(0, (el / target) * 100));
    const body = rings
      ? (isConfirm(n, h)
        ? `<div class="ask-box" data-tap="${n}" data-hid="${h.id}"><span class="hk-ask">Нажмите ещё раз, чтобы закрыть</span></div>`
        : dialHTML(n, h, true) + `<div class="tl-state">${stLabel(h, anyOver)}</div>`)
      : `<div class="tl-timer${anyOver ? " over" : ""}${isFinal(h) ? " fin" : ""}${isTapArmed(n, h.id) ? " armtap" : ""}" data-tap="${n}" data-hid="${h.id}">${fmtLeft(target - el)}</div>
         <div class="tl-state${isConfirm(n, h) ? " confirm" : ""}">${stLabel(h, anyOver)}</div>
         <div class="progress"><i style="width:${pct}%"></i></div>`;
    return `<article class="tile active ${roundClass(maxRound(list))} st-${st}${beta.build ? " has-bd" : ""}${rings ? " dialed" : ""}${anyOver ? " alarm" : ""}${called ? " called" : ""}" data-table="${n}">${head}${body}</article>`;
  }

  const rows = list.map((h, i) => {
    if (rings) return `<div class="hk-cell ${roundClass(h.round)} st-${stateOf(h)}${isFinal(h) ? " fin" : ""}${isTapArmed(n, h.id) ? " armtap" : ""}">
        <span class="hk-n">${i + 1}</span>
        ${isTapArmed(n, h.id)
          ? `<div class="ask-box" data-tap="${n}" data-hid="${h.id}"><span class="hk-ask">${
              isFinal(h) ? "Нажмите ещё раз, чтобы закрыть" : "Ещё раз — новый круг"}</span></div>`
          : dialHTML(n, h, false)}
        <button class="hk-x" data-remove="${n}" data-hid="${h.id}" title="убрать кальян">${ico("x")}</button>
      </div>`;
    const target = targetSec(h);
    const el = (Date.now() - h.roundStart) / 1000;
    const over = el >= target;
    // multi-плитка вдвое шире обычной, поэтому «курят N мин» помещается в ту же
    // строку. Без него на столе с двумя кальянами было видно только время круга,
    // а сколько гость уже курит — нигде.
    const fin = isFinal(h);
    const armed = isTapArmed(n, h.id);
    /* Взведённая строка отдаёт всё место вопросу: время в эти три секунды не
       нужно, а «ещё ра…» многоточием не говорит главного — ЧТО сейчас будет. */
    const body = armed
      ? `<span class="hk-ask">${fin ? "Нажмите ещё раз, чтобы закрыть" : "Ещё раз — новый круг"}</span>`
      : `<span class="hk-t"><span class="hk-time">${fmtShort(target - el)}</span><span class="hk-sep">/</span><span class="hk-round">${fin ? "Ф" : h.round}</span></span>
        <span class="hk-sm">${smokedShort(h)}</span>`;
    return `<div class="hk ${roundClass(h.round)} st-${stateOf(h)}${over ? " over" : ""}${fin ? " fin" : ""}${armed ? " armtap" : ""}" data-tap="${n}" data-hid="${h.id}">
        <span class="hk-n">${i + 1}</span>
        ${body}
        <button class="hk-x" data-remove="${n}" data-hid="${h.id}" title="убрать кальян">${ico("x")}</button>
      </div>`;
  }).join("");
  return `<article class="tile active multi ${roundClass(maxRound(list))} hk${Math.min(list.length, 6)} st-${st}${rings ? " dialed" : ""}${anyOver ? " alarm" : ""}${called ? " called" : ""}" data-table="${n}">
    ${head}
    <div class="hk-list">${rows}</div>
  </article>`;
}

document.body.classList.toggle("whitenum", !!settings.whiteNum);

const grid = document.getElementById("grid");

/* подобрать сетку так, чтобы все столы влезли в экран без прокрутки */
let gridShape = "";
function layoutGrid() {
  // телефон: втиснуть 20 столов в один экран невозможно — там сетка со скроллом из CSS
  if (window.innerWidth <= 560) {
    if (gridShape !== "phone") {
      gridShape = "phone";
      grid.style.gridTemplateColumns = "";
      grid.style.gridTemplateRows = "";
    }
    return;
  }
  const wide = Object.values(tables).filter((t) => t && (t.hookahs || []).length > 1).length;
  const n = cfg.tables + customKeys().length + 1 + wide;   // multi-плитки шире — им нужна лишняя ячейка
  const w = grid.clientWidth || innerWidth;
  const h = grid.clientHeight || innerHeight - 70;
  /* Плитка НЕ меньше этого — на 40 столах попытка втиснуть весь зал в экран
     давала строку 88px: таймер сжимался в ноль, цифры лезли на подпись, а
     ⇄/✕/+ уезжали за край. Решение Андрея: пусть лучше сетка прокручивается.
     Ширина ≥180 нужна ещё и затем, чтобы три кнопки остались по 44px. */
  const MIN_W = 200, MIN_H = 128;
  const cols = Math.max(2, Math.min(n, Math.floor((w + 8) / (MIN_W + 8))));
  const rows = Math.ceil(n / cols);
  const shape = "d" + cols + "x" + rows + "w" + wide;
  if (shape !== gridShape) {
    gridShape = shape;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    // minmax: влезает — растягиваем на весь экран, не влезает — прокрутка
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(${MIN_H}px, 1fr))`;
  }
  // Плотная сетка: плитка ниже 180px — убираем полоску прогресса и жмём
  // подпись в одну строку, место освобождается ровно под забивку.
  setDense(Math.max(MIN_H, (h - 8 * (rows - 1)) / rows) < 180);
}
function setDense(on) {
  if (setDense.was === on) return;                 // класс на body — трогаем только при смене
  setDense.was = on;
  document.body.classList.toggle("dense", on);
}
window.addEventListener("resize", () => { layoutGrid(); });

/* Подпись КАЖДОГО стола отдельно (какие кальяны, круги, забивка, вызовы).
   Раньше это была одна строка на весь зал, и любое изменение на одном столе
   заставляло пересобирать сетку целиком. */
function tileSignatures() {
  const out = {};
  for (const n of Array.from({ length: cfg.tables }, (_, i) => i + 1).concat(customKeys())) {
    const l = hookahsOf(n);
    // забивка и этапы входят в подпись: отметку с другого устройства пульт подхватит сам
    const bsig = (h) => (h.build ? (h.build.heat || "") + (h.build.flavor || "") : "") + (h.ready ? "R" : "") + (h.served ? "S" : "");
    out[n] = (settings.simple && l.length ? "s" + worstOf(l).id : "") + l.map((h) => h.id + "-" + h.round + bsig(h)).join(",") +
      (calledTables().has(n) ? "!" : "") +
      (tapArm.key.split("|")[0] === String(n) && Date.now() < tapArm.until ? "^" : "");
  }
  return out;
}
let lastSigs = {};

const customKeys = () => Object.keys(tables).filter((k) => /^c/.test(k));
const tkey = (raw) => (/^c/.test(raw) ? raw : +raw);

/* каждая плитка рисуется отдельно: сбой одной не должен уносить весь зал */
function safeTile(key) {
  try { return tileHTML(key); }
  catch (e) {
    console.error("[плитка]", key, e);
    return `<article class="tile idle" data-table="${key}">
      <div class="tl-num">${typeof key === "number" ? key : ""}</div>
      <div class="tl-state">ошибка отображения</div></article>`;
  }
}

/* Сетка обновляется ПОШТУЧНО: меняем только те плитки, чья подпись изменилась.
   Полная подстановка innerHTML сбрасывала прокрутку — на iOS с инерционным
   скроллом зал подбрасывало наверх при каждом изменении на любом столе.
   Целиком пересобираем только когда меняется НАБОР столов (добавили свой,
   поменяли их число в настройках). */
/* ===== Пока палец на экране — сетку не трогаем =====
   Замена плитки (outerHTML) и перестановка через `order` выдёргивают узел
   из-под пальца: на iOS тап после этого не доезжает вообще. Держим паузу
   от касания и ещё полсекунды после — за это время человек успевает дожать. */
let gridHold = 0;
const holdGrid = (ms) => { gridHold = Math.max(gridHold, Date.now() + ms); };
const gridBusy = () => Date.now() < gridHold;
for (const ev of ["pointerdown", "touchstart"]) grid.addEventListener(ev, () => holdGrid(1200), { passive: true });
for (const ev of ["pointerup", "touchend", "touchcancel"]) grid.addEventListener(ev, () => holdGrid(500), { passive: true });

function renderGrid(force) {
  layoutGrid();
  // палец на экране — только цифры, структуру не трогаем
  if (gridBusy() && !force && grid.children.length) { updateTimers(); paintClearArm(); return; }
  const sigs = tileSignatures();
  const keys = Object.keys(sigs);
  const prev = Object.keys(lastSigs);
  const setChanged = keys.length !== prev.length || keys.some((k) => !(k in lastSigs));

  if (setChanged || !grid.children.length) {
    const n = +cfg.tables > 0 ? +cfg.tables : 25;           // подстраховка, если настройки не доехали
    grid.innerHTML = Array.from({ length: n }, (_, i) => safeTile(i + 1)).join("")
      + customKeys().map(safeTile).join("")
      + `<article class="tile addtile" data-newtable="1"><div class="add-plus">＋</div><div class="tl-state">свой стол</div></article>`;
    lastSigs = sigs;
    markFreshTiles();
    applyOrder(true);
    return;
  }

  const keepScroll = grid.scrollTop;
  let changed = 0;
  for (const k of keys) {
    if (!force && sigs[k] === lastSigs[k]) continue;
    const el = grid.querySelector('.tile[data-table="' + k + '"]');
    if (!el) continue;
    el.outerHTML = safeTile(tkey(k));                       // заменяем ОДНУ плитку, контейнер не трогаем
    changed++;
  }
  lastSigs = sigs;
  // Страховка: если прокрутка всё-таки уехала, вернуть и СКАЗАТЬ об этом в консоль —
  // на iOS этот сброс воспроизводится, а в Chromium нет, вслепую его не поймать.
  if (changed && Math.abs(grid.scrollTop - keepScroll) > 1) {
    console.log("[scroll] сброс при замене плиток:", keepScroll, "→", grid.scrollTop, "· заменено:", changed);
    grid.scrollTop = keepScroll;
    requestAnimationFrame(() => { if (Math.abs(grid.scrollTop - keepScroll) > 1) grid.scrollTop = keepScroll; });
  }
  if (changed) markFreshTiles(); else updateTimers();       // ничего не переставили — просто цифры
  paintClearArm();
  applyOrder(changed > 0);                                 // плитки заменяли — расстановку вернуть
}

/* «✕ → Точно?» перерисовываем ТОЧЕЧНО.
   ⚠️ Раньше взвод входил в подпись плитки: первый тап пересоздавал плитку целиком,
   и второй тап на iPad уходил в узел, которого уже нет — крестик «не работал»
   тем чаще, чем больше кальянов в зале (плитки пересоздавались чаще).
   На мыши этого не видно: клик доезжает синхронно. */
function paintClearArm() {
  const on = Date.now() < clearArm.until ? String(clearArm.n) : "";
  for (const b of grid.querySelectorAll(".tl-x")) {
    const armed = b.dataset.clear === on;
    if (b.classList.contains("arm") === armed) continue;
    b.classList.toggle("arm", armed);
    b.innerHTML = armed ? "Точно?" : ico("x");
  }
}

/* ===== Порядок плиток: логистика смены =====
   Зал на 40 столов не читается «по номерам»: мастеру нужен ответ на вопрос
   «к какому столу идти СЕЙЧАС, а к какому следующим». Поэтому занятые столы
   поднимаются наверх и сортируются по остатку времени, свободные уходят вниз
   своим обычным порядком.

   Делаем это CSS-свойством `order`, а НЕ перестановкой узлов: DOM остаётся
   на месте, поэтому поштучная замена плиток (tileSignatures) и прокрутка
   продолжают работать, а браузер не теряет нажатие под пальцем.
   `order` принимает отрицательные значения — просроченные столы уходят выше
   всех сами собой, чем больше просрочка, тем выше. */
/* ===== История сообщений за смену =====
   Лента над столами показывает только НЕразобранное — это правильно, но вопрос
   «а что мне писали час назад» возникает каждую смену. Здесь всё за 14 часов,
   включая принятое и собственные записки, и отсюда же можно ответить. */
const HIST_ICO = { move: "⇄", msg: "✉️", reply: "↩︎" };
const HIST_KIND = { move: "перенос стола", msg: "записка", reply: "ответ" };
let histList = [];
async function openHistory() {
  $("histBody").innerHTML = `<p class="hint">Загружаю…</p>`;
  $("histBox").classList.remove("hidden");
  try {
    const d = await (await api("/api/events", { cache: "no-store" })).json();
    histList = d.ok ? d.events || [] : [];
  } catch { histList = []; $("histBody").innerHTML = `<p class="hint">Нет связи с сервером.</p>`; return; }
  drawHistory();
}
function drawHistory() {
  if (!histList.length) {
    $("histBody").innerHTML = `<p class="hint">За эту смену сообщений не было.</p>`;
    return;
  }
  $("histBody").innerHTML = histList.map((e) => `
    <div class="hist-row${evDone.has(e.id) ? " done" : ""}">
      <div class="h-top">
        <span class="h-ico">${HIST_ICO[e.kind] || "•"}</span>
        <b>${esc(e.who)}</b>
        <span class="h-kind">${HIST_KIND[e.kind] || e.kind}${e.mine ? " · вы" : ""}${
          e.toName ? " → " + esc(e.toName) : ""}</span>
        <span class="h-age">${human(Date.now() - e.ts)} назад</span>
      </div>
      <p class="h-txt">${esc(e.text)}</p>
      ${e.about ? `<p class="h-about">на «${esc(e.about)}»</p>` : ""}
      ${e.kind === "msg" && !e.mine
        ? `<button class="btn" data-histrp="${e.id}">Ответить</button>` : ""}
    </div>`).join("");
}
$("histBtn").addEventListener("click", openHistory);
$("histClose").addEventListener("click", () => $("histBox").classList.add("hidden"));
$("histBox").addEventListener("click", (e) => {
  if (e.target === $("histBox")) { $("histBox").classList.add("hidden"); return; }
  const b = e.target.closest("[data-histrp]");
  if (!b) return;
  const ev = histList.find((x) => x.id === b.dataset.histrp);
  $("histBox").classList.add("hidden");
  openReply(b.dataset.histrp, ev);
});
/* на кнопке — сколько сообщений ещё не разобрано */
function drawHistBadge() {
  const n = evShown.filter((e) => !evAck[e.id]).length;   // принятые внимания не требуют
  const el = $("histBadge");
  el.textContent = n > 9 ? "9+" : n;
  el.classList.toggle("hidden", !n);
}

/* обрезка по границе слова: последнее слово не рвём, вместо него многоточие */
function cutWords(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[,\s]+$/, "") + "…";
}

/* ⚠️ Запас считан от максимума: круг админ вправе выставить до 90 минут
   (`ROUND_MAX` на сервере) = 5400 с, а order = left*100 → до 540000.
   При прежних 500000 занятый стол с длинным кругом уезжал НИЖЕ свободных. */
const ORD_FREE = 1000000;      // свободные — после всех занятых
const ORD_LAST = 2000000;      // «свой стол» всегда в самом конце
/* ⚠️ ПОЧЕМУ ЗДЕСЬ НЕТ КВАНТОВАНИЯ.
   Остаток у всех идущих кальянов уменьшается с ОДИНАКОВОЙ скоростью, значит
   разница между двумя столами постоянна — порядок по остатку не может измениться
   сам по себе, только от действия человека (запустили, закрыли, отбили круг).
   Квантование по 15 с (было 06.08) эту устойчивость ЛОМАЛО: внутри кванта столы
   вставали по номеру, то есть неправильно, а расходясь по разным квантам резко
   прыгали в правильный порядок — «спустя время таймеры опять скачут».
   Номер стола участвует только как разрыв ТОЧНОГО равенства и умножен так,
   что перебить реальную разницу в секунду не может. */
function applyOrder(force) {
  // палец на экране — не переставляем… но если плитки только что пересобрали,
  // расстановку надо вернуть обязательно: иначе зал прыгает в порядок по номерам
  if (gridBusy() && !force) return;
  let firstFree = null, ffOrd = Infinity;
  for (const el of grid.children) {
    el.classList.remove("first-free");
    if (el.dataset.newtable) { el.style.order = ORD_LAST; continue; }
    const k = el.dataset.table;
    if (!k) { el.style.order = ORD_LAST; continue; }
    const list = hookahsOf(k);
    const seat = (Number(k) || 0) % 100;          // стабильный довесок внутри кванта
    if (!list.length) {
      const o = ORD_FREE + seat;
      el.style.order = o;
      if (o < ffOrd) { ffOrd = o; firstFree = el; }
      continue;
    }
    // берём САМЫЙ горящий кальян стола: на multi-столе решает он, а не средний.
    // Считаем именно остаток, а не «кто раньше начал» — у кругов разный норматив.
    const left = Math.min(...list.map((h) => targetSec(h) - (Date.now() - h.roundStart) / 1000));
    el.style.order = Math.round(left) * 100 + seat;
  }
  // телефон: свободные начинают СВОЙ ряд (CSS в media 560) — занятый стол
  // не должен делить строку со свободным, у них разная ширина и смысл
  if (firstFree) firstFree.classList.add("first-free");
}

/* Сторож прокрутки: замечает скачок, которого пользователь не делал, и называет
   виновника. Нужен только пока ловим iOS-специфичный сброс. */
(() => {
  let last = 0, touching = false;
  grid.addEventListener("touchstart", () => { touching = true; }, { passive: true });
  grid.addEventListener("touchend", () => { setTimeout(() => { touching = false; }, 400); }, { passive: true });
  grid.addEventListener("scroll", () => {
    const now = grid.scrollTop;
    if (!touching && now === 0 && last > 40)
      console.log("[scroll] УЕХАЛО В НОЛЬ без касания, было", last,
                  "· высота содержимого", grid.scrollHeight, "· видно", grid.clientHeight);
    last = now;
  }, { passive: true });
})();

/* Анимации появления и подтверждения вешаем ПОСЛЕ пересборки сетки.
   Через CSS этого сделать нельзя: innerHTML переписывается целиком, и любая
   правка на одном столе заставила бы мигнуть все активные плитки разом. */
let seenActive = new Set();          // столы, которые уже были активны на прошлой отрисовке
let stageFlash = null;               // стол, где только что отметили этап

/* Класс обязательно снимаем: у просроченного стола крутится бесконечный
   alarmPulse, а свойство animation на элементе одно — оставленный класс
   погасил бы пульсацию насовсем. */
function playOnce(tile, cls, ms) {
  tile.classList.add(cls);
  setTimeout(() => tile.classList.remove(cls), ms);
}

function markFreshTiles() {
  const now = new Set();
  for (const tile of grid.querySelectorAll(".tile.active")) {
    const key = String(tile.dataset.table);
    now.add(key);
    if (stageFlash !== null && key === String(stageFlash)) playOnce(tile, "stage-ok", 600);
    else if (!seenActive.has(key)) playOnce(tile, "is-new", 350);   // стол только что ожил
  }
  seenActive = now;
  stageFlash = null;
}

/* каждую секунду меняем только текст таймеров — DOM не пересобирается,
   поэтому нажатия пальцем больше не теряются */
/* Пишем в DOM только когда строка ДЕЙСТВИТЕЛЬНО изменилась.
   Подпись состояния меняется раз в минуту, а тик идёт раз в секунду — лишний
   перепарсинг innerHTML под пальцем сбивал прокрутку на iOS («обрезает столы
   и через секунду подкидывает наверх»). В Chromium это не воспроизводилось. */
function setLabel(el, html) {
  if (!el || el.dataset.lbl === html) return;
  el.dataset.lbl = html;
  el.innerHTML = html;
}

function updateTimers() {
  if (settings.simple || settings.view !== "rings") { updateTimersDigits(); return; }
  for (const el of grid.querySelectorAll(".dial[data-tap]")) {
    const n = tkey(el.dataset.tap);
    const h = hookahsOf(n).find((x) => x.id === el.dataset.hid);
    if (!h) continue;
    const target = targetSec(h);
    const left = target - (Date.now() - h.roundStart) / 1000;
    const over = left <= 0;
    const frac = Math.min(1, Math.max(0, 1 - left / target));
    const ring = el.querySelector(".ring-fg");
    if (ring) {                                   // двигаем только заполнение текущего кольца
      const c = parseFloat(ring.getAttribute("stroke-dasharray")) || 0;
      ring.setAttribute("stroke-dashoffset", (c * (1 - frac)).toFixed(1));
    }
    const t = el.querySelector(".dial-t");
    if (t) t.textContent = mmss(left);
    el.classList.toggle("over", over);
    setState(el, stateOf(h));
    const cell = el.closest(".hk-cell");
    if (cell) setState(cell, stateOf(h));
    const tile = el.closest(".tile");
    if (tile && !tile.classList.contains("multi")) {
      tile.classList.toggle("alarm", over);
      const stEl = tile.querySelector(".tl-state");
      if (stEl) stEl.classList.toggle("confirm", isConfirm(n, h));
      setLabel(stEl, stateLabel(n, h, over));
    }
  }
  paintTiles();
}

/* перекрасить плитки по худшему состоянию их кальянов */
function setState(el, st) {
  for (const k of ["calm", "soon", "now", "over"]) el.classList.toggle("st-" + k, k === st);
}
function paintTiles() {
  for (const tile of grid.querySelectorAll(".tile.active")) {
    const list = hookahsOf(tkey(tile.dataset.table));
    if (!list.length) continue;
    setState(tile, tableState(list));
    tile.classList.toggle("alarm", list.some(overdue));
  }
}

/* старый вид: крупные цифры и полоса прогресса */
function updateTimersDigits() {
  for (const el of grid.querySelectorAll("[data-tap]")) {
    const n = tkey(el.dataset.tap);
    const h = hookahsOf(n).find((x) => x.id === el.dataset.hid);
    if (!h) continue;
    const target = targetSec(h);
    const left = target - (Date.now() - h.roundStart) / 1000;
    const over = left <= 0;
    if (el.classList.contains("tl-timer")) {
      el.innerHTML = fmtLeft(left);
      el.classList.toggle("over", over);
      const tile = el.closest(".tile");
      tile.classList.toggle("alarm", over);
      const stEl = tile.querySelector(".tl-state");
      if (stEl) stEl.classList.toggle("confirm", isConfirm(n, h));
      setLabel(stEl, stateLabel(n, h, over));
      const bar = tile.querySelector(".progress > i");
      if (bar) bar.style.width = Math.min(100, Math.max(0, (1 - left / target) * 100)) + "%";
      setState(tile, stateOf(h));
    } else {
      const t = el.querySelector(".hk-time") || el.querySelector(".hk-t");
      if (t) t.textContent = fmtShort(left);      // трогаем только цифры времени, круг остаётся
      el.classList.toggle("over", over);
      setState(el, stateOf(h));
    }
  }
  paintTiles();
}

/* ===== Тики и сигналы таймеров ===== */
let prevAlarm = {};
let saidNag = {};                       // по каким кальянам уже сказали «злостную» просрочку
const NAG_MS = 15 * 60 * 1000;          // столько ждём после просрочки, прежде чем ругаться
function tick() {
  for (const n of Object.keys(tables))
    for (const h of hookahsOf(n)) {
      const key = n + ":" + h.id;
      const isAlarm = overdue(h);
      const t = voiceTable(n);
      if (isAlarm && !prevAlarm[key]) {
        if (!(t && say(t + "_overdue"))) beep();   // голос выключен или стол именованный — обычный писк
        buzz();
      }
      // к столу так и не подошли спустя 15 минут — сказать один раз, тоном жёстче
      if (isAlarm && !saidNag[key] && t
          && Date.now() - h.roundStart >= targetSec(h) * 1000 + NAG_MS) {
        saidNag[key] = true;
        say(t + "_overdue3");
      }
      if (!isAlarm && saidNag[key]) delete saidNag[key];
      prevAlarm[key] = isAlarm;
    }
  renderGrid();
  drawOffscreen();
  renderEvents();
  if (infoN != null) drawInfo();      // окно «i» открыто — там тоже тикает таймер
}

/* ===== Просроченный стол вне экрана =====
   Плата за прокручиваемую сетку: красная плитка может оказаться ниже сгиба, и
   кальянщик её просто не увидит. Показываем внизу подсказку со стрелкой в ту
   сторону, где горит; тап — прокрутить к первому такому столу. */
function offscreenOverdue() {
  const box = grid.getBoundingClientRect();
  const above = [], below = [];
  for (const n of Object.keys(tables)) {
    if (!hookahsOf(n).some(overdue)) continue;
    const el = grid.querySelector('.tile[data-table="' + n + '"]');
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < box.top + 4) above.push(n);
    else if (r.top > box.bottom - 4) below.push(n);
  }
  return { above, below };
}
function drawOffscreen() {
  const el = document.getElementById("offscreen");
  if (!el) return;
  const { above, below } = offscreenOverdue();
  const n = above.length + below.length;
  if (!n) { el.classList.add("hidden"); return; }
  // если горит и сверху, и снизу — ведём к ближайшему снизу: туда чаще всего и прокручивают
  const to = below[0] != null ? below[0] : above[0];
  const dir = below[0] != null ? "↓" : "↑";
  el.dataset.to = to;
  el.textContent = `${dir} ${n === 1 ? "стол " + to + " — пора к столу" : n + " стола ждут"}`;
  el.classList.remove("hidden");
}
document.getElementById("offscreen").addEventListener("click", (e) => {
  const el = grid.querySelector('.tile[data-table="' + e.currentTarget.dataset.to + '"]');
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
});
grid.addEventListener("scroll", drawOffscreen, { passive: true });

/* ===== Действия ===== */
function onTap(e) {
  const sb = e.target.closest("[data-spam]");
  if (sb) {
    e.stopPropagation();
    const id = sb.dataset.spam;
    if (spamArm.id === id && Date.now() < spamArm.until) {   // второй тап — бан на сутки
      spamArm = { id: "", until: 0 };
      callAction(id, "spam");
    } else {
      spamArm = { id, until: Date.now() + 3000 };            // первый тап — «Бан?»
      renderCalls();
      setTimeout(renderCalls, 3200);
    }
    return;
  }
  const cb = e.target.closest("[data-call]");
  if (cb) { e.stopPropagation(); callAction(cb.dataset.id, cb.dataset.call); return; }

  const x = e.target.closest("[data-clear]");
  if (x) {
    e.stopPropagation();
    haptic();                                   // короткий отклик в приложении (в браузере — тишина)
    confirmClear(tkey(x.dataset.clear));
    return;
  }

  const nt = e.target.closest("[data-newtable]");
  if (nt) { e.stopPropagation(); $("newTable").classList.remove("hidden"); $("ntName").focus(); return; }

  const mv = e.target.closest("[data-move]");
  if (mv) { e.stopPropagation(); openMove(tkey(mv.dataset.move)); return; }

  const add = e.target.closest("[data-add]");
  if (add) {
    e.stopPropagation();
    const n = tkey(add.dataset.add);
    if (beta.build) openBuild(n, "add"); else tableAction("add", n);
    return;
  }

  const inf = e.target.closest("[data-info]");          // «i» — разбор стола по кальянам
  if (inf) { e.stopPropagation(); openInfo(tkey(inf.dataset.info)); return; }

  const bd = e.target.closest("[data-build]");          // чип забивки — записать или поправить
  // окно забивки открываем ПОВЕРХ, а «i» закрываем: два окна друг на друге путают
  if (bd) { e.stopPropagation(); closeInfo(); openBuild(tkey(bd.dataset.build), "edit", bd.dataset.hid); return; }

  const stg = e.target.closest("[data-stage]");         // «прогрелся» / «отдал гостю»
  if (stg) {
    e.stopPropagation();
    // помечаем стол ДО запроса: ответ придёт с пересборкой сетки, и подтверждение
    // сядет уже на новую плитку — старую к тому моменту выкинет
    stageFlash = tkey(stg.dataset.sn);
    tableAction("stage", tkey(stg.dataset.sn), stg.dataset.hid, { stage: stg.dataset.stage });
    flashConn(stg.dataset.stage === "ready" ? "✓ прогрелся" : "✓ отдал гостю");
    return;
  }

  const rm = e.target.closest("[data-remove]");
  if (rm) { e.stopPropagation(); tableAction("removeHookah", tkey(rm.dataset.remove), rm.dataset.hid); return; }

  const tapEl = e.target.closest("[data-tap]");           // конкретный кальян
  if (tapEl) {
    e.stopPropagation();
    armedTap(tkey(tapEl.dataset.tap), tapEl.dataset.hid);
    return;
  }

  const tile = e.target.closest(".tile[data-table]");     // тап по свободному столу — ставим кальян
  if (tile) {
    const n = tkey(tile.dataset.table);
    // свободный стол открывает конструктор: сама модалка и есть защита от
    // случайного касания, второй тап тут уже не нужен
    if (beta.build && !hookahsOf(n).length) openBuild(n, "add");
    else armedTap(n);
  }
}

/* Запуск и новый круг — только двойным тапом: первый «взводит» стол (жёлтая
   подсветка и подсказка), второй в течение 2,5 с выполняет. Случайное касание
   при прокрутке экрана больше ничего не включает.
   На ФИНАЛЬНОМ круге тем же двойным нажатием кальян завершается: механика та
   же, ждём чуть дольше (3 с) и говорим словами, что произойдёт. */
function armedTap(n, hid) {
  const list = hookahsOf(n);
  const h = (hid && list.find((x) => x.id === hid)) || list[0];
  const fin = isFinal(h);
  if (isTapArmed(n, hid)) {
    tapArm = { key: "", until: 0 };
    delete prevAlarm[n];
    if (fin) finishHookah(n, h);
    else tableAction("tap", n, hid);
    return;
  }
  const wait = fin ? ARM_FIN_MS : ARM_MS;
  tapArm = { key: String(n) + "|" + (hid || ""), until: Date.now() + wait };
  // первый тап уходит в хронику статистики: если второго не будет — видно, когда был взвод
  api("/api/table", { method: "POST", body: JSON.stringify({ action: "arm", n, hid }) }).catch(() => {});
  renderGrid(true);
  setTimeout(() => { if (Date.now() >= tapArm.until) renderGrid(true); }, wait + 100);
}

/* ===== Финальный круг: кальян завершён =====
   Завершается ИМЕННО тот кальян, по которому нажали. Остальные на столе живут
   дальше, а стол закрывается сам — когда завершили последний.
   К серверу идёт то, что человек видел на экране: посадка (sid) и ревизия
   стола. Если стол за эти секунды успели поменять с другого устройства —
   сервер закрытие не применит, а покажет свежее состояние. */
async function finishHookah(n, h) {
  if (!h) return;
  const t = tables[n] || {};
  const list = hookahsOf(n);
  const wasLast = list.length <= 1;
  const title = String(n).startsWith("c") ? "«" + (t.label || "стол") + "»" : "Стол " + n;
  const d = await tableAction("finish", n, h.id, {
    expectedSid: t.sid || "",
    expectedRevision: typeof t.rev === "number" ? t.rev : null,
  });
  if (!d || !d.ok || d.repeated) return;          // повтор того же запроса второй раз ничего не закрывает
  const closed = "closed" in d ? d.closed : wasLast;
  const left = typeof d.left === "number" ? d.left : Math.max(0, list.length - 1);
  offerUndo(closed ? title + " закрыт"
    : "Кальян завершён · " + title + (left ? " · ещё " + left + " в работе" : ""));
}

/* На части планшетов (особенно iPad в режиме приложения) pointerup до обработчика
   не доходит — слушаем touchend и click как запасные, но гасим эхо того же
   касания. Тап, в котором палец уехал (прокрутка), нажатием не считается. */
let downX = 0, downY = 0, lastPtr = 0, lastTouch = 0;
document.body.addEventListener("pointerdown", (e) => { downX = e.clientX; downY = e.clientY; }, true);
document.body.addEventListener("touchstart", (e) => {
  const t = e.touches && e.touches[0];
  if (t) { downX = t.clientX; downY = t.clientY; }
}, { capture: true, passive: true });
function scrolled(e) {
  const t = e.changedTouches && e.changedTouches[0];
  const x = t ? t.clientX : e.clientX, y = t ? t.clientY : e.clientY;
  return typeof x === "number" && Math.hypot(x - downX, y - downY) > 12;
}
document.body.addEventListener("pointerup", (e) => {
  lastPtr = Date.now();
  if (!scrolled(e)) onTap(e);
});
document.body.addEventListener("touchend", (e) => {
  if (Date.now() - lastPtr < 500) return;                 // эхо уже обработанного pointerup
  lastTouch = Date.now();
  if (!scrolled(e)) onTap(e);
}, { passive: true });
document.body.addEventListener("click", (e) => {
  if (Date.now() - lastPtr < 500 || Date.now() - lastTouch < 500) return;
  onTap(e);
});

/* ===== Индикатор связи ===== */
function updateConn() {
  const el = document.getElementById("connState");
  if (conn.ok) { el.textContent = "● онлайн"; el.className = "conn ok"; }
  else { el.textContent = "● " + (conn.error || "нет связи"); el.className = "conn bad"; }
  /* Точка в шапке была декоративной и всегда горела оранжевым. На телефоне
     подпись «онлайн» скрыта медиазапросом, поэтому статуса не было видно
     совсем. Теперь цвет точки и есть статус. */
  const dot = document.querySelector(".brand .dot");
  if (dot) {
    dot.classList.toggle("ok", conn.ok);
    dot.classList.toggle("bad", !conn.ok);
    dot.title = conn.ok ? "связь с сервером есть" : (conn.error || "нет связи");
  }
  drawOutbox();
}

/* ===== Настройки ===== */

/* ===== Окно «i»: разбор стола по кальянам =====
   Плитка отвечает только на «когда идти». Что забито, на каком этапе и сколько
   кальянов на столе — здесь, по одной карточке на КАЖДЫЙ кальян. Кнопки внутри
   те же самые (data-build / data-stage / data-remove), обработчик общий на body,
   поэтому дублировать логику не пришлось. */
let infoN = null;
/* ===== Закрытие стола: компактное подтверждение =====
   Крестик на плитке нужен для скорости, но само закрытие — необратимое действие:
   вместо взвода «Точно?» (его легко нажать дважды машинально) — маленький диалог
   с контекстом: какой стол, сколько уже курят, что посадка завершится. */
const haptic = () => {
  try {
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (H) H.impact({ style: "LIGHT" });
  } catch {}
};
let clearN = null;
function confirmClear(n) {
  const list = hookahsOf(n);
  if (!list.length) return;
  clearN = n;
  const custom = String(n).startsWith("c");
  const title = custom ? ((tables[n] && tables[n].label) || "свой стол") : "стол " + n;
  const w = worstOf(list);
  $("clearTitle").textContent = "Закрыть " + title + "?";
  $("clearHint").textContent = (list.length > 1
    ? list.length + " кальяна на столе, " + smokedText(w)
    : "Кальян " + smokedText(w)) + ". Текущая посадка будет завершена.";
  $("clearBox").classList.remove("hidden");
}
const closeClear = () => { clearN = null; $("clearBox").classList.add("hidden"); };
$("clearNo").addEventListener("click", closeClear);
$("clearBox").addEventListener("click", (e) => { if (e.target === $("clearBox")) closeClear(); });
$("clearYes").addEventListener("click", async () => {
  const n = clearN;
  if (n == null) return;
  closeClear();
  const t = tables[n] || {};
  const title = String(n).startsWith("c") ? "«" + (t.label || "стол") + "»" : "Стол " + n;
  // то же, что видел человек: посадка и ревизия. Стол успели поменять — сервер не закроет
  const guard = { expectedSid: t.sid || "", expectedRevision: typeof t.rev === "number" ? t.rev : null };
  delete tables[n]; delete prevAlarm[n];
  saveTables(); renderGrid(true);
  const d = await tableAction("clear", n, "", guard);
  if (d && d.ok && !d.repeated) offerUndo(title + " закрыт");
});

function openInfo(n) {
  infoN = n;
  drawInfo();
  $("infoBox").classList.remove("hidden");
}
const closeInfo = () => { infoN = null; $("infoBox").classList.add("hidden"); };
function drawInfo() {
  if (infoN == null) return;
  const list = hookahsOf(infoN);
  const t = tables[infoN];
  if (!list.length) { closeInfo(); return; }      // стол закрыли, пока окно открыто
  const custom = String(infoN).startsWith("c");
  $("infTitle").textContent = (custom ? (t && t.label) || "Свой стол" : "Стол " + infoN)
    + (list.length > 1 ? ` · ${list.length} кальяна` : "");
  $("infBody").innerHTML = list.map((h, i) => {
    const target = targetSec(h);
    const left = target - (Date.now() - h.roundStart) / 1000;
    const over = left <= 0;
    const b = h.build || {};
    const flavor = b.mix && b.mix.length > 1 ? b.flavor : [b.brand, b.flavor].filter(Boolean).join(" ");
    // HEAT_ICO — это готовая SVG-разметка, через esc() она напечаталась бы текстом
    const heat = b.heat ? HEAT_ICO[b.heat] + " " + esc(HEAT_TXT[b.heat]) : "";
    return `
    <div class="inf-row${over ? " over" : ""}">
      <div class="inf-head">
        <b>Кальян ${i + 1}${list.length > 1 ? " из " + list.length : ""}</b>
        <span class="inf-clock${over ? " over" : ""}">${mmss(left)}</span>
      </div>
      <div class="inf-meta">круг ${h.round} · ${esc(smokedText(h))}</div>
      <div class="inf-meta">${heat ? heat + " · " : ""}${flavor ? esc(flavor) : "забивка не записана"}${
        b.mix && b.mix.length > 1 ? ` · ${b.mix.length} табака` : ""}</div>
      <div class="inf-acts">
        ${beta.build ? `<button class="btn" data-build="${infoN}" data-hid="${h.id}">${
          flavor || heat ? ics("pencil") + " правка забивки" : "＋ забивка"}</button>` : ""}
        ${list.length > 1 ? `<button class="btn danger" data-remove="${infoN}" data-hid="${h.id}">${ico("x")}</button>` : ""}
      </div>
    </div>`;
  }).join("");
}
$("infClose").addEventListener("click", closeInfo);
$("infoBox").addEventListener("click", (e) => { if (e.target === $("infoBox")) closeInfo(); });
$("infAdd").addEventListener("click", () => {
  const n = infoN;
  closeInfo();
  if (beta.build) openBuild(n, "add"); else tableAction("add", n, "");
});
/* ⇄ переехал сюда из шапки плитки: перенос — редкое действие уровня СТОЛА,
   а четыре кнопки в шапке не помещались на узкой плитке телефона (сжимались
   до 31px при норме 44). Три помещаются везде. */
$("infMove").addEventListener("click", () => {
  const n = infoN;
  closeInfo();
  openMove(n);
});
/* «Закрыть стол» переехал с плитки в это окно (просьба Андрея 19.08): закрытие —
   редкое действие с последствиями, ему не место в один тап на плитке. Двойное
   подтверждение осталось. */
$("infClear").addEventListener("click", () => {
  const n = infoN;
  closeInfo();
  confirmClear(n);                 // единый диалог подтверждения — как у крестика
});

/* ===== Круги: сколько их и по сколько минут =====
   Раньше было ровно три поля (1-й, 2-й, «3-й и дальше»). Теперь список: админ
   сам решает, сколько кругов у заведения. Последний круг действует и для всех
   следующих — гость может сидеть пятый час, придумывать ему восьмое число незачем. */
const ROUNDS_MAX = 8;
const roundList = () => (Array.isArray(settings.rs) && settings.rs.length
  ? settings.rs.slice() : [settings.r1, settings.r2, settings.r3]);
function rndDraw(rs) {
  $("setRounds").innerHTML = rs.map((v, i) => `
    <label class="field"><span>${i + 1}-й круг${i === rs.length - 1 && rs.length > 1 ? " · финальный" : ""}</span>
      <input type="number" min="3" max="90" step="1" value="${v}" /></label>`).join("");
  $("rndDel").disabled = rs.length <= 1;
  $("rndAdd").disabled = rs.length >= ROUNDS_MAX;
}
const rndNow = () => [...$("setRounds").querySelectorAll("input")].map((i) => +i.value || 15);
$("rndAdd").addEventListener("click", () => {
  const rs = rndNow();
  if (rs.length >= ROUNDS_MAX) return;
  rs.push(rs[rs.length - 1] || 15);        // новый круг наследует длительность предыдущего
  rndDraw(rs);
});
$("rndDel").addEventListener("click", () => {
  const rs = rndNow();
  if (rs.length <= 1) return;
  rs.pop();
  rndDraw(rs);
});

const settingsModal = $("settings");
$("settingsBtn").addEventListener("click", () => {
  rndDraw(roundList());
  $("setSound").checked = settings.sound; $("setVibrate").checked = settings.vibrate;
  $("setVoice").checked = !!settings.voice;
  $("setVoiceSet").value = VOICE_SETS.includes(settings.voiceSet) ? settings.voiceSet : "mix";
  $("setSimple").checked = !!settings.simple;
  $("setRings").checked = settings.view === "rings";
  $("setWhiteNum").checked = !!settings.whiteNum;
  settingsModal.classList.remove("hidden");
});
/* общий вид с сервера: применяем у себя, только если что-то реально поменялось —
   иначе фоновый опрос каждые 4 c дёргал бы перерисовку и терял нажатия */
function applyView(v) {
  if (!v) return;
  const view = v.view === "rings" ? "rings" : "digits";
  const rs = Array.isArray(v.rs) && v.rs.length ? v.rs : [v.r1, v.r2, v.r3].filter(Boolean);
  const roundsChanged = (settings.rs || []).join(",") !== rs.join(",");
  const changed = roundsChanged || settings.simple !== !!v.simple || settings.view !== view
    || settings.whiteNum !== !!v.whiteNum;
  if (!changed) return;
  settings.whiteNum = !!v.whiteNum;
  document.body.classList.toggle("whitenum", settings.whiteNum);
  settings.rs = rs;
  settings.r1 = rs[0]; settings.r2 = rs[1] || rs[0]; settings.r3 = rs[2] || rs[rs.length - 1];
  settings.service = settings.r1;
  settings.view = view; settings.simple = !!v.simple;
  saveSettings();                         // локальный кэш — чтобы офлайн стартовать с последним видом
  if (roundsChanged) prevAlarm = {};
  renderGrid(true);
}
function closeSettings() {
  const cl = (v, a, b, d) => { v = +v; return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  // личные настройки этого устройства
  settings.sound = $("setSound").checked; settings.vibrate = $("setVibrate").checked;
  const voiceWasOff = !settings.voice, setWas = settings.voiceSet;
  settings.voice = $("setVoice").checked;
  settings.voiceSet = $("setVoiceSet").value;
  saveSettings(); updateSoundBtn();
  // включили голос или сменили его — сразу дать послушать, как теперь звучит
  if (settings.voice && (voiceWasOff || setWas !== settings.voiceSet)) say("_test");
  settingsModal.classList.add("hidden");
  // общий вид — на сервер; оттуда прилетит всем устройствам (и этому — через applyView)
  const rs = [...$("setRounds").querySelectorAll("input")]
    .map((i, k) => cl(i.value, 3, 90, roundList()[k] || 15));
  const view = $("setRings").checked ? "rings" : "digits";
  const simple = $("setSimple").checked;
  const whiteNum = $("setWhiteNum").checked;
  api("/api/view", { method: "POST", body: JSON.stringify({ rs, view, simple, whiteNum }) })
    .then((r) => r.json()).then((d) => { if (d.ok && d.view) applyView(d.view); })
    .catch(() => {});
}
$("closeSettings").addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) closeSettings(); });
let resetArm = 0;
$("resetAll").addEventListener("click", () => {
  const b = $("resetAll");
  if (Date.now() < resetArm) {
    tables = {}; prevAlarm = {}; saveTables(); closeSettings(); renderGrid(true);
    tableAction("resetAll", 0);
    resetArm = 0; b.textContent = "Освободить все столы";
    return;
  }
  resetArm = Date.now() + 3000;
  b.textContent = "Точно? Нажмите ещё раз";
  setTimeout(() => { if (Date.now() > resetArm) { resetArm = 0; b.textContent = "Освободить все столы"; } }, 3200);
});

const soundBtn = $("soundBtn");
const updateSoundBtn = () => drawSoundState();
soundBtn.addEventListener("click", () => {
  settings.sound = !settings.sound;
  saveSettings();
  if (settings.sound) { unlockAudio(); beep(); }
  drawSoundState();
});

/* ===== «На смене»: смену держит сервер (видимость столов), пуши только добавляют звук =====
   Занятые столы видит только тот, кто на смене. Кнопка работает и там, где пуши
   недоступны (десктоп, iPhone без установки на «Домой») — тогда просто без звука. */
const shiftBtn = $("shiftBtn");
let shiftOn = false;      // отметил ли смену это устройство/сотрудник (вид кнопки)
let youOnShift = true;    // видит ли занятые столы (с сервера); true по умолчанию — не мигаем пустотой

function b64ToU8(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function drawShift(state) {
  const narrow = window.innerWidth <= 560;
  if (state === "on") { shiftBtn.innerHTML = ico("buzz") + (narrow ? "" : "<span>на смене</span>"); shiftBtn.classList.add("on"); }
  else { shiftBtn.innerHTML = ico("buzz-off") + (narrow ? "" : "<span>не на смене</span>"); shiftBtn.classList.remove("on"); }
}
window.addEventListener("resize", () => drawShift(shiftOn ? "on" : "off"));

/* баннер, когда столы скрыты: человек залогинен, но не на смене */
function drawShiftBanner() {
  const b = document.getElementById("shiftBanner");
  if (!b) return;
  if (youOnShift) { b.classList.add("hidden"); b.textContent = ""; return; }
  b.classList.remove("hidden");
  b.textContent = "📴 Вы не на смене — занятые столы скрыты. Нажмите «на смене» вверху, чтобы видеть и вести столы.";
}

/* Разрешение на уведомления спрашиваем ПЕРВЫМ делом, прямо из обработчика касания:
   в Safari/iOS requestPermission() требует «живого» жеста, а он сгорает за первым же
   сетевым ожиданием. Раньше запрос шёл после двух await — и подписка молча не
   доходила до сервера: кнопка «на смене» срабатывала, а пуши не приходили. */
function askNotifyPermission() {
  if (!pushSupported()) return Promise.resolve("denied");
  if (Notification.permission !== "default") return Promise.resolve(Notification.permission);
  return new Promise((resolve) => {
    let done = false;
    const fin = (p) => { if (!done) { done = true; resolve(p || Notification.permission); } };
    try {
      const r = Notification.requestPermission(fin);        // старая колбэк-форма (Safari)
      if (r && typeof r.then === "function") r.then(fin, () => fin(Notification.permission));
    } catch { fin(Notification.permission); }
  });
}

/* подписка на пуши — по возможности, не блокирует смену.
   perm можно передать заранее (см. askNotifyPermission), иначе спросим здесь. */
async function enablePush(perm) {
  if (!pushSupported()) return false;
  try {
    if (perm === undefined) perm = await askNotifyPermission();
    if (perm !== "granted") {
      flashConn("на смене · но уведомления запрещены — звук вызова не придёт");
      return false;
    }
    const reg = await navigator.serviceWorker.ready;
    const v = await (await api("/api/push/vapid")).json();
    if (!v.ok) return false;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(v.publicKey) });
    const r = await api("/api/push/subscribe", { method: "POST",
      body: JSON.stringify({ sub: sub.toJSON(), ua: navigator.userAgent }) });
    return r.ok;
  } catch (e) { console.error("[push]", e); return false; }
}

/* Сервер отсчитывает смену от МОМЕНТА ПОДПИСКИ (14 часов), а не от нажатия кнопки.
   Поэтому, пока человек на смене и разрешение уже выдано, тихо переподписываемся
   раз в час: иначе к следующему дню окно закрывается и пуши перестают уходить,
   ничего об этом не сообщая. */
let pushSyncTs = 0, pushSyncing = false;
async function keepPushAlive() {
  if (!shiftOn || pushSyncing) return;
  if (!pushSupported() || Notification.permission !== "granted") return;
  if (Date.now() - pushSyncTs < 55 * 60 * 1000) return;
  pushSyncing = true;
  try {
    const ok = await enablePush("granted");
    pushSyncTs = ok ? Date.now() : Date.now() - 50 * 60 * 1000;   // не вышло — повторим через 5 минут
  } finally { pushSyncing = false; }
}
async function disablePush() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api("/api/push/off", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
  } catch {}
}

shiftBtn.addEventListener("click", async () => {
  try {
    if (shiftOn) {                                    // смена окончена
      await api("/api/shift", { method: "POST", body: JSON.stringify({ on: false }) });
      disablePush();
      shiftOn = false; drawShift("off");
    } else {                                          // заступаем на смену
      const permP = askNotifyPermission();            // до первого await — жест ещё «живой»
      await api("/api/shift", { method: "POST", body: JSON.stringify({ on: true }) });
      shiftOn = true; drawShift("on");
      pushSyncTs = 0;
      enablePush(await permP)                         // звук вызовов — по возможности
        .then((ok) => { if (ok) pushSyncTs = Date.now(); });
    }
    pollCalls();                                      // сразу подтянуть / скрыть столы
  } catch (e) { console.error("[shift]", e); }
});

/* столы всегда заливаются цветом круга; отдельная «цветная шкала по состоянию» убрана */
function applyPaint() { document.body.classList.remove("paint"); }

/* короткая подсказка в шапке вместо статуса связи */
function flashConn(text) {
  const el = document.getElementById("connState");
  if (!el) return;
  el.textContent = text;
  el.className = "conn ok";
  setTimeout(updateConn, 2500);
}

/* отмена последнего действия со столами — на случай случайного тапа */
let canUndo = false;
function drawUndo() {
  const b = document.getElementById("undoBtn");
  if (b) b.classList.toggle("hidden", !canUndo);
}
async function doUndo() {
  try {
    const d = await (await api("/api/undo", { method: "POST", body: "{}" })).json();
    if (d.ok) {
      tables = d.tables || {}; saveTables();
      canUndo = !!d.canUndo; drawUndo(); renderGrid(true);
      if (d.undone) flashConn("↩︎ отменено: " + d.undone);
      hideUndoToast();
    } else if (d.error) flashConn("⚠️ " + d.error);
  } catch {}
}
document.getElementById("undoBtn").addEventListener("click", doUndo);

/* ===== «Стол 12 закрыт · Отменить» =====
   Закрытие необратимо для гостя, но не для смены: 45 секунд внизу экрана висит
   кнопка отката. Она зовёт ту же /api/undo — снимок стола вернётся вместе с
   записью в архиве, чтобы посадка не посчиталась дважды. */
const UNDO_TOAST_MS = 45000;
let undoToastT = 0;
function hideUndoToast() {
  const el = document.getElementById("undoToast");
  if (el) el.classList.add("hidden");
  clearTimeout(undoToastT);
}
function offerUndo(text) {
  const el = document.getElementById("undoToast");
  if (!el) { flashConn(text); return; }
  const t = document.getElementById("undoToastText");
  if (t) t.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(undoToastT);
  undoToastT = setTimeout(hideUndoToast, UNDO_TOAST_MS);
}
document.getElementById("undoToastBtn").addEventListener("click", doUndo);
document.getElementById("undoToastX").addEventListener("click", hideUndoToast);

/* Планшет на стойке не должен засыпать: пока пульт открыт, экран держим включённым.
   Иначе звук просрочки и вызова прозвучит в погасший экран. */
let wakeLock = null;
async function keepAwake() {
  if (!("wakeLock" in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && me && (me.device || me.role === "device")) keepAwake();
});

/* тема — личный выбор каждого устройства, доступен всей смене */
function applyTheme() {
  const light = settings.theme === "light";
  document.body.classList.toggle("light", light);
  const b = document.getElementById("themeBtn");
  if (b) b.innerHTML = ico(light ? "sun" : "moon");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", light ? "#f6f2ec" : "#15100c");
}
document.getElementById("themeBtn").addEventListener("click", () => {
  settings.theme = settings.theme === "light" ? "dark" : "light";
  saveSettings(); applyTheme();
drawUndo();
});

/* ===== Экран «Смена»: кто работает, журнал, админские действия ===== */
const crewModal = $("crew");
function hhmmss(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

let journalSig = "";
async function loadCrew(initial) {
  try {
    const d = await (await api("/api/me")).json();
    if (!d.ok) return;
    me = { name: d.name, role: d.role };
    localStorage.setItem("serp.me", JSON.stringify(me));
    drawWho();
    $("adminBox").classList.toggle("hidden", d.role !== "admin");
    // поля сервисного режима заполняем только при открытии — фоновое обновление
    // не должно затирать то, что админ прямо сейчас вводит
    if (initial && d.role === "admin") {
      $("svcOn").checked = !!svc.service;
      $("svcBlock").checked = !!svc.blockGuests;
      $("svcNote").value = svc.note || "";
    }

    $("onShiftList").innerHTML = d.onShift.length
      ? d.onShift.map((s) => `<div class="staff-row"><span>${ics("dot")} ${esc(s.name && s.name !== "—" ? s.name : "устройство без входа по ПИН")}</span>
          <span class="muted">${esc(s.dev)} · с ${hhmmss(s.since)}</span></div>`).join("")
      : `<div class="muted">Никто не включил уведомления. Нажмите «не на смене» в шапке.</div>`;

    if (d.role === "admin") {
      $("staffList").innerHTML = d.staff.map((x) => `
        <div class="staff-row">
          <span>${x.role === "admin" ? "★ " : x.role === "device" ? "📟 " : ""}${esc(x.name)} <span class="muted">ПИН ${esc(x.pin || "")}</span></span>
          ${x.id === "a1" ? "" : `<button class="btn ghost danger mini" data-rmstaff="${x.id}">убрать</button>`}
        </div>`).join("");
    }

    loadHistory();
    // журнал перерисовываем только когда появились новые записи — иначе дёргается прокрутка
    const sig = d.journal.length ? d.journal[0].ts + ":" + d.journal.length : "0";
    if (sig !== journalSig) {
      journalSig = sig;
      $("journal").innerHTML = d.journal.length
        ? d.journal.map((j) => `<div class="jrow"><span class="jt">${hhmmss(j.ts)}</span>
            <span class="jw">${esc(j.who)}</span><span class="jx">${esc(j.text)}</span></div>`).join("")
        : `<div class="muted">Пока пусто.</div>`;
    }
  } catch {}
}

let histSig = "";
async function loadHistory() {
  try {
    const d = await (await api("/api/history")).json();
    if (!d.ok) return;
    const sig = d.items.length + ":" + (d.items[0] ? d.items[0].ts : 0);
    $("histSum").textContent = d.today.sessions
      ? `за сутки: ${d.today.sessions} столов · ${d.today.hookahs} кальянов · ${d.today.rounds} кругов`
      : "";
    if (sig === histSig) return;
    histSig = sig;
    $("history").innerHTML = d.items.length
      ? d.items.slice(0, 40).map((h) => {
          const hk = h.hookahs.length > 1 ? ` · ${h.hookahs.length} кальяна` : "";
          const rounds = h.hookahs.reduce((a, x) => a + x.rounds, 0);
          return `<div class="jrow"><span class="jt">${hhmmss(h.ts)}</span>
            <span class="jw">${typeof h.table === "number" ? "Стол " + h.table : esc(h.table)}</span>
            <span class="jx">${h.totalMinutes} мин${hk} · ${rounds} кругов · закрыл ${esc(h.by)}</span></div>`;
        }).join("")
      : `<div class="muted">Пока никто не закрывал столы.</div>`;
  } catch {}
}

$("crewBtn").addEventListener("click", () => { crewModal.classList.remove("hidden"); loadCrew(true); });
/* пока экран открыт — журнал и список смены обновляются сами */
setInterval(() => {
  if (!crewModal.classList.contains("hidden") && !needKey) loadCrew(false);
}, 4000);
$("closeCrew").addEventListener("click", () => crewModal.classList.add("hidden"));
crewModal.addEventListener("click", (e) => { if (e.target === crewModal) crewModal.classList.add("hidden"); });

$("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem(LS_KEY); localStorage.removeItem("serp.me");
  me = null; drawWho();
  crewModal.classList.add("hidden");
  askKey("Введите свой ПИН.");
});

/* сервисный режим */
$("svcSave").addEventListener("click", async () => {
  $("svcMsg").textContent = "Применяю…";
  try {
    const d = await (await api("/api/mode", { method: "POST", body: JSON.stringify({
      service: $("svcOn").checked, blockGuests: $("svcBlock").checked, note: $("svcNote").value.trim() }) })).json();
    if (!d.ok) { $("svcMsg").textContent = d.error || "Не получилось"; return; }
    svc = d.mode; drawSvcBanner();
    $("svcMsg").textContent = d.mode.service
      ? "Сервисный режим включён — уведомления не уходят."
      : "Сервисный режим выключен, всё работает как обычно.";
    loadCrew(false);
  } catch { $("svcMsg").textContent = "Нет связи."; }
});

/* проверка звука на всех пультах */
async function soundCheck(kind) {
  try {
    const d = await (await api("/api/ping", { method: "POST", body: JSON.stringify({ kind }) })).json();
    $("bcMsg").textContent = d.ok
      ? (kind === "timer" ? "Сигнал «пора к столу» пошёл на все пульты." : "Сигнал вызова пошёл на все пульты.")
      : (d.error || "не получилось");
  } catch { $("bcMsg").textContent = "Нет связи."; }
}
$("pingBtn").addEventListener("click", () => soundCheck("call"));
$("pingTimerBtn").addEventListener("click", () => soundCheck("timer"));

/* сервисное сообщение всей смене */
$("bcSend").addEventListener("click", async () => {
  const text = $("bcText").value.trim();
  if (!text) { $("bcMsg").textContent = "Напишите текст сообщения."; return; }
  $("bcMsg").textContent = "Отправляю…";
  try {
    const d = await (await api("/api/broadcast", { method: "POST", body: JSON.stringify({ text }) })).json();
    if (!d.ok) { $("bcMsg").textContent = d.error || "Не отправилось"; return; }
    $("bcText").value = "";
    $("bcMsg").textContent = d.sent
      ? `Отправлено на ${d.sent} устройств${d.sent === 1 ? "о" : "а"}.`
      : "Сейчас никто не на смене — сообщение никому не ушло.";
    loadCrew(false);
  } catch { $("bcMsg").textContent = "Нет связи."; }
});

/* сотрудники */
$("stAdd").addEventListener("click", async () => {
  const name = $("stName").value.trim(), pin = $("stPin").value.trim();
  $("stMsg").textContent = "";
  try {
    const d = await (await api("/api/staff", { method: "POST",
      body: JSON.stringify({ action: "add", name, pin }) })).json();
    if (!d.ok) { $("stMsg").textContent = d.error || "Не получилось"; return; }
    $("stName").value = ""; $("stPin").value = "";
    $("stMsg").textContent = "Добавлен. Пусть войдёт по своему ПИНу.";
    loadCrew(false);
  } catch { $("stMsg").textContent = "Нет связи."; }
});
$("staffList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-rmstaff]");
  if (!b) return;
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "точно?";
    setTimeout(() => { b.dataset.armed = "0"; b.textContent = "убрать"; }, 3000); return; }
  try {
    await api("/api/staff", { method: "POST", body: JSON.stringify({ action: "remove", id: b.dataset.rmstaff }) });
    loadCrew(false);
  } catch {}
});

/* ===== Заступление кальянщика за общий планшет =====
   Планшет остаётся планшетом (сессия год, экран не гаснет), но действия
   пишутся на заступившего — в журнале и статистике видно, чья смена. */
function drawWorkerBtn() {
  const b = $("workerBtn");
  if (!b) return;
  if (!me || !me.device) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  const human = me.role !== "device";
  b.textContent = human ? "👤 " + me.name : "👤 кто на смене?";
  b.classList.toggle("on", human);
}
async function refreshMe() {
  try {
    const d = await (await api("/api/me")).json();
    if (!d.ok) return;
    me = { name: d.name, role: d.role, device: !!d.device };
    localStorage.setItem("serp.me", JSON.stringify(me));
    drawWho(); drawWorkerBtn();
  } catch {}
}
$("workerBtn").addEventListener("click", () => {
  $("wkPin").value = "";
  $("wkMsg").textContent = me && me.role !== "device"
    ? `Сейчас за пультом ${me.name}. Новый кальянщик — введи свой ПИН, либо «Сдать смену».`
    : "Заступаешь за пульт — введи свой ПИН. Все действия со столами будут записаны на тебя. Смена сдаётся сама в 11 утра.";
  $("workerGate").classList.remove("hidden");
  $("wkPin").focus();
});
async function workerSet(body) {
  try {
    const d = await (await api("/api/worker", { method: "POST", body: JSON.stringify(body) })).json();
    if (!d.ok) { $("wkMsg").textContent = d.error || "Не получилось"; return; }
    $("workerGate").classList.add("hidden");
    me = { name: d.name, role: d.role, device: !!d.device };
    localStorage.setItem("serp.me", JSON.stringify(me));
    drawWho(); drawWorkerBtn();
    flashConn(d.role === "device" ? "👤 Смена сдана — пульт общий" : "👤 За пультом " + d.name);
  } catch { $("wkMsg").textContent = "Нет связи."; }
}
$("wkGo").addEventListener("click", () => {
  const pin = $("wkPin").value.trim();
  if (pin) workerSet({ pin });
});
$("wkPin").addEventListener("keydown", (e) => { if (e.key === "Enter") $("wkGo").click(); });
$("wkOff").addEventListener("click", () => workerSet({ off: 1 }));
$("wkCancel").addEventListener("click", () => $("workerGate").classList.add("hidden"));
$("workerGate").addEventListener("click", (e) => { if (e.target === $("workerGate")) $("workerGate").classList.add("hidden"); });

/* ===== Вход по ПИН сотрудника ===== */
async function doLogin() {
  const pin = $("keyInput").value.trim();
  if (!pin) return;
  $("keyMsg").textContent = "Проверяю…";
  try {
    const r = await fetch("/api/login", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
    const d = await r.json();
    if (!d.ok) { $("keyMsg").textContent = d.error || "Не получилось войти"; return; }
    localStorage.setItem(LS_KEY, d.token);          // персональный токен вместо общего ключа
    me = { name: d.name, role: d.role };
    localStorage.setItem("serp.me", JSON.stringify(me));
    $("keyInput").value = "";
    $("keyMsg").textContent = "";
    hideKeyGate();
    drawWho();
    refreshMe();
    pollCalls();
  } catch { $("keyMsg").textContent = "Нет связи с сервером"; }
}
$("keySave").addEventListener("click", doLogin);
$("keyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

/* ===== Свой (временный) стол с подписью ===== */
$("ntCreate").addEventListener("click", async () => {
  const label = $("ntName").value.trim();
  if (!label) return;
  $("ntName").value = "";
  $("newTable").classList.add("hidden");
  try {
    const d = await (await api("/api/table", { method: "POST",
      body: JSON.stringify({ action: "createCustom", label }) })).json();
    if (d.ok && d.tables) { tables = d.tables; saveTables(); renderGrid(true); }
    if (d.ok) { canUndo = !!d.canUndo; drawUndo(); }
  } catch {}
});
$("ntCancel").addEventListener("click", () => { $("ntName").value = ""; $("newTable").classList.add("hidden"); });
$("ntName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("ntCreate").click(); });

/* ===== Перенос стола: гости пересели — таймеры едут следом ===== */
let moveFrom = null;
function openMove(n) {
  moveFrom = n;
  const free = [];
  for (let i = 1; i <= cfg.tables; i++) if (!hookahsOf(i).length) free.push(i);
  const name = /^c/.test(String(n)) ? "«" + ((tables[n] && tables[n].label) || "стол") + "»" : "стол " + n;
  $("mtTitle").textContent = "Куда пересадить " + name + "?";
  $("mtGrid").innerHTML = free.length
    ? free.map((i) => `<button class="btn mt-t" data-mt="${i}">${i}</button>`).join("")
    : `<p class="hint">Свободных столов нет.</p>`;
  $("moveTable").classList.remove("hidden");
}
const closeMove = () => { moveFrom = null; $("moveTable").classList.add("hidden"); };
$("mtCancel").addEventListener("click", closeMove);
$("moveTable").addEventListener("click", (e) => { if (e.target === $("moveTable")) closeMove(); });
$("mtGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mt]");
  if (!b || moveFrom == null) return;
  const from = moveFrom, to = +b.dataset.mt;
  closeMove();
  tableAction("move", from, "", { to });
  flashConn("⇄ пересадил на стол " + to);
});

/* ===== Конструктор забивки: что именно кальянщик поставил на стол =====
   Один экран, два тапа: чем греем и (по желанию) вкус. «Пропустить» оставлен
   намеренно — если заполнение начнёт тормозить зал, кальян всё равно запустится. */
let flavorHints = [];
let bdEditing = false;        // режим правки списка вкусов: у подсказок появляется ✕
/* Каталог табака заведения: бренд · линейка · вкус. Выбираем ТОЛЬКО из него,
   иначе в базе заведётся десяток написаний одного и того же табака. Своё
   название вписать можно, но оно помечается как «не из каталога». */
let catalog = [];
let catReady = false;
async function loadCatalog() {
  if (catReady) return;
  try {
    const d = await (await api("/api/catalog")).json();
    if (d.ok) { catalog = d.items || []; catReady = true; }
  } catch {}
}
const catTitle = (c) => [c.brand, c.line, c.flavor].filter(Boolean).join(" · ");
/* поиск без учёта регистра и раскладки: «блэк» находит BlackBurn */
const RU2EN = { й: "q", ц: "w", у: "e", к: "r", е: "t", н: "y", г: "u", ш: "i", щ: "o", з: "p",
  ф: "a", ы: "s", в: "d", а: "f", п: "g", р: "h", о: "j", л: "k", д: "l", я: "z", ч: "x",
  с: "c", м: "v", и: "b", т: "n", ь: "m", б: ",", ю: "." };
const lat = (s) => s.toLowerCase().replace(/[а-яё]/g, (ch) => RU2EN[ch] || ch);
function catFind(q) {
  const s = q.trim().toLowerCase();
  if (!s) return catalog.slice(0, 40);
  const sl = lat(s);
  const hit = (c) => {
    // ищем и по названию, и по тому, как позицию произносят вслух («малибу», «черника»)
    const t = (catTitle(c) + " " + (c.a || []).join(" ")).toLowerCase();
    return t.includes(s) || lat(t).includes(sl);
  };
  return catalog.filter(hit).slice(0, 40);
}
function applyBeta(b) {
  if (!!b.build === beta.build && !!b.voice === beta.voice) return;   // без изменений — не дёргаем сетку
  beta = { build: !!b.build, voice: !!b.voice };
  localStorage.setItem("serp.beta", JSON.stringify(beta));   // навигация на других страницах берёт флаг отсюда
  $("voiceBtn").classList.toggle("hidden", !beta.voice);
  renderGrid(true);
}
/* В чаше может быть от одного табака до десяти — держим состав списком. */
const MIX_MAX = 10;
let bd = { n: null, mode: "add", hid: "", heat: "", mix: [] };
const mixLabel = (mix) => (mix || []).map((m) => m.flavor).filter(Boolean).join(" + ");
function drawBuild() {
  const start = bd.mode === "add";
  const name = /^c/.test(String(bd.n)) ? "«" + ((tables[bd.n] && tables[bd.n].label) || "стол") + "»" : "Стол " + bd.n;
  const many = hookahsOf(bd.n).length;
  $("bdTitle").textContent = start
    ? name + (many ? " · ещё кальян" : " · новый кальян")
    : name + " · забивка";
  for (const b of document.querySelectorAll("#bdHeats [data-heat]"))
    b.classList.toggle("on", b.dataset.heat === bd.heat);
  const q = $("bdFlavor").value || "";
  const found = catFind(q);
  const inMix = (cat) => bd.mix.some((m) => m.cat === cat);
  // что уже в чаше — отдельной строкой сверху, оттуда же и убирается
  $("bdMix").innerHTML = bd.mix.length
    ? bd.mix.map((m, k) => `<button class="bd-mx" data-mx="${k}">${
        m.brand ? `<span class="fl-br">${esc(m.brand)}</span>` : ""}${esc(m.flavor)}<span class="mx-x">✕</span></button>`).join("")
    : "";
  $("bdMix").classList.toggle("hidden", !bd.mix.length);
  /* Бренд не назвали, а вкус с таким названием есть у нескольких — предлагаем
     выбрать, а не подставляем наугад. Раньше при равной оценке побеждала та
     позиция, что раньше в каталоге, и кальянщик этого даже не видел. */
  const withAlts = bd.mix.findIndex((m) => m.alts && m.alts.length);
  const box = $("bdAlts");
  if (withAlts < 0) { box.classList.add("hidden"); box.innerHTML = ""; }
  else {
    const m = bd.mix[withAlts];
    box.classList.remove("hidden");
    box.innerHTML = `<div class="bd-alts-t">Бренд не назван — уточните:</div>`
      + [{ i: m.cat, brand: m.brand, line: m.line || "", flavor: m.flavor }, ...m.alts]
        .map((a, j) => `<button class="bd-alt${j === 0 ? " on" : ""}" data-alt="${withAlts}" data-ai="${j}">${
          esc(a.brand)}${a.line ? " · " + esc(a.line) : ""}</button>`).join("");
  }
  $("bdMixHint").textContent = bd.mix.length > 1 ? "микс из " + bd.mix.length : "";
  const own = q.trim();
  $("bdFlavors").innerHTML =
    (own && !found.length ? `<button class="btn bd-fl off" data-own="${esc(own)}">«${esc(own)}» — вписать своё</button>` : "")
    + (found.length
      ? found.map((c) => `<button class="btn bd-fl${inMix(c.i) ? " on" : ""}" data-cat="${c.i}">${
          c.brand ? `<span class="fl-br">${esc(c.brand)}</span>` : ""}${esc(c.flavor)}</button>`).join("")
      : own ? "" : `<p class="hint" style="margin:0">Каталог пуст.</p>`);
  $("bdFlHint").textContent = q.trim()
    ? "Нашлось: " + found.length + (found.length >= 40 ? "+" : "")
    : "Табак — из каталога, можно несколько (до " + MIX_MAX + ")";
  $("bdEdit").classList.add("hidden");   // список теперь из каталога, руками его не чистят
  $("bdGo").textContent = start ? "Запустить" : "Сохранить";
  $("bdSkip").classList.toggle("hidden", !start);
  // забивку можно и снять — если записали не тот кальян
  $("bdWipe").classList.toggle("hidden", start || !(bd.heat || bd.mix.length));
  $("bdMic").classList.toggle("hidden", !beta.voice);
}
function openBuild(n, mode, hid) {
  bdEditing = false;
  $("bdVoiceMsg").classList.add("hidden");
  const h = hid ? hookahsOf(n).find((x) => x.id === hid) : null;
  const cur = (h && h.build) || {};
  const curMix = Array.isArray(cur.mix) && cur.mix.length ? cur.mix
    : (cur.flavor ? [{ cat: typeof cur.cat === "number" ? cur.cat : undefined,
                       brand: cur.brand || "", flavor: cur.flavor }] : []);
  bd = { n, mode: mode === "edit" ? "edit" : "add", hid: hid || "",
    heat: cur.heat || "", mix: curMix.slice(0, MIX_MAX) };
  $("bdFlavor").value = "";
  drawBuild();
  $("buildBox").classList.remove("hidden");
  loadCatalog().then(() => { if (bd.n === n) drawBuild(); });   // каталог тянем один раз за сессию
}
const closeBuild = () => {
  if (bdSegStop) { bdSegStop(); bdSegStop = null; }
  if (bdRec && bdRec.state === "recording") { try { bdRec.stop(); } catch {} }
  bd.n = null;
  $("buildBox").classList.add("hidden");
};
function submitBuild(skip) {
  const { n, mode, hid } = bd;
  if (n == null) return;
  // из каталога уходит НОМЕР — сервер подставит наши бренд и вкус сам
  const typed = ($("bdFlavor").value || "").trim().slice(0, 40);
  const mix = bd.mix.map((m) => (m.cat != null ? { cat: m.cat } : { flavor: m.flavor }));
  if (!mix.length && typed) mix.push({ flavor: typed });      // вписал и сразу «Запустить»
  const build = skip ? null : { heat: bd.heat, mix };
  const has = !!(build && (build.heat || mix.length));
  closeBuild();
  if (mode === "edit") { if (has) tableAction("build", n, hid, { build }); return; }
  tableAction("add", n, "", has ? { build } : {});
}
$("bdHeats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-heat]");
  if (!b) return;
  bd.heat = bd.heat === b.dataset.heat ? "" : b.dataset.heat;   // повторный тап снимает выбор
  drawBuild();
});
function bdPick(cat) {
  const c = catalog.find((x) => x.i === cat);
  if (!c) return;
  const at = bd.mix.findIndex((m) => m.cat === cat);
  if (at >= 0) bd.mix.splice(at, 1);
  else if (bd.mix.length < MIX_MAX) bd.mix.push({ cat: c.i, brand: c.brand, line: c.line || "", flavor: c.flavor });
  else flashConn("в чаше уже " + MIX_MAX + " табаков");
  drawBuild();
}
$("bdFlavors").addEventListener("click", (e) => {
  const c = e.target.closest("[data-cat]");
  if (c) { bdPick(+c.dataset.cat); return; }
  const o = e.target.closest("[data-own]");            // своё название — вне каталога
  if (o) {
    const v = o.dataset.own;
    if (!bd.mix.some((m) => m.cat == null && m.flavor === v) && bd.mix.length < MIX_MAX)
      bd.mix.push({ flavor: v });
    $("bdFlavor").value = "";
    drawBuild();
  }
});
$("bdMix").addEventListener("click", (e) => {         // убрать составляющую из чаши
  const b = e.target.closest("[data-mx]");
  if (!b) return;
  bd.mix.splice(+b.dataset.mx, 1);
  drawBuild();
});
$("bdFlavor").addEventListener("input", () => drawBuild());
$("bdFlavor").addEventListener("keydown", (e) => { if (e.key === "Enter") submitBuild(false); });
$("bdEdit").addEventListener("click", () => { bdEditing = !bdEditing; drawBuild(); });
$("bdWipe").addEventListener("click", () => {
  const { n, hid } = bd;
  closeBuild();
  tableAction("build", n, hid, { clear: true });
  flashConn("забивка снята");
});

/* Диктовка прямо в окне забивки: стол уже выбран, называть его не надо —
   говорим только вкус и способ, поля заполняются сами. Проверить и «Запустить». */
let bdRec = null, bdChunks = [], bdStream = null, bdSegStop = null, bdLive = "";
function bdMicState(rec) {
  $("bdMic").textContent = rec ? "⏹ стоп" : "🎤 сказать";
  $("bdMic").classList.toggle("rec", rec);
}
function bdSay(msg, err) {
  const el = $("bdVoiceMsg");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
  el.style.color = err ? "var(--danger)" : "var(--muted)";
}
async function bdMicStart() {
  try { bdStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { bdSay("Нет доступа к микрофону — разрешите его для сайта.", true); return; }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  bdChunks = [];
  bdLive = "";
  bdRec = new MediaRecorder(bdStream, mime ? { mimeType: mime } : undefined);
  bdRec.ondataavailable = (e) => { if (e.data && e.data.size) bdChunks.push(e.data); };
  bdRec.onstop = async () => {
    if (bdSegStop) { bdSegStop(); bdSegStop = null; }
    bdStream.getTracks().forEach((t) => t.stop());
    const bdRecType = bdRec.mimeType || "";
    bdRec = null; bdMicState(false);
    const blob = new Blob(bdChunks, { type: ((bdRecType || mime) || "audio/webm").split(";")[0] });
    if (blob.size < 2000) { bdSay("Ничего не записалось.", true); return; }
    bdSay(bdLive ? "слышу: «" + bdLive + "» — уточняю…" : "Распознаю…");
    try {
      const r = await api("/api/voice?t=" + encodeURIComponent(bd.n),
        { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
      const d = await r.json();
      if (!d.ok) { bdSay(d.error || "Не получилось распознать", true); return; }
      const one = d.one || {};
      if (one.heat) bd.heat = one.heat;
      if (one.mix && one.mix.length) bd.mix = one.mix.slice(0, MIX_MAX);
      else if (one.flavor) bd.mix = [{ flavor: one.flavor }];
      if ((one.mix && one.mix.length) || one.flavor) $("bdFlavor").value = "";
      drawBuild();
      bdSay(one.heat || one.flavor
        ? "услышал: «" + (d.text || "") + "» — проверьте и запускайте"
        : "услышал «" + (d.text || "") + "», но вкуса и способа не разобрал");
    } catch (e) { if (e.message !== "auth") bdSay("Сервер не ответил.", true); }
  };
  bdRec.start();
  bdSegStop = segRecorder(bdStream, mime, (txt) => {   // слова появляются по ходу речи
    bdLive = (bdLive + " " + txt).trim();
    if (bdRec) bdSay("слышу: «" + bdLive + "…»");
  });
  bdMicState(true);
  bdSay("Говорите: «дабл эппл на фольге»");
  setTimeout(() => { if (bdRec && bdRec.state === "recording") bdRec.stop(); }, 30000);
}
$("bdMic").addEventListener("click", () => {
  if (bdRec && bdRec.state === "recording") bdRec.stop();
  else bdMicStart();
});

$("bdGo").addEventListener("click", () => submitBuild(false));
$("bdSkip").addEventListener("click", () => submitBuild(true));
$("bdCancel").addEventListener("click", closeBuild);
$("buildBox").addEventListener("click", (e) => { if (e.target === $("buildBox")) closeBuild(); });

/* ===== Голос: кальянщик говорит, что забил (бета) =====
   Записываем короткую фразу, сервер распознаёт и разбирает её в столы.
   Ничего не применяется само: сначала показываем, что понято, и ждём «Записать».
   Ошибка в номере стола дороже лишнего тапа, поэтому подтверждение обязательное. */
let vcRec = null, vcChunks = [], vcTick = null, vcT0 = 0, vcItems = [], vcBusy = false;
const VC_MAX_MS = 60000;                       // минута на фразу: раньше резало на полуслове
const VC_SEG_MS = 3000;                        // кусок живой расшифровки

/* Живая расшифровка. Параллельно с общей записью пишем короткие куски по 5 с и
   сразу гоняем их в текст — на экране видно, что тебя слышат, и не надо гадать,
   записалось ли. Куски пишутся ОТДЕЛЬНЫМИ рекордерами: продолжение webm без
   заголовка сервер бы не разобрал. Итог всё равно считаем по целой записи —
   на стыке кусков может срезать слово, а стол и вкус ошибок не прощают. */
const VC_SEG_FIRST_MS = 2000;                  // первый кусок короче: слова должны появиться сразу
async function liveSend(blob, onText) {
  try {
    const r = await api("/api/voice/live", { method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
    const d = await r.json();
    if (d.ok && d.text) onText(d.text);
  } catch {}
}
/* Кусочный рекордер: пишет отдельными файлами и отдаёт текст по мере речи.
   Возвращает функцию остановки. Используют оба микрофона — и большое окно,
   и окно забивки: человек должен видеть, что его слышат, в обоих. */
function segRecorder(stream, mime, onText) {
  let on = true, cur = null, first = true;
  (function round() {
    if (!on) return;
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    cur = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const b = new Blob(chunks, { type: ((rec.mimeType || mime) || "audio/webm").split(";")[0] });
      round();                                   // следующий кусок начинаем сразу, без паузы в записи
      if (b.size > 2500) liveSend(b, onText);
    };
    rec.start();
    const ms = first ? VC_SEG_FIRST_MS : VC_SEG_MS;
    first = false;
    setTimeout(() => { if (rec.state === "recording") rec.stop(); }, ms);
  })();
  return () => { on = false; if (cur && cur.state === "recording") { try { cur.stop(); } catch {} } };
}

let vcSegStopFn = null, vcSegOn = false, vcLive = "";
function vcLiveDraw() {
  const t = vcLive.trim();
  $("vcHeard").textContent = t ? "«" + t + (vcSegOn ? "…" : "") + "»" : "";
  $("vcHeard").classList.toggle("hidden", !t);
}
function vcSegStart(stream, mime) {
  vcSegOn = true;
  vcSegStopFn = segRecorder(stream, mime, (txt) => {
    vcLive = (vcLive + " " + txt).trim();
    vcLiveDraw();
  });
}
function vcSegStop() {
  vcSegOn = false;
  if (vcSegStopFn) { vcSegStopFn(); vcSegStopFn = null; }
}

function vcState(s) {                           // rec | send | done | err
  $("vcMic").classList.toggle("on", s === "rec");
  $("vcMic").classList.toggle("wait", s === "send");
  $("vcGo").textContent = s === "rec" ? "Стоп" : s === "done" ? "Записать" : "…";
  $("vcGo").classList.toggle("hidden", s === "send" || (s === "done" && !vcItems.length) || s === "err");
  $("vcAgain").classList.toggle("hidden", s === "rec" || s === "send");
}
function vcClose() {
  vcSegStop();
  if (vcRec && vcRec.state === "recording") { try { vcRec.stop(); } catch {} }
  vcRec = null;
  if (vcTick) { clearInterval(vcTick); vcTick = null; }
  $("voiceBox").classList.add("hidden");
}
async function vcOpen() {
  vcItems = []; vcChunks = []; vcBusy = false; vcLive = "";
  $("vcItems").innerHTML = "";
  $("vcHeard").textContent = "";
  $("vcHeard").classList.add("hidden");
  $("vcHint").textContent = "Например: «четвёртый стол дабл эппл на фольге, шестой пломбир на калауде». Можно назвать несколько столов одной фразой.";
  $("voiceBox").classList.remove("hidden");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { vcFail("Нет доступа к микрофону — разрешите его для сайта в настройках браузера."); return; }
  // Safari на iPad умеет только mp4, Chrome — webm/opus: берём то, что поддержано
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  vcRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  vcRec.ondataavailable = (e) => { if (e.data && e.data.size) vcChunks.push(e.data); };
  vcRec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = ((vcRec && vcRec.mimeType) || mime || "audio/webm").split(";")[0];
    vcSend(new Blob(vcChunks, { type }));
  };
  vcRec.start();
  vcSegStart(stream, mime);
  vcT0 = Date.now();
  vcState("rec");
  vcTick = setInterval(() => {
    const s = Math.floor((Date.now() - vcT0) / 1000);
    const left = Math.ceil((VC_MAX_MS - (Date.now() - vcT0)) / 1000);
    $("vcTimer").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    if (left <= 10) $("vcHint").textContent = "Заканчивайте — осталось " + Math.max(0, left) + " с";
    if (Date.now() - vcT0 > VC_MAX_MS) vcStop();
  }, 250);
}
function vcStop() {
  vcSegStop();
  if (vcTick) { clearInterval(vcTick); vcTick = null; }
  if (vcRec && vcRec.state === "recording") { try { vcRec.stop(); } catch {} }
  vcState("send");
  $("vcHint").textContent = "Распознаю…";
}
function vcFail(msg) {
  $("vcHint").textContent = msg;
  vcItems = [];
  vcState("err");
}
async function vcSend(blob) {
  if (!blob || blob.size < 2000) { vcFail("Ничего не записалось — попробуйте ещё раз."); return; }
  try {
    const r = await api("/api/voice", { method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
    const d = await r.json();
    if (!d.ok) { vcFail(d.error || "Не получилось распознать"); return; }
    vcLive = String(d.text || "");            // живой текст заменяем итоговым: он точнее
    vcLiveDraw();
    vcItems = d.items || [];
    if (!vcItems.length) { vcFail("Столов в этой фразе не разобрал. Назовите номер стола: «четвёртый стол…»."); return; }
    const noT = vcItems.filter((x) => !x.table).length;
    $("vcHint").textContent = noT
      ? "Стол не назвали — выберите его в строке и нажмите «Записать»."
      : "Проверьте и нажмите «Записать». Кальян можно снять из списка крестиком.";
    vcDrawItems();
    vcState("done");
  } catch (e) {
    if (e.message !== "auth") vcFail("Сервер не ответил — попробуйте ещё раз.");
  }
}
function vcDrawItems() {
  $("vcItems").innerHTML = vcItems.map((it, i) => {
    const list = hookahsOf(it.table);
    const last = list[list.length - 1];
    // стол занят, а у последнего кальяна забивки нет — скорее всего дописывают его, а не ставят новый
    if (it.mode === undefined) it.mode = list.length ? (last && last.build && last.build.heat ? "add" : "fix") : "add";
    // речь ошибается в названиях («ламбир» вместо «пломбир») — правим прямо здесь,
    // не выходя из окна: способ переключается тапом, вкус дописывается руками
    const heatTxt = it.heat ? HEAT_ICO[it.heat] + " " + HEAT_TXT[it.heat] : "способ?";
    const free = [];
    for (let k = 1; k <= cfg.tables; k++) if (!hookahsOf(k).length) free.push(k);
    const busyList = [];
    for (let k = 1; k <= cfg.tables; k++) if (hookahsOf(k).length) busyList.push(k);
    return `<div class="vc-row${it.table ? "" : " noteble"}">
      ${it.table
        ? `<div class="vc-t">${it.table}</div>`
        : `<select class="vc-pick" data-vt="${i}">
             <option value="">стол?</option>
             ${free.map((k) => `<option value="${k}">${k} — свободен</option>`).join("")}
             ${busyList.map((k) => `<option value="${k}">${k} — занят</option>`).join("")}
           </select>`}
      <div class="vc-b">
        <div class="vc-w">
          <button class="vc-heat${it.heat ? " on" : ""}" data-vh="${i}">${heatTxt}</button>
          ${(it.mix && it.mix.length > 1)
            ? `<span class="vc-cat">${esc(it.flavor)} <span class="vc-off">микс ×${it.mix.length}</span></span>`
            : it.cat != null
            ? `<span class="vc-cat">${it.brand ? esc(it.brand) + " · " : ""}${esc(it.flavor)}</span>`
            : `<input class="vc-fl" data-vf="${i}" value="${esc(it.flavor || "")}" placeholder="вкус" maxlength="40" />`}
          ${it.cat == null && !(it.mix && it.mix.length) && it.flavor ? `<span class="vc-off" title="такого табака нет в каталоге">нет в каталоге</span>` : ""}
        </div>
        ${list.length ? `<div class="vc-sw">
            <button class="vc-m${it.mode === "fix" ? " on" : ""}" data-vm="${i}" data-mode="fix">в текущий</button>
            <button class="vc-m${it.mode === "add" ? " on" : ""}" data-vm="${i}" data-mode="add">новый кальян</button>
          </div>` : `<div class="vc-sw"><span class="hint">стол свободен — поставим кальян</span></div>`}
      </div>
      <button class="vc-x" data-vx="${i}" title="убрать из списка">✕</button>
    </div>`;
  }).join("");
}
$("vcItems").addEventListener("change", (e) => {
  const t = e.target.closest("[data-vt]");
  if (t) {                                          // стол дослали руками — строка оживает
    const it = vcItems[+t.dataset.vt];
    it.table = +t.value || null;
    it.busy = it.table ? hookahsOf(it.table).length : 0;
    it.mode = undefined;
    vcDrawItems();
  }
});
$("vcItems").addEventListener("input", (e) => {
  const f = e.target.closest("[data-vf]");
  if (f) { const it = vcItems[+f.dataset.vf]; it.flavor = f.value.slice(0, 40); it.cat = null; it.mix = []; }  // без перерисовки: курсор бы прыгал
});
$("vcItems").addEventListener("click", (e) => {
  const h = e.target.closest("[data-vh]");
  if (h) {                                                        // фольга → калауд → не указан
    const it = vcItems[+h.dataset.vh];
    it.heat = it.heat === "foil" ? "kaloud" : it.heat === "kaloud" ? "" : "foil";
    vcDrawItems();
    return;
  }
  const m = e.target.closest("[data-vm]");
  if (m) { vcItems[+m.dataset.vm].mode = m.dataset.mode; vcDrawItems(); return; }
  const x = e.target.closest("[data-vx]");
  if (x) {
    vcItems.splice(+x.dataset.vx, 1);
    if (!vcItems.length) { vcFail("Список пуст."); return; }
    vcDrawItems();
  }
});
async function vcApply() {
  if (vcBusy) return;
  vcBusy = true;
  const list = vcItems.slice();
  vcClose();
  for (const it of list) {
    if (!it.table) continue;                        // без стола применять некуда
    const build = (it.mix && it.mix.length)
      ? { heat: it.heat || "", mix: it.mix.map((m) => (m.cat != null ? { cat: m.cat } : { flavor: m.flavor })) }
      : { heat: it.heat || "", flavor: it.flavor || "" };
    if (!build.heat && !(build.mix && build.mix.length) && !build.flavor) continue;
    const hs = hookahsOf(it.table);
    if (it.mode === "fix" && hs.length) await tableAction("build", it.table, hs[hs.length - 1].id, { build });
    else await tableAction("add", it.table, "", { build });
  }
  const done = list.filter((x) => x.table);
  flashConn(done.length ? "🎤 записал: " + done.map((x) => "стол " + x.table).join(", ")
    : "⚠️ ни у одной строки не выбран стол");
}
$("voiceBtn").addEventListener("click", vcOpen);
$("vcCancel").addEventListener("click", vcClose);
$("vcAgain").addEventListener("click", vcOpen);
$("vcGo").addEventListener("click", () => {
  if (vcRec && vcRec.state === "recording") vcStop();
  else if (vcItems.length) vcApply();
});
$("voiceBox").addEventListener("click", (e) => { if (e.target === $("voiceBox")) vcClose(); });

/* ===== Старт ===== */
bootStep("app", "ok");
bootStep("conn", "wait");
if (sessionStorage.getItem("serp.updated")) {        // перезапуск был из-за новой версии — скажем об этом
  sessionStorage.removeItem("serp.updated");
  setTimeout(() => flashConn("✨ Пульт обновился до свежей версии"), 1200);
}
drawWho();
if (!getKey()) askKey("Введите свой ПИН — он покажет, кто на смене.");
else refreshMe();
updateSoundBtn();
applyPaint();
applyTheme();
drawUndo();
renderGrid();
fetch("/api/config").then((r) => r.json()).then((d) => { if (d.ok) { cfg = d; applyView(d.view); if (d.weather) drawWeather(d.weather); bootStep("conn", "ok"); renderGrid(); } }).catch(() => {});
pollCalls();
setInterval(pollCalls, CALLS_MS);
setInterval(tick, 1000);
unlockAudio();                                  // пробуем сразу; если рано — сработает при первом касании
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((reg) => {
    reg.update();
    setInterval(() => reg.update(), 10 * 60 * 1000);   // в PWA страницу руками не обновишь
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    try { sessionStorage.setItem("serp.updated", "1"); } catch {}   // после перезапуска покажем «обновился»
    location.reload();                                  // приехала новая версия — переключаемся на неё
  });
}

/* ===== Меню «ещё» ===== */
(() => {
  const btn = document.getElementById("moreBtn"), menu = document.getElementById("moreMenu");
  const close = () => { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle("hidden") === false;
    btn.setAttribute("aria-expanded", String(open));
  });
  // выбрал действие — меню закрылось; сами кнопки при этом отработают свои обработчики
  menu.addEventListener("click", () => setTimeout(close, 0));
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== btn) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
})();

/* Локальная проверка звуков: играет здесь и сейчас, никому не рассылается.
   Порядок тот же, в каком их слышит кальянщик за смену. */
$("soundTestBtn").addEventListener("click", () => {
  unlockAudio();
  const step = (ms, fn) => setTimeout(fn, ms);
  flashConn("1/3 · так звучит «пора к столу»");
  beep();
  step(1600, () => { flashConn("2/3 · так звучит вызов гостя"); beepCall(); buzz(); });
  step(3800, () => {
    if (!settings.sound) { flashConn("звук выключен — включите переключатель выше"); return; }
    if (!settings.voice) { flashConn("3/3 · голос выключен — включите галочку выше"); return; }
    flashConn("3/3 · голос: " + $("setVoiceSet").value);
    voiceQueue.length = 0; voicePlaying = false;   // не ждём хвост предыдущего объявления
    say("_test");
  });
});

/* Выбор бренда в окне забивки: подменяем позицию, список альтернатив сохраняем,
   чтобы можно было передумать. */
$("bdAlts").addEventListener("click", (e) => {
  const b = e.target.closest("[data-alt]");
  if (!b) return;
  const m = bd.mix[+b.dataset.alt];
  if (!m) return;
  const all = [{ i: m.cat, brand: m.brand, line: m.line || "", flavor: m.flavor }, ...(m.alts || [])];
  const pick = all[+b.dataset.ai];
  if (!pick) return;
  const rest = all.filter((x) => x.i !== pick.i);
  bd.mix[+b.dataset.alt] = { ...m, cat: pick.i, brand: pick.brand, line: pick.line, flavor: pick.flavor, alts: rest };
  drawBuild();
});

"use strict";
/*
 * «Серп» — вызов кальянщика со стола + пульт кальянщика.
 * Гость сканирует QR стола → /t/<N> → жмёт кнопку вызова.
 * Планшет кальянщика опрашивает /api/calls (ключ в заголовке X-Pult-Key).
 *
 * Гостевое API (открытое):
 *   GET  /api/config            → { venue, tables, open }
 *   POST /api/call              { table, kind, comment?, did } → { ok, id }
 *   GET  /api/call/<id>         → { ok, status }
 * Пульт (ключ в заголовке X-Pult-Key, НЕ в URL — иначе течёт в логи):
 *   GET  /api/calls             → активные вызовы (без IP/метки устройства)
 *   POST /api/ack | /api/done | /api/spam   { id }
 *   GET  /api/push/vapid · POST /api/push/{subscribe,off,status}
 * Служебное: GET /health
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const PORT = process.env.PORT || CFG.port || 8905;
const PULT_KEY = process.env.PULT_KEY || CFG.pultKey;

const RETENTION_MS = 36 * 60 * 60 * 1000; // вызовы храним 36 часов, потом забываем
const ACTIVE_MS = 12 * 60 * 60 * 1000;    // старше — не показываем на пульте
const DUP_MS = 3 * 60 * 1000;             // повтор той же кнопки со стола
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX = 10;                        // вызовов с IP за окно
const DAY_MAX = 8;                        // вызовов с устройства в сутки
const VENUE_WINDOW_MS = 60 * 1000;        // глобальный потолок: держит ротацию IP
const VENUE_MAX = 15;                     // вызовов на всё заведение в минуту
const CALLS_CAP = 5000;                   // жёсткий предел массива в памяти
const AUTH_WINDOW_MS = 60 * 1000;         // окно счётчика неверных ключей
const AUTH_MAX_IP = 120;                  // неверных ключей с IP за окно (за одним адресом всё заведение)
const AUTH_MAX_ALL = 50;                  // неверных ключей со всех IP за окно → алерт

/* Ключи недавних действий со столами — против двойного применения при обрыве связи.
   Живут 5 минут: дольше держать незачем, очередь клиента протухает раньше (OUTBOX_TTL). */
const recentOps = new Map();
const OPS_TTL = 5 * 60 * 1000;
setInterval(() => {
  const cut = Date.now() - OPS_TTL;
  for (const [k, t] of recentOps) if (t < cut) recentOps.delete(k);
}, 60 * 1000);

/* ---- аварийная сеть: один кривой запрос не должен ронять смену ---- */
process.on("uncaughtException", (e) => console.error("[FATAL-caught]", e && e.stack || e));
process.on("unhandledRejection", (e) => console.error("[REJECT-caught]", e && e.stack || e));

/* ---- надёжное хранилище: атомарная запись, громкая ошибка на битом файле ---- */
function readJson(file, def) {
  const fp = path.join(DATA_DIR, file);
  try { return JSON.parse(fs.readFileSync(fp, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return def;
    const bad = fp + ".corrupt-" + Date.now();
    try { fs.renameSync(fp, bad); } catch {}
    console.error(`[data] ${file} битый (${e.message}) → сохранён как ${path.basename(bad)}, стартуем с пустым`);
    return def;
  }
}
function writeJsonSync(file, value) {
  const fp = path.join(DATA_DIR, file);
  const tmp = fp + ".tmp";
  try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, fp); }
  catch (e) { console.error(`[data] не сохранился ${file}:`, e.message); }
}
/* запись пачкой, но не позже 2 секунд — иначе поток вызовов откладывал её бесконечно */
const pending = new Map();
function saveLater(file, getValue) {
  if (pending.has(file)) return;
  pending.set(file, setTimeout(() => {
    pending.delete(file);
    writeJsonSync(file, getValue());
  }, 400));
}
function flushAll() {
  for (const [file, t] of pending) clearTimeout(t);
  pending.clear();
  writeJsonSync("calls.json", calls);
  try { writeJsonSync("orders.json", orders); } catch {}
  try { writeJsonSync("barorders.json", barOrders); } catch {}
  writeJsonSync("tables.json", tstate);
  writeJsonSync("mode.json", mode);
  writeJsonSync("history.json", history);
  writeJsonSync("bans.json", bans);
  writeJsonSync("subs.json", subs);
  writeJsonSync("guest.json", guestCfg);
  try { writeJsonSync("view.json", viewCfg); } catch {}
  try { writeJsonSync("stats.json", stats); } catch {}
  try { writeJsonSync("statlog.json", statlog); } catch {}
  try { writeJsonSync("flavors.json", flavors); } catch {}
  /* ⚠️ Эти три ДОЛГО отсутствовали, а первая строка функции гасит их отложенную
     запись `clearTimeout`. То есть штатный рестарт (деплой!) в неудачные 400 мс
     не просто не успевал их записать — он ОТМЕНЯЛ запись:
       sessions — только что выданный токен пропадал, планшет просил ПИН посреди смены;
       journal  — хвост журнала терялся при каждом деплое (note() пишется почти на всё);
       staff    — сотрудник показан добавленным, а его нет.
     Всё, что уходит через saveLater, обязано быть и здесь. */
  try { writeJsonSync("sessions.json", sessions); } catch {}
  try { writeJsonSync("staff.json", staff); } catch {}
  try { writeJsonSync("journal.json", journal); } catch {}
  try { writeJsonSync("events.json", events); } catch {}
}
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => { console.log(`[${sig}] сохраняю данные…`); flushAll(); process.exit(0); });

let calls = readJson("calls.json", []);
if (!Array.isArray(calls)) calls = [];
const save = () => saveLater("calls.json", () => calls);

let soundPing = 0;      // метка «проверка звука» — пульты пикают, увидев новую
let pingKind = "call";  // какой именно сигнал проиграть: вызов гостя или просрочка таймера

/* ===== ЗАКАЗЫ ЗАБИВКИ (Стамбул) =====
   Официант с телефона выбирает стол и пишет, что забить. Заказ падает на главный
   планшет кальянщика: он берёт его в работу и запускает стол. Заказ — это НАМЕРЕНИЕ,
   таймер он не трогает: таймер стартует только когда кальянщик реально запустил стол. */
const ORDERS_CAP = 500;                       // жёсткий предел массива в памяти
const ORDER_ACTIVE_MS = 6 * 60 * 60 * 1000;   // старше — на планшете не показываем
const ORDER_KEEP_MS = 24 * 60 * 60 * 1000;    // старше — забываем совсем
const ORDER_DUP_MS = 60 * 1000;               // повтор того же текста на тот же стол
let orders = readJson("orders.json", []);
/* Заказы на бар. Отдельно от заказов забивки: у них своя жизнь (бармен
   отмечает готовность) и свой адресат — барный планшет. */
let barOrders = readJson("barorders.json", []);
/* Когда по столу закрыли счёт — с этого момента прошлые кальяны к нему
   не относятся. Без этой отметки закрытый кальян всплывал бы у следующих гостей. */
let barCleared = readJson("barcleared.json", {});
const saveCleared = () => saveLater("barcleared.json", () => barCleared);
const BAR_CAP = 200;                                  // смена не делает больше
const BAR_DONE_TTL = 4 * 3600 * 1000;                 // готовые висят 4 часа, потом уходят
const saveBar = () => saveLater("barorders.json", () => barOrders);
if (!Array.isArray(orders)) orders = [];
const saveOrders = () => saveLater("orders.json", () => orders);
const orderActive = (o) => (o.status === "new" || o.status === "taken") && Date.now() - o.ts < ORDER_ACTIVE_MS;
/* стол запустили — значит заказы по нему выполнены; закрываем сами, чтобы кальянщик
   не тыкал одно и то же дважды (и чтобы напоминания перестали приходить). */
function closeOrdersFor(table, why, who) {
  let n = 0;
  for (const o of orders) {
    if (String(o.table) !== String(table) || !orderActive(o)) continue;
    o.status = "done"; o.doneTs = Date.now(); o.doneBy = who || ""; o.why = why || "";
    statOrder(o, "done", who);
    n++;
  }
  if (n) saveOrders();
  return n;
}

/* последние действия со столами — для кнопки «отменить».
   Стек СВОЙ у каждого сотрудника: отменить можно только собственный тап, не чужой. */
const undoStacks = new Map();      // staffId -> [{what, state, ts}]
const UNDO_MAX = 10;
const UNDO_TTL = 10 * 60 * 1000;   // старше 10 минут отменять уже нечего
function myUndo(actor) {
  const id = actor ? actor.id : "?";
  if (!undoStacks.has(id)) undoStacks.set(id, []);
  const st = undoStacks.get(id).filter((u) => Date.now() - u.ts < UNDO_TTL);
  undoStacks.set(id, st);
  return st;
}
/* ⚠️ Снимок берём ДО изменения, а В СТЕК кладём только ПОСЛЕ успешного применения.
   Раньше запись попадала в стек сразу, ещё до проверок, — и оставалась там даже
   когда запрос отклонён. Сценарий, стоивший бы гостей: жмёшь ⇄ «5 → 9», стол 9
   занят, приходит ошибка; через 8 минут стол 9 закрыли и посадили новых гостей;
   жмёшь ↩︎ — и снимок восьмиминутной давности затирает живую посадку. */
const undoSnapshot = () => JSON.parse(JSON.stringify(tstate));
function commitUndo(actor, what, key, state, arch) {
  if (!state) return;
  const st = myUndo(actor);
  st.push({ what, key, state, ts: Date.now(), arch: (arch || []).filter(Boolean) });
  if (st.length > UNDO_MAX) st.shift();
}

/* состояние столов (таймеры) — на сервере, чтобы планшет и телефон видели одно и то же.
   На столе может быть несколько кальянов: { "5": { hookahs: [{id, startedAt, round, roundStart}] } } */
let tstate = readJson("tables.json", {});
if (!tstate || typeof tstate !== "object" || Array.isArray(tstate)) tstate = {};
for (const [n, t] of Object.entries(tstate)) {          // миграция со старого «один таймер на стол»
  if (t && !Array.isArray(t.hookahs))
    tstate[n] = { hookahs: [{ id: "h1", startedAt: t.startedAt || Date.now(),
      round: t.round || 1, roundStart: t.roundStart || Date.now() }] };
}
/* ---- ревизия стола ----
   Счётчик изменений стола. Клиент прикладывает к закрытию ту ревизию, которую
   видел на экране: если между нажатием и приходом запроса стол успели поменять
   с другого устройства, закрытие не проходит — вместо того чтобы вслепую
   срубить чужую работу, пульт покажет свежее состояние. */
for (const t of Object.values(tstate)) if (t && typeof t.rev !== "number") t.rev = 1;
const bumpRev = (t) => { if (t) t.rev = (t.rev || 0) + 1; return t; };
let hSeq = 0;

/* ---- ЗАБИВКА (конструктор кальянщика) ----
   Кальянщик отмечает, ЧТО он сделал, а не только когда тапнул:
     build.heat   — фольга или калауд (способ прогрева),
     build.flavor — вкус/микс строкой,
   и этапы времени внутри первого круга:
     startedAt — поставил угли, ready — прогрелся, served — отдал гостю.
   Сейчас это только сбор данных: таймеры и круги работают ровно как раньше.
   Когда наберётся статистика (/pult/build.html), из неё выведем реальный
   норматив прогрева на фольге и на калауде — и уже тогда перекроим мультитаймер. */
const HEATS = ["foil", "kaloud"];
const HEAT_LABEL = { foil: "фольга", kaloud: "калауд" };

/* Кому конструктор и голос открыты. Значения в config.json → beta:
   "off" — выключено совсем, "admin" — только админ (бета-обкатка), "all" — всей смене.
   Так одна и та же сборка стоит на обеих точках, а поведение задаёт конфиг. */
const BETA = Object.assign({ build: "all", voice: "off" }, CFG.beta || {});
function betaOn(what, actor) {
  const v = BETA[what];
  if (v === "all") return true;
  if (v === "admin") return !!actor && actor.role === "admin";
  return false;
}
const betaFlags = (actor) => ({ build: betaOn("build", actor), voice: betaOn("voice", actor) });
/* В чаше может быть и один табак, и микс до десяти — поэтому забивка хранит
   СПИСОК составляющих (build.mix). Поле build.flavor остаётся как подпись для
   показа и для записей, сделанных до появления миксов. */
const MIX_MAX = 10;
const txt40 = (v) => String(v == null ? "" : v).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);

function mixPart(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") { const f = txt40(raw); return f ? { flavor: f, off: 1 } : null; }
  if (typeof raw !== "object") return null;
  const i = Number.isInteger(raw.cat) ? raw.cat : NaN;
  const c = catalog[i] && catalog[i].i === i ? catalog[i] : null;
  const pct = Number.isFinite(+raw.pct) && +raw.pct > 0 && +raw.pct <= 100 ? Math.round(+raw.pct) : 0;
  if (c) return { cat: c.i, brand: c.brand, ...(c.line ? { line: c.line } : {}), flavor: c.flavor,
    ...(pct ? { pct } : {}) };
  const f = txt40(raw.flavor);
  return f ? { flavor: f, off: 1, ...(pct ? { pct } : {}) } : null;
}
/* подпись микса: «Дабл эппл + Мята», в один табак — просто его название */
const mixLabel = (mix) => (mix || [])
  .map((m) => (m.flavor ? m.flavor + (m.pct ? " " + m.pct + "%" : "") : ""))
  .filter(Boolean).join(" + ");

function cleanBuild(raw) {
  if (!raw || typeof raw !== "object") return null;
  const heat = HEATS.includes(raw.heat) ? raw.heat : null;
  // новый вид (список) и старый (одна позиция) принимаем оба
  let src = Array.isArray(raw.mix) ? raw.mix : [];
  if (!src.length && (raw.cat != null || raw.flavor)) src = [{ cat: raw.cat, flavor: raw.flavor }];
  const seen = new Set();
  const mix = [];
  for (const one of src.slice(0, MIX_MAX)) {
    const m = mixPart(one);
    if (!m) continue;
    const k = m.cat != null ? "c" + m.cat : "f" + m.flavor.toLowerCase();
    if (seen.has(k)) continue;              // один и тот же табак дважды в чаше не бывает
    seen.add(k);
    mix.push(m);
  }
  if (!heat && !mix.length) return null;
  const b = { ...(heat ? { heat } : {}) };
  if (mix.length) {
    b.mix = mix;
    b.flavor = mixLabel(mix);
    // для одного табака сохраняем и плоские поля — так проще везде, где микса нет
    if (mix.length === 1) {
      if (mix[0].brand) b.brand = mix[0].brand;
      if (mix[0].line) b.line = mix[0].line;
      if (mix[0].cat != null) b.cat = mix[0].cat; else b.off = 1;
    }
  }
  return b;
}

/* plan — снимок норматива круга (мин) на момент запуска: смена времён кругов
   админом не пересчитывает уже дымящиеся кальяны задним числом */
const newHookah = (build) => ({ id: "h" + (++hSeq) + "-" + Math.random().toString(36).slice(2, 7),
  startedAt: Date.now(), round: 1, roundStart: Date.now(), plan: roundMinutes(1),
  ...(build ? { build } : {}) });
const newSid = () => "s" + crypto.randomBytes(5).toString("hex");   // id посадки: столы переиспользуются, посадка — нет
const saveTables = () => saveLater("tables.json", () => tstate);

/* Список вкусов руками не заводим: помним, что кальянщики уже писали, и
   подсказываем самое частое — через неделю это и есть реальное меню точки. */
let flavors = readJson("flavors.json", {});
if (!flavors || typeof flavors !== "object" || Array.isArray(flavors)) flavors = {};
const saveFlavors = () => saveLater("flavors.json", () => flavors);
const FLAVOR_CAP = 200, FLAVOR_TOP = 14;
function rememberFlavor(name) {
  if (!name) return;
  const f = flavors[name] || (flavors[name] = { n: 0, last: 0 });
  f.n++; f.last = Date.now();
  const keys = Object.keys(flavors);
  if (keys.length > FLAVOR_CAP) {                     // редкие и давние вытесняются
    keys.sort((a, b) => (flavors[a].n - flavors[b].n) || (flavors[a].last - flavors[b].last));
    while (keys.length > FLAVOR_CAP) delete flavors[keys.shift()];
  }
  saveFlavors();
}
const sortedFlavors = () => Object.entries(flavors)
  .sort((a, b) => (b[1].n - a[1].n) || (b[1].last - a[1].last)).map(([name]) => name);
const topFlavors = () => sortedFlavors().slice(0, FLAVOR_TOP);
/* для разбора речи список берём шире: чем больше знакомых названий видит модель,
   тем точнее «дабл яблоко» превращается в «Дабл эппл» */
const knownFlavors = (n) => sortedFlavors().slice(0, n || 60);

/* ---- КАТАЛОГ ТАБАКА (бренд · линейка · вкус) ----
   Собран из базы генератора миксов «Стамбула» (data/catalog.json).
   Речь сопоставляем ТОЛЬКО с ним: модели отдаём пронумерованный список и
   просим вернуть НОМЕР позиции, а не название — выдумать несуществующий
   табак при таком ответе невозможно. Не нашлось совпадения — так и пишем. */
let catalog = readJson("catalog.json", []);
if (!Array.isArray(catalog)) catalog = [];
catalog = catalog.filter((x) => x && x.flavor).map((x, i) => ({
  i, brand: String(x.brand || ""), line: String(x.line || ""), flavor: String(x.flavor),
  // русское название из справочника — такой же вариант произношения, как алиасы:
  // кальянщик скажет «барбарис», а на банке написано Barberry
  aliases: [...(Array.isArray(x.aliases) ? x.aliases : []), ...(x.ru ? [String(x.ru)] : [])]
    .map((a) => String(a).trim()).filter(Boolean),
  // состав вкуса — не название: ищем по нему, но он не должен перебивать имя
  desc: String(x.desc || ""),
  ...(x.strength ? { strength: String(x.strength) } : {}),
}));
const catTitle = (c) => [c.brand, c.line, c.flavor].filter(Boolean).join(" · ");
const catList = () => catalog.map((c) => `${c.i}|${catTitle(c)}${
  c.aliases.length ? " (он же " + c.aliases.join(", ") + ")" : ""}`).join("\n");
function forgetFlavor(name) {                        // вписали не то — убираем из подсказок
  if (!flavors[name]) return false;
  delete flavors[name];
  saveFlavors();
  return true;
}

/* ---- запрос к OpenAI: голос и разбор фразы. Без npm-зависимостей, как весь сервер ---- */
const OPENAI_KEY = process.env.OPENAI_API_KEY || CFG.openaiKey || "";
const VOICE_MODEL = CFG.voiceModel || "gpt-transcribe";
const PARSE_MODEL = CFG.parseModel || "gpt-5-mini";
const VOICE_MAX = 4 * 1024 * 1024;               // 4 МБ ≈ минута речи, больше не принимаем

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new Error("too big")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function openai(path, body, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: "api.openai.com", path, method: "POST", timeout: 30000,
      headers: { Authorization: "Bearer " + OPENAI_KEY, ...headers } }, (resp) => {
      let d = "";
      resp.on("data", (c) => (d += c));
      resp.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("плохой ответ OpenAI")); } });
    });
    r.on("timeout", () => { r.destroy(); reject(new Error("OpenAI не ответил за 30 с")); });
    r.on("error", reject);
    r.end(body);
  });
}
/* Подсказка распознавалке: без списка своих названий она пишет «Трофимов»
   вместо Trofimoff's и «Black Burn» вместо BlackBurn — а потом это приходится
   вытягивать вторым проходом. Отдаём бренды и ходовые вкусы прямо в речь.
   Список короткий намеренно: длинная подсказка размывает внимание модели. */
let speechHint = "";
function speechPrompt() {
  if (speechHint) return speechHint;
  const brands = [...new Set(catalog.map((c) => c.brand).filter(Boolean))];
  const flavors = [];
  for (const c of catalog) {                       // по одному-двум вкусам с бренда — как звучит марка
    if (flavors.filter((f) => f.b === c.brand).length < 4) flavors.push({ b: c.brand, f: c.flavor });
    if (flavors.length >= 34) break;
  }
  speechHint = "Кальянная. Кальянщик диктует: номер стола, табак, способ прогрева — фольга или калауд."
    + (brands.length ? " Бренды: " + brands.join(", ") + "." : "")
    + (flavors.length ? " Вкусы: " + flavors.map((x) => x.f).join(", ") + "." : "");
  return speechHint;
}

/* Расширение файла берём из типа, который прислал браузер: Safari пишет mp4,
   Chrome — webm, и OpenAI разбирает файл по имени, а не по содержимому. */
function transcribe(req, audio) {
  const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const ext = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/m4a": "m4a", "audio/mpeg": "mp3",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg" }[ct] || "webm";
  const mp = multipart({
    model: VOICE_MODEL,
    language: "ru",
    prompt: speechPrompt(),
  }, { name: "speech." + ext, type: ct || "audio/webm", data: audio });
  return openai("/v1/audio/transcriptions", mp.body, { "Content-Type": mp.type });
}

/* ================= РАЗБОР ФРАЗЫ СВОИМ КОДОМ =================
   Раньше распознанный текст уходил во вторую модель со всем каталогом в
   запросе: дорого (каталог целиком в каждой фразе), медленно (+2 секунды) и
   НЕСТАБИЛЬНО — одна и та же фраза давала разные ответы.
   Теперь ищем по своей базе обычным кодом: бесплатно, мгновенно и одинаково
   каждый раз. Модель осталась только на распознавании речи. */

const NUMS = ["ноль", "первый", "второй", "третий", "четвертый", "пятый", "шестой", "седьмой",
  "восьмой", "девятый", "десятый", "одиннадцатый", "двенадцатый", "тринадцатый", "четырнадцатый",
  "пятнадцатый", "шестнадцатый", "семнадцатый", "восемнадцатый", "девятнадцатый", "двадцатый",
  "двадцать первый", "двадцать второй", "двадцать третий", "двадцать четвертый", "двадцать пятый"];
const sNorm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9]+/g, " ").replace(/\s+/g, " ").trim();
/* латиница ↔ кириллица: «барбарис» должен находить Barberry, «бонче» — Bonche */
const CYR = { a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "дж",
  k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у",
  v: "в", w: "в", x: "кс", y: "и", z: "з" };
const cyr = (s) => sNorm(s)
  // сначала пары букв, иначе «ch» превратится в «кх» и Chabacco не найдётся
  .replace(/ch/g, "ч").replace(/sh/g, "ш").replace(/kh/g, "х").replace(/zh/g, "ж")
  .replace(/ph/g, "ф").replace(/ck/g, "к").replace(/th/g, "т")
  .replace(/[a-z]/g, (c) => CYR[c] || c).replace(/\s+/g, "");

/* Слова сравниваем по началу: русские окончания («барбарисом», «чизкейка»)
   не должны мешать. 5 букв совпало — считаем, что это то же слово.
   Плюс гасим гласные: «блэкберн» и «блакбурн» (транслит Black Burn) — одно и то же,
   а различаются только ими. Согласные при этом обязаны совпасть точно. */
const VOW = /[аоэеиыуюяёй]/g;
const fold = (s) => String(s || "").replace(VOW, "*");
function wordHit(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 5) return false;
  if (a.slice(0, n) === b.slice(0, n)) return true;
  return fold(a).slice(0, n) === fold(b).slice(0, n);
}

/* Индекс каталога: у каждой позиции набор слов из названия, русского названия,
   алиасов и бренда — по ним и ищем. */
let catIndex = [];
function buildCatIndex() {
  catIndex = catalog.map((c) => {
    const names = [c.flavor, ...(c.aliases || [])];
    const bw = new Set(sNorm(c.brand).split(" ").filter(Boolean));
    const words = new Set();
    for (const nm of names) {
      const ws = sNorm(nm).split(" ").filter((w) => w.length > 2 && !bw.has(w));
      for (const w of ws) { words.add(w); words.add(cyr(w)); }
      // «Cane Mint» вслух звучит одним словом «кейнмин» — ищем и склеенный вид
      if (ws.length > 1) { const j = ws.join(""); words.add(j); words.add(cyr(j)); }
    }
    const soft = new Set();
    for (const w of sNorm(c.desc || "").split(" ")) if (w.length > 2 && !words.has(w)) {
      soft.add(w); soft.add(cyr(w));
    }
    return { c, words: [...words], soft: [...soft], bkey: cyr(c.brand),
      brand: cyr(c.brand), brandWords: sNorm(c.brand).split(" ").map(cyr) };
  });
}

/* Ищем позицию каталога в куске фразы. Возвращаем лучшую и насколько уверены. */
function catSearch(text) {
  if (!catIndex.length && catalog.length) buildCatIndex();   // строим при первом обращении:
  const words = sNorm(text).split(" ").filter((w) => w.length > 2).map((w) => [w, cyr(w)]);
  if (!words.length) return null;
  const saidBrands = new Set();
  for (const it of catIndex)
    for (const [, wc] of words)
      if (it.brand && wc.length >= 4) {
        const a = fold(it.brand), b = fold(wc);
        if (a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5))) saidBrands.add(it.c.brand);
      }
  let best = null;
  const all = [];                 // все проходные варианты — из них соберём выбор брендов
  for (const it of catIndex) {
    // назвали бренд — позиция обязана быть этого бренда
    if (saidBrands.size && !saidBrands.has(it.c.brand)) continue;
    let hit = 0, nameHit = 0;
    // отдельно считаем слова САМОГО названия: по ним и меряем уверенность,
    // иначе алиасы раздувают её выше единицы и пропускают чужой табак
    const own = new Set();
    for (const w of sNorm(it.c.flavor).split(" ")) if (w.length > 2) { own.add(w); own.add(cyr(w)); }
    for (const w of it.words) {
      if (w.length < 3) continue;
      if (words.some(([wn, wc]) => wordHit(w, wn) || wordHit(w, wc))) {
        hit++;
        if (own.has(w)) nameHit++;
      }
    }
    let softHit = 0;
    for (const w of it.soft) {
      if (w.length < 3) continue;
      if (words.some(([wn, wc]) => wordHit(w, wn) || wordHit(w, wc))) softHit++;
    }
    if (!hit && !softHit) continue;
    // сколько слов названия нашлось — так и уверены; бренд добавляет вес
    const bset = new Set(sNorm(it.c.brand).split(" "));
    const nameWords = new Set(sNorm(it.c.flavor).split(" ").filter((w) => w.length > 2 && !bset.has(w)));
    // доля найденного в названии важнее абсолютного числа слов: у длинного
    // названия одно совпавшее слово почти ничего не значит
    const cover = nameWords.size ? Math.min(1, nameHit / nameWords.size) : 0;
    // бренд назван ровно этот (а не его линейка) — это сильный довод
    const exact = words.some(([, wc]) => wc.length >= 4 && fold(it.bkey) === fold(wc));
    /* Названо ровно это название — сильнейший довод. Без него составное
       транслитерированное имя («Clubnikakiwi») набирало hit=2 на одном слове
       «клубника» и обходило точное «Клубника» с hit=1. */
    const saidSet = new Set(words.flatMap(([wn, wc]) => [wn, wc]));
    const nameExact = nameWords.size > 0 && [...nameWords].every((w) => saidSet.has(w));
    const score = hit + cover * 2 + softHit * 0.35
      + (saidBrands.has(it.c.brand) ? 1.5 : 0) + (exact ? 1.2 : 0)
      + (nameExact ? 1.5 : 0)
      - Math.max(0, nameWords.size - hit) * 0.8;
    if (!best || score > best.score) best = { it, score, hit: hit + softHit, cover };
    if (score >= 2.5) all.push({ it, score, cover });
  }
  // либо назван бренд, либо название совпало заметно — иначе лучше «нет в каталоге»,
  // чем уверенно подставленный чужой табак
  if (!best) return null;
  if (best.cover < 0.5 && !saidBrands.size) return null;
  if (best.score < 2.5) return null;

  /* Бренд не назвали, а вкус с таким названием есть у многих («Клубника» — у 26).
     Угадывать бессмысленно: отдаём список, кальянщик выберет в карточке.
     Раньше при равной оценке побеждала та позиция, что раньше в каталоге, —
     то есть выбор между правильным и чужим табаком был случайным. */
  let alts = [];
  if (!saidBrands.size) {
    const seen = new Set([best.it.c.brand]);
    alts = all
      // порог был −0.6 и отсекал РАВНОЗНАЧНЫЕ варианты: «Клубника» есть у семи
      // брендов с одинаковой оценкой, а в выбор не попадал ни один
      .filter((x) => x.it !== best.it && x.cover >= best.cover - 0.01 && x.score >= best.score - 1.6)
      .sort((x, y) => y.score - x.score)
      .filter((x) => { if (seen.has(x.it.c.brand)) return false; seen.add(x.it.c.brand); return true; })
      .slice(0, 7)
      .map((x) => ({ i: x.it.c.i, brand: x.it.c.brand, line: x.it.c.line || "", flavor: x.it.c.flavor }));
  }
  return { cat: best.it.c, score: best.score, cover: best.cover,
           brandSaid: saidBrands.size > 0, alts,
           // только для диагностики /api/catsearch — на подбор не влияет
           top: all.sort((x, y) => y.score - x.score).slice(0, 8)
                   .map((x) => ({ brand: x.it.c.brand, flavor: x.it.c.flavor,
                                  score: +x.score.toFixed(2), cover: +x.cover.toFixed(2) })),
           saidBrands: [...saidBrands] };
}

/* В чаше бывает микс: «дабл эппл и мята со льдом» — надо найти ВСЕ табаки.
   Идём жадно: нашли позицию, вычеркнули её слова из фразы, ищем в остатке.
   Заодно запоминаем, на каком слове нашлась позиция — по этому месту потом
   привязываются проценты («Блэкберн малина 15%, Брауни 50%»). */
/* Микс ищем ПО КУСКАМ фразы, а не по всей разом: «малина 15%, потом Кейнмин
   10%, также Брауни 50%» — три отдельных куска, в каждом свой табак и свой
   процент. Жадный поиск по всей фразе на большом каталоге хватал лучшее
   совпадение где угодно и придумывал лишние позиции. */
const SPLIT_MIX = /[;.]|\s+(?:потом|также|затем|плюс|ещё|еще)\s+|,\s*(?=[а-яa-z\d])/gi;
function chunksOf(text) {
  return String(text || "").split(SPLIT_MIX).map((x) => (x || "").trim()).filter(Boolean);
}
function catSearchMix(text) {
  const out = [];
  let brandHint = "";
  for (const ch of chunksOf(text)) {
    if (out.length >= MIX_MAX) break;
    // бренд, названный в соседнем куске, помогает следующему («тоже Блэкберн»)
    const f = catSearch(ch) || (brandHint ? catSearch(brandHint + " " + ch) : null);
    if (!f) continue;
    if (out.some((x) => x.cat.i === f.cat.i)) continue;
    brandHint = f.cat.brand;
    out.push({ cat: f.cat, pct: pctIn(ch), alts: f.alts || [] });
  }
  return out;
}

/* Кандидаты для куска, который код не разобрал: все позиции названного бренда,
   а если бренд не назван — те, где совпало хоть одно слово. Список короткий,
   поэтому подсказка модели стоит копейки, в отличие от всего каталога. */
function candidatesFor(chunk, brandHint) {
  if (!catIndex.length && catalog.length) buildCatIndex();
  const words = sNorm(chunk).split(" ").filter((w) => w.length > 2).map((w) => [w, cyr(w)]);
  const brands = new Set();
  for (const it of catIndex)
    for (const [, wc] of words)
      if (it.bkey && wc.length >= 4) {
        const a = fold(it.bkey), b = fold(wc);
        if (a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5))) brands.add(it.c.brand);
      }
  if (!brands.size && brandHint) brands.add(brandHint);
  let list = brands.size
    ? catIndex.filter((it) => brands.has(it.c.brand))
    : catIndex.filter((it) => it.words.some((w) => words.some(([wn, wc]) => wordHit(w, wn) || wordHit(w, wc))));
  return list.slice(0, 160).map((it) => it.c);
}
/* доля в куске: «15 процентов», «15%», «15 %» */
function pctIn(chunk) {
  // ищем по СЫРОМУ тексту: нормализация выбрасывает знак «%», и «15%» терялось
  const m = String(chunk || "").toLowerCase().match(/(\d{1,3})\s*(?:%|процент)/);
  if (!m) return 0;
  const v = +m[1];
  return v > 0 && v <= 100 ? v : 0;
}

/* Доли микса: «малина 15%, брауни 50%». Процент приписываем ближайшему
   найденному табаку — обычно он стоит прямо перед числом или сразу после. */
function attachPercents(text, found) {
  if (found.length < 2) return found;
  const words = sNorm(text).split(" ");
  const pcts = [];
  for (let k = 0; k < words.length; k++) {
    const m = words[k].match(/^(\d{1,3})$/);
    const nxt = words[k + 1] || "";
    if (m && (/^процент/.test(nxt) || words[k].includes("%"))) pcts.push({ at: k, v: +m[1] });
    else {
      const inline = words[k].match(/^(\d{1,3})%$/);
      if (inline) pcts.push({ at: k, v: +inline[1] });
      else if (m && /^процент/.test(nxt)) pcts.push({ at: k, v: +m[1] });
      else if (m && k + 1 < words.length && /^%/.test(nxt)) pcts.push({ at: k, v: +m[1] });
    }
  }
  if (!pcts.length) return found;
  const taken = new Set();
  for (const p of pcts) {
    let best = -1, dist = 99;
    found.forEach((f, idx) => {
      if (taken.has(idx)) return;
      const d = Math.abs(f.at - p.at);
      if (d < dist) { dist = d; best = idx; }
    });
    if (best >= 0 && dist <= 6) { found[best].pct = p.v; taken.add(best); }
  }
  return found;
}

/* Способ прогрева — по корню слова, чтобы ловить любые падежи */
function heatOf(text) {
  const t = sNorm(text);
  if (/фольг/.test(t)) return "foil";
  if (/к[оа]ла?уд|kaloud/.test(t)) return "kaloud";
  return "";
}

/* Номер стола: и цифрой, и словом. «на четвертый стол», «стол 12». */
function tableOf(text, maxTable) {
  const t = sNorm(text);
  let m = t.match(/(?:стол\w*\s+)(\d{1,2})|(\d{1,2})\s*(?:й|ый|ой)?\s*стол/);
  if (m) {
    const n = +(m[1] || m[2]);
    if (n >= 1 && n <= maxTable) return n;
  }
  // \b в JS считает границей только латиницу — по русским словам он молчит,
  // поэтому сравниваем словами, а не регуляркой
  const w = t.split(" ");
  for (let i = NUMS.length - 1; i >= 1; i--) {
    if (i > maxTable) continue;
    const parts = NUMS[i].split(" ");
    for (let k = 0; k + parts.length <= w.length; k++)
      if (parts.every((pp, q) => w[k + q] === pp)) return i;
  }
  return null;
}

/* Фраза на несколько столов режется по упоминаниям стола. */
function splitByTables(text) {
  const raw = String(text || "");
  const t = raw.toLowerCase();
  const at = [];                                   // где встречается слово «стол»
  let pos = 0;
  while (true) {
    const i = t.indexOf("стол", pos);
    if (i < 0) break;
    at.push(i);
    pos = i + 4;
  }
  if (!at.length) return [raw];
  // Начало куска — до трёх слов перед «стол» (номер бывает из двух слов, плюс
  // предлог), но НЕ залезая в предыдущий стол: иначе сосед утащит чужой вкус.
  const starts = at.map((i, k) => {
    const floor = k === 0 ? 0 : at[k - 1] + 4;
    // Забираем назад только числительные и предлоги («на двадцать пятый стол»).
    // Слепо брать три слова нельзя: во фразе на два стола сосед утащит чужой вкус.
    const NUMW = new Set([...NUMS.slice(1).flatMap((x) => x.split(" ")), "на", "в", "за", "для"]);
    let start = i;
    for (let back = 0; back < 3; back++) {
      const q = raw.lastIndexOf(" ", Math.max(0, start - 2));
      const from = q < 0 ? floor : q;
      if (from < floor) break;
      const word = sNorm(raw.slice(from, start));
      if (!word || !(NUMW.has(word) || /^\d{1,2}$/.test(word))) break;
      start = from;
      if (q < 0) break;                      // дошли до начала фразы
    }
    return Math.max(start, floor);
  });
  return starts
    .map((st, k) => raw.slice(st, k + 1 < starts.length ? starts[k + 1] : undefined))
    .filter((x) => x.trim());
}

/* Добор непонятых кусков моделью.
   Код сравнивает БУКВЫ, а вслух название звучит иначе: «Cane Mint» = «кейнмин»,
   транслитерацией это не берётся. Поэтому куски, где код ничего не нашёл,
   отдаём модели — но не весь каталог, а короткий список кандидатов
   (обычно позиции названного бренда). Стоит копейки и не тормозит. */
async function askModelForChunks(jobs) {
  if (!jobs.length || !OPENAI_KEY) return;
  const lines = jobs.map((j, k) =>
    `#${k}: «${j.chunk}»\n` + j.cands.map((c) => `   ${c.i}|${catTitle(c)}`).join("\n")).join("\n");
  try {
    const r = await openai("/v1/chat/completions", JSON.stringify({
      model: PARSE_MODEL, reasoning_effort: "minimal", max_completion_tokens: 400,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content:
        "Кальянщик называет табак вслух, распознавание речи пишет как услышало: "
        + "«кейнмин» = Cane Mint, «барби оранж» = Barbie Orange, «супернова» = Supernova. "
        + "Для каждого куска выбери НОМЕР подходящей позиции из его списка. "
        + "Ничего не подходит — null. Верни JSON {\"a\":{\"<номер куска>\":число|null}}." },
        { role: "user", content: lines }],
    }), { "Content-Type": "application/json" });
    const got = JSON.parse(r.choices[0].message.content).a || {};
    jobs.forEach((j, k) => {
      const v = got[String(k)];
      const i = Number.isInteger(v) ? v : NaN;
      const c = catalog[i] && catalog[i].i === i ? catalog[i] : null;
      if (c && j.cands.some((x) => x.i === c.i)) j.found = c;
    });
  } catch (e) { /* не ответила — остаёмся с тем, что нашёл код */ }
}

/* Полный разбор: идём ПО КУСКАМ. Кусок разобран кодом только если совпадение
   явное (совпала большая часть названия) — иначе код скорее навредит: он
   сравнивает буквы и на «Кейнмин» уверенно выдаёт «Black Honey».
   Всё неявное уходит модели с коротким списком кандидатов. */
async function parseSpeechFull(text, maxTable) {
  const parts = parseSpeech(text, maxTable);      // столы, способ, «остаток»
  const jobs = [];
  for (const it of parts) {
    it.mix = [];
    let hint = "";
    for (const ch of chunksOf(it.full || it.heard || "")) {
      const f = catSearch(ch);
      const sure = f && f.cover >= 0.6;            // название совпало заметно
      if (sure) {
        hint = f.cat.brand;
        if (!it.mix.some((m) => m.cat === f.cat.i) && it.mix.length < MIX_MAX)
          it.mix.push({ cat: f.cat.i, brand: f.cat.brand, ...(f.cat.line ? { line: f.cat.line } : {}),
            flavor: f.cat.flavor, ...(pctIn(ch) ? { pct: pctIn(ch) } : {}) });
        continue;
      }
      if (jobs.length >= 10) continue;
      const cands = candidatesFor(ch, hint);
      if (cands.length) jobs.push({ chunk: ch, cands, part: it, pct: pctIn(ch) });
    }
  }
  await askModelForChunks(jobs);
  for (const j of jobs) {
    if (!j.found) continue;
    const it = j.part;
    if (it.mix.some((m) => m.cat === j.found.i) || it.mix.length >= MIX_MAX) continue;
    it.mix.push({ cat: j.found.i, brand: j.found.brand,
      ...(j.found.line ? { line: j.found.line } : {}), flavor: j.found.flavor,
      ...(j.pct ? { pct: j.pct } : {}) });
  }
  for (const it of parts) {
    if (it.mix.length) {
      it.flavor = mixLabel(it.mix);
      it.offCatalog = false;
      if (it.mix.length === 1) { it.brand = it.mix[0].brand; it.cat = it.mix[0].cat; }
      else { it.cat = null; it.brand = ""; }
    }
  }
  return parts.filter((it) => it.table || it.mix.length || it.heat);
}

/* Разбор всей фразы: список столов с забивкой. Никаких запросов наружу. */
function parseSpeech(text, maxTable) {
  return splitByTables(text).map((part) => {
    const n = tableOf(part, maxTable);
    const found = catSearchMix(part);   // синхронная часть; добор моделью — ниже, в voiceMix
    const heat = heatOf(part);
    if (!n && !found.length && !heat) return null;
    if (found.length) {
      const mix = found.map((f) => ({ cat: f.cat.i, brand: f.cat.brand,
        ...(f.cat.line ? { line: f.cat.line } : {}), flavor: f.cat.flavor,
        ...(f.pct ? { pct: f.pct } : {}) }));
      return { table: n, heat, mix, flavor: mixLabel(mix),
        ...(mix.length === 1 ? { brand: mix[0].brand, line: mix[0].line || "", cat: mix[0].cat } : { cat: null }),
        heard: part.trim().slice(0, 120), full: part.trim() };
    }
    // ничего не нашли — отдаём услышанное, пусть человек поправит
    const STOP = new Set(["на", "и", "еще", "ещё", "в", "с", "а", "стол", ...NUMS.slice(1).flatMap((x) => x.split(" "))]);
    const rest = sNorm(part).split(" ")
      .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w)
        && !/^стол/.test(w) && !/^фольг/.test(w) && !/^к[оа]ла?уд/.test(w))
      .join(" ").trim();
    return { table: n, heat, brand: "", line: "", flavor: rest.slice(0, 40), mix: [],
      cat: null, ...(rest ? { offCatalog: true } : {}),
      heard: part.trim().slice(0, 120), full: part.trim() };
  }).filter(Boolean);
}

/* ---- Проверка бренда НАШИМ кодом, а не просьбой к модели ----
   Промпт «бренд обязан совпасть» модель соблюдает через раз: одна и та же фраза
   в разных прогонах давала то Trofimoff's Hurtleberry, то Tangiers Blueberry.
   Поэтому сверяем сами: если в услышанном назван бренд, а модель выбрала
   позицию другого — отменяем выбор. Лучше «нет в каталоге», чем чужой табак. */
const TRANSLIT = { a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и",
  j: "дж", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т",
  u: "у", v: "в", w: "в", x: "кс", y: "й", z: "з" };
const norm = (x) => String(x || "").toLowerCase().replace(/[^a-zа-яё0-9]+/g, "");
const toCyr = (x) => norm(x).replace(/[a-z]/g, (ch) => TRANSLIT[ch] || ch);
/* Ищем бренд по началу слова: «Трофимов» в речи и «Trofimoff's» в каталоге
   совпадают первыми шестью буквами, а дальше расходятся — этого достаточно. */
function brandsIn(text) {
  const t = norm(text), tc = toCyr(text);
  const hit = new Set();
  for (const b of new Set(catalog.map((c) => c.brand).filter(Boolean))) {
    for (const v of [norm(b), toCyr(b)]) {
      const key = v.slice(0, Math.min(6, v.length));
      if (key.length >= 4 && (t.includes(key) || tc.includes(key))) { hit.add(b); break; }
    }
  }
  return hit;
}

/* Номер из ответа модели превращаем в НАШУ запись каталога. Номера нет —
   оставляем услышанное с пометкой offCatalog: в карточке это видно сразу. */
function fromCatalog(x, heard) {
  const i = Number.isInteger(x && x.cat) ? x.cat : (x && x.cat != null ? parseInt(x.cat, 10) : NaN);
  let c = catalog[i] && catalog[i].i === i ? catalog[i] : null;
  const heat = HEATS.includes(x && x.heat) ? x.heat : "";
  if (c) {
    const said = brandsIn(heard || (x && x.heard) || "");
    // бренд назвали, а выбран чужой — снимаем выбор и оставляем услышанное
    if (said.size && !said.has(c.brand)) {
      const raw = String((x && x.flavor) || c.flavor || "").slice(0, 40);
      return { heat, brand: "", line: "", flavor: raw, cat: null, offCatalog: true,
        wrongBrand: [...said][0] };
    }
    return { heat, brand: c.brand, line: c.line, flavor: c.flavor, cat: c.i };
  }
  const raw = String((x && x.flavor) || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 40);
  return { heat, brand: "", line: "", flavor: raw, cat: null, ...(raw ? { offCatalog: true } : {}) };
}

function multipart(fields, file) {
  const b = "----serp" + crypto.randomBytes(8).toString("hex");
  const parts = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
    + `Content-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from("\r\n"), Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: "multipart/form-data; boundary=" + b };
}

/* ---- сотрудники, сессии, журнал действий ---- */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;        // сессия сотрудника живёт месяц
const SESSION_DEVICE_MS = 365 * 24 * 60 * 60 * 1000; // общий планшет на стойке не разлогинивается
const JOURNAL_CAP = 1000;

let staff = readJson("staff.json", []);
if (!Array.isArray(staff)) staff = [];
if (!staff.length) {                            // первый запуск: админ с ключом заведения
  staff = [{ id: "a1", name: "Администратор", pin: String(PULT_KEY), role: "admin", active: true, createdAt: Date.now() }];
  writeJsonSync("staff.json", staff);
}
const saveStaff = () => saveLater("staff.json", () => staff);

let sessions = readJson("sessions.json", {});
if (!sessions || typeof sessions !== "object") sessions = {};
const saveSessions = () => saveLater("sessions.json", () => sessions);

/* архив закрытых столов: сессия не исчезает по крестику, а уходит в файл */
const HISTORY_CAP = 3000;
let history = readJson("history.json", []);
if (!Array.isArray(history)) history = [];
const saveHistory = () => saveLater("history.json", () => history);

function archive(actor, key, label, hookahs, reason, sid) {
  if (!hookahs || !hookahs.length) return;
  const now = Date.now();
  const rec = {
    ts: now, by: actor ? actor.name : "—", reason, sid,
    table: /^c/.test(String(key)) ? (label || "свой стол") : +key,
    custom: /^c/.test(String(key)),
    hookahs: hookahs.map((h) => ({
      rounds: h.round,
      minutes: Math.round((now - h.startedAt) / 60000),
    })),
  };
  rec.totalMinutes = Math.max(...rec.hookahs.map((h) => h.minutes));
  try { logEvent("close", { t: rec.table, min: rec.totalMinutes, hk: rec.hookahs.length, why: reason,
    who: rec.by, sid, hooks: rec.hookahs.map((h) => [h.rounds, h.minutes]) }); } catch {}
  history.push(rec);
  if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);
  saveHistory();
  return rec;                       // ссылку помнит «отменить»: откат убирает запись из архива
}

/* ---- СТОРОЖ ЗАБЫТЫХ СТОЛОВ ----
   Столы иногда просто не закрывают: на соседней точке стол провисел 10 часов,
   а на второй — больше суток. Такой стол врёт в «занято», навсегда держит
   «просрочено» на пульте и портит статистику смены.

   Правило намеренно осторожное — закрываем ТОЛЬКО когда совпало всё:
     1) заведение сейчас закрыто (вне часов приёма) — то есть смена кончилась;
     2) кальян старше порога (по умолчанию 6 часов, `abandonHours` в конфиге).
   В рабочее время не трогаем ничего: длинная посадка — это нормально. */
const ABANDON_MS = Math.max(1, Number(CFG.abandonHours || 6)) * 3600000;
function sweepAbandoned() {
  try {
    if (isOpenNow()) return;
    const now = Date.now();
    let closed = 0;
    for (const [k, t] of Object.entries(tstate)) {
      const hs = (t && t.hookahs) || [];
      if (!hs.length) continue;
      const oldest = Math.min(...hs.map((h) => h.startedAt || now));
      if (now - oldest < ABANDON_MS) continue;
      const hours = Math.round((now - oldest) / 360000) / 10;
      archive(null, k, t.label, hs, `закрыт автоматически: забыт (${hours} ч)`, t.sid);
      delete tstate[k];
      closed++;
      note(null, `стол ${k} закрыт автоматически — висел ${hours} ч`);
    }
    if (closed) { saveTables(); console.log(`[сторож] закрыто забытых столов: ${closed}`); }
  } catch (e) { console.log("[сторож] сбой:", String(e.message || e).slice(0, 90)); }
}
setInterval(sweepAbandoned, 10 * 60 * 1000).unref?.();
setTimeout(sweepAbandoned, 30000).unref?.();

let journal = readJson("journal.json", []);
if (!Array.isArray(journal)) journal = [];
const saveJournal = () => saveLater("journal.json", () => journal);

/* кто, что и когда сделал — видно всей смене */
function note(actor, text, meta) {
  journal.push({ ts: Date.now(), who: actor ? actor.name : "—", whoId: actor ? actor.id : "",
    text, ...(meta || {}) });
  if (journal.length > JOURNAL_CAP) journal = journal.slice(-JOURNAL_CAP);
  saveJournal();
  console.log(`[журнал] ${actor ? actor.name : "—"}: ${text}`);
}
const staffById = (id) => staff.find((s) => s.id === id && s.active);

/* ===== Оповещения на главный планшет =====
   Кальянщик ведёт столы с телефона (перенёс гостей, обновил угли), а планшет
   на стойке об этом не знает: он видит только конечное состояние и молча
   перерисовывает плитку. Поэтому копим короткую ленту событий и показываем её
   на пульте всплывающей строкой со звуком.
   В памяти, без файла: событие живёт 3 минуты, переживать рестарт ему незачем. */
/* 14 часов = смена целиком. Строку на планшете гасит ТОЛЬКО мастер кнопкой
   «Принял», и она должна пережить перезагрузку планшета, а не исчезнуть
   непрочитанной. Столько же живёт и история сообщений (`GET /api/events`):
   «а что мне писали час назад» — обычный вопрос в конце смены. */
const EVENTS_TTL = 14 * 60 * 60 * 1000;
const EVENTS_CAP = 400;
/* ⚠️ Раньше лента жила ТОЛЬКО в памяти, и деплой (штатная операция!) уничтожал
   неразобранные записки: строка на пульте просто пропадала, никто не узнавал,
   что сообщение было. Теперь на диске, как и всё остальное. */
let events = readJson("events.json", []);
if (!Array.isArray(events)) events = [];
const saveEvents = () => saveLater("events.json", () => events);
/* src — метка УСТРОЙСТВА-источника (не сотрудника): тот, кто нажал, своё же
   оповещение видеть не должен, а под одним ПИНом можно сидеть и с телефона,
   и с планшета одновременно. */
const srcOf = (req) => {
  const k = String(req.headers["x-pult-key"] || "");
  return k ? crypto.createHash("sha1").update(k).digest("hex").slice(0, 12) : "";
};
function pushEvent(req, actor, kind, text, extra) {
  events.push({ id: crypto.randomBytes(6).toString("hex"), ts: Date.now(),
    kind, text, who: actor ? actor.name : "—", byId: actor ? actor.id : "",
    src: srcOf(req), ...(extra || {}) });
  const cut = Date.now() - EVENTS_TTL;
  events = events.filter((e) => e.ts > cut).slice(-EVENTS_CAP);
  saveEvents();
}

/* ---- сервисный режим: идут работы, уведомления никому не шлём ---- */
/* Сервисные сообщения смене: пишет управляющий из панели, к столу НЕ привязаны.
   Живут на экране, пока смена не нажмёт «Понятно» или пока не выйдет срок:
   висеть до утра объявление про поставщика не должно. */
const NOTICE_TTL = 8 * 3600 * 1000;
let notices = readJson("notices.json", []);
if (!Array.isArray(notices)) notices = [];
const saveNotices = () => saveLater("notices.json", () => notices);
const liveNotices = () => notices.filter((n) => Date.now() - n.ts < NOTICE_TTL);
let mode = readJson("mode.json", { service: false, blockGuests: false, note: "", since: 0, by: "" });
if (!mode || typeof mode !== "object") mode = { service: false, blockGuests: false, note: "", since: 0, by: "" };
const saveMode = () => saveLater("mode.json", () => mode);

/* ---- баны устройств (кнопка «Бан» на пульте) ---- */
const BAN_MS = 24 * 60 * 60 * 1000;      // устройство — сутки
const BAN_IP_MS = 60 * 60 * 1000;        // IP — только час: за одним IP сидит всё заведение
let bans = readJson("bans.json", { dids: {}, ips: {} });
if (!bans || typeof bans !== "object") bans = {};
bans.dids = bans.dids || {}; bans.ips = bans.ips || {};
function saveBans() {
  const now = Date.now();
  for (const m of [bans.dids, bans.ips])
    for (const k of Object.keys(m)) if (m[k] < now) delete m[k];
  saveLater("bans.json", () => bans);
}
/* ─── ПРОФИЛЬ ИЗ ПАНЕЛИ УПРАВЛЕНИЯ (Serp Cloud) ───────────────────────────────
   Общий модуль cloud.js — тот же, что у остальных точек. Поведение при
   недоступности панели и правила применения описаны там же. */
const cloud = require("./cloud.js").init({
  cfg: CFG, dataDir: DATA_DIR,
  onProfile: (p) => { applyGuestFromCloud(p); applyStaffFromCloud(p); applyVenueFromCloud(p); },
});
/* События онбординга в панель (первый вход, наклейки, первый вызов/кальян) — см. onboarding.js.
   Без cfg.cloud модуль молчит; каждое событие уезжает один раз (data/onboarding-sent.json). */
const onboarding = require("./onboarding.js").init({ cfg: CFG, dataDir: DATA_DIR });

/* ---- команда из панели ----
   ⚠️ ПРАВИЛА, от которых зависит, сможет ли смена войти вечером:
   1. только добавляем и правим — НИКОГДА не удаляем и не гасим;
   2. админов и запись с ключом заведения не трогаем вообще;
   3. чужой занятый ПИН не переписываем;
   4. пустой список из панели не делает ничего. */
function applyStaffFromCloud(p) {
  const team = p && p.team;
  if (!team || typeof staff === "undefined" || !Array.isArray(staff)) return;
  const digits = (v) => /^\d{4,9}$/.test(String(v || ""));
  const taken = (pin, exceptId) => staff.some((x) => x.active !== false && x.pin === pin && x.id !== exceptId);
  let added = 0, fixed = 0;

  const upsert = (name, pin, role) => {
    if (!name || !digits(pin)) return;
    const byPin = staff.find((x) => x.pin === pin && x.active !== false);
    if (byPin) {                                   // человек уже есть — поправим только имя
      if (byPin.role !== "admin" && byPin.name !== name) { byPin.name = name; fixed++; }
      return;
    }
    const byName = staff.find((x) => x.active !== false && x.role !== "admin" &&
      String(x.name || "").toLowerCase() === name.toLowerCase());
    if (byName) {
      if (!taken(pin, byName.id) && byName.pin !== String(PULT_KEY)) { byName.pin = pin; fixed++; }
      return;
    }
    if (taken(pin)) return;                        // ПИН занят другим — не создаём коллизию
    staff.push({ id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name, pin, role, active: true, createdAt: Date.now() });
    added++;
  };

  for (const m of team.staff || []) upsert(String(m.name || "").slice(0, 40).trim(), String(m.pin || "").trim(), "master");
  if (digits(team.devicePin)) {
    const dev = staff.find((x) => x.role === "device" && x.active !== false);
    if (dev) { if (dev.pin !== team.devicePin && !taken(team.devicePin, dev.id)) { dev.pin = team.devicePin; fixed++; } }
    else upsert("Планшет стойки", team.devicePin, "device");
  }
  /* Админский ПИН из панели НЕ применяем: это ключ заведения, ошибка в нём
     отрезала бы доступ всем. Только замечаем расхождение. */
  if (team.adminPin && team.adminPin !== String(PULT_KEY))
    console.log("[cloud] админский ПИН в панели отличается от ключа заведения — не трогаю");

  if (added || fixed) { saveStaff(); console.log(`[cloud] команда: добавлено ${added}, поправлено ${fixed}`); }
}

/* Состав смены с точки — в панель (только мастера и планшет: админов и ключ
   заведения панель не ведёт). */
function pushStaffToCloud() {
  try {
    const list = staff.filter((x) => x.active !== false && x.role === "master")
      .map((x) => ({ name: x.name, pin: x.pin }));
    cloud.pushStaff(list);
  } catch (e) {}
}

function applyGuestFromCloud(p) {
  const g = p && p.guest;
  if (!g || !guestCfg) return;
  if (Array.isArray(g.buttons) && g.buttons.length) {
    guestCfg.buttons = g.buttons.map((b, i) => {
      const local = guestCfg.buttons[i] || {};
      return { ...local,
        id: local.id || "b" + (i + 1),
        icon: b.icon || local.icon || "",
        label: b.label || local.label || "",
        sub: b.sub === undefined ? local.sub : b.sub };
    });
  }
  if (g.info) guestCfg.info = g.info;
}

/* ---- операционные настройки из панели ----
   Панель — источник правды по столам, часам приёма вызовов, кругам и часу
   сдачи смены. Применяем идемпотентно и пишем в лог ТОЛЬКО изменения.
   Локальный config.json не переписываем: панель молчит → точка живёт по нему
   и по кэшу профиля (data/cloud-profile.json), а профиля без этих полей
   (старая панель) = как раньше.
   Круги — особый случай: их админ меняет и на точке (/api/view). Поэтому
   значение из панели применяется, когда ОНО изменилось с прошлого раза
   (запоминаем в view.json как cloudRounds), а не при каждом опросе —
   иначе правка на точке жила бы до ближайшего опроса панели. */
function applyVenueFromCloud(p) {
  const v = p && p.venue;
  if (!v || typeof v !== "object") return;
  const changes = [];

  // столы: занятый стол с большим номером не должен исчезнуть с пульта
  const tables = Math.round(+v.tables);
  if (tables > 0 && tables !== CFG.tables) {
    let want = tables;
    const busyMax = Object.keys(tstate || {}).filter((k) => /^\d+$/.test(k)).reduce((m, k) => Math.max(m, +k), 0);
    if (want < busyMax) { console.log(`[cloud] столов: панель просит ${want}, но занят стол ${busyMax} — оставляю ${busyMax}`); want = busyMax; }
    if (want !== CFG.tables) { changes.push(`столов: ${CFG.tables} → ${want}`); CFG.tables = want; }
  }

  // часы приёма вызовов: только ЧЧ:ММ. Точка без объекта hours в config.json
  // работает круглосуточно — такой график панелью не включаем, чтобы не
  // закрыть гостям вызов среди вечера незаметно для смены.
  const hh = /^([01]?\d|2[0-3]):[0-5]\d$/;
  const h = v.hours && typeof v.hours === "object" ? v.hours : {};
  if (CFG.hours && typeof CFG.hours === "object") {
    for (const k of ["from", "to"]) {
      const val = String(h[k] || "").trim();
      if (hh.test(val) && val !== CFG.hours[k]) { changes.push(`часы ${k === "from" ? "с" : "до"}: ${CFG.hours[k]} → ${val}`); CFG.hours[k] = val; }
    }
  }

  // час сдачи смены (0–23); shiftDayKey читает переменную при каждом вызове
  const sh = Number(h.shiftResetHour !== undefined ? h.shiftResetHour : v.shiftResetHour);
  if (Number.isInteger(sh) && sh >= 0 && sh <= 23 && sh !== SHIFT_RESET_HOUR) {
    changes.push(`час сдачи смены: ${SHIFT_RESET_HOUR} → ${sh}`); SHIFT_RESET_HOUR = sh;
  }

  // круги (минуты)
  const r = v.rounds && typeof v.rounds === "object" ? v.rounds : {};
  const rr = { r1: +r.r1, r2: +r.r2, r3: +r.r3 };
  if ([rr.r1, rr.r2, rr.r3].every((x) => Number.isFinite(x) && x > 0)) {
    const seen = viewCfg.cloudRounds || null;
    const same = !!seen && seen.r1 === rr.r1 && seen.r2 === rr.r2 && seen.r3 === rr.r3;
    if (!same) {
      const n = { r1: clampMin(rr.r1, viewCfg.r1), r2: clampMin(rr.r2, viewCfg.r2), r3: clampMin(rr.r3, viewCfg.r3) };
      if (n.r1 !== viewCfg.r1 || n.r2 !== viewCfg.r2 || n.r3 !== viewCfg.r3)
        changes.push(`круги: ${viewCfg.r1}/${viewCfg.r2}/${viewCfg.r3} → ${n.r1}/${n.r2}/${n.r3}`);
      Object.assign(viewCfg, n); Object.assign(ROUNDS, n);
      viewCfg.rs = normRounds(n);                 // здесь круги — список (rs); панель шлёт три числа
      viewCfg.cloudRounds = rr; saveView();
    }
  }
  for (const c of changes) console.log("[cloud] " + c);
}

/* Гостевые вызовы по QR: на точках без наклеек эндпойнт должен быть закрыт,
   а не «просто никем не используемый» — он доступен из интернета без ключа.
   Значение из панели (модуль «qr») ПЕРЕВЕШИВАЕТ локальный конфиг. */
const LOCAL_MODULES = { qr: CFG.guestCalls === true };
const guestCalls = () => cloud.moduleOn("qr", LOCAL_MODULES.qr);
const effectiveModules = () => cloud.modules(LOCAL_MODULES);

/* Какие страницы каким модулем закрываются. */
const MODULE_PAGES = {
  "/guest.html":       { mod: "qr",    local: () => LOCAL_MODULES.qr },
  "/pult/qr.html":     { mod: "qr",    local: () => LOCAL_MODULES.qr },
  "/zal/index.html":   { mod: "zal",   local: () => true },
  "/pult/build.html":  { mod: "build", local: () => true },
  "/pult/bans.html":   { mod: "bans",  local: () => true },
  "/pult/diag.html":   { mod: "diag",  local: () => true },
};

const LIMITS_ON = CFG.limits !== false;        // выключатель всех ограничений для гостей
const AUTH_THROTTLE = CFG.authThrottle !== false; // выключатель защиты от подбора входа
const isBanned = (did, ip) =>
  LIMITS_ON && ((did && bans.dids[did] > Date.now()) || (ip && bans.ips[ip] > Date.now()));

/* ---- Web Push: уведомления кальянщику на телефон («на смене») ---- */
let webpush = null;
try { webpush = require("web-push"); } catch { console.error("web-push не установлен — пуши выключены"); }
if (webpush && CFG.vapid)
  webpush.setVapidDetails("mailto:admin@stambul42.ru", CFG.vapid.publicKey, CFG.vapid.privateKey);
/* Нативные пуши Android-обёртки (FCM): System WebView не умеет Web Push,
   приложение регистрирует FCM-токен через /api/push/fcm. Ключ сервисного
   аккаунта — секрет, лежит рядом с сервером, нет файла — канал выключен. */
const fcm = require("./fcm");
fcm.init((CFG.fcm && CFG.fcm.keyFile) || require("path").join(__dirname, "fcm-service-account.json"));
const pushReady = () => !!(webpush && CFG.vapid) || fcm.ready();

const SHIFT_MS = 14 * 60 * 60 * 1000;    // смена сама гаснет
const SUBS_CAP = 20;                     // не больше стольких подписок
/* только настоящие push-сервисы: иначе сервер можно заставить долбить чужие адреса */
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
let subs = readJson("subs.json", []);
if (!Array.isArray(subs)) subs = [];
subs = subs.filter((s) => s && ((s.sub && typeof s.sub.endpoint === "string") || typeof s.fcm === "string"));
const saveSubs = () => saveLater("subs.json", () => subs);
/* Единая отправка на одну подписку: Web Push или FCM — по типу записи.
   Возвращает true / "dead" (подписку удалять) / false (ошибка, не трогаем). */
function sendTo(s, obj, ttlSec) {
  if (s.fcm) return fcm.send(s.fcm, obj, ttlSec);
  if (!webpush || !CFG.vapid) return Promise.resolve(false);
  return webpush.sendNotification(s.sub, JSON.stringify(obj), { TTL: ttlSec })
    .then(() => true)
    .catch((e) => {
      if (e.statusCode === 404 || e.statusCode === 410) return "dead";
      console.error("[push]", e.statusCode || e.message);
      return false;
    });
}

/* «на смене»: админ и общий планшет (device) видят занятые столы всегда; кальянщик (master) —
   только когда заступил на смену. Смена = включённые пуши на любом устройстве сотрудника
   ЛИБО ручная отметка на этом устройстве (кнопка «на смене», работает и без пушей). */
function pushShiftIds() {
  const now = Date.now();
  const ids = new Set();
  for (const s of subs) if (s.onShift && now - s.shiftTs < SHIFT_MS) ids.add(s.staffId);
  return ids;
}
function sessionOf(req) {
  const k = req.headers["x-pult-key"];
  return typeof k === "string" ? sessions[k] : null;
}
/* видит ли занятые столы (роль + любая смена сотрудника) */
function actorOnShift(req, actor) {
  if (!actor) return false;
  if (actor.service) return true;              // Serp Cloud читает состояние зала, но не выполняет действий
  // actor.device — кальянщик, заступивший за общий планшет: он физически у стойки
  if (actor.role === "admin" || actor.role === "device" || actor.device) return true;
  if (pushShiftIds().has(actor.id)) return true;
  const sess = sessionOf(req);
  return !!(sess && sess.shiftTs && Date.now() - sess.shiftTs < SHIFT_MS);
}
/* отметил ли смену именно ЭТО устройство/сотрудник — для вида кнопки «на смене» */
function selfOnShift(req, actor) {
  if (!actor) return false;
  const now = Date.now();
  const sess = sessionOf(req);
  if (sess && sess.shiftTs && now - sess.shiftTs < SHIFT_MS) return true;
  for (const s of subs) if (s.staffId === actor.id && s.onShift && now - s.shiftTs < SHIFT_MS) return true;
  return false;
}

function validPushEndpoint(ep) {
  try { const u = new URL(ep); return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname); }
  catch { return false; }
}
/* Тихий отказ: люди на смене есть, а получателей пуша ноль. Пустой список не даёт
   ни исключения, ни строчки в логе — раньше это выглядело как «всё в порядке»,
   хотя не уходило ничего. Ругаемся не чаще раза в час, чтобы не залить журнал. */
function staffOnShiftNow() {
  const now = Date.now(), ids = new Set();
  for (const k of Object.keys(sessions)) {
    const s = sessions[k];
    if (s && s.shiftTs && now - s.shiftTs < SHIFT_MS) ids.add(s.staffId);
  }
  return ids;
}
let lastPushWarn = 0;
function pushAudit(where, targetCount) {
  if (targetCount > 0) return;
  const people = staffOnShiftNow().size;
  if (!people) return;                        // на смене никого — молчание законно
  if (Date.now() - lastPushWarn < 3600 * 1000) return;
  lastPushWarn = Date.now();
  console.error(`[push] ТИХИЙ ОТКАЗ (${where}): на смене ${people} чел., получателей 0 — подписки протухли`);
}
function pushTargetCount() {
  const now = Date.now();
  return subs.filter((s) => s.onShift && now - s.shiftTs < SHIFT_MS).length;
}
function pushCall(call, repeat) {
  if (!pushReady()) return;
  if (mode.service) { console.log(`[сервис] пуш подавлен · стол ${call.table}`); return; }
  const now = Date.now();
  const obj = {
    title: (repeat ? "⏰ Не принят · " : "🔔 ") + `Стол ${call.table}`,
    body: kindLabel(call.kind) + (call.comment ? ": " + call.comment : ""),
    tag: call.id,
  };
  let dirty = false;
  const targets = subs.filter((s) => s.onShift && now - s.shiftTs < SHIFT_MS);
  pushAudit("вызов", targets.length);
  const jobs = targets.map((s) =>
    sendTo(s, obj, 600).then((r) => {
      if (r === "dead") { s.dead = true; dirty = true; console.log("[push] подписка протухла, удаляю"); }
    }));
  Promise.allSettled(jobs).then(() => {
    if (dirty) { subs = subs.filter((s) => !s.dead); saveSubs(); }
  });
}
/* заказ забивки от официанта — всем, кто на смене (главный планшет в их числе) */
function pushOrder(o, repeat) {
  if (!pushReady()) return 0;
  if (mode.service) { console.log(`[сервис] пуш заказа подавлен · стол ${o.table}`); return 0; }
  const now = Date.now();
  const obj = {
    title: (repeat ? "⏰ Заказ ждёт · " : "💨 Забить ") + `стол ${o.table}`,
    body: (o.text || "на усмотрение кальянщика") + (o.by ? " · " + o.by : ""),
    tag: "order-" + o.id,
    url: "/pult/",
  };
  let dirty = false;
  const targets = subs.filter((s) => s.onShift && now - s.shiftTs < SHIFT_MS);
  const jobs = targets.map((s) =>
    sendTo(s, obj, 900).then((r) => { if (r === "dead") { s.dead = true; dirty = true; } }));
  Promise.allSettled(jobs).then(() => {
    if (dirty) { subs = subs.filter((s) => !s.dead); saveSubs(); }
  });
  return targets.length;
}
/* заказ висит непринятым — напоминаем раз в ORDER_NAG_MS, пока его не взяли */
const ORDER_NAG_MS = 4 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const o of orders) {
    if (o.status !== "new" || now - o.ts > ORDER_ACTIVE_MS) continue;
    if (now - (o.nagTs || o.ts) < ORDER_NAG_MS) continue;
    o.nagTs = now;
    pushOrder(o, true);
  }
}, 30 * 1000);

/* адресный пуш одному сотруднику — для ответа на его записку */
function pushToStaff(staffId, title, body) {
  if (!pushReady() || !staffId) return 0;
  const now = Date.now();
  const targets = subs.filter((s) => s.staffId === staffId && now - s.shiftTs < SHIFT_MS);
  const obj = { title, body, tag: "reply-" + now, url: "/zal/" };
  for (const s of targets) sendTo(s, obj, 900);
  return targets.length;
}

/* сервисное сообщение от админа всем, кто сейчас на смене */
function pushBroadcast(from, text) {   // работает и в сервисном режиме: админ шлёт осознанно
  const now = Date.now();
  const targets = subs.filter((s) => s.onShift && now - s.shiftTs < SHIFT_MS);
  if (pushReady()) {
    const obj = { title: "📢 " + from, body: text, tag: "broadcast-" + now };
    let dirty = false;
    const jobs = targets.map((s) => sendTo(s, obj, 3600)
      .then((r) => { if (r === "dead") { s.dead = true; dirty = true; } }));
    Promise.allSettled(jobs).then(() => {
      if (dirty) { subs = subs.filter((s) => !s.dead); saveSubs(); }
    });
  }
  return targets.length;
}

/* ===== Уведомления «пора к столу» =====
   Раньше про просрочку знал только открытый пульт и пищал сам — а браузер глушит звук,
   пока по экрану не коснулись. Теперь время кругов считает сервер и шлёт обычное
   уведомление: его звук играет система, ничего трогать не нужно. */
const ROUNDS = CFG.rounds || { r1: 25, r2: 15, r3: 15 };

/* Круги задаются СПИСКОМ: сколько их и по сколько минут каждый — настройка админа.
   Последний круг в списке действует и для всех следующих: гость может сидеть
   пятый час, а придумывать ему шестое, седьмое и восьмое число незачем.
   r1/r2/r3 остаются для совместимости со старыми записями и старыми пультами. */
const ROUND_MIN = 3, ROUND_MAX = 90, ROUNDS_MAX = 8;
function normRounds(v) {
  let rs = Array.isArray(v && v.rs) && v.rs.length ? v.rs : [v && v.r1, v && v.r2, v && v.r3];
  rs = rs.map((x) => Math.min(ROUND_MAX, Math.max(ROUND_MIN, Math.round(Number(x)) || 0)))
         .filter((x) => x >= ROUND_MIN).slice(0, ROUNDS_MAX);
  if (!rs.length) rs = [ROUNDS.r1, ROUNDS.r2, ROUNDS.r3];
  return rs;
}

/* ---- общий для всех устройств вид пульта ----
   Раньше «простой вид / кольца / время кругов» жили в localStorage каждого устройства —
   у всех по-разному. Теперь ведущая копия на сервере: админ настроил один раз — у всех одинаково.
   Время кругов отсюда же берёт и сервер для уведомлений «пора к столу». */
const clampMin = (v, d) => { v = +v; return isFinite(v) ? Math.min(90, Math.max(3, Math.round(v))) : d; };
let viewCfg = readJson("view.json", { r1: ROUNDS.r1, r2: ROUNDS.r2, r3: ROUNDS.r3, view: "digits", simple: false });
viewCfg = {
  r1: clampMin(viewCfg.r1, ROUNDS.r1), r2: clampMin(viewCfg.r2, ROUNDS.r2), r3: clampMin(viewCfg.r3, ROUNDS.r3),
  rs: normRounds(viewCfg),
  view: viewCfg.view === "rings" ? "rings" : "digits", simple: !!viewCfg.simple,
  whiteNum: !!viewCfg.whiteNum,
  // что в последний раз прислала панель — чтобы не перетирать правку админа на точке (см. applyVenueFromCloud)
  ...(viewCfg.cloudRounds ? { cloudRounds: viewCfg.cloudRounds } : {}),
};
const saveView = () => saveLater("view.json", () => viewCfg);

const roundMinutes = (round) => {
  const rs = viewCfg.rs;
  return rs[Math.min(Math.max(1, round), rs.length) - 1];
};

/* ---- ФИНАЛЬНЫЙ КРУГ ----
   Кругов у заведения ровно столько, сколько задал админ (у Стамбула три).
   Последний в списке — финальный: с него кальян не продлевают, а ЗАВЕРШАЮТ
   двойным нажатием (action "finish"). Круга с номером больше не существует —
   запрет держит сервер, интерфейс лишь повторяет его словами. */
const finalRound = () => viewCfg.rs.length;

/* ---- погода на точке (крыша — прямо зависит от дождя и ветра) ----
   Open-Meteo, без ключа. Сервер тянет раз в 15 мин и раздаёт всем пультам —
   чтобы каждый планшет не долбил API. Кемерово, ТЦ «Гринвич». */
const WX_LAT = 55.354, WX_LON = 86.087;
const WX_URL = `https://api.open-meteo.com/v1/forecast?latitude=${WX_LAT}&longitude=${WX_LON}` +
  "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation" +
  "&hourly=weather_code,precipitation,precipitation_probability,wind_gusts_10m" +
  "&timezone=Asia/Krasnoyarsk&wind_speed_unit=ms&forecast_hours=12";
const WX_GUST_WARN = 11;                   // м/с — порывы, о которых стоит предупредить
let weather = null;

function wmo(c) {
  if (c === 0) return { e: "☀️", t: "ясно" };
  if (c === 1) return { e: "🌤", t: "малооблачно" };
  if (c === 2) return { e: "⛅", t: "облачно" };
  if (c === 3) return { e: "☁️", t: "пасмурно" };
  if (c === 45 || c === 48) return { e: "🌫", t: "туман" };
  if (c >= 51 && c <= 57) return { e: "🌦", t: "морось" };
  if (c >= 61 && c <= 67) return { e: "🌧", t: "дождь" };
  if (c >= 71 && c <= 77) return { e: "🌨", t: "снег" };
  if (c >= 80 && c <= 82) return { e: "🌧", t: "ливень" };
  if (c === 85 || c === 86) return { e: "🌨", t: "снегопад" };
  if (c >= 95) return { e: "⛈", t: "гроза" };
  return { e: "🌡", t: "" };
}

function computeWeather(d) {
  const cur = d.current || {};
  const h = d.hourly || {};
  const times = h.time || [];
  const now = cur.time;
  let i = -1;
  for (let k = 0; k < times.length; k++) { if (times[k] <= now) i = k; else break; }
  if (i < 0) i = 0;
  let heads = null;
  for (let k = i + 1; k < times.length && k <= i + 8; k++) {   // заглядываем на ~8 часов
    const prec = (h.precipitation || [])[k] || 0;
    const prob = (h.precipitation_probability || [])[k] || 0;
    const gust = (h.wind_gusts_10m || [])[k] || 0;
    const code = (h.weather_code || [])[k] || 0;
    const rain = prec >= 0.3 || prob >= 60 || code >= 61;   // морось с низкой вероятностью не тревожим
    const wind = gust >= WX_GUST_WARN;
    if (rain || wind) {
      const inH = k - i;
      const w = wmo(code);
      const at = String(times[k]).slice(11, 16);
      heads = rain
        ? { kind: "rain", inH, at, text: `${w.t || "осадки"} ~через ${inH} ч (${at})` }
        : { kind: "wind", inH, at, text: `порывы ${Math.round(gust)} м/с ~через ${inH} ч (${at})` };
      break;
    }
  }
  const w = wmo(cur.weather_code || 0);
  return {
    t: Math.round(cur.temperature_2m), feels: Math.round(cur.apparent_temperature),
    emoji: w.e, label: w.t,
    wind: Math.round(cur.wind_speed_10m), gust: Math.round(cur.wind_gusts_10m),
    heads, ts: Date.now(),
  };
}

function fetchWeather() {
  https.get(WX_URL, (r) => {
    let buf = "";
    r.on("data", (c) => { buf += c; if (buf.length > 200000) r.destroy(); });
    r.on("end", () => { try { weather = computeWeather(JSON.parse(buf)); }
      catch (e) { console.error("[погода] разбор:", e.message); } });
  }).on("error", (e) => console.error("[погода]", e.message));
}
fetchWeather();
setInterval(fetchWeather, 15 * 60 * 1000);

function pushOverdue(key, label, h) {
  if (!pushReady() || mode.service) return;
  const now = Date.now();
  const where = /^c/.test(String(key)) ? `«${label || "стол"}»` : "Стол " + key;
  const obj = {
    title: "⏰ " + where,
    body: `Пора к столу — круг ${h.round} вышел`,
    tag: "overdue-" + key + "-" + h.id,
  };
  const targets = subs.filter((x) => x.onShift && now - x.shiftTs < SHIFT_MS);
  pushAudit("таймер", targets.length);
  let dirty = false;
  const jobs = targets.map((s) => sendTo(s, obj, 300)
    .then((r) => { if (r === "dead") { s.dead = true; dirty = true; } }));
  /* раньше метку dead никто не сохранял: после рестарта труп возвращался из subs.json */
  Promise.allSettled(jobs).then(() => {
    if (dirty) { subs = subs.filter((s) => !s.dead); saveSubs(); }
  });
  console.log(`[таймер] ${where} · круг ${h.round} вышел — ${targets.length ? `уведомление ушло на ${targets.length}` : "УВЕДОМЛЕНИЕ НЕ УШЛО: получателей нет"}`);
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, t] of Object.entries(tstate)) {
    for (const h of t.hookahs || []) {
      const limit = (h.plan || roundMinutes(h.round)) * 60000;
      if (now - h.roundStart < limit) { if (h.notified) { delete h.notified; changed = true; } continue; }
      if (h.notified) {
        // напоминаем раз в 5 минут, пока к столу не подошли
        if (now - h.notified > 5 * 60000) { h.notified = now; changed = true; pushOverdue(key, t.label, h); }
        continue;
      }
      h.notified = now; changed = true;
      statReminder(/^c/.test(String(key)) ? (t.label || "стол") : +key, h.round, h.plan, t.sid);
      pushOverdue(key, t.label, h);
    }
  }
  if (changed) saveTables();
}, 20 * 1000);

/* вызов не приняли за 3 минуты — напомнить пушем ещё раз (один раз) */
setInterval(() => {
  const now = Date.now();
  for (const c of calls)
    if (c.status === "new" && !c.repushed && now - c.ts > 3 * 60 * 1000 && now - c.ts < 30 * 60 * 1000) {
      c.repushed = true; pushCall(c, true); save();
    }
}, 30 * 1000);

/* ===== Статистика смены (идея Каро): дневные счётчики =====
   Копим только числа — ни имён, ни устройств. Ключ — дата по времени заведения.
   Часть метрик (закрытые столы, средняя сессия) считается из history на лету. */
const STATS_DAYS = 60;
const LATE_MIN = 10;                          // порог значимой задержки отметки, минут (строго больше)
const LATE_CRIT_MIN = 20;                     // существенная задержка, минут (строго больше)
let stats = readJson("stats.json", {});
if (!stats || typeof stats !== "object" || Array.isArray(stats)) stats = {};
const saveStats = () => saveLater("stats.json", () => stats);
const TZ_MIN = (CFG.hours && CFG.hours.tzOffsetMinutes) || 420;
const DAY_START_H = 11;                       // операционный день заведения: 11:00 → 03:00 следующего утра
const dayKey = (ts) => new Date((ts || Date.now()) + TZ_MIN * 60000 - DAY_START_H * 3600000).toISOString().slice(0, 10);

// Смена заканчивается в SHIFT_RESET_HOUR (по умолчанию 04:00), независимо от границы статистического дня.
// Старая сессия не может сама «пережить» новое утро: сотрудник входит ПИНом заново.
// let, а не const: панель может поменять час (applyVenueFromCloud) без перезапуска.
let SHIFT_RESET_HOUR = Number.isFinite(+CFG.shiftResetHour) ? +CFG.shiftResetHour : 4;
const shiftResetLabel = () => String(SHIFT_RESET_HOUR).padStart(2, "0") + ":00";
const shiftDayKey = (ts) => new Date((ts || Date.now()) + TZ_MIN * 60000 - SHIFT_RESET_HOUR * 3600000).toISOString().slice(0, 10);
function resetExpiredShift() {
  const today = shiftDayKey();
  let sessionsChanged = false, subsChanged = false;
  for (const sess of Object.values(sessions)) {
    if (!sess || typeof sess !== "object") continue;
    // Миграция уже открытых пультов: первый деплой не обрывает смену посреди работы.
    if (!sess.shiftDay) { sess.shiftDay = shiftDayKey(sess.shiftTs || Date.now()); sessionsChanged = true; }
    if (sess.shiftTs && shiftDayKey(sess.shiftTs) !== today) { sess.shiftTs = 0; sessionsChanged = true; }
    if (sess.workerSince && shiftDayKey(sess.workerSince) !== today) {
      delete sess.workerId; delete sess.workerSince; sessionsChanged = true;
    }
  }
  for (const sub of subs) {
    if (sub && sub.onShift && (!sub.shiftTs || shiftDayKey(sub.shiftTs) !== today)) {
      sub.onShift = false; subsChanged = true;
    }
  }
  if (sessionsChanged) saveSessions();
  if (subsChanged) saveSubs();
}
// Аналитика из существующей хроники: не меняет stats.json и не трогает работу пульта.
const JUNK_ROUND_S = 60, DUR_ROUNDS_MAX = 5;
function detailFromLog(ev) {
  const o = { junk: 0, real: 0, realLate10: 0, realLate20: 0, durs: {}, plans: {}, who: {}, overs: [], acts: 0, anon: 0 };
  if (!Array.isArray(ev)) return o;
  const who = (name) => (o.who[name] || (o.who[name] = { starts: 0, rounds: 0, late10: 0, junk: 0 }));
  for (const e of ev) {
    const name = e.who || null;
    if (["start", "round", "close", "ack", "done", "move"].includes(e.e)) { o.acts++; if (!name || /планшет/i.test(name)) o.anon++; }
    if (e.e === "start" && name) who(name).starts++;
    if (e.e !== "round") continue;
    const durS = Number(e.durS), junk = Number.isFinite(durS) && durS < JUNK_ROUND_S;
    if (junk) { o.junk++; if (name) who(name).junk++; continue; }
    o.real++;
    const overS = Number.isFinite(e.overS) ? e.overS : (Number(e.over) || 0) * 60;
    o.overs.push(Math.max(0, Math.round(overS)));
    if (e.late10) o.realLate10++;
    if (e.late20) o.realLate20++;
    if (name) { who(name).rounds++; if (e.late10) who(name).late10++; }
    const r = Number(e.r);
    if (Number.isFinite(durS) && r >= 1 && r <= DUR_ROUNDS_MAX) {
      (o.durs[r] || (o.durs[r] = [])).push(durS);
      if (Number.isFinite(Number(e.plan))) o.plans[r] = Number(e.plan);
    }
  }
  return o;
}

function statDay(ts) {
  const k = dayKey(ts);
  if (!stats[k]) {
    stats[k] = { starts: 0, rounds: 0, overCount: 0, overMin: 0, reminders: 0,
      late10Count: 0, late10Min: 0, late20Count: 0, calls: {}, byHour: {} };
    const keys = Object.keys(stats).sort();
    while (keys.length > STATS_DAYS) delete stats[keys.shift()];
  }
  return stats[k];
}
/* хроника дня — чтобы «проваливаться» в день и видеть, что за чем шло.
   Только столы и время, без имён (кто делал — есть в журнале пульта). */
const STATLOG_DAYS = 30;
const STATLOG_CAP = 2000;                     // событий на день, больше — режем старые
let statlog = readJson("statlog.json", {});
if (!statlog || typeof statlog !== "object" || Array.isArray(statlog)) statlog = {};
const saveStatlog = () => saveLater("statlog.json", () => statlog);
function logEvent(e, data) {
  const k = dayKey();
  if (!statlog[k]) {
    statlog[k] = [];
    const keys = Object.keys(statlog).sort();
    while (keys.length > STATLOG_DAYS) delete statlog[keys.shift()];
  }
  statlog[k].push({ ts: Date.now(), e, ...data });
  if (statlog[k].length > STATLOG_CAP) statlog[k] = statlog[k].slice(-STATLOG_CAP);
  saveStatlog();
}

function statStart(t, who, hk, sid, build) {       // на стол поставили новый кальян
  onboarding.mark("first-start");                                       // онбординг: первый кальян на столе
  const d = statDay();
  d.starts++;
  const hour = new Date(Date.now() + TZ_MIN * 60000).getUTCHours();
  d.byHour[hour] = (d.byHour[hour] || 0) + 1;
  const wx = weather ? { wt: weather.t, ww: weather.wind } : {};   // погода в момент запуска: крыша
  const b = build || {};
  logEvent("start", { t, who, hk, sid, ...wx,
    ...(b.heat ? { heat: b.heat } : {}), ...(b.flavor ? { fl: b.flavor } : {}), ...(b.brand ? { br: b.brand } : {}),
    // состав микса отдельным списком: аналитика считает каждый табак, а не строку
    ...(b.mix && b.mix.length > 1
      ? { mix: b.mix.map((m) => (m.pct ? m.flavor + "|" + m.pct : m.flavor)) } : {}) });
  saveStats();
}

/* ---- события забивки. Агрегаты в stats.json НЕ трогаем: всё считается
   на лету из хроники в /api/build, поэтому старая статистика не ломается. ---- */
function statBuild(t, h, who, sid, late) {         // забивку записали (или поправили) после запуска
  const b = h.build || {};
  logEvent("build", { t, ...(b.heat ? { heat: b.heat } : {}), ...(b.flavor ? { fl: b.flavor } : {}),
    ...(late ? { late: 1 } : {}), who, sid });
}
function statStage(t, h, stage, who, sid) {        // «прогрелся» / «отдал гостю»
  const b = h.build || {};
  const secs = Math.max(0, Math.round((Date.now() - h.startedAt) / 1000));
  logEvent("stage", { t, st: stage, s: secs,
    ...(b.heat ? { heat: b.heat } : {}), ...(b.flavor ? { fl: b.flavor } : {}), ...(b.brand ? { br: b.brand } : {}),
    // подача: сколько прошло с отметки «прогрелся» — это чистый сервис, без прогрева
    ...(stage === "served" && h.ready ? { fromReadyS: Math.round((Date.now() - h.ready) / 1000) } : {}),
    who, sid });
}
function statRound(t, round, roundStart, who, planSnap, sid) {   // круг закрыт тапом «угли обновили»
  const d = statDay();
  d.rounds++;
  const durS = Math.round((Date.now() - roundStart) / 1000);
  const plan = planSnap || roundMinutes(round);
  const overSeconds = durS - plan * 60;
  const overM = overSeconds > 0 ? Math.round(overSeconds / 60) : 0;
  // техническая метрика (задержка > 1 мин) — остаётся для хроники и диагностики
  if (overSeconds > 60) { d.overCount = (d.overCount || 0) + 1; d.overMin = (d.overMin || 0) + overM; }
  // показатель качества: строго больше 10 мин; ровно 10:00 — ещё в пределах допуска
  if (overSeconds > LATE_MIN * 60) {
    d.late10Count = (d.late10Count || 0) + 1;
    d.late10Min = (d.late10Min || 0) + overM;
  }
  if (overSeconds > LATE_CRIT_MIN * 60) d.late20Count = (d.late20Count || 0) + 1;
  logEvent("round", { t, r: round, over: overM, overS: Math.max(0, overSeconds),
    late10: overSeconds > LATE_MIN * 60, late20: overSeconds > LATE_CRIT_MIN * 60,
    durS, plan, who, sid });
  saveStats();
}
function statCall(kind, t, txt, sid, did) {
  const d = statDay();
  d.calls[kind] = (d.calls[kind] || 0) + 1;
  // did кладём, чтобы «скан → вызов» считался по устройству, а не по совпадению времени
  logEvent("call", { t, k: kind, sid, ...(did ? { did } : {}), ...(txt ? { txt: String(txt).slice(0, 200) } : {}) });
  saveStats();
}
/* Гость отсканировал QR и открыл страницу — даже если ничего не нажал.
   Это единственный способ увидеть, что связка «наклейка → страница» работает.
   Одно устройство на одном столе в пределах VISIT_DEDUP_MS — один заход,
   иначе перезагрузка страницы и возврат из фона накрутят цифры. */
const VISIT_DEDUP_MS = 15 * 60 * 1000;
const visitSeen = new Map();                  // did|стол → ts последнего засчитанного захода
function statVisit(t, did) {
  const key = did + "|" + t;
  const now = Date.now();
  if (now - (visitSeen.get(key) || 0) < VISIT_DEDUP_MS) return false;
  visitSeen.set(key, now);
  if (visitSeen.size > 5000) for (const [k, ts] of visitSeen) if (now - ts > VISIT_DEDUP_MS) visitSeen.delete(k);
  logEvent("visit", { t, did });
  console.log(`[visit] стол ${t} · did ${String(did).slice(0, 6)}…`);
  return true;
}
/* заказ забивки: создан официантом / взят в работу / закрыт.
   waitS у take и done — сколько заказ ждал от создания: это и есть скорость зала. */
function statOrder(o, what, who) {
  const d = statDay();
  d.orders = d.orders || { new: 0, taken: 0, done: 0, cancel: 0, waitSum: 0, waitCount: 0 };
  d.orders[what] = (d.orders[what] || 0) + 1;
  const waitS = what === "new" ? 0 : Math.round((Date.now() - o.ts) / 1000);
  if (what === "taken") { d.orders.waitSum += waitS; d.orders.waitCount++; }
  logEvent("order", { t: o.table, st: what, who: who || o.by,
    ...(o.text ? { txt: String(o.text).slice(0, 200) } : {}),
    ...(what === "new" ? {} : { waitS }) });
  saveStats();
}
function statReminder(t, round, plan, sid) {             // стол ушёл в просрочку (повторы не считаем)
  const d = statDay();
  d.reminders++;
  logEvent("overdue", { t, r: round, plan: plan || roundMinutes(round), sid });
  saveStats();
}

/* ---- подпись стола в QR: /t/5-a3f8c1b2e4 вместо угадываемого /t/5 ---- */
function tableToken(n) {
  return crypto.createHmac("sha256", String(CFG.qrSecret || ""))
    .update("table:" + n).digest("hex").slice(0, 10);
}
/* ---- QR-наклейки на лету ----
   Раньше PNG рисовал tools/make-qr.py (python + модуль qrcode), и их надо было
   класть в public/qr руками — новая точка после раскатки оставалась с картинками
   эталона под чужой подписью. Теперь SVG считает сам сервер
   (tools/vendor/qrcode.js, MIT, Kazuhiko Arase). Адрес в коде = хост, с которого
   пришёл запрос (или CFG.publicUrl): у каждой точки свой домен. */
let qrLib = null;
try { qrLib = require("./tools/vendor/qrcode.js"); }
catch (e) { console.error("[qr] tools/vendor/qrcode.js не загрузился — наклейки не генерируются:", e.message); }
const qrCache = new Map();                    // url → svg; наклеек на точке десятки, память копеечная
function publicOrigin(req) {
  if (CFG.publicUrl) return String(CFG.publicUrl).replace(/\/$/, "");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (/^(127\.|localhost)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}
function qrSvg(url) {
  if (!qrLib) return null;
  let svg = qrCache.get(url);
  if (svg) return svg;
  const q = qrLib(0, "M"); q.addData(url); q.make();   // 0 = размер подбирается сам
  const n = q.getModuleCount(), pad = 2, size = n + pad * 2;   // тихая зона 2 модуля, как в make-qr.py
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + pad} ${y + pad}h1v1h-1z`;
  svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  if (qrCache.size > 500) qrCache.clear();    // чужие Host-заголовки не должны раздувать кэш
  qrCache.set(url, svg);
  return svg;
}
function tokenOk(n, token) {
  if (!CFG.qrSecret) return true;                 // секрет не задан — режим совместимости
  const a = Buffer.from(String(token || ""));
  const b = Buffer.from(tableToken(n));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* Вызов пришёл с гостевой страницы по подписанной ссылке: подпись в теле (s/sig/token)
   либо в Referer вида /t/5-a3f8c1b2e4 — фронт не меняем, браузер шлёт его сам. */
function fromSignedQr(req, b, n) {
  const m = String(req.headers.referer || "").match(/\/t\/(\d{1,3})-([a-f0-9]{10})(?:[/?#]|$)/);
  const sig = String((b && (b.s || b.sig || b.token)) || (m && +m[1] === n ? m[2] : "") || "");
  return !!sig && tokenOk(n, sig);
}

/* ---- часы работы: вне графика вызовы не принимаются ---- */
function isOpenNow() {
  const h = CFG.hours;
  if (!h || !h.enabled) return true;
  const now = new Date(Date.now() + (h.tzOffsetMinutes || 0) * 60000);
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [fh, fm] = String(h.from || "0:00").split(":").map(Number);
  const [th, tm] = String(h.to || "0:00").split(":").map(Number);
  const from = fh * 60 + fm, to = th * 60 + tm;
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to; // через полночь
}

/* ---- лимиты ---- */
const ipLog = new Map();      // ip -> [ts]
const venueLog = [];          // все вызовы заведения за минуту
const authFail = new Map();   // ip -> [ts] неверных ключей (опрос пульта)
const loginFail = new Map();  // ip -> [ts] неверных ПИНов (вход)
const visitIp = new Map();    // ip -> [ts] отметок «страница открыта» (счётчик сканов QR)
let authFailAll = [];

function slidingAllowed(map, key, windowMs, max) {
  const now = Date.now();
  const arr = (map.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { map.set(key, arr); return false; }
  arr.push(now); map.set(key, arr);
  return true;
}
function venueAllowed() {
  const now = Date.now();
  while (venueLog.length && now - venueLog[0] > VENUE_WINDOW_MS) venueLog.shift();
  if (venueLog.length >= VENUE_MAX) return false;
  venueLog.push(now); return true;
}

const KINDS = { master: "Позвать кальянщика", coals: "Заменить угли", other: "Другое",
  notice: "Сообщение управляющего" }; // запасные подписи для старых вызовов

/* ---- гостевая страница: кнопки вызова и блок «Пока вы ждёте» правятся админом с пульта ---- */
const GUEST_DEF = {
  buttons: [
    { id: "master", icon: "🫖", label: "Позвать кальянщика", sub: "подойдёт к вашему столу", done: "Кальянщик уже идёт к вам", withComment: false },
    { id: "coals", icon: "🔥", label: "Заменить угли", sub: "освежим жар без ожидания", done: "Сейчас обновим угли", withComment: false },
    { id: "other", icon: "✍️", label: "Другой вопрос", sub: "напишите пару слов — придём с ответом", done: "Вопрос передан кальянщику", withComment: true },
  ],
  info: "Кальянщик видит вызов сразу — звонить или ловить его взглядом не нужно.\nХотите новый вкус? Скажите кальянщику про крепость и настроение — соберёт микс под вас.",
};
let guestCfg = readJson("guest.json", GUEST_DEF);
if (!guestCfg || !Array.isArray(guestCfg.buttons) || !guestCfg.buttons.length) guestCfg = GUEST_DEF;
const saveGuest = () => saveLater("guest.json", () => guestCfg);
const kindOf = (k) => guestCfg.buttons.find((x) => x.id === k);
const kindLabel = (k) => (kindOf(k) || {}).label || KINDS[k] || "Вызов";

/* ---- уборка: память не должна расти бесконечно ---- */
function gc() {
  const now = Date.now();
  const before = calls.length;
  calls = calls.filter((c) => now - c.ts < RETENTION_MS);
  if (calls.length > CALLS_CAP) calls = calls.slice(-CALLS_CAP);
  if (calls.length !== before) save();
  const wasOrders = orders.length;
  orders = orders.filter((o) => now - o.ts < ORDER_KEEP_MS);
  if (orders.length > ORDERS_CAP) orders = orders.slice(-ORDERS_CAP);
  if (orders.length !== wasOrders) saveOrders();
  for (const [k, arr] of ipLog) {
    const live = arr.filter((t) => now - t < IP_WINDOW_MS);
    if (live.length) ipLog.set(k, live); else ipLog.delete(k);
  }
  for (const map of [authFail, loginFail])
    for (const [k, arr] of map) {
      const live = arr.filter((t) => now - t < AUTH_WINDOW_MS);
      if (live.length) map.set(k, live); else map.delete(k);
    }
  saveBans();
}
setInterval(gc, 5 * 60 * 1000);

/* ---- helpers ---- */
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = "", done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 4096) { finish({}); req.destroy(); }
    });
    req.on("end", () => { try { finish(JSON.parse(buf || "{}")); } catch { finish({}); } });
    req.on("error", () => finish({}));
    req.on("aborted", () => finish({}));
    setTimeout(() => finish({}), 10000);
  });
}
/* доверяем заголовку X-Real-IP только от своего nginx (127.0.0.1) */
function clientIp(req) {
  const peer = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (peer === "127.0.0.1" || peer === "::1") {
    const real = req.headers["x-real-ip"];
    if (typeof real === "string" && real.trim()) return real.trim();
  }
  return peer || "?";
}
/* сравнение ключа без утечки по времени */
function keyOk(k) {
  if (typeof k !== "string" || !PULT_KEY) return false;
  const a = Buffer.from(k), b = Buffer.from(PULT_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cloudTokenOk(req) {
  const expected = String((CFG.cloud || {}).token || "");
  const got = String(req.headers["x-venue-token"] || "");
  if (!expected || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* авторизация пульта: токен сессии сотрудника, либо ключ заведения (обратная совместимость).
   Возвращает объект сотрудника — чтобы в журнале было видно, кто действовал. */
function auth(req, res) {
  const ip = clientIp(req);
  const k = req.headers["x-pult-key"];
  const token = typeof k === "string" ? k : "";
  const sess = sessions[token];
  if (sess) {
    const who = staffById(sess.staffId);
    const ttl = who && who.role === "device" ? SESSION_DEVICE_MS : SESSION_MS;
    if (who && Date.now() - sess.ts < ttl) {
      resetExpiredShift();
      if (sess.shiftDay !== shiftDayKey()) {
        if (who.role === "device") {
          // планшет стойки живёт год (INSTRUKCIYA.md): новая смена для него — не выход,
          // а сброс «кто заступил». Иначе утром стойка встречала смену экраном ПИНа.
          sess.shiftDay = shiftDayKey(); delete sess.workerId; delete sess.workerSince; saveSessions();
        } else {
          json(res, 401, { ok: false, reauth: true, error: `Смена завершена в ${shiftResetLabel()}. Введите ПИН, чтобы начать новую.` });
          return null;
        }
      }
      sess.seen = Date.now();
      if (who.role !== "device") return who;
      // общий планшет: если кальянщик заступил на смену — атрибуция на человека.
      // на границе операционного дня (11:00) смена сдаётся автоматически
      if (sess.workerId) {
        if (shiftDayKey(sess.workerSince || 0) !== shiftDayKey()) {
          delete sess.workerId; delete sess.workerSince; saveSessions();
        } else {
          const w = staffById(sess.workerId);
          if (w && w.active !== false) return { ...w, device: true };
          delete sess.workerId; delete sess.workerSince; saveSessions();
        }
      }
      return { ...who, device: true };
    }
  }
  if (keyOk(token)) { json(res, 401, { ok: false, reauth: true, error: "Введите ПИН сотрудника, чтобы начать смену." }); return null; }
  const qk = new URLSearchParams((req.url.split("?")[1] || "")).get("key");
  if (keyOk(qk || "")) { json(res, 401, { ok: false, reauth: true, error: "Введите ПИН сотрудника, чтобы начать смену." }); return null; }
  // пустой ключ — устройство просто ещё не вошло, это не подбор: молча просим войти
  if (!token && !qk) { json(res, 401, { ok: false, error: "нужен вход" }); return null; }
  const now = Date.now();
  authFailAll = authFailAll.filter((t) => now - t < AUTH_WINDOW_MS);
  authFailAll.push(now);
  if (authFailAll.length === AUTH_MAX_ALL)
    console.error(`[ALERT] ${AUTH_MAX_ALL} неверных ключей за минуту — похоже на перебор`);
  if (AUTH_THROTTLE && !slidingAllowed(authFail, ip, AUTH_WINDOW_MS, AUTH_MAX_IP)) {
    json(res, 429, { ok: false, error: "слишком много попыток" });
    return null;
  }
  console.log(`[auth] неверный вход с ${ip}`);
  json(res, 401, { ok: false, error: "нужен ключ" });
  return null;
}
/* короткое имя устройства — на пульт вместо сырого User-Agent */
function devLabel(ua) {
  if (!ua) return "устройство без метки";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  const m = ua.match(/Android[^;)]*;\s*([^;)]{2,30})/);
  if (m) return m[1].trim().replace(/[^\wа-яА-Я .+-]/g, "");
  if (/Windows/.test(ua)) return "Windows";
  if (/Macintosh|Mac OS/.test(ua)) return "Mac";
  return "браузер";
}

/* ---- статика ---- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json",
  ".json": "application/json", ".svg": "image/svg+xml",
  // без явного типа озвучка уезжала как application/octet-stream, а вместе
  // с nosniff это повод для браузера отказаться её проигрывать
  ".mp3": "audio/mpeg" };
function serveFile(res, fp, versioned) {
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    const ext = path.extname(fp);
    // файлы с меткой версии (?v=NN) можно держать в кэше вечно — при правке меняется адрес.
    // На слабом канале заведения это разница между «мгновенно» и «полминуты».
    const cache = versioned ? "public, max-age=31536000, immutable"
      : ext === ".png" ? "public, max-age=604800"
      : "no-cache, must-revalidate";
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache });
    res.end(data);
  });
}
function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split("?")[0]); }
  catch { res.writeHead(400).end("bad url"); return; }              // кривой %-escape валил процесс
  if (rel.includes("\0")) { res.writeHead(400).end("bad url"); return; }
  if (rel === "/pult") { res.writeHead(301, { Location: "/pult/" }); res.end(); return; }
  if (rel === "/demo") rel = "/demo.html";
  if (rel === "/") rel = "/index.html";
  if (rel === "/pult/") rel = "/pult/index.html";
  if (rel === "/zal") { res.writeHead(301, { Location: "/zal/" }); res.end(); return; }
  if (rel === "/zal/") rel = "/zal/index.html";
  if (rel.split("/").some((p) => p.startsWith("."))) { res.writeHead(404).end("not found"); return; } // .DS_Store и пр.
  /* Модуля на точке нет → и входа в него быть не должно. Раньше страница
     выключенного модуля просто лежала и открывалась по прямой ссылке. */
  const gate = MODULE_PAGES[rel];
  if (gate && !cloud.moduleOn(gate.mod, gate.local())) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("этот раздел на точке не подключён");
    return;
  }
  const fp = path.join(PUB, path.normalize(rel));
  if (!fp.startsWith(PUB)) { res.writeHead(403).end("forbidden"); return; }
  const q = req.url.split("?")[1] || "";
  serveFile(res, fp, /(^|&)v=\d+/.test(q));
}

const server = http.createServer(async (req, res) => {
 try {
  const u = req.url.split("?")[0];

  if (u === "/health") { json(res, 200, { ok: true, calls: calls.length, subs: subs.length,
    pushTargets: pushTargetCount(), onShift: staffOnShiftNow().size, open: isOpenNow() }); return; }

  /* гостевая страница стола: /t/5-a3f8c1b2e4 (подпись, чтобы номер не подбирался) */
  const mT = u.match(/^\/t\/(\d{1,3})(?:-([a-f0-9]{10}))?$/);
  if (mT) {
    if (!guestCalls()) { res.writeHead(404).end("нет такого стола"); return; }
    const n = +mT[1], token = mT[2];
    if (n < 1 || n > CFG.tables) { res.writeHead(404).end("нет такого стола"); return; }
    if (!token && CFG.qrLegacy) { serveFile(res, path.join(PUB, "guest.html")); return; }
    if (!tokenOk(n, token)) {
      if (AUTH_THROTTLE) slidingAllowed(authFail, clientIp(req), AUTH_WINDOW_MS, AUTH_MAX_IP);
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end('<meta charset="utf-8"><body style="background:#15100c;color:#f3e9df;font:16px/1.6 -apple-system,sans-serif;text-align:center;padding:60px 24px">' +
        "<div style='font-size:44px'>🌙</div><h2>Код не распознан</h2>" +
        "<p style='color:#a08b78'>Отсканируйте QR-код на вашем столе<br>или позовите кальянщика рукой.</p></body>");
      return;
    }
    serveFile(res, path.join(PUB, "guest.html"));
    return;
  }

  /* наклейка стола: /qr/t-5-a3f8c1b2e4.svg — как и PNG раньше, без ключа,
     но только с верной подписью: имя файла и есть секрет */
  const mQ = u.match(/^\/qr\/t-(\d{1,3})-([a-f0-9]{10})\.svg$/);
  if (mQ) {
    const n = +mQ[1];
    if (!(n >= 1 && n <= CFG.tables) || !tokenOk(n, mQ[2])) { res.writeHead(404).end("not found"); return; }
    const svg = qrSvg(`${publicOrigin(req)}/t/${n}-${mQ[2]}`);
    if (!svg) { res.writeHead(500).end("qr unavailable"); return; }
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=604800" });
    res.end(svg);
    return;
  }

  if (u === "/api/config") {
    /* pultName — как заведение зовут между собой сотрудники, если
       официальное имя (venue, для гостей и панели) другое. Необязательное. */
    json(res, 200, { ok: true, venue: CFG.venue, pultName: CFG.pultName || CFG.venue, tables: CFG.tables, open: isOpenNow(), rounds: ROUNDS,
      shiftResetHour: SHIFT_RESET_HOUR,          // пульт показывает час на экране «смена завершена»
      view: viewCfg, weather,
      service: !!mode.service, blockGuests: !!(mode.service && mode.blockGuests),
      buttons: guestCfg.buttons.map((b) => ({ id: b.id, icon: b.icon, label: b.label, sub: b.sub, done: b.done, withComment: !!b.withComment })),
      info: guestCfg.info,
      modules: effectiveModules(),
      brand: (cloud.profile && cloud.profile.brand) || null });
    return;
  }

  /* Скан QR: страница открылась. Тихо — ответ всегда ok, чтобы неудача счётчика
     не мешала гостю позвать кальянщика. */
  if (u === "/api/visit") {
    if (req.method !== "POST") { json(res, 405, { ok: false }); return; }
    const b = await readBody(req);
    const table = +b.table;
    const did = /^[a-f0-9]{16}$/.test(String(b.did || "")) ? b.did : "";
    if (!(table >= 1 && table <= CFG.tables) || !did) { json(res, 200, { ok: true }); return; }
    if (slidingAllowed(visitIp, clientIp(req), 60 * 1000, 30)) statVisit(table, did);
    json(res, 200, { ok: true });
    return;
  }

  if (u === "/api/call") {
    if (req.method !== "POST") { json(res, 405, { ok: false }); return; }
    /* ⚠️ ЕДИНСТВЕННАЯ ТОЧКА ВХОДА БЕЗ АВТОРИЗАЦИИ — и она была открыта в интернет.
       У «Стамбула» гостевых QR нет, а эндпойнт отвечал 200 кому угодно: лимиты
       выключены сознательно, потолок ≈120 вызовов за 3 минуты, и каждый пишет
       строку в хронику дня, которая обрезана 2000 событиями. То есть несколько
       минут флуда стирали статистику смены целиком — закрытия, круги, заказы.
       Заводите QR — поставьте `guestCalls: true` в config.json. */
    if (!guestCalls()) { json(res, 404, { ok: false, error: "вызовы со столов отключены" }); return; }
    const b = await readBody(req);
    const table = +b.table;
    const kind = String(b.kind || "");
    const comment = String(b.comment || "").slice(0, 200).replace(/[\r\n\t]+/g, " ").trim();
    const did = /^[a-f0-9]{16}$/.test(String(b.did || "")) ? b.did : "";
    const ip = clientIp(req);
    const ua = String(req.headers["user-agent"] || "").slice(0, 180);
    if (!(table >= 1 && table <= CFG.tables) || (!kindOf(kind) && !KINDS[kind])) { json(res, 400, { ok: false, error: "bad request" }); return; }
    if (LIMITS_ON && !did) { json(res, 400, { ok: false, error: "обновите страницу" }); return; }
    if (!isOpenNow()) { json(res, 503, { ok: false, error: "Сейчас закрыто — вызов не отправлен" }); return; }
    if (mode.service && mode.blockGuests) {
      json(res, 503, { ok: false, error: "Идут технические работы — позовите кальянщика рукой" }); return;
    }
    // забаненные — тихий «успех»: вызов не создаётся, спамер об этом не узнаёт
    if (isBanned(did, ip)) { json(res, 200, { ok: true, id: crypto.randomBytes(8).toString("hex") }); return; }
    const dup = calls.find((c) => c.table === table && c.kind === kind && c.status === "new" && Date.now() - c.ts < DUP_MS);
    if (dup) { json(res, 200, { ok: true, id: dup.id, repeated: true }); return; }
    if (LIMITS_ON) {
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      if (calls.filter((c) => c.did === did && c.ts > dayAgo).length >= DAY_MAX) {
        json(res, 429, { ok: false, error: "лимит вызовов на сегодня исчерпан" }); return;
      }
      if (!slidingAllowed(ipLog, ip, IP_WINDOW_MS, IP_MAX)) {
        json(res, 429, { ok: false, error: "слишком много вызовов, подождите" }); return;
      }
      if (!venueAllowed()) { json(res, 429, { ok: false, error: "слишком много вызовов, подождите" }); return; }
    }
    const c = { id: crypto.randomBytes(8).toString("hex"), table, kind, comment,
      ts: Date.now(), status: "new", ackTs: 0, did, ip, ua };
    calls.push(c);
    if (calls.length > CALLS_CAP) calls = calls.slice(-CALLS_CAP);
    if (fromSignedQr(req, b, table)) onboarding.mark("first-call");    // онбординг: первый вызов по QR
    statCall(kind, table, comment, (tstate[table] || {}).sid, did);
    save();
    pushCall(c, false);
    console.log(`[call] стол ${table} · ${kindLabel(kind)}${comment ? " · " + JSON.stringify(comment) : ""} · ${ip}`);
    json(res, 200, { ok: true, id: c.id });
    return;
  }

  const mC = u.match(/^\/api\/call\/([a-f0-9]{16})$/);
  if (mC) {
    const c = calls.find((x) => x.id === mC[1]);
    if (!c) { json(res, 404, { ok: false }); return; }
    json(res, 200, { ok: true, status: c.status, ackTs: c.ackTs });
    return;
  }

  if (u === "/api/login" && req.method === "POST") {
    const ip = clientIp(req);
    const b = await readBody(req);
    const pin = String(b.pin || "").trim();
    const who = staff.find((s) => s.active && s.pin && s.pin === pin);
    if (!who) {
      if (AUTH_THROTTLE && !slidingAllowed(loginFail, ip, AUTH_WINDOW_MS, 10)) {
        json(res, 429, { ok: false, error: "слишком много попыток, подождите минуту" }); return;
      }
      console.log(`[auth] неверный ПИН с ${ip}`);
      json(res, 401, { ok: false, error: "Такой ПИН не найден" });
      return;
    }
    authFail.delete(ip); loginFail.delete(ip);   // вошли правильно — снимаем все счётчики адреса
    const token = crypto.randomBytes(24).toString("hex");
    const startsShift = b.passive !== true; // SaaS читает статистику, но не должен попадать «на смену»
    sessions[token] = { staffId: who.id, ts: Date.now(), seen: Date.now(), shiftDay: shiftDayKey(), shiftTs: startsShift ? Date.now() : 0,
      dev: devLabel(String(req.headers["user-agent"] || "")) };
    saveSessions();
    note(who, startsShift ? "вошёл в пульт и заступил на смену" : "служебный вход для статистики");
    if (who.role === "admin") onboarding.mark("admin-login");          // онбординг: первый вход админа
    else if (who.role === "device") onboarding.mark("device-login");    // …и планшета стойки
    json(res, 200, { ok: true, token, name: who.name, role: who.role });
    return;
  }

  /* ===== дальше только пульт: токен сессии или ключ в заголовке X-Pult-Key ===== */
  if (u.startsWith("/api/")) {
    const service = cloudTokenOk(req);
    const serviceRead = req.method === "GET" && /^\/api\/(calls|stats(?:\/|$))/.test(u);
    // панель может ещё передать смене сообщение — это единственная запись, доступная служебному ключу
    const serviceNotice = req.method === "POST" && u === "/api/notice";
    if (service && !serviceRead && !serviceNotice) { json(res, 403, { ok: false, error: "служебному ключу доступно только чтение метрик и сообщение смене" }); return; }
    const actor = service ? { id: "cloud", name: "Serp Cloud", role: "service", service: true } : auth(req, res);
    if (!actor) return;

    if (u === "/api/calls") {
      const cut = Date.now() - ACTIVE_MS;
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      const perDid = new Map();
      for (const c of calls) if (c.did && c.ts > dayAgo) perDid.set(c.did, (perDid.get(c.did) || 0) + 1);
      const onShift = actorOnShift(req, actor);          // занятые столы видит только тот, кто на смене
      json(res, 200, { ok: true, ts: Date.now(), tables: onShift ? tstate : {},
        youOnShift: onShift, myShift: selfOnShift(req, actor), view: viewCfg, weather,
        flavors: topFlavors(),                             // подсказки конструктора забивки
        beta: betaFlags(actor),                            // кому сейчас открыт конструктор и голос

        canUndo: myUndo(actor).length > 0, ping: soundPing, pingKind: pingKind,
        // что сделали с ДРУГИХ устройств: перенос стола, отметка сервиса
        events: events.filter((e) => Date.now() - e.ts < EVENTS_TTL && e.src !== srcOf(req)
            && (!e.to || e.to === actor.id))          // ответ видит только тот, кому он адресован
          .map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, text: e.text, who: e.who,
            ...(e.toName ? { toName: e.toName } : {}), ...(e.about ? { about: e.about } : {}) })),
        /* Барные заказы — только тем, кто на смене. Готовые не убираем сразу:
           бармен должен видеть, что уже сделал, иначе повторит. */
        /* Закрытые кальяны этого стола: гость за них платит, поэтому из счёта
           они пропадать не должны, даже когда чаша уже погашена. */
        hkDone: history.filter((h) => Date.now() - h.ts < 8 * 3600 * 1000
            && h.table !== undefined && h.ts > (barCleared[String(h.table)] || 0))
          .map((h) => ({ table: h.table, ts: h.ts, by: h.by || "",
            n: (h.hookahs || []).length || 1, minutes: h.totalMinutes || 0,
            rounds: ((h.hookahs || [])[0] || {}).rounds || 0 })),
        bar: barOrders.filter((o) => !o.closed)
          .map((o) => ({ id: o.id, table: o.table, items: o.items, comment: o.comment,
            sum: o.sum, guest: o.guest || 0, by: o.by, ts: o.ts, status: o.status,
            doneBy: o.doneBy || "", doneTs: o.doneTs || 0 })),
        // заказы забивки от официантов: главный планшет показывает их лентой над столами
        orders: orders.filter(orderActive).map((o) => ({
          id: o.id, table: o.table, text: o.text, by: o.by, ts: o.ts,
          status: o.status, takenBy: o.takenBy || "", takenTs: o.takenTs || 0, mine: o.byId === actor.id,
        })),
        mode: { service: !!mode.service, blockGuests: !!mode.blockGuests,
          note: mode.note || "", since: mode.since || 0, by: mode.by || "" },
        // сервисные сообщения — отдельно от вызовов: они не про стол, а про смену
        notices: liveNotices().map((n) => ({ id: n.id, text: n.text, ts: n.ts, by: n.by || "" })),
        // наружу не отдаём ни IP, ни метку устройства, ни сырой User-Agent
        calls: calls.filter((c) => c.status !== "done" && c.ts > cut).map((c) => ({
          id: c.id, table: c.table, kind: c.kind, kindLabel: kindLabel(c.kind), icon: (kindOf(c.kind) || {}).icon || (c.kind === "notice" ? "📣" : ""),
          comment: c.comment, ts: c.ts, status: c.status, ackTs: c.ackTs,
          dev: devLabel(c.ua), todayCount: c.did ? perDid.get(c.did) || 0 : 0,
        })) });
      return;
    }

    /* ===== заказ забивки: телефон официанта → главный планшет ===== */
    /* Приём заказа на бар. Позиции приходят списком, сумму считаем на сервере:
       клиент может ошибиться или соврать, а по этой цифре сверяют кассу. */
    if (u === "/api/bar" && req.method === "POST") {
      const b = await readBody(req);
      const table = +b.table;
      if (!(table >= 1 && table <= CFG.tables)) { json(res, 400, { ok: false, error: "нет такого стола" }); return; }
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map((x) => ({
        n: Math.max(1, Math.min(99, parseInt(x.n, 10) || 1)),
        name: String(x.name || "").slice(0, 60).replace(/[\r\n\t]+/g, " ").trim(),
        // комментарий у КАЖДОЙ позиции: «без сахара» относится к кофе, а не ко всему заказу
        note: String(x.note || "").slice(0, 80).replace(/[\r\n\t]+/g, " ").trim(),
        price: Math.max(0, Math.min(99999, parseInt(x.price, 10) || 0)),
      })).filter((x) => x.name);
      const comment = String(b.comment || "").slice(0, 200).replace(/[\r\n\t]+/g, " ").trim();
      if (!items.length && !comment) { json(res, 400, { ok: false, error: "пустой заказ" }); return; }
      const sum = items.reduce((a, x) => a + x.n * x.price, 0);
      // гость: 0 — общий счёт стола, 1..N — раздельно по гостям
      const guest = Math.max(0, Math.min(20, parseInt(b.guest, 10) || 0));
      const o = { id: crypto.randomBytes(8).toString("hex"), table, items, comment, sum, guest,
        by: actor.name, byId: actor.id, ts: Date.now(), status: "new", doneTs: 0, doneBy: "" };
      barOrders.push(o);
      if (barOrders.length > BAR_CAP) barOrders = barOrders.slice(-BAR_CAP);
      saveBar();
      const what = items.map((x) => (x.n > 1 ? x.n + "× " : "") + x.name).join(", ");
      note(actor, `заказ на бар · стол ${table}: ${what || comment}`);
      console.log(`[бар] стол ${table} · ${what}${comment ? " · " + comment : ""} · ${actor.name}`);
      json(res, 200, { ok: true, id: o.id, order: o });
      return;
    }

    /* Смена состояния чека. Кнопки на барном планшете: взял в работу, готово,
       вернуть в работу. Кто отметил — пишем, чтобы не спорили. */
    if (u === "/api/bar/act" && req.method === "POST") {
      const b = await readBody(req);
      const o = barOrders.find((x) => x.id === String(b.id || ""));
      if (!o) { json(res, 404, { ok: false, error: "заказ не найден" }); return; }
      const st = String(b.status || "");
      if (!["new", "work", "done"].includes(st)) { json(res, 400, { ok: false, error: "неизвестное состояние" }); return; }
      o.status = st;
      if (st === "done") { o.doneTs = Date.now(); o.doneBy = actor.name; }
      else { o.doneTs = 0; o.doneBy = ""; }
      saveBar();
      note(actor, `бар · стол ${o.table}: ${st === "done" ? "готово" : st === "work" ? "взял в работу" : "вернул в работу"}`);
      json(res, 200, { ok: true, order: o });
      return;
    }

    /* Правка заказа: снять позицию или отменить целиком. Отменённый заказ
       не стираем, а помечаем — бармен должен увидеть, что его сняли, даже
       если он уже взялся. Позиция с комментарием живёт как одна строка. */
    if (u === "/api/bar/edit" && req.method === "POST") {
      const b = await readBody(req);
      const o = barOrders.find((x) => x.id === String(b.id || ""));
      if (!o) { json(res, 404, { ok: false, error: "заказ не найден" }); return; }
      if (o.closed) { json(res, 400, { ok: false, error: "счёт уже закрыт" }); return; }
      if (b.cancel) {
        o.status = "cancelled"; o.cancelTs = Date.now(); o.cancelBy = actor.name;
        saveBar(); note(actor, `бар · стол ${o.table}: заказ отменён`);
        json(res, 200, { ok: true, order: o }); return;
      }
      /* Смена количества у уже отправленной позиции: гость передумал,
         а переотправлять весь заказ — терять его место в очереди бармена. */
      if (b.qty !== undefined) {
        const i = parseInt(b.idx, 10);
        if (!(i >= 0 && i < (o.items || []).length)) { json(res, 400, { ok: false, error: "нет такой позиции" }); return; }
        const q = Math.max(0, Math.min(99, parseInt(b.qty, 10) || 0));
        if (q === 0) o.items.splice(i, 1); else o.items[i].n = q;
        o.sum = o.items.reduce((a, x) => a + x.n * (x.price || 0), 0);
        if (!o.items.length) { o.status = "cancelled"; o.cancelTs = Date.now(); o.cancelBy = actor.name; }
        saveBar(); note(actor, `бар · стол ${o.table}: количество изменено`);
        json(res, 200, { ok: true, order: o }); return;
      }
      /* Перенос заказа на другого гостя — раздельный счёт правится после факта. */
      if (b.guest !== undefined) {
        o.guest = Math.max(0, Math.min(20, parseInt(b.guest, 10) || 0));
        saveBar(); note(actor, `бар · стол ${o.table}: заказ → гость ${o.guest || "общий"}`);
        json(res, 200, { ok: true, order: o }); return;
      }
      const k = parseInt(b.drop, 10);
      if (!(k >= 0 && k < (o.items || []).length)) { json(res, 400, { ok: false, error: "нет такой позиции" }); return; }
      const gone = o.items[k];
      o.items.splice(k, 1);
      o.sum = o.items.reduce((a, x) => a + x.n * (x.price || 0), 0);
      if (!o.items.length) { o.status = "cancelled"; o.cancelTs = Date.now(); o.cancelBy = actor.name; }
      saveBar();
      note(actor, `бар · стол ${o.table}: снята позиция «${gone.name}»`);
      json(res, 200, { ok: true, order: o }); return;
    }

    /* Гости ушли — счёт стола закрывается целиком. Заказы не удаляем,
       а помечаем: история смены должна оставаться. */
    if (u === "/api/bar/close" && req.method === "POST") {
      const b = await readBody(req);
      const table = +b.table;
      if (!(table >= 1 && table <= CFG.tables)) { json(res, 400, { ok: false, error: "нет такого стола" }); return; }
      let n = 0;
      for (const o of barOrders) {
        if (String(o.table) === String(table) && !o.closed) {
          o.closed = true; o.closedTs = Date.now(); o.closedBy = actor.name; n++;
        }
      }
      barCleared[String(table)] = Date.now(); saveCleared();
      if (n) { saveBar(); }
      note(actor, `бар · стол ${table}: счёт закрыт${n ? ` (${n})` : ""}`);
      json(res, 200, { ok: true, closed: n });
      return;
    }

    if (u === "/api/order" && req.method === "POST") {
      const b = await readBody(req);
      const table = typeof b.table === "string" && /^c[a-z0-9]+$/.test(b.table) ? b.table : +b.table;
      const text = String(b.text || "").slice(0, 200).replace(/[\r\n\t]+/g, " ").trim();
      const isCustom = typeof table === "string";
      if (!isCustom && !(table >= 1 && table <= CFG.tables)) { json(res, 400, { ok: false, error: "нет такого стола" }); return; }
      if (isCustom && !tstate[table]) { json(res, 404, { ok: false, error: "стол уже убрали" }); return; }
      // тот же текст на тот же стол в пределах минуты — не плодим второй заказ
      const dup = orders.find((o) => String(o.table) === String(table) && o.text === text &&
        o.status === "new" && Date.now() - o.ts < ORDER_DUP_MS);
      if (dup) { json(res, 200, { ok: true, id: dup.id, repeated: true, order: dup }); return; }
      const o = { id: crypto.randomBytes(8).toString("hex"), table, text,
        by: actor.name, byId: actor.id, ts: Date.now(), status: "new",
        takenTs: 0, takenBy: "", doneTs: 0, doneBy: "", why: "", nagTs: 0 };
      orders.push(o);
      if (orders.length > ORDERS_CAP) orders = orders.slice(-ORDERS_CAP);
      saveOrders();
      statOrder(o, "new", actor.name);
      const pushTo = pushOrder(o, false);
      note(actor, `заказ забивки · стол ${table}${text ? `: «${text}»` : " (на усмотрение)"}`);
      console.log(`[заказ] стол ${table} · ${JSON.stringify(text)} · ${actor.name} · push ${pushTo}`);
      json(res, 200, { ok: true, id: o.id, pushTo, order: o });
      return;
    }

    if (u === "/api/order/act" && req.method === "POST") {
      const b = await readBody(req);
      const o = orders.find((x) => x.id === String(b.id || ""));
      if (!o) { json(res, 404, { ok: false, error: "заказ не найден" }); return; }
      const act = String(b.act || "");
      /* Принять заказ в работу может только стойка: планшет или администратор.
         Кальянщик в зале заказы ОТПРАВЛЯЕТ, а заводит их в работу стойка.
         Проверка здесь, а не в интерфейсе: скрытая кнопка — не запрет. */
      if (act === "take" && actor.role !== "admin" && actor.role !== "device" && !actor.device) {
        json(res, 403, { ok: false, error: "заказ в работу заводит стойка" }); return;
      }
      if (act === "take") {
        if (o.status !== "new") { json(res, 200, { ok: true, already: o.status, order: o }); return; }
        o.status = "taken"; o.takenTs = Date.now(); o.takenBy = actor.name;
        statOrder(o, "taken", actor.name);
        note(actor, `взял заказ · стол ${o.table}`);
      } else if (act === "done") {
        if (o.status === "done") { json(res, 200, { ok: true, already: "done", order: o }); return; }
        o.status = "done"; o.doneTs = Date.now(); o.doneBy = actor.name; o.why = "закрыт вручную";
        statOrder(o, "done", actor.name);
        note(actor, `закрыл заказ · стол ${o.table}`);
      } else if (act === "cancel") {
        // отменить может тот, кто заказ создал, или кальянщик на планшете/админ
        if (o.byId !== actor.id && actor.role !== "admin" && actor.role !== "device" && !actor.device) {
          json(res, 403, { ok: false, error: "отменить может автор заказа или кальянщик" }); return;
        }
        if (o.status === "cancel") { json(res, 200, { ok: true, already: "cancel", order: o }); return; }
        o.status = "cancel"; o.doneTs = Date.now(); o.doneBy = actor.name;
        o.why = String(b.why || "").slice(0, 120).trim();
        statOrder(o, "cancel", actor.name);
        note(actor, `отменил заказ · стол ${o.table}${o.why ? `: ${o.why}` : ""}`);
      } else { json(res, 400, { ok: false, error: "нет такого действия" }); return; }
      saveOrders();
      json(res, 200, { ok: true, order: o });
      return;
    }

    /* Записка с телефона на главный планшет. Отдельного канала не заводим —
       ложится в ту же ленту событий, которую мастер гасит кнопкой «Принял»,
       поэтому записка не пропадёт непрочитанной. */
    if (u === "/api/say" && req.method === "POST") {
      const b = await readBody(req);
      /* 200 знаков хватало записке «подойди в зал», но заказ на бар состоит
         из позиций и в них не влезает. 600 — с запасом на десяток строк. */
      const text = String(b.text || "").slice(0, 600).replace(/[\r\n\t]+/g, " ").trim();
      if (!text) { json(res, 400, { ok: false, error: "пустое сообщение" }); return; }
      pushEvent(req, actor, "msg", text);
      note(actor, `сообщение на планшет: «${text}»`);
      json(res, 200, { ok: true });
      return;
    }

    /* Ответ на записку — адресно её автору. Без этого записка в одну сторону
       всегда рождает вопрос «а он вообще видел?», и человек идёт спрашивать
       голосом через зал — то есть ровно то, ради чего записку и заводили. */
    if (u === "/api/reply" && req.method === "POST") {
      const b = await readBody(req);
      const orig = events.find((e) => e.id === String(b.id || ""));
      if (!orig) { json(res, 404, { ok: false, error: "сообщение уже устарело" }); return; }
      const text = String(b.text || "").slice(0, 200).replace(/[\r\n\t]+/g, " ").trim();
      if (!text) { json(res, 400, { ok: false, error: "пустой ответ" }); return; }
      if (!orig.byId) { json(res, 400, { ok: false, error: "непонятно, кому отвечать" }); return; }
      pushEvent(req, actor, "reply", text,
        { to: orig.byId, toName: orig.who, about: String(orig.text || "").slice(0, 60) });
      const sent = pushToStaff(orig.byId, "↩︎ " + (actor ? actor.name : "Пульт"), text);
      note(actor, `ответил ${orig.who}: «${text}»`);
      json(res, 200, { ok: true, pushTo: sent });
      return;
    }

    if (u === "/api/events") {                       // история сообщений за смену
      const cut = Date.now() - EVENTS_TTL;
      json(res, 200, { ok: true, ts: Date.now(),
        // в ленте своё эхо скрыто, а в истории оно нужно: «я писал — мне ответили»
        events: events.filter((e) => e.ts > cut && (!e.to || e.to === actor.id || e.byId === actor.id))
          .slice(-200).reverse().map((e) => ({
            id: e.id, ts: e.ts, kind: e.kind, text: e.text, who: e.who,
            mine: e.byId === actor.id,
            ...(e.toName ? { toName: e.toName } : {}), ...(e.about ? { about: e.about } : {}),
          })) });
      return;
    }

    if (u === "/api/orders") {                       // лента заказов для телефона официанта
      const cut = Date.now() - ORDER_ACTIVE_MS;
      json(res, 200, { ok: true, ts: Date.now(),
        orders: orders.filter((o) => o.ts > cut).slice(-100).reverse().map((o) => ({
          id: o.id, table: o.table, text: o.text, by: o.by, ts: o.ts, status: o.status,
          takenBy: o.takenBy || "", takenTs: o.takenTs || 0, doneTs: o.doneTs || 0,
          why: o.why || "", mine: o.byId === actor.id,
        })) });
      return;
    }

    if (u === "/api/me") {
      const nowMs = Date.now();
      const onShiftList = [];
      const seenShift = new Set();
      for (const s of subs) if (s.onShift && nowMs - s.shiftTs < SHIFT_MS) {
        onShiftList.push({ name: s.staffName || "—", dev: s.dev || "", since: s.shiftTs });
        if (s.staffId) seenShift.add(s.staffId);
      }
      for (const sess of Object.values(sessions))       // ручная смена без пушей
        if (sess.shiftTs && nowMs - sess.shiftTs < SHIFT_MS && !seenShift.has(sess.staffId)) {
          const who = staffById(sess.staffId);
          onShiftList.push({ name: who ? who.name : "—", dev: sess.dev || "", since: sess.shiftTs });
          if (sess.staffId) seenShift.add(sess.staffId);
        }
      json(res, 200, { ok: true, id: actor.id, name: actor.name, role: actor.role, device: !!actor.device,
        staff: actor.role === "admin"
          ? staff.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, role: x.role, pin: x.pin }))
          : staff.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, role: x.role })),
        onShift: onShiftList,
        journal: journal.slice(-60).reverse() });
      return;
    }

    /* ---- Сканы QR: сколько раз гости открывали страницу стола ----
       Считаем из statlog на лету, агрегатов не держим. */
    if (u === "/api/stats/visits") {
      const q = (req.url.split("?")[1] || "").match(/(?:^|&)d=(\d{1,3})/);
      const days = Math.min(STATLOG_DAYS, Math.max(1, q ? +q[1] : 30));
      const keys = Object.keys(statlog).sort().slice(-days);
      const byDay = [], byTable = new Map(), devices = new Set(), recent = [];
      const byHour = new Array(24).fill(0);
      let visits = 0, calls = 0, converted = 0, lastTs = 0;
      const CONV_MS = 20 * 60 * 1000;
      for (const k of keys) {
        const events = statlog[k] || [];
        const dayVisits = events.filter((e) => e.e === "visit");
        const dayCalls = events.filter((e) => e.e === "call");
        for (const v of dayVisits) {
          const hit = dayCalls.some((c) => c.ts >= v.ts && c.ts - v.ts < CONV_MS &&
            (c.did ? c.did === v.did : String(c.t) === String(v.t)));
          if (hit) converted++;
          // журнал: когда, с какого стола и с какого устройства заходили
          recent.push({ ts: v.ts, t: String(v.t), did: String(v.did || "").slice(0, 6), called: hit });
          const t = String(v.t);
          byTable.set(t, (byTable.get(t) || 0) + 1);
          if (v.did) devices.add(v.did);
          byHour[new Date(v.ts + TZ_MIN * 60000).getUTCHours()]++;
          if (v.ts > lastTs) lastTs = v.ts;
        }
        visits += dayVisits.length;
        calls += dayCalls.length;
        byDay.push({ day: k, visits: dayVisits.length, calls: dayCalls.length });
      }
      json(res, 200, { ok: true, days: keys.length, visits, calls, converted,
        devices: devices.size, lastTs, byDay, byHour,
        // последние заходы: телефон опознаётся только меткой устройства (номера у нас нет)
        recent: recent.sort((a, b) => b.ts - a.ts).slice(0, 60),
        byTable: [...byTable.entries()].map(([t, n]) => ({ table: t, n }))
          .sort((a, b) => b.n - a.n || (+a.table || 0) - (+b.table || 0)).slice(0, 30) });
      return;
    }

    if (u === "/api/stats") {                       // статистика смены — видит вся команда
      for (const [k, d0] of Object.entries(stats)) {
        if (Number.isFinite(d0.late10Count)) continue;
        const ev = statlog[k];
        if (!ev) continue;
        let c10 = 0, m10 = 0, c20 = 0;
        for (const e of ev) {
          if (e.e !== "round") continue;
          const overS = Number.isFinite(e.overS) ? e.overS : (Number(e.over) > LATE_MIN ? e.over * 60 : 0);
          if (overS > LATE_MIN * 60) { c10++; m10 += Math.round(overS / 60); }
          if (overS > LATE_CRIT_MIN * 60) c20++;
        }
        d0.late10Count = c10; d0.late10Min = m10; d0.late20Count = c20;
        saveStats();
      }
      const closed = {};                            // закрытые столы по дням: сколько и как долго сидели
      const since = Date.now() - 30 * 86400000;
      for (const h of history) {
        if (h.ts < since) continue;
        const k = dayKey(h.ts);
        const o = closed[k] || (closed[k] = { sessions: 0, hookahs: 0, rounds: 0, minutesSum: 0 });
        o.sessions++;
        o.hookahs += h.hookahs.length;
        o.rounds += h.hookahs.reduce((a, x) => a + x.rounds, 0);
        o.minutesSum += h.totalMinutes || 0;
      }
      const detail = {};
      for (const k of Object.keys(statlog)) detail[k] = detailFromLog(statlog[k]);
      json(res, 200, { ok: true, today: dayKey(), days: stats, closed, detail, junkRoundSec: JUNK_ROUND_S,
        rounds: { r1: viewCfg.r1, r2: viewCfg.r2, r3: viewCfg.r3 },
        buttons: guestCfg.buttons.map((b) => ({ id: b.id, icon: b.icon, label: b.label })) });
      return;
    }

    if (u === "/api/stats/day") {                   // хроника одного дня для «провала»
      const q = (req.url.split("?")[1] || "").match(/(?:^|&)d=([\d-]{10})/);
      const day = q ? q[1] : dayKey();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { json(res, 400, { ok: false }); return; }
      json(res, 200, { ok: true, day, events: statlog[day] || [],
        buttons: guestCfg.buttons.map((b) => ({ id: b.id, icon: b.icon, label: b.label })) });
      return;
    }

    /* ---- Аналитика забивок: сколько на самом деле греется фольга и калауд ----
       Считаем на лету из хроники (statlog), агрегатов в stats.json не держим —
       так старая статистика не ломается, а поля событий можно менять свободно. */
    if (u === "/api/build") {
      if (!betaOn("build", actor)) { json(res, 403, { ok: false, error: "конструктор пока в бете" }); return; }
      const q = (req.url.split("?")[1] || "").match(/(?:^|&)d=(\d{1,3})/);
      const days = Math.min(STATLOG_DAYS, Math.max(1, q ? +q[1] : 30));
      const keys = Object.keys(statlog).sort().slice(-days);
      const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y);
        const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
      const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y);
        return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
      const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
      const box = (a) => ({ n: a.length, med: med(a), avg: avg(a), p80: pct(a, 0.8),
        min: a.length ? Math.min(...a) : null, max: a.length ? Math.max(...a) : null });
      const H = {};                                   // heat -> { starts, ready[], served[], service[] }
      const bucket = (k) => H[k] || (H[k] = { starts: 0, ready: [], served: [], service: [] });
      const FL = {}, WHO = {}, recent = [];
      let starts = 0, withHeat = 0, lateBuild = 0;
      for (const k of keys) for (const e of statlog[k] || []) {
        if (e.e === "start") {
          starts++;
          if (e.heat) { withHeat++; bucket(e.heat).starts++; }
          if (e.fl) { const f = FL[e.fl] || (FL[e.fl] = { name: e.fl, n: 0, ready: [] }); f.n++; }
        } else if (e.e === "build") {
          if (e.late && e.heat) { lateBuild++; withHeat++; bucket(e.heat).starts++; }
          if (e.late && e.fl) { const f = FL[e.fl] || (FL[e.fl] = { name: e.fl, n: 0, ready: [] }); f.n++; }
        } else if (e.e === "stage") {
          const b = bucket(e.heat || "none");
          const w = WHO[e.who] || (WHO[e.who] = { who: e.who || "—", ready: [], served: [] });
          if (e.st === "ready") {
            b.ready.push(e.s); w.ready.push(e.s);
            if (e.fl) { const f = FL[e.fl] || (FL[e.fl] = { name: e.fl, n: 0, ready: [] }); f.ready.push(e.s); }
          } else {
            b.served.push(e.s); w.served.push(e.s);
            if (Number.isFinite(e.fromReadyS)) b.service.push(e.fromReadyS);
            recent.push({ ts: e.ts, t: e.t, heat: e.heat || "", fl: e.fl || "",
              servedS: e.s, fromReadyS: e.fromReadyS, who: e.who || "" });
          }
        }
      }
      const heats = {};
      for (const [k, v] of Object.entries(H))
        heats[k] = { starts: v.starts, ready: box(v.ready), served: box(v.served), service: box(v.service) };
      json(res, 200, { ok: true, days, labels: HEAT_LABEL,
        totals: { starts, withHeat, noHeat: Math.max(0, starts - withHeat), lateBuild },
        heats,
        flavors: Object.values(FL).sort((a, b) => b.n - a.n).slice(0, 25)
          .map((f) => ({ name: f.name, n: f.n, ready: med(f.ready), samples: f.ready.length })),
        masters: Object.values(WHO).sort((a, b) => b.served.length - a.served.length)
          .map((w) => ({ who: w.who, ready: box(w.ready), served: box(w.served) })),
        recent: recent.sort((a, b) => b.ts - a.ts).slice(0, 40) });
      return;
    }

    /* Словарь вкусов копится сам из вписанного — значит, нужен способ убрать
       оттуда мусор и опечатки. Читают все с бетой, правит только админ. */
    /* Диагностика подбора табака по строке — только админу.
       Нужна, чтобы настраивать голосовой поиск по замерам, а не на глаз:
       видно и что выбрано, и какие бренды предложены как альтернатива. */
    if (u.split("?")[0] === "/api/catsearch" && req.method === "GET") {
      if (actor.role !== "admin") { json(res, 403, { ok: false }); return; }
      const q = decodeURIComponent(((req.url.split("?")[1] || "").match(/(?:^|&)q=([^&]*)/) || [])[1] || "");
      if (!q) { json(res, 400, { ok: false, error: "нужен ?q=" }); return; }
      const mix = catSearchMix(q);
      const raw = catSearch(q);
      json(res, 200, { ok: true, q, chunks: chunksOf(q),
        подробно: raw ? { выбрано: raw.cat.brand + " · " + raw.cat.flavor,
                          услышанные_бренды: raw.saidBrands, топ: raw.top } : "ничего",
        mix: mix.map((f) => ({ brand: f.cat.brand, line: f.cat.line || "", flavor: f.cat.flavor,
          alts: (f.alts || []).map((a) => a.brand + " · " + a.flavor) })) });
      return;
    }

    if (u === "/api/flavors" && req.method === "GET") {
      if (!betaOn("build", actor)) { json(res, 403, { ok: false, error: "конструктор пока в бете" }); return; }
      json(res, 200, { ok: true, canEdit: actor.role === "admin",
        items: sortedFlavors().map((name) => ({ name, n: flavors[name].n, last: flavors[name].last })) });
      return;
    }

    if (u === "/api/catalog") {                       // каталог табака для конструктора
      if (!betaOn("build", actor)) { json(res, 403, { ok: false, error: "конструктор пока в бете" }); return; }
      // алиасы («малибу», «черника») уезжают в пульт: по ним и ищут в зале
      json(res, 200, { ok: true, items: catalog.map((c) => ({ i: c.i, brand: c.brand, line: c.line,
        flavor: c.flavor, ...(c.aliases.length ? { a: c.aliases } : {}),
        ...(c.strength ? { s: c.strength } : {}) })),
        recent: topFlavors() });
      return;
    }

    if (u === "/api/history") {
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      const today = history.filter((h) => h.ts > dayAgo);
      json(res, 200, { ok: true,
        items: history.slice(-200).reverse(),
        today: { sessions: today.length,
          hookahs: today.reduce((a, h) => a + h.hookahs.length, 0),
          rounds: today.reduce((a, h) => a + h.hookahs.reduce((x, y) => x + y.rounds, 0), 0) } });
      return;
    }

    if (u === "/api/bans") {                        // список активных банов — только админ
      if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
      const now = Date.now();
      const lastByDid = new Map(), lastByIp = new Map();
      for (const c of calls) {
        if (c.did) { const p = lastByDid.get(c.did); if (!p || c.ts > p.ts) lastByDid.set(c.did, c); }
        if (c.ip) { const p = lastByIp.get(c.ip); if (!p || c.ts > p.ts) lastByIp.set(c.ip, c); }
      }
      const mapDid = ([did, t]) => { const c = lastByDid.get(did);
        return { did, until: t, table: c ? c.table : null, dev: c ? devLabel(c.ua) : "", lastTs: c ? c.ts : 0 }; };
      const mapIp = ([ip, t]) => { const c = lastByIp.get(ip);
        return { ip, until: t, table: c ? c.table : null, dev: c ? devLabel(c.ua) : "", lastTs: c ? c.ts : 0 }; };
      json(res, 200, { ok: true, enforced: LIMITS_ON, now,
        dids: Object.entries(bans.dids).filter(([, t]) => t > now).map(mapDid).sort((a, b) => b.until - a.until),
        ips: Object.entries(bans.ips).filter(([, t]) => t > now).map(mapIp).sort((a, b) => b.until - a.until) });
      return;
    }

    if (u === "/api/qr") {
      onboarding.mark("qr-printed");                                     // онбординг: открыл наклейки
      json(res, 200, { ok: true, venue: CFG.venue,
        tables: Array.from({ length: CFG.tables }, (_, i) => i + 1)
          .map((n) => { const t = tableToken(n);
            // PNG из старого make-qr.py с той же подписью ещё лежит — отдаём его (наклейки
            // напечатаны с него); нет — SVG считает сервер на лету
            const png = `/qr/t-${n}-${t}.png`;
            const img = fs.existsSync(path.join(PUB, png)) ? png : `/qr/t-${n}-${t}.svg`;
            return { n, path: `/t/${n}-${t}`, img }; }) });
      return;
    }

    if (u === "/api/push/vapid") {
      json(res, 200, { ok: !!(webpush && CFG.vapid), publicKey: (CFG.vapid || {}).publicKey || "" });
      return;
    }

    /* ---- Голосовой ввод забивки (бета) ----
       Кальянщик говорит «четвёртый стол дабл эппл на фольге» — распознаём речь
       моделью OpenAI, потом второй моделью разбираем фразу в структуру и
       подтягиваем вкус к уже известным (речь слышит «дабл яблоко» — в базе
       «Дабл эппл»). Ключ живёт ТОЛЬКО в config.json на сервере: планшет ходит
       к нам, наружу — никогда (CSP заведения это и не пустит).
       Сами ничего не применяем: пульт показывает понятое и ждёт подтверждения. */
    /* Живая расшифровка: пульт шлёт кусок записи каждые несколько секунд и
       сразу показывает слова на экране. Только текст, без разбора — так видно,
       что тебя слышат, и не надо гадать, записалось ли. Итоговую фразу всё равно
       разбираем целиком в /api/voice: у куска на стыке может срезать слово. */
    if (u.split("?")[0] === "/api/voice/live" && req.method === "POST") {
      if (!betaOn("voice", actor)) { json(res, 403, { ok: false, error: "голос пока в бете" }); return; }
      if (!OPENAI_KEY) { json(res, 503, { ok: false, error: "не задан ключ OpenAI" }); return; }
      let audio;
      try { audio = await readRaw(req, VOICE_MAX); }
      catch { json(res, 413, { ok: false, error: "кусок слишком большой" }); return; }
      if (!audio || audio.length < 2000) { json(res, 200, { ok: true, text: "" }); return; }
      try {
        const tr = await transcribe(req, audio);
        if (tr.error) { json(res, 502, { ok: false, error: tr.error.message || "сбой" }); return; }
        json(res, 200, { ok: true, text: String(tr.text || "").trim() });
      } catch (e) { json(res, 502, { ok: false, error: String((e && e.message) || e).slice(0, 120) }); }
      return;
    }

    if (u.split("?")[0] === "/api/voice" && req.method === "POST") {
      if (!betaOn("voice", actor)) { json(res, 403, { ok: false, error: "голос пока в бете" }); return; }
      if (!OPENAI_KEY) { json(res, 503, { ok: false, error: "не задан ключ OpenAI (config.json → openaiKey)" }); return; }
      let audio;
      try { audio = await readRaw(req, VOICE_MAX); }
      catch { json(res, 413, { ok: false, error: "запись слишком длинная" }); return; }
      if (!audio || audio.length < 2000) { json(res, 400, { ok: false, error: "пустая запись" }); return; }
      const t0 = Date.now();
      try {
        const tr = await transcribe(req, audio);
        if (tr.error) { json(res, 502, { ok: false, error: "распознавание: " + (tr.error.message || "сбой") }); return; }
        const text = String(tr.text || "").trim();
        // «кто отвечал» — чтобы это можно было проверить, а не принимать на веру:
        // chat/completions возвращает имя модели сам, у распознавалки признак — поле languages
        const via = { voice: VOICE_MODEL, voiceSig: tr.languages ? "languages" : "" };
        if (!text) { json(res, 200, { ok: true, text: "", items: [], via, ms: Date.now() - t0 }); return; }

        // окно забивки уже открыто на конкретном столе — там номер называть не надо
        const qt = (req.url.split("?")[1] || "").match(/(?:^|&)t=([\w-]{1,24})/);
        const onlyTable = qt ? decodeURIComponent(qt[1]) : "";
        if (onlyTable) {
          // стол уже выбран — ищем только вкус и способ, всё своим кодом
          const fm = catSearchMix(text);
          const one = fm.length
            ? { heat: heatOf(text),
                mix: fm.map((f) => ({ cat: f.cat.i, brand: f.cat.brand,
                  ...(f.cat.line ? { line: f.cat.line } : {}), flavor: f.cat.flavor,
                  ...(f.pct ? { pct: f.pct } : {}),
                  ...(fm.length === 1 && f.alts && f.alts.length ? { alts: f.alts } : {}) })),
                flavor: mixLabel(fm.map((f) => ({ flavor: f.cat.flavor, pct: f.pct }))) }
            : { heat: heatOf(text), brand: "", line: "", mix: [], flavor: sNorm(text)
                  .replace(/\b(фольг\w*|к[оа]ла?уд\w*|на|и)\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 40),
                cat: null };
          json(res, 200, { ok: true, text, one, via: { ...via, parse: "поиск по каталогу" },
            ms: Date.now() - t0 });
          return;
        }

        // разбор фразы своим кодом: без второй модели, без разброса и без токенов
        let items = (await parseSpeechFull(text, CFG.tables)).slice(0, 12).map((x) => {
          const n = x.table && x.table >= 1 && x.table <= CFG.tables ? x.table : null;
          const busy = n ? ((tstate[n] && tstate[n].hookahs.length) || 0) : 0;
          return { ...x, table: n, busy, action: busy ? "add" : "start" };
        });

        note(actor, `сказал голосом: «${text.slice(0, 80)}»`);
        json(res, 200, { ok: true, text, items, via: { ...via, parse: "поиск по каталогу" }, ms: Date.now() - t0 });
      } catch (e) {
        json(res, 502, { ok: false, error: String((e && e.message) || e).slice(0, 120) });
      }
      return;
    }

    if (req.method === "POST") {
      const b = await readBody(req);

      if (u === "/api/push/subscribe") {
        if (!b.sub || typeof b.sub.endpoint !== "string" || !validPushEndpoint(b.sub.endpoint)) {
          json(res, 400, { ok: false, error: "плохая подписка" }); return;
        }
        /* ⚠️ Вторая строка тут раньше выбивала ВСЕ ОСТАЛЬНЫЕ подписки этого сотрудника
           (после первого фильтра её условие уже невыполнимо): двое официантов под
           одним ПИНом — и заказы приходили только на телефон, подписавшийся последним,
           а второй молчал и об этом не сообщал. Один человек = сколько угодно устройств,
           дубль ловим только по самому endpoint. */
        subs = subs.filter((s) => !s.sub || s.sub.endpoint !== b.sub.endpoint);
        subs.push({ sub: b.sub, dev: devLabel(String(b.ua || "")), onShift: true, shiftTs: Date.now(),
          staffId: actor.id, staffName: actor.name });
        note(actor, "заступил на смену (уведомления включены)");
        if (subs.length > SUBS_CAP) subs = subs.slice(-SUBS_CAP);
        saveSubs();
        console.log(`[shift] на смене: ${subs.filter((s) => s.onShift).length}`);
        json(res, 200, { ok: true });
        return;
      }
      /* Android-обёртка: нативный FCM-токен вместо Web Push-подписки.
         Живёт в общем subs — вся логика смен (onShift/shiftTs/staffId) едина.
         Приложение перерегистрируется периодически — это продлевает смену,
         поэтому журналим только ПЕРВУЮ регистрацию устройства, не каждый пинг. */
      if (u === "/api/push/fcm") {
        const t = String(b.token || "").trim();
        if (t.length < 40 || t.length > 4096 || /\s/.test(t)) {
          json(res, 400, { ok: false, error: "плохой токен" }); return;
        }
        const old = subs.find((s) => s.fcm === t);
        if (old && old.staffId === actor.id) {
          old.onShift = true; old.shiftTs = Date.now();
          saveSubs();
          json(res, 200, { ok: true, fcm: fcm.ready() }); return;
        }
        subs = subs.filter((s) => s.fcm !== t);       // токен сменил хозяина — старая запись лишняя
        subs.push({ fcm: t, dev: "Android" + (b.model ? " · " + String(b.model).slice(0, 40) : ""),
          onShift: true, shiftTs: Date.now(), staffId: actor.id, staffName: actor.name });
        note(actor, "заступил на смену (Android-приложение)");
        if (subs.length > SUBS_CAP) subs = subs.slice(-SUBS_CAP);
        saveSubs();
        console.log(`[shift] fcm-подписка: ${actor.name} · на смене: ${subs.filter((s) => s.onShift).length}`);
        json(res, 200, { ok: true, fcm: fcm.ready() });
        return;
      }
      if (u === "/api/push/off") {
        for (const s of subs) if (s.sub && s.sub.endpoint === b.endpoint) s.onShift = false;
        saveSubs();
        note(actor, "закончил смену (уведомления выключены)");
        json(res, 200, { ok: true });
        return;
      }
      if (u === "/api/push/status") {
        const s = subs.find((x) => x.sub && x.sub.endpoint === b.endpoint);
        json(res, 200, { ok: true, onShift: !!(s && s.onShift && Date.now() - s.shiftTs < SHIFT_MS) });
        return;
      }
      if (u === "/api/worker") {                      // кто заступил за общий планшет
        /* ⚠️ Здесь НЕ считались неудачные попытки вообще — ни `loginFail`, ни
           `authFail`, даже при включённом тротлинге. Это был неограниченный перебор
           ПИНа с планшета, который физически стоит в зале, причём успех админским
           ПИНом поднимает сессию киоска до админской. Считаем как обычный вход. */
        const tok = String(req.headers["x-pult-key"] || "");
        const sess = sessions[tok];
        const base = sess && staffById(sess.staffId);
        if (!base || base.role !== "device") { json(res, 400, { ok: false, error: "доступно только на планшете заведения" }); return; }
        if (b.off) {
          if (sess.workerId) { const w0 = staffById(sess.workerId); if (w0) note(w0, "сдал смену за пультом"); }
          delete sess.workerId; delete sess.workerSince;
          saveSessions();
          json(res, 200, { ok: true, name: base.name, role: "device", device: true });
          return;
        }
        const pin = String(b.pin || "").trim();
        const w = staff.find((x) => x.active && String(x.pin) === pin && x.role !== "device");
        if (!w) {
          const ip = clientIp(req);
          if (AUTH_THROTTLE && !slidingAllowed(loginFail, ip, AUTH_WINDOW_MS, 10)) {
            json(res, 429, { ok: false, error: "слишком много попыток, подождите минуту" }); return;
          }
          console.log(`[auth] неверный ПИН заступления с ${ip}`);
          json(res, 200, { ok: false, error: "Такой ПИН не найден" }); return;
        }
        loginFail.delete(clientIp(req));                // вошли правильно — счётчик сбрасываем
        sess.workerId = w.id; sess.workerSince = Date.now();
        saveSessions();
        note(w, "заступил на смену за пультом");
        json(res, 200, { ok: true, name: w.name, role: w.role, device: true });
        return;
      }

      if (u === "/api/shift") {                          // ручная отметка «на смене» — работает и без пушей
        const sess = sessionOf(req);
        const on = !!b.on;
        if (sess) { sess.shiftTs = on ? Date.now() : 0; saveSessions(); }
        note(actor, on ? "заступил на смену" : "закончил смену");
        json(res, 200, { ok: true, onShift: actorOnShift(req, actor), myShift: selfOnShift(req, actor) });
        return;
      }
      if (u === "/api/unban") {                          // снять бан устройства/IP — только админ
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        let n = 0;
        if (b.all) { n = Object.keys(bans.dids).length + Object.keys(bans.ips).length; bans.dids = {}; bans.ips = {}; }
        else {
          if (b.did && bans.dids[b.did]) { delete bans.dids[b.did]; n++; }
          if (b.ip && bans.ips[b.ip]) { delete bans.ips[b.ip]; n++; }
        }
        saveBans();
        if (n) note(actor, b.all ? "снял все баны" : `снял бан (${b.did ? "устройство" : "IP"})`);
        json(res, 200, { ok: true, removed: n });
        return;
      }
      /* Сервисное сообщение смене из панели управления. К столу НЕ привязано:
         это объявление для людей, а не вызов от гостя. Пульт показывает его
         полосой сверху, пока кто-нибудь не нажмёт «Понятно». */
      if (u === "/api/notice") {
        if (actor.role !== "admin" && !actor.service) { json(res, 403, { ok: false, error: "только для админа" }); return; }
        const text = String(b.text || "").slice(0, 300).replace(/[\r\n\t]+/g, " ").trim();
        if (!text) { json(res, 400, { ok: false, error: "нужен текст" }); return; }
        const n = { id: crypto.randomBytes(6).toString("hex"), text, ts: Date.now(), by: actor.name || "" };
        notices = liveNotices().concat(n).slice(-10);
        saveNotices();
        note(actor, `отправил сообщение смене: ${text.slice(0, 60)}`);
        console.log(`[notice] ${JSON.stringify(text)}`);
        json(res, 200, { ok: true, notice: n });
        return;
      }
      /* «Понятно» на пульте — снимаем у всех: сообщение прочитано сменой,
         а не отдельным устройством. */
      if (u === "/api/notice/ack") {
        const id = String(b.id || "");
        const was = notices.length;
        notices = notices.filter((n) => n.id !== id);
        if (notices.length !== was) { saveNotices(); note(actor, "прочитал сообщение смене"); }
        json(res, 200, { ok: true });
        return;
      }

      if (u === "/api/view") {                           // общий вид пульта — только админ
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        const rs = normRounds(b);                    // сколько кругов и по сколько минут
        viewCfg = { rs, r1: rs[0], r2: rs[1] || rs[0], r3: rs[2] || rs[rs.length - 1],
          view: b.view === "rings" ? "rings" : "digits", simple: !!b.simple,
          /* ⚠️ Поле, которого клиент НЕ ПРИСЛАЛ, менять нельзя.
             Пульт со старой сборкой шлёт настройки вида без `whiteNum`, и при
             `!!b.whiteNum` это читалось как «выключить»: админ включает настройку,
             кто-то на необновлённом планшете открывает и закрывает ⚙️ — и она молча
             гаснет у всех. Любое новое поле вида добавлять ТОЛЬКО так. */
          whiteNum: "whiteNum" in b ? !!b.whiteNum : !!viewCfg.whiteNum,
          ...(viewCfg.cloudRounds ? { cloudRounds: viewCfg.cloudRounds } : {}) };   // правка на точке не должна сбрасывать память о панели
        saveView();
        note(actor, `настроил вид пульта: круги ${rs.join("/")}, ${viewCfg.simple ? "простой" : viewCfg.view === "rings" ? "кольца" : "цифры"}`);
        json(res, 200, { ok: true, view: viewCfg });
        return;
      }
      if (u === "/api/staff") {                       // добавить/убрать сотрудника — только админ
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        if (b.action === "add") {
          const name = String(b.name || "").slice(0, 40).replace(/[\r\n\t]/g, " ").trim();
          const pin = String(b.pin || "").trim();
          if (!name || !/^\d{4,8}$/.test(pin)) { json(res, 400, { ok: false, error: "имя и ПИН из 4–8 цифр" }); return; }
          if (staff.some((x) => x.active && x.pin === pin)) { json(res, 400, { ok: false, error: "такой ПИН уже занят" }); return; }
          const role = ["admin", "device"].includes(b.role) ? b.role : "master";
          const who = { id: "s" + Date.now().toString(36), name, pin, role, active: true, createdAt: Date.now() };
          staff.push(who); saveStaff(); pushStaffToCloud();
          note(actor, `добавил сотрудника «${name}»`);
          json(res, 200, { ok: true });
          return;
        }
        if (b.action === "remove") {
          const who = staff.find((x) => x.id === b.id);
          if (!who) { json(res, 404, { ok: false }); return; }
          if (who.id === "a1") { json(res, 400, { ok: false, error: "администратора удалить нельзя" }); return; }
          who.active = false; saveStaff(); pushStaffToCloud();
          for (const [t, sess] of Object.entries(sessions)) if (sess.staffId === who.id) delete sessions[t];
          for (const s of subs) if (s.staffId === who.id) s.onShift = false;   // уволен — пуши прекращаются
          saveSessions(); saveSubs();
          note(actor, `убрал сотрудника «${who.name}» (доступ отозван)`);
          json(res, 200, { ok: true });
          return;
        }
        json(res, 400, { ok: false });
        return;
      }

      if (u === "/api/mode") {
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        const on = !!b.service;
        mode = { service: on, blockGuests: on && !!b.blockGuests,
          note: String(b.note || "").slice(0, 140).replace(/[\r\n\t]+/g, " ").trim(),
          since: on ? (mode.service ? mode.since || Date.now() : Date.now()) : 0,
          by: on ? actor.name : "" };
        saveMode();
        note(actor, on
          ? `включил сервисный режим${mode.blockGuests ? " (вызовы гостей закрыты)" : ""}${mode.note ? ": " + mode.note : ""}`
          : "выключил сервисный режим");
        json(res, 200, { ok: true, mode });
        return;
      }

      if (u === "/api/guest") {                       // кнопки и тексты гостевой страницы — только админ
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        const s = (v, n) => String(v || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
        const clean = [];
        for (const raw of (Array.isArray(b.buttons) ? b.buttons : []).slice(0, 6)) {
          const label = s(raw.label, 40);
          if (!label) continue;                        // строка без текста — не кнопка
          const id = /^[a-z0-9]{1,16}$/.test(String(raw.id || "")) ? raw.id : "b" + crypto.randomBytes(3).toString("hex");
          const icon = [...s(raw.icon, 16)].slice(0, 4).join("") || "🔔";
          clean.push({ id, icon, label, sub: s(raw.sub, 60),
            done: s(raw.done, 80) || "Передали кальянщику", withComment: !!raw.withComment });
        }
        if (!clean.length) { json(res, 400, { ok: false, error: "нужна хотя бы одна кнопка" }); return; }
        guestCfg = { buttons: clean, info: String(b.info || "").slice(0, 600).trim() };
        saveGuest();
        /* Тексты гостевой живут в панели: отправляем правку туда, иначе
           ближайший опрос профиля вернул бы старое. */
        cloud.pushGuest({ buttons: guestCfg.buttons, info: guestCfg.info });
        note(actor, `изменил гостевую страницу (${clean.length} ${clean.length === 1 ? "кнопка" : "кнопки"})`);
        json(res, 200, { ok: true, buttons: guestCfg.buttons, info: guestCfg.info });
        return;
      }

      if (u === "/api/ping") {                        // проверка звука: пикнуть на всех открытых пультах
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        soundPing = Date.now();
        pingKind = b.kind === "timer" ? "timer" : "call";
        note(actor, `проверил звук на пультах (${pingKind === "timer" ? "таймер" : "вызов"})`);
        json(res, 200, { ok: true, ts: soundPing, kind: pingKind });
        return;
      }

      if (u === "/api/testcall") {                    // тест: вызов на планшеты, минуя часы и лимиты — только админ
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        const table = +b.table;
        const kind = String(b.kind || "master");
        if (!(table >= 1 && table <= CFG.tables) || (!kindOf(kind) && !KINDS[kind])) { json(res, 400, { ok: false, error: "плохой стол или кнопка" }); return; }
        const c = { id: crypto.randomBytes(8).toString("hex"), table, kind, comment: "🔧 проверка связи",
          ts: Date.now(), status: "new", ackTs: 0, did: "", ip: clientIp(req), ua: "проверка", test: true };
        calls.push(c);
        if (calls.length > CALLS_CAP) calls = calls.slice(-CALLS_CAP);
        save();
        pushCall(c, false);
        const onShiftCount = subs.filter((s) => s.onShift && Date.now() - s.shiftTs < SHIFT_MS).length;
        note(actor, `тест вызова · стол ${table} · ${kindLabel(kind)}`);
        json(res, 200, { ok: true, id: c.id, pushTo: onShiftCount });
        return;
      }
      if (u === "/api/broadcast") {                   // сервисное сообщение всей смене
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        const text = String(b.text || "").slice(0, 300).replace(/[\r\n\t]+/g, " ").trim();
        if (!text) { json(res, 400, { ok: false, error: "пустое сообщение" }); return; }
        const to = pushBroadcast(actor.name, text);
        note(actor, `сообщение смене: «${text}»`, { broadcast: true });
        json(res, 200, { ok: true, sent: to });
        return;
      }

      if (u === "/api/undo") {                        // отменить СВОЁ последнее действие
        const st = myUndo(actor);
        if (!st.length) { json(res, 200, { ok: false, error: "нечего отменять" }); return; }
        const last = st.pop();
        // возвращаем только те столы, которых касалось действие: чужую работу не трогаем
        if (last.key === "*") tstate = last.state;
        else for (const key of Array.isArray(last.key) ? last.key : [last.key]) {
          if (last.state[key]) tstate[key] = last.state[key];
          else delete tstate[key];
        }
        /* Закрытие уносит посадку в архив. Отмена обязана убрать и её: иначе
           стол вернётся на пульт живым, а в статистике останется «закрыт» —
           одна посадка посчитается дважды. */
        if (last.arch && last.arch.length) {
          const gone = new Set(last.arch);
          const before = history.length;
          history = history.filter((r) => !gone.has(r));
          if (history.length !== before) saveHistory();
        }
        saveTables();
        logEvent("undo", { who: actor.name, what: last.what });
        note(actor, `отменил: ${last.what}`);
        json(res, 200, { ok: true, tables: tstate, undone: last.what, canUndo: st.length > 0 });
        return;
      }

      if (u === "/api/flavors") {                       // убрать вкус из подсказок
        if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
        const name = String(b.remove || "").trim();
        if (!name) { json(res, 400, { ok: false, error: "нечего удалять" }); return; }
        const gone = forgetFlavor(name);
        if (gone) note(actor, `убрал вкус из подсказок: «${name.slice(0, 40)}»`);
        json(res, 200, { ok: true, removed: gone, flavors: topFlavors() });
        return;
      }

      if (u === "/api/table") {
        /* ⚠️ Повтор одного и того же действия.
           Потерянный ОТВЕТ неотличим от недоставленного запроса: сервер круг уже
           прибавил, а клиент считает это сбоем связи и шлёт то же самое ещё раз —
           гость получает угли на 15 минут раньше. Клиент теперь прикладывает ключ
           запроса `op`; помним ключи 5 минут и на повтор отвечаем текущим
           состоянием, ничего не меняя. */
        const opRaw = typeof b.opId === "string" ? b.opId : typeof b.op === "string" ? b.op : "";
        const op = /^[a-z0-9]{4,32}$/.test(opRaw) ? opRaw : "";
        if (op) {
          const seen = recentOps.get(op);
          if (seen) {
            console.log(`[повтор] ${b.action} · стол ${b.n} · ключ ${op} — не применяю`);   // закрытие по повтору НЕ закрывает и НЕ архивирует второй раз
            json(res, 200, { ok: true, repeated: true, tables: tstate, canUndo: myUndo(actor).length > 0 });
            return;
          }
          recentOps.set(op, Date.now());
        }
        if (!actorOnShift(req, actor)) { json(res, 403, { ok: false, error: "Заступите на смену, чтобы вести столы" }); return; }
        // ключ стола: номер 1..N или временный подписанный стол "c…"
        const isCustom = typeof b.n === "string" && /^c[a-z0-9]+$/.test(b.n);
        const n = isCustom ? b.n : +b.n;
        const now = Date.now();
        // запоминаем состояние ДО действия — чтобы сотрудник мог откатить свой тап
        const undoWhat = { tap: "новый круг", add: "добавление кальяна", clear: "закрытие стола",
          finish: "завершение кальяна",
          removeHookah: "удаление кальяна", resetAll: "сброс всех столов",
          createCustom: "создание стола", move: "перенос стола",
          build: "правка забивки", stage: "отметка этапа" }[b.action];
        // снимок делаем сейчас, но в стек он попадёт только если действие пройдёт
        const undoSnap = undoWhat ? undoSnapshot() : null;
        const arch = [];               // что ушло в архив этим действием — чтобы «отменить» вернуло и статистику
        let finished = null;           // финальный круг: какой кальян завершили и был ли он последним
        const undoLabel = undoWhat && undoWhat + (isCustom || b.action === "createCustom" ? "" : " · стол " + n);
        const undoKey = b.action === "resetAll" ? "*" : b.action === "move" ? [n, +b.to] : n;
        if (b.action === "createCustom") {
          const label = String(b.label || "").slice(0, 24).replace(/[\r\n\t]/g, " ").trim();
          if (!label) { json(res, 400, { ok: false, error: "нужно название" }); return; }
          if (Object.keys(tstate).filter((k) => k.startsWith("c")).length >= 10) {
            json(res, 400, { ok: false, error: "слишком много временных столов" }); return;
          }
          const id = "c" + now.toString(36) + Math.random().toString(36).slice(2, 5);
          commitUndo(actor, undoLabel, id, undoSnap, []); // отмена уберёт именно этот стол
          const bld0 = betaOn("build", actor) ? cleanBuild(b.build) : null;
          if (bld0 && bld0.flavor) rememberFlavor(bld0.flavor);
          tstate[id] = { sid: newSid(), rev: 1, label, hookahs: [newHookah(bld0)] };
          statStart(label, actor.name, 1, tstate[id].sid, bld0);
          saveTables();
          note(actor, `создал стол «${label}»`);
          json(res, 200, { ok: true, tables: tstate, canUndo: myUndo(actor).length > 0 });
          return;
        }
        if (b.action !== "resetAll" && !isCustom && !(n >= 1 && n <= CFG.tables)) { json(res, 400, { ok: false }); return; }
        if (isCustom && !tstate[n] && b.action !== "clear") { json(res, 404, { ok: false }); return; }
        /* ⚠️ ДЕЙСТВИЕ ВСЛЕПУЮ. Между нажатием на планшете и приходом запроса стол
           мог уехать: гостей пересадили, посадку закрыли, сели новые. Клиент
           прикладывает то, что видел на экране, — посадку (expectedSid) и
           ревизию стола (expectedRevision). Не совпало — не делаем НИЧЕГО и
           отдаём свежие столы: пусть человек посмотрит и решит сам. */
        const exSid = typeof b.expectedSid === "string" ? b.expectedSid : "";
        const exRev = b.expectedRevision === undefined || b.expectedRevision === null
          ? null : Number(b.expectedRevision);
        if (exSid || exRev !== null) {
          const cur = tstate[n];
          if (!cur) { json(res, 409, { ok: false, stale: true, error: "Стол уже свободен", tables: tstate }); return; }
          if (exSid && cur.sid !== exSid) {
            json(res, 409, { ok: false, stale: true, error: "За столом уже другая посадка", tables: tstate }); return; }
          if (exRev !== null && (cur.rev || 0) !== exRev) {
            json(res, 409, { ok: false, stale: true, error: "Стол только что изменили — посмотрите и повторите", tables: tstate }); return; }
        }
        const hid = typeof b.hid === "string" ? b.hid : "";
        let wasEmpty = false;                              // «+ кальян» на пустой стол = посадка, а не добавление
        if (b.action === "arm") {                          // первый тап двойного нажатия — только в хронику:
          const list = (tstate[n] && tstate[n].hookahs) || [];   // если второго тапа не будет, здесь видно, когда был первый
          const h = (hid && list.find((x) => x.id === hid)) || list[0];
          logEvent("arm", { t: isCustom ? ((tstate[n] || {}).label || "стол") : n,
            ...(h ? { r: h.round } : {}), who: actor.name, sid: (tstate[n] || {}).sid });
          json(res, 200, { ok: true });
          return;
        }
        if (b.action === "clear") {                                       // стол свободен целиком
          if (tstate[n]) arch.push(archive(actor, n, tstate[n].label, tstate[n].hookahs, "стол закрыт", tstate[n].sid));
          delete tstate[n];
        }
        else if (b.action === "resetAll") {
          if (actor.role !== "admin") { json(res, 403, { ok: false, error: "только для админа" }); return; }
          for (const [k, t] of Object.entries(tstate)) arch.push(archive(actor, k, t.label, t.hookahs, "сброс всех столов", t.sid));
          tstate = {};
        }
        else if (b.action === "add") {                                    // ещё один кальян на стол
          if (!tstate[n]) { tstate[n] = { sid: newSid(), hookahs: [] }; wasEmpty = true; }
          if (tstate[n].hookahs.length < 6) {
            const bld = betaOn("build", actor) ? cleanBuild(b.build) : null;                              // забивка из конструктора
            if (bld && bld.flavor) rememberFlavor(bld.flavor);
            tstate[n].hookahs.push(newHookah(bld));
            statStart(isCustom ? (tstate[n].label || "стол") : n, actor.name, tstate[n].hookahs.length, tstate[n].sid, bld);
          }
        } else if (b.action === "build") {                                // забивку записали или поправили после запуска
          if (!betaOn("build", actor)) { json(res, 403, { ok: false, error: "конструктор пока в бете" }); return; }
          const t = tstate[n];
          if (!t) { json(res, 404, { ok: false, error: "стол свободен" }); return; }
          const h = (hid && t.hookahs.find((x) => x.id === hid)) || t.hookahs[0];
          if (!h) { json(res, 404, { ok: false }); return; }
          if (b.clear) {                                                  // записал не то — снять забивку целиком
            delete h.build;
            logEvent("build", { t: isCustom ? (t.label || "стол") : n, cleared: 1, who: actor.name, sid: t.sid });
          } else {
            const bld = cleanBuild(b.build);
            if (!bld) { json(res, 400, { ok: false, error: "нечего сохранять" }); return; }
            const late = !(h.build && h.build.heat);                      // забивку дописали задним числом
            // карточка приходит целиком: снятый способ или стёртый вкус должны исчезать, а не залипать
            h.build = bld;
            if (bld.flavor) rememberFlavor(bld.flavor);
            statBuild(isCustom ? (t.label || "стол") : n, h, actor.name, t.sid, late);
          }
        } else if (b.action === "stage") {                                // этап прогрева: прогрелся / отдал гостю
          if (!betaOn("build", actor)) { json(res, 403, { ok: false, error: "конструктор пока в бете" }); return; }
          const t = tstate[n];
          if (!t) { json(res, 404, { ok: false, error: "стол свободен" }); return; }
          const h = (hid && t.hookahs.find((x) => x.id === hid)) || t.hookahs[0];
          if (!h) { json(res, 404, { ok: false }); return; }
          const stage = b.stage === "served" ? "served" : "ready";
          // повторный тап ничего не портит и не задваивает событие
          if (!h[stage]) { h[stage] = now; statStage(isCustom ? (t.label || "стол") : n, h, stage, actor.name, t.sid); }
        } else if (b.action === "removeHookah") {
          if (tstate[n]) {
            const gone = tstate[n].hookahs.find((h) => h.id === hid);
            if (gone) arch.push(archive(actor, n, tstate[n].label, [gone], "кальян убран", tstate[n].sid));
            tstate[n].hookahs = tstate[n].hookahs.filter((h) => h.id !== hid);
            if (!tstate[n].hookahs.length) delete tstate[n];              // последний убрали — стол свободен
          }
        } else if (b.action === "move") {                                 // гости пересели за другой стол
          const to = +b.to;
          if (!tstate[n]) { json(res, 404, { ok: false, error: "стол свободен" }); return; }
          if (!(to >= 1 && to <= CFG.tables)) { json(res, 400, { ok: false, error: "нет такого стола" }); return; }
          if (String(to) === String(n)) { json(res, 400, { ok: false, error: "это тот же стол" }); return; }
          if (tstate[to]) { json(res, 400, { ok: false, error: "стол " + to + " занят" }); return; }
          tstate[to] = { sid: tstate[n].sid, rev: tstate[n].rev || 1, hookahs: tstate[n].hookahs };   // посадка (sid) и таймеры едут как есть
          delete tstate[n];
          /* Барный счёт обязан уехать вместе с гостями: иначе бармен понесёт
             напитки на пустой стол, а официант потеряет заказ. */
          let movedBar = 0;
          for (const o of barOrders) if (String(o.table) === String(n) && !o.closed) { o.table = to; movedBar++; }
          if (movedBar) saveBar();
          logEvent("move", { t: isCustom ? (b.label || "стол") : n, to, who: actor.name, sid: tstate[to].sid });
          pushEvent(req, actor, "move", `Стол ${isCustom ? (b.label || "стол") : n} → ${to}: гости пересели${
            movedBar ? ` · барный счёт переехал` : ""}`);
        } else if (b.action === "tap") {                                  // подали / обновили угли
          if (!tstate[n]) {
            const bld = betaOn("build", actor) ? cleanBuild(b.build) : null;
            if (bld && bld.flavor) rememberFlavor(bld.flavor);
            tstate[n] = { sid: newSid(), hookahs: [newHookah(bld)] };
            statStart(n, actor.name, 1, tstate[n].sid, bld);
          }
          else {
            const list = tstate[n].hookahs;
            const h = (hid && list.find((x) => x.id === hid)) || list[0];
            if (h) {
              /* Четвёртого круга не существует. С финального круга кальян
                 ЗАВЕРШАЮТ (action "finish"), а не продлевают: запрет тут, на
                 сервере, — интерфейс его только повторяет.

                 ⚠️ ПЕРЕХОДНЫЙ ПЕРИОД. У Стамбула пульт ВШИТ в приложение на
                 планшетах: пока их не переустановили, там живёт сборка, которая
                 про финальный круг не знает и умеет только «новый круг». Если
                 запретить ей tap, кальянщик встанет намертво на третьем круге и
                 сможет только закрыть стол крестиком. Новую сборку узнаём по
                 ключу `opId` (старая шлёт только `op`) — ей запрет, старой
                 прежнее поведение. УБРАТЬ, когда на всех устройствах v188+. */
              const newClient = typeof b.opId === "string" && !!b.opId;
              if (newClient && h.round >= finalRound()) {
                json(res, 409, { ok: false, final: true, hid: h.id, round: h.round,
                  error: "Финальный круг — кальян завершают, а не продлевают", tables: tstate });
                return;
              }
              statRound(isCustom ? (tstate[n].label || "стол") : n, h.round, h.roundStart, actor.name, h.plan, tstate[n].sid);
              h.round += 1;
              h.roundStart = now;
              h.plan = roundMinutes(h.round);           // норматив нового круга — снимок на сейчас
              // перешли на второй круг — значит раскурили: с этого момента гость курит
              if (h.round === 2 && !h.smokeStart) h.smokeStart = now;
            }
            else { list.push(newHookah()); statStart(isCustom ? (tstate[n].label || "стол") : n, actor.name, list.length, tstate[n].sid); }
          }
        } else if (b.action === "finish") {
          /* ФИНАЛЬНЫЙ КРУГ: двойное нажатие завершает ИМЕННО ЭТОТ кальян.
             Остальные кальяны стола продолжают тикать, а стол закрывается
             сам — когда завершили последний. */
          const t = tstate[n];
          if (!t) { json(res, 404, { ok: false, stale: true, error: "Стол уже свободен", tables: tstate }); return; }
          const h = (hid && t.hookahs.find((x) => x.id === hid)) || t.hookahs[0];
          if (!h) { json(res, 404, { ok: false, stale: true, error: "Кальян уже убран", tables: tstate }); return; }
          if (h.round < finalRound()) {
            json(res, 400, { ok: false, error: "Кальян ещё не на финальном круге", tables: tstate }); return; }
          finished = { last: t.hookahs.length === 1, i: t.hookahs.indexOf(h) + 1, of: t.hookahs.length };
          arch.push(archive(actor, n, t.label, [h],
            finished.last ? "финальный круг: посадка закрыта" : "финальный круг: кальян завершён", t.sid));
          t.hookahs = t.hookahs.filter((x) => x.id !== h.id);
          if (!t.hookahs.length) delete tstate[n];        // последний кальян завершён — стол снова свободен
        } else { json(res, 400, { ok: false }); return; }
        commitUndo(actor, undoLabel, undoKey, undoSnap, arch);   // сюда доходим только при успехе
        if (tstate[n]) bumpRev(tstate[n]);                       // ревизия стола — против действий вслепую
        if (b.action === "move" && tstate[+b.to]) bumpRev(tstate[+b.to]);
        // кальян реально поставили — заказы официанта по этому столу закрываются сами
        if ((b.action === "tap" || b.action === "add") && tstate[n]) closeOrdersFor(n, "стол запущен", actor.name);
        saveTables();
        const disp = isCustom ? `«${(b.label || "").slice(0, 24) || "временный"}»` : n;
        const bh = (x) => { const h = x && ((hid && x.hookahs.find((y) => y.id === hid)) || x.hookahs[0]);
          const bb = (h && h.build) || {};
          const name = bb.mix && bb.mix.length > 1 ? bb.flavor
            : [bb.brand, bb.flavor].filter(Boolean).join(" ");
          return [bb.heat ? HEAT_LABEL[bb.heat] : "", name].filter(Boolean).join(" · "); };
        const what = { clear: `освободил стол ${disp}`,
          add: `${wasEmpty ? "поставил" : "добавил"} кальян · стол ${disp}${bh(tstate[n]) ? " · " + bh(tstate[n]) : ""}`,
          removeHookah: `убрал кальян · стол ${disp}`, tap: `отметил стол ${disp}`,
          finish: finished && finished.last ? `закрыл стол ${disp}: финальный круг пройден`
            : `завершил кальян ${finished ? finished.i : ""} · стол ${disp}`,
          move: `пересадил стол ${disp} → ${+b.to}`,
          build: b.clear ? `снял забивку · стол ${disp}`
            : `записал забивку · стол ${disp}${bh(tstate[n]) ? " · " + bh(tstate[n]) : ""}`,
          stage: `${b.stage === "served" ? "отдал гостю" : "прогрелся"} · стол ${disp}`,
          resetAll: "освободил ВСЕ столы" }[b.action];
        if (what) note(actor, what, { table: n });
        json(res, 200, { ok: true, tables: tstate, canUndo: myUndo(actor).length > 0,
          ...(finished ? { finished: true, closed: finished.last, left: (tstate[n] && tstate[n].hookahs.length) || 0 } : {}) });
        return;
      }
      if (u === "/api/ack" || u === "/api/done" || u === "/api/spam") {
        const c = calls.find((x) => x.id === b.id);
        if (!c) { json(res, 404, { ok: false }); return; }
        if (u === "/api/ack") {
          c.status = "acked"; c.ackTs = Date.now(); c.ackBy = actor.name;
          logEvent("ack", { t: c.table, k: c.kind, who: actor.name, waitS: Math.round((Date.now() - c.ts) / 1000) });
          note(actor, `принял вызов · стол ${c.table}`, { table: c.table });
        }
        else if (u === "/api/spam") {          // бан устройства (сутки) и IP (час), вызов убрать
          logEvent("spam", { t: c.table, who: actor.name });
          c.status = "done";
          if (c.did) bans.dids[c.did] = Date.now() + BAN_MS;
          if (c.ip) bans.ips[c.ip] = Date.now() + BAN_IP_MS;
          saveBans();
          note(actor, `пометил вызов спамом и забанил · стол ${c.table}`, { table: c.table });
        } else {
          c.status = "done"; c.doneBy = actor.name;
          logEvent("done", { t: c.table, k: c.kind, who: actor.name, waitS: Math.round((Date.now() - c.ts) / 1000) });
          note(actor, `закрыл вызов · стол ${c.table}`, { table: c.table });
        }
        save();
        json(res, 200, { ok: true });
        return;
      }
    }
    json(res, 404, { ok: false });
    return;
  }

  serveStatic(req, res);
 } catch (e) {
  console.error("[handler]", e && e.stack || e);
  try { json(res, 500, { ok: false }); } catch {}
 }
});

// Даже если никто не открыл пульт ровно в 04:00, старая смена и её пуши выключаются.
resetExpiredShift();
setInterval(resetExpiredShift, 30000);
gc();
server.listen(PORT, "127.0.0.1", () =>
  console.log(`ограничения для гостей: ${LIMITS_ON ? "включены" : "ВЫКЛЮЧЕНЫ"} · защита входа: ${AUTH_THROTTLE ? "включена" : "ВЫКЛЮЧЕНА"}`),
  console.log(`«${CFG.venue}»: http://127.0.0.1:${PORT} · столов: ${CFG.tables} · часы: ${CFG.hours && CFG.hours.enabled ? CFG.hours.from + "–" + CFG.hours.to : "круглосуточно"}`));

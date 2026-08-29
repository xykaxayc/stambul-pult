"use strict";
/* ===== FCM HTTP v1 без зависимостей =====
   Android-обёртка пульта не умеет Web Push (System WebView не подключён к
   push-сервису), поэтому телефоны с приложением подписываются нативным
   FCM-токеном, а сервер шлёт им через Firebase. Аутентификация — сервисный
   аккаунт Google: подписываем JWT RS256 своим ключом, меняем на access_token
   (кэшируем ~50 минут), шлём messages:send.

   Ключ: JSON сервисного аккаунта (private_key, client_email, project_id) —
   СЕКРЕТ, живёт только на сервере точки, в git не попадает. Нет файла —
   модуль тихо выключен, Web Push работает как раньше. */
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");

let sa = null;                       // сервисный аккаунт
let cached = { token: "", exp: 0 };  // access_token с запасом по времени

function init(keyFile) {
  try {
    sa = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    if (!sa.private_key || !sa.client_email || !sa.project_id) throw new Error("не хватает полей");
    console.log(`[fcm] включён · проект ${sa.project_id}`);
  } catch (e) {
    sa = null;
    if (e.code !== "ENOENT") console.error("[fcm] ключ не прочитан:", e.message);
  }
  return !!sa;
}
const ready = () => !!sa;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function post(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: "POST", headers, timeout: 10000 }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end(body);
  });
}

async function accessToken() {
  if (!sa) throw new Error("fcm off");
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = b64u(crypto.sign("RSA-SHA256", Buffer.from(head + "." + claim), sa.private_key));
  const body = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
    "&assertion=" + head + "." + claim + "." + sig;
  const r = await post("oauth2.googleapis.com", "/token",
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }, body);
  const d = JSON.parse(r.body || "{}");
  if (!d.access_token) throw new Error("токен не выдан: " + r.body.slice(0, 200));
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in - 300) * 1000 };
  return cached.token;
}

/* Отправка одному устройству. Возвращает: true — ушло; "dead" — токен мёртв
   (приложение снесли/токен ротирован), подписку можно удалять; false — прочая
   ошибка (сеть, квота), подписку НЕ трогаем. */
async function send(token, { title, body, tag }, ttlSec) {
  if (!sa) return false;
  try {
    const at = await accessToken();
    const msg = JSON.stringify({
      message: {
        token,
        notification: { title: title || "", body: body || "" },
        android: {
          priority: "high",
          ttl: (ttlSec || 900) + "s",
          collapse_key: String(tag || "pult").replace(/[^\w.-]/g, "_").slice(0, 60),
          notification: { channel_id: "pult", sound: "default",
            tag: String(tag || "") || undefined },
        },
      },
    });
    const r = await post("fcm.googleapis.com", "/v1/projects/" + sa.project_id + "/messages:send",
      { Authorization: "Bearer " + at, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(msg) }, msg);
    if (r.status === 200) return true;
    // 404/UNREGISTERED — приложение снесли; "not a valid FCM registration token" —
    // токен битый навсегда: обе записи чистим как протухшие
    if (r.status === 404 || /UNREGISTERED|registration token/i.test(r.body)) return "dead";
    console.error("[fcm]", r.status, r.body.slice(0, 160));
    return false;
  } catch (e) { console.error("[fcm]", e.message); return false; }
}

module.exports = { init, ready, send };

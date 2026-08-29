"use strict";
/* Страница печати наклеек. Живёт внутри пульта: ключ уже сохранён в этом браузере,
   а список адресов столов приходит только с ним — иначе адреса можно было бы просто подсмотреть. */

const esc = (s) => String(s).replace(/[<>&"']/g, (ch) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[ch]));

(async () => {
  const msg = document.getElementById("msg");
  const key = localStorage.getItem("serp.key") || "";
  if (!key) {
    msg.textContent = "Сначала откройте пульт и введите ключ — потом вернитесь сюда.";
    return;
  }
  try {
    const r = await fetch("/api/qr", { headers: { "X-Pult-Key": key } });
    if (r.status === 401) { msg.textContent = "Ключ не подошёл. Откройте пульт и введите его заново."; return; }
    const d = await r.json();
    if (!d.ok) { msg.textContent = "Не удалось получить список столов."; return; }
    document.getElementById("sheet").innerHTML = d.tables.map((t) => `
      <div class="card">
        <div class="venue">🌙 ${esc(d.venue).toUpperCase()}</div>
        <div class="table">Стол ${t.n}</div>
        <img src="${esc(t.img)}" alt="QR стол ${t.n}" />
        <div class="hint">Наведите камеру —<br />позовите кальянщика со стола</div>
        <div class="dom">${esc(location.host)}</div>
      </div>`).join("");
  } catch {
    msg.textContent = "Нет связи с сервером.";
  }
})();

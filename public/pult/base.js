"use strict";
/* Пульт умеет жить под префиксом адреса.
   Боевой пульт лежит на /pult/, песочница «Пульт 2» — на /pult2/pult/.
   Страницы, стили и картинки подключены относительно и переезжают сами,
   а код зовёт /api/… от корня — поэтому здесь один раз подменяем fetch.
   Заодно красим шапку, чтобы песочницу нельзя было спутать с боевым залом.
   На боевом префикса нет — файл не делает ничего.
   Подключать ПЕРВЫМ на каждой странице пульта, до остального кода. */
(function () {
  var m = location.pathname.match(/^(.*)\/pult\//);
  var base = (m && m[1]) || "";

  /* В нативном приложении оболочка лежит ВНУТРИ пакета и открывается по
     capacitor://localhost — значит /api/… некуда слать относительно.
     Подставляем боевой адрес: с сервера берём только данные. */
  if (location.protocol === "capacitor:" || location.protocol === "ionic:")
    base = "https://kalyan.stambul42.ru";

  window.SERP_BASE = base;

  /* ---- БРЕНД ИЗ ПАНЕЛИ УПРАВЛЕНИЯ ----
     Акцентный цвет задаётся в панели, а не в стилях точки. Сначала красим по
     кэшу (иначе на каждой загрузке был бы проблеск старого цвета), потом
     спрашиваем сервер и обновляем кэш. */
  try {
    var paint = function (b) {
      if (!b) return;
      var r = document.documentElement.style;
      if (b.accent) r.setProperty("--ember", b.accent);
      if (b.accent2) r.setProperty("--ember2", b.accent2);
      if (b.name) document.title = b.name + document.title.replace(/^[^·|]*/, "").replace(/^\s*/, " ");
    };
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem("serp.brand") || "null"); } catch (e) {}
    paint(cached);
    fetch(base + "/api/config").then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.brand) return;
      var s = JSON.stringify(j.brand);
      if (s !== localStorage.getItem("serp.brand")) { localStorage.setItem("serp.brand", s); paint(j.brand); }
    }).catch(function () {});
  } catch (e) {}

  window.SERP_BASE = base;
  if (!base) return;

  /* В приложении оболочка лежит по capacitor://localhost, а картинки (QR-коды
     столов и прочее) — абсолютными путями «/qr/…» на сервере. fetch мы чиним
     ниже, но <img src="/…"> идёт мимо него и превращается в битую ссылку.
     Дописываем адрес и им — иначе на странице проверки вместо кодов пустые
     квадраты, что и было видно на телефоне. */
  if (/^https?:/.test(base)) {
    var fix = function (el) {
      var a = el.getAttribute && el.getAttribute("src");
      if (a && a.charAt(0) === "/" && a.charAt(1) !== "/") el.setAttribute("src", base + a);
    };
    var rewriteAssets = function (root) {
      if (!root || !root.querySelectorAll) return;
      if (root.tagName === "IMG") fix(root);
      var list = root.querySelectorAll("img[src^='/']");
      for (var i = 0; i < list.length; i++) fix(list[i]);
    };
    new MutationObserver(function (recs) {          // коды дорисовываются после ответа сервера
      for (var i = 0; i < recs.length; i++)
        for (var j = 0; j < recs[i].addedNodes.length; j++) rewriteAssets(recs[i].addedNodes[j]);
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", function () { rewriteAssets(document); });
    else rewriteAssets(document);
  }

  var f = window.fetch;
  window.fetch = function (u, o) {
    if (typeof u === "string" && u.charAt(0) === "/") u = base + u;
    return f.call(window, u, o);
  };

  function mark() {
    if (!document.body || document.getElementById("sbMark")) return;
    var s = document.createElement("style");
    s.textContent =
      "#sbMark{position:fixed;left:0;right:0;top:0;z-index:999;height:4px;pointer-events:none;" +
        "background:repeating-linear-gradient(90deg,#ff4d4d 0 14px,transparent 14px 28px)}" +
      "#sbMark b{position:absolute;left:50%;transform:translateX(-50%);top:4px;" +
        "background:#ff4d4d;color:#14100b;letter-spacing:.6px;" +
        "font:800 10px/1 -apple-system,'Segoe UI',Roboto,sans-serif;" +
        "padding:3px 10px;border-radius:0 0 8px 8px}";
    document.head.appendChild(s);
    var d = document.createElement("div");
    d.id = "sbMark";
    d.innerHTML = "<b>ПЕСОЧНИЦА · ПУЛЬТ 2</b>";
    document.body.appendChild(d);
    document.title = "🧪 " + document.title;
  }
  if (/^https?:/.test(base)) return;          // приложение — не песочница, метку не рисуем
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mark);
  else mark();

})();

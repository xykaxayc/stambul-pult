"use strict";
/* Общая навигация по страницам «Серпа». Подключение на любой странице:
     <script src="nav.js?v=1" defer></script>                    — панель сверху
     <script src="nav.js?v=1" defer data-mode="menu"></script>   — кнопка ☰ в шапке пульта
   Админские страницы не показываются обычным сотрудникам (это косметика:
   доступ всё равно проверяет сервер). */
(function () {
  var me = null;
  try { me = JSON.parse(localStorage.getItem("serp.me") || "null"); } catch (e) {}
  var admin = me && me.role === "admin";
  var beta = { build: false };
  try { beta = JSON.parse(localStorage.getItem("serp.beta") || "{}"); } catch (e) {}
  /* Какие модули подключены точке — приходит из панели управления через
     /api/config, кэш в localStorage, чтобы меню не мигало на загрузке. */
  var mods = {};
  try { mods = JSON.parse(localStorage.getItem("serp.modules") || "{}"); } catch (e) {}
  var modOn = function (name) { return mods[name] === undefined ? true : !!mods[name]; };

  var ITEMS = [
    { href: "/pult/", icon: '<svg class="serp-nav-ic" viewBox="0 0 24 24"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>', name: "Пульт" },
    { href: "/pult/hub.html", icon: '<svg class="serp-nav-ic" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>', name: "Админка", admin: true },
    { href: "/pult/stats.html", icon: '<svg class="serp-nav-ic" viewBox="0 0 24 24"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>', name: "Статистика", module: "stats" },
    { href: "/pult/build.html", icon: '<svg class="serp-nav-ic" viewBox="0 0 24 24"><path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/></svg>', name: "Забивки", beta: "build", module: "build" },
    { href: "/pult/test.html", icon: '<svg class="serp-nav-ic" viewBox="0 0 24 24"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/></svg>', name: "Проверка", admin: true },
    { href: "/pult/diag.html", icon: '<svg class="serp-nav-ic" viewBox="0 0 24 24"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>', name: "Диагностика", module: "diag" },
  ].filter(function (it) { return (!it.admin || admin) && (!it.beta || beta[it.beta]) && (!it.module || modOn(it.module)); });

  // пульт может жить под префиксом (песочница /pult2) — ссылки и подсветка с ним
  var base = window.SERP_BASE || "";
  var path = base && location.pathname.indexOf(base) === 0
    ? location.pathname.slice(base.length) : location.pathname;
  var here = (path === "/pult/" || path.indexOf("index") !== -1) ? "/pult/" : path;

  var style = document.createElement("style");
  style.textContent =
    ".serp-nav{display:flex;gap:8px;flex-wrap:wrap;" +
      "padding:calc(10px + env(safe-area-inset-top,0px)) calc(14px + env(safe-area-inset-right,0px)) 10px calc(14px + env(safe-area-inset-left,0px));background:#1e1611;border-bottom:1px solid #3a2c20;scrollbar-width:none}" +
    ".serp-nav::-webkit-scrollbar{display:none}" +
    ".serp-nav-ic{width:15px;height:15px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}" +
      ".serp-nav a{flex:0 0 auto;display:flex;gap:6px;align-items:center;padding:8px 13px;" +
      "border-radius:999px;border:1px solid #3a2c20;color:#a08b78;text-decoration:none;" +
      "font:600 13px/1 -apple-system,'Segoe UI',Roboto,sans-serif;white-space:nowrap}" +
    ".serp-nav a.cur{background:rgba(255,122,24,.15);border-color:rgba(255,122,24,.55);color:#ffb347}" +
    ".serp-menu-pop{position:fixed;z-index:400;right:8px;background:#241a13;border:1px solid #3a2c20;" +
      "border-radius:14px;padding:6px;box-shadow:0 10px 30px rgba(0,0,0,.45);display:none;min-width:190px}" +
    ".serp-menu-pop.open{display:block}" +
    ".serp-menu-pop a{display:flex;gap:10px;align-items:center;padding:11px 12px;border-radius:10px;" +
      "color:#f3e9df;text-decoration:none;font:600 14px/1 -apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".serp-menu-pop a.cur{color:#ffb347;background:rgba(255,122,24,.12)}" +
    "@media print{.serp-nav,.serp-menu-pop{display:none!important}}";
  document.head.appendChild(style);

  function link(it, cls) {
    var a = document.createElement("a");
    a.href = base + it.href;
    a.className = (it.href === here ? "cur " : "") + (cls || "");
    a.innerHTML = "<span>" + it.icon + "</span><span>" + it.name + "</span>";
    return a;
  }

  var mode = (document.currentScript && document.currentScript.dataset.mode) || "bar";

  if (mode === "menu") {
    // пульт: одна кнопка ☰ в шапке, столы не двигаем
    var actions = document.querySelector(".top-actions");
    if (!actions) return;
    var pop = document.createElement("div");
    pop.className = "serp-menu-pop";
    ITEMS.forEach(function (it) { pop.appendChild(link(it)); });
    document.body.appendChild(pop);
    var btn = document.createElement("button");
    btn.className = "icon-btn";
    btn.title = "Другие страницы";
    btn.setAttribute("aria-label", "Меню");
    btn.textContent = "☰";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var r = btn.getBoundingClientRect();
      pop.style.top = (r.bottom + 8) + "px";
      pop.classList.toggle("open");
    });
    document.addEventListener("click", function (e) {
      if (!pop.contains(e.target) && e.target !== btn) pop.classList.remove("open");
    });
    actions.insertBefore(btn, actions.firstChild);
  } else {
    var nav = document.createElement("nav");
    nav.className = "serp-nav";
    nav.setAttribute("aria-label", "Страницы пульта");
    ITEMS.forEach(function (it) { nav.appendChild(link(it)); });
    document.body.insertBefore(nav, document.body.firstChild);
    var cur = nav.querySelector("a.cur");
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ inline: "center", block: "nearest" });
  }

  /* Обновляем карту модулей с сервера. Поменялась — перечитываем страницу,
     иначе в меню остался бы вход в отключённый раздел. */
  try {
    fetch(base + "/api/config").then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.modules) return;
      var s = JSON.stringify(j.modules);
      if (s !== localStorage.getItem("serp.modules")) {
        localStorage.setItem("serp.modules", s);
        if (Object.keys(mods).length) location.reload();
      }
    }).catch(function () {});
  } catch (e) {}
})();

/* SkyShelf: vanilla JavaScript frontend. Все данные приходят из Java REST API. */
"use strict";
const $ = (s, root = document) => root.querySelector(s);
const app = $("#app"),
  modal = $("#modal");
const state = {
  user: null,
  csrf: null,
  files: [],
  folders: [],
  projects: [],
  usage: {},
  view: "files",
  projectId: null,
  folderId: null,
  query: "",
  filter: "all",
  uploading: false,
  projectDetail: null,
  tasks: [],
  members: [],
  activity: [],
};
const paths = {
  cloud: "M7 18h11a4 4 0 0 0 .5-8A6.5 6.5 0 0 0 6 8a5 5 0 0 0 1 10Z",
  folder:
    "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  files: "M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8M8 17h6",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5",
  download: "M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  team: "M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3m17 0v-3a4 4 0 0 0-3-4M13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm3-3a4 4 0 0 1 0 7",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm-2-5h4l1 3 3-1 3 4-2 3 2 3-3 4-3-1-1 3h-4l-1-3-3 1-3-4 2-3-2-3 3-4 3 1 1-3Z",
  shield: "M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Zm-4 10 3 3 5-6",
  logout: "M9 4H3v16h6m5-13 5 5-5 5m-6-5h11",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  edit: "m15 4 5 5M4 16 16 4a3 3 0 0 1 4 4L8 20H4v-4Z",
  link: "m10 13 4-4m-5-2 2-2a5 5 0 0 1 7 7l-2 2m-7-4-3 3a5 5 0 0 0 7 7l2-2",
  star: "m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z",
  restore: "M3 10a9 9 0 1 1 1 8M3 4v6h6m3-4v6l4 2",
  close: "m6 6 12 12M6 18 18 6",
  clock: "M12 7v5l4 2M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0Z",
  menu: "M4 6h16M4 12h16M4 18h16",
  check: "m5 12 4 4L19 6",
  lock: "M6 11h12v10H6V11Zm2 0V7a4 4 0 0 1 8 0v4",
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3",
  activity: "M3 12h4l2-6 4 12 2-6h6",
  versions: "M3 12a9 9 0 1 0 3-6.7M3 4v6h6M12 7v5l3 2",
  calendar: "M4 5h16v16H4V5Zm4-3v6m8-6v6M4 10h16",
  deadline: "M4 5h16v16H4V5Zm4-3v6m8-6v6M4 10h16",
  book: "M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 0-3 1V4Zm3 16V4",
  spark: "m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7L12 2Zm7 13 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  palette: "M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h5a4 4 0 0 0 4-4c0-3-4-6-9-6ZM7 10h.01M9 6h.01m5 0h.01m3 4h.01",
  package: "m12 2 9 5-9 5-9-5 9-5Zm-9 5v10l9 5 9-5V7M12 12v10",
  copy: "M8 8h12v12H8V8ZM4 4h12v4H8v8H4V4Z",
  flag: "M5 21V4m0 1h11l-2 4 2 4H5",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.files}"/></svg>`;
const esc = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const brand = () =>
  `<a class="brand" href="#home" aria-label="SkyShelf, главная"><span class="brand-icon">${icon("cloud")}</span>SkyShelf</a>`;
const btn = (label, action, type = "", ico = "") =>
  `<button class="btn ${type}" data-action="${action}">${ico ? icon(ico) : ""}${label}</button>`;
const ib = (label, action, id, ico) =>
  `<button class="icon-btn" title="${label}" aria-label="${label}" data-action="${action}" data-id="${id}">${icon(ico)}</button>`;
const roles = {
  OWNER: "Владелец",
  MEMBER: "Участник",
  READER: "Читатель",
  USER: "Пользователь",
  ADMIN: "Администратор",
};
const plans = { START: "Старт", PERSONAL: "Личный", TEAM: "Команда" };
const projectStatuses = { IN_PROGRESS: "В работе", READY: "Готов к сдаче", SUBMITTED: "Передан" };
const prettySize = (b) =>
  b < 1024
    ? `${b} Б`
    : b < 1048576
      ? `${(b / 1024).toFixed(1)} КБ`
      : b < 1073741824
        ? `${(b / 1048576).toFixed(1)} МБ`
        : `${(b / 1073741824).toFixed(0)} ГБ`;
const prettyDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : "—";
const prettyFullDate = (iso) => iso ? new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Не указано";
const project = () => state.projects.find((p) => p.id === state.projectId);
const writable = () => !state.projectId || project()?.role !== "READER";
const owner = () => !state.projectId || project()?.role === "OWNER";
const suffix = () =>
  state.projectId ? `?projectId=${encodeURIComponent(state.projectId)}` : "";
let toastTimer,
  routeEpoch = 0;
function toast(message, error = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = `show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 5000);
}
async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  if (options.method && !["GET", "HEAD"].includes(options.method)) {
    if (!state.csrf) await csrf();
    headers[state.csrf.header] = state.csrf.token;
  }
  let res;
  try {
    res = await fetch("/api" + path, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  } catch {
    throw new Error("Сервер недоступен. Проверьте, что backend запущен.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.includes("/auth/")) state.user = null;
    throw new Error(data.message || `Ошибка запроса (${res.status})`);
  }
  return data;
}
async function csrf() {
  const res = await fetch("/api/auth/csrf", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Не удалось подключиться к серверу.");
  state.csrf = await res.json();
}
function applyAppearance() {
  document.documentElement.dataset.theme = state.user?.theme || "dark";
  document.documentElement.dataset.accent = state.user?.accent || "blue";
}
function publicNav() {
  return `<header class="public-nav"><div>${brand()}<span class="version-pill">Final 1.0</span></div><nav><a href="#home" data-action="scroll-section" data-section="student-suite">Для учёбы</a><a href="#home" data-action="scroll-section" data-section="security-story">Защита</a><a href="#home" data-action="scroll-section" data-section="workflow">Как работает</a>${state.user ? '<a class="btn primary magnetic" href="#files">Открыть хранилище</a>' : '<a href="#login">Войти</a><a class="btn primary magnetic" href="#register">Начать бесплатно</a>'}</nav></header>`;
}
function landing() {
  document.body.classList.add("landing-mode");
  app.innerHTML = `<div class="cursor-dot"></div><div class="cursor-ring"></div><div class="landing-noise"></div><div class="public-shell landing-shell">${publicNav()}<main>
  <section class="landing-hero new-hero" id="top"><div class="hero-grid"></div><div class="hero-orb orb-a" data-parallax=".08"></div><div class="hero-orb orb-b" data-parallax="-.05"></div><div class="hero-copy reveal"><div class="eyebrow"><span class="live-dot"></span> Облако для учебных команд</div><h1>От первой идеи<br>до <span>готовой сдачи.</span></h1><p>SkyShelf собирает файлы, команду, версии и дедлайн в одном защищённом пространстве — без хаоса в чатах и «final_final_3».</p><div class="hero-actions"><a class="btn primary large magnetic" href="${state.user ? "#files" : "#register"}">Создать пространство ${icon("arrow")}</a><a class="btn glass large magnetic" href="#home" data-action="scroll-section" data-section="student-suite">Посмотреть возможности</a></div><div class="hero-trust"><span>${icon("shield")} AES‑256‑GCM</span><span>${icon("versions")} История версий</span><span>${icon("team")} Команда до 5 человек</span></div></div>
  <div class="hero-visual reveal" data-parallax="-.035"><div class="glass-cloud"><img src="assets/cloud.png" alt="Стеклянное облако SkyShelf"><div class="cloud-sheen"></div><div class="float-chip chip-one">${icon("check")} Итоговая версия готова</div><div class="float-chip chip-two">${icon("lock")} Файл зашифрован</div><div class="float-chip chip-three"><b>04</b><span>задачи<br>проекта</span></div></div></div><a class="scroll-cue" href="#home" data-action="scroll-section" data-section="problem"><span></span>Листайте, чтобы увидеть путь проекта</a></section>

  <section class="problem-section section-pad" id="problem"><div class="section-kicker reveal">01 · Проблема</div><div class="split-heading reveal"><h2>Учебный проект живёт<br>сразу в <span>пяти местах.</span></h2><p>Файлы — в мессенджере, задачи — в заметках, актуальная версия — у одного участника, а ссылка преподавателю создаётся в последнюю минуту.</p></div><div class="problem-track">
    <article class="problem-card reveal"><span>01</span>${icon("files")}<h3>Версии теряются</h3><p>Непонятно, какой файл последний и кто внёс изменения.</p></article>
    <article class="problem-card reveal"><span>02</span>${icon("team")}<h3>Ответственность размыта</h3><p>Участники не видят общий прогресс и исполнителей.</p></article>
    <article class="problem-card reveal"><span>03</span>${icon("deadline")}<h3>Сдача собирается вручную</h3><p>Нет единого итогового файла и контролируемой ссылки.</p></article>
  </div></section>

  <section class="student-section section-pad" id="student-suite"><div class="student-backdrop" data-parallax=".04">SKYSHELF</div><div class="section-kicker reveal">02 · Student workspace</div><div class="split-heading reveal"><h2>Не просто диск.<br><span>Рабочая полка проекта.</span></h2><p>Мы добавили сценарии, которых не хватает обычным облакам: курс, преподаватель, дедлайн, чек‑лист и отдельный режим сдачи.</p></div><div class="bento">
    <article class="bento-card bento-project reveal"><div class="mini-project"><div class="mini-top"><span class="mini-orb"></span><span>СПО · ЭФБО-14-24</span><b>72%</b></div><h3>SkyShelf · итоговый проект</h3><div class="mini-progress"><i style="width:72%"></i></div><div class="mini-tasks"><span class="done">${icon("check")} Материалы собраны</span><span class="done">${icon("check")} Роли проверены</span><span>${icon("flag")} Выбрать итоговый файл</span></div></div><div><span class="card-index">A</span><h3>Чек‑лист сдачи</h3><p>Вся команда видит следующий шаг, прогресс и дедлайн.</p></div></article>
    <article class="bento-card reveal"><span class="card-icon">${icon("versions")}</span><span class="card-index">B</span><h3>Версии без дублей</h3><p>Загрузите новую редакцию, оставьте комментарий и вернитесь к любой версии.</p><div class="version-stack"><i>v3 · сейчас</i><i>v2 · 18:40</i><i>v1 · первая версия</i></div></article>
    <article class="bento-card reveal"><span class="card-icon">${icon("link")}</span><span class="card-index">C</span><h3>Ссылка преподавателю</h3><p>Чистая публичная карточка проекта: описание, команда и только итоговый файл.</p><div class="teacher-link">skyshelf.local/#submit/<span>••••••••</span></div></article>
    <article class="bento-card bento-custom reveal"><span class="card-index">D</span><div><h3>Проект со своим характером</h3><p>Обложка, цвет, название курса и визуальный акцент для каждой команды.</p></div><div class="swatches"><i></i><i></i><i></i><i></i></div></article>
  </div></section>

  <section class="workflow-section section-pad" id="workflow"><div class="section-kicker reveal">03 · Путь клиента</div><div class="split-heading reveal"><h2>Один понятный маршрут.<br><span>От команды до защиты.</span></h2><p>Интерфейс ведёт пользователя по реальному сценарию семестрового проекта и не требует отдельного менеджера задач.</p></div><div class="workflow-line reveal"><i></i>${[["01","Создать проект","Курс, преподаватель, дедлайн"],["02","Пригласить команду","Владелец, участник, читатель"],["03","Собрать работу","Файлы, папки, версии, чек‑лист"],["04","Зафиксировать финал","Итоговый файл и ZIP‑пакет"],["05","Передать ссылку","Контролируемая сдача преподавателю"]].map(x=>`<article><b>${x[0]}</b><span>${icon(x[0]==="05"?"flag":"arrow")}</span><h3>${x[1]}</h3><p>${x[2]}</p></article>`).join("")}</div></section>

  <section class="security-section section-pad" id="security-story"><div class="security-visual reveal"><div class="security-core">${icon("shield")}<span>ZERO<br>PLAIN<br>FILES</span></div><div class="orbit orbit-one"><i>AES</i><i>256</i><i>GCM</i></div><div class="orbit orbit-two"><i>SHA</i><i>2FA</i><i>CSRF</i></div></div><div class="security-copy reveal"><div class="section-kicker">04 · Защита данных</div><h2>Безопасность —<br><span>часть архитектуры.</span></h2><p>Файл шифруется на сервере до записи в объектное хранилище. При чтении проверяется аутентичность AES‑GCM и контрольная сумма SHA‑256.</p><div class="security-list"><div><b>01</b><span><strong>Argon2id</strong>Пароли не хранятся в открытом виде</span></div><div><b>02</b><span><strong>TOTP‑2FA</strong>Второй фактор через приложение‑аутентификатор</span></div><div><b>03</b><span><strong>Хешированные ссылки</strong>Исходный токен не попадает в базу данных</span></div><div><b>04</b><span><strong>Журнал действий</strong>Команда видит значимые события проекта</span></div></div></div></section>

  <section class="architecture-strip reveal"><div><span>Frontend</span><strong>HTML · CSS · JavaScript</strong></div><i>${icon("arrow")}</i><div><span>REST API</span><strong>Java 17 · Spring Boot</strong></div><i>${icon("arrow")}</i><div><span>Data</span><strong>PostgreSQL · MinIO</strong></div><div class="arch-lock">${icon("lock")} AES‑GCM</div></section>

  <section class="final-cta section-pad reveal"><div class="cta-cloud"><img src="assets/cloud.png" alt=""><span></span></div><div><div class="section-kicker">Готовы собрать проект?</div><h2>Пусть у команды будет<br><span>одна актуальная версия.</span></h2><p>Начните с демо-пространства и пройдите весь сценарий сдачи за несколько минут.</p><a class="btn primary large magnetic" href="${state.user ? "#projects" : "#login"}">${state.user ? "Открыть проекты" : "Войти в демо"} ${icon("arrow")}</a></div></section>
  </main><footer class="public-foot rich-foot"><div>${brand()}<p>Защищённое облако для учебных команд.</p></div><div><b>Команда</b><span>Бухман Лев · Team Lead</span><span>Селезнёв Сергей · Аналитик</span><span>Ладинский Александр · Frontend/Backend</span></div><div><b>Проект</b><span>СПО · ЭФБО-14-24</span><span>Final 1.0 · 2026</span></div></footer></div>`;
  initLandingMotion();
}

function initLandingMotion() {
  const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches, dot=$(".cursor-dot"),ring=$(".cursor-ring");
  if(!reduce&&matchMedia("(pointer:fine)").matches){let x=-50,y=-50,rx=-50,ry=-50;window.onpointermove=e=>{x=e.clientX;y=e.clientY;dot.style.transform=`translate3d(${x}px,${y}px,0)`;document.body.classList.toggle("cursor-hover",!!e.target.closest("a,button,input,select"));};const tick=()=>{rx+=(x-rx)*.14;ry+=(y-ry)*.14;ring.style.transform=`translate3d(${rx}px,${ry}px,0)`;if(document.body.classList.contains("landing-mode"))requestAnimationFrame(tick);};tick();}
  const reveal=new IntersectionObserver(items=>items.forEach(item=>{if(item.isIntersecting){item.target.classList.add("shown");reveal.unobserve(item.target);}}),{threshold:.13});document.querySelectorAll(".reveal").forEach(el=>reveal.observe(el));
  const parallax=()=>{const y=scrollY;document.querySelectorAll("[data-parallax]").forEach(el=>el.style.transform=`translate3d(0,${y*Number(el.dataset.parallax)}px,0)`);document.documentElement.style.setProperty("--scroll",Math.min(1,y/700));};window.onscroll=reduce?null:parallax;parallax();
}
function authPage(register = false) {
  app.innerHTML = `<div class="public-shell auth-shell">${publicNav()}<main class="auth-layout"><div class="auth-story"><div class="auth-cloud"><img src="assets/cloud.png" alt=""></div><div><span class="eyebrow">Protected student cloud</span><h2>Место для того,<br>что вы создаёте.</h2><div class="auth-security">${icon("shield")} AES‑256‑GCM · Argon2id · TOTP</div></div></div><section class="auth-form"><div class="eyebrow">Ваше облако SkyShelf</div><h1 style="margin-top:14px">${register ? "Начнём с знакомства" : "С возвращением"}</h1><p>${register ? "Создайте аккаунт и загрузите первый файл." : "Войдите, чтобы продолжить работу с файлами."}</p><form id="auth-form">${register ? '<label>Ваше имя<input name="name" autocomplete="name" maxlength="80" required placeholder="Александр"></label>' : ""}<label>Email<input name="email" type="email" autocomplete="email" required maxlength="180" placeholder="you@example.com"></label><label>Пароль<input name="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" required minlength="${register ? "10" : "1"}" maxlength="128" placeholder="${register ? "Не менее 10 символов" : "Введите пароль"}"></label>${!register?'<label>Код 2FA <span class="label-hint">если включён</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000 000"></label>':""}<p class="form-error" role="alert"></p><button class="btn primary" type="submit">${register ? "Создать аккаунт" : "Войти в хранилище"} ${icon("arrow")}</button></form><p class="auth-switch">${register ? 'Уже есть аккаунт? <a class="text-link" href="#login">Войти</a>' : 'Впервые здесь? <a class="text-link" href="#register">Создать аккаунт</a>'}</p><div class="demo-hint"><b>Демо:</b> demo@skyshelf.local · SkyShelfDemo2026!</div></section></main></div>`;
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      data = Object.fromEntries(new FormData(form));
    const submit = $("button[type=submit]", form);
    submit.disabled = true;
    try {
      await csrf();
      if (register) await api("/auth/register", { method: "POST", body: data });
      state.user = await api("/auth/login", {
        method: "POST",
        body: { email: data.email, password: data.password, code: data.code || null },
      });
      await csrf();
      applyAppearance();
      location.hash = "#files";
      toast(
        register ? "Аккаунт создан. Добро пожаловать!" : "Вы вошли в SkyShelf",
      );
    } catch (error) {
      $(".form-error", form).textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
}
async function loadWorkspace() {
  const [files, folders, usage, projects] = await Promise.all([
    api("/files" + suffix()),
    api("/folders" + suffix()),
    api("/storage" + suffix()),
    api("/projects"),
  ]);
  Object.assign(state, { files, folders, usage, projects });
}
function navItem(view, label, ico) {
  return `<a class="nav-item ${state.view === view ? "selected" : ""}" href="#${view}" ${state.view === view ? 'aria-current="page"' : ""}>${icon(ico)}${label}${view === "trash" && state.usage.trashCount ? `<span class="count">${state.usage.trashCount}</span>` : ""}</a>`;
}
function shell(body) {
  const u = state.user,
    usage = state.usage,
    percent = Math.min(100, ((usage.used || 0) / (usage.quota || 1)) * 100);
  app.innerHTML = `<div class="shell"><aside class="sidebar">${brand()}<div class="sidebar-version">Final 1.0 · protected cloud</div><p class="workspace-label">Библиотека</p><nav>${navItem("files", "Мои файлы", "files")}${navItem("favorites", "Избранное", "star")}${navItem("projects", "Учебные проекты", "team")}${navItem("trash", "Корзина", "trash")}<p class="workspace-label nav-label">Контроль</p>${navItem("activity", "Журнал действий", "activity")}${navItem("security", "Безопасность", "shield")}${navItem("settings", "Настройки", "settings")}${u.role === "ADMIN" ? navItem("admin", "Администрирование", "lock") : ""}</nav><div class="sidebar-bottom"><div class="quota-box"><div class="row between"><span>${icon("cloud")} Хранилище</span><span class="badge">${esc(plans[usage.plan] || "Старт")}</span></div><div class="progress"><span style="width:${percent}%"></span></div><p>${prettySize(usage.used || 0)} из ${prettySize(usage.quota || 16106127360)}</p><p class="secure-caption">${icon("lock")} Объекты зашифрованы</p></div><div class="user-mini"><span class="avatar">${esc(u.name.slice(0, 2).toUpperCase())}</span><div><div class="name">${esc(u.name)}</div><p>${roles[u.role]}</p></div>${ib("Выйти", "logout", "", "logout")}</div></div></aside><div class="main"><header class="topbar"><button class="icon-btn mobile-menu" data-action="menu" aria-label="Открыть меню">${icon("menu")}</button><label class="search" aria-label="Поиск файлов">${icon("search")}<input id="search" placeholder="Поиск по файлам и версиям" value="${esc(state.query)}" autocomplete="off"></label><div class="topbar-right"><span class="sync-state"><span class="status-dot"></span>Данные защищены</span><span class="badge top-secure">${icon("shield")} AES‑256</span><a class="avatar" href="#settings" aria-label="Настройки профиля">${esc(u.name.slice(0, 2).toUpperCase())}</a></div></header><main class="content">${body}</main></div></div>`;
  $("#search").oninput = (e) => {
    state.query = e.target.value;
    if (["files", "favorites", "trash", "project"].includes(state.view)) renderFiles();
  };
  setupDrop();
}
function fileType(f) {
  const ext = f.name.split(".").pop().toUpperCase();
  const cl = ["PNG", "JPG", "JPEG"].includes(ext)
    ? "image"
    : ext === "PDF"
      ? "pdf"
      : ext === "ZIP"
        ? "zip"
        : "";
  return `<span class="file-type ${cl}">${esc(ext.slice(0, 4))}</span>`;
}
function empty(title, text, action = "") {
  return `<div class="empty">${icon("cloud")}<h3>${title}</h3><p>${text}</p>${action}</div>`;
}
function workspacePage() {
  const trash = state.view === "trash" || state.projectTrash,
    p = project(),
    isProject = state.view === "project";
  let heading = state.view === "favorites" ? "Избранное" : trash
    ? "Корзина"
    : isProject
      ? esc(p?.name || "Общий проект")
      : "Мои файлы";
  const folder = state.folders.find((f) => f.id === state.folderId);
  if (folder) heading = esc(folder.name);
  const folders = state.folders
    .map(
      (f) =>
        `<article class="folder-card"><div class="folder-top"><span class="${esc(f.color)}">${icon("folder")}</span>${writable() ? ib("Настройки папки", "folder-edit", f.id, "more") : ""}</div><button class="folder-name" data-action="open-folder" data-id="${f.id}">${esc(f.name)}</button><small>${state.files.filter((x) => x.folderId === f.id && !x.trashed).length} файлов</small></article>`,
    )
    .join("");
  shell(
    `${isProject ? '<div class="breadcrumb"><a href="#projects">Учебные проекты</a><span>/</span><span>' + esc(p?.name) + "</span></div>" : ""}${folder ? '<div class="breadcrumb"><button data-action="folder-back">Все папки</button><span>/</span><span>' + esc(folder.name) + "</span></div>" : ""}<div class="page-heading"><div><div class="page-kicker">${state.view === "favorites" ? "Быстрый доступ" : trash ? "Безопасное удаление" : "Личное пространство"}</div><h1>${heading}</h1><p>${state.view === "favorites" ? "Отмеченные материалы из личного пространства." : trash ? "Удалённые файлы остаются здесь и занимают место." : isProject ? `${p?.members || 1} из ${p?.memberLimit || 5} участников · Ваша роль: ${roles[p?.role] || ""}` : "Ваши материалы, версии и папки — в одном защищённом месте."}</p></div><div class="row">${isProject ? btn("Участники", "members", "ghost", "team") : ""}${!trash && writable() ? btn("Загрузить файлы", "upload", "primary", "upload") : ""}</div></div>${!trash && !isProject && !folder && state.view !== "favorites" ? `<section class="welcome dashboard-welcome"><div class="welcome-glow"></div><img src="assets/cloud.png" alt=""><div class="welcome-copy"><div class="eyebrow">Зашифровано · синхронизировано</div><h2>Важное — на своей полке.</h2><p>Соберите материалы в папки или перенесите работу в учебный проект с версиями и чек‑листом.</p><a class="btn glass" href="#projects">К учебным проектам ${icon("arrow")}</a></div><div class="welcome-metric"><strong>${state.files.filter(x=>!x.trashed).length}</strong><span>активных<br>файлов</span></div></section>` : ""}${isProject && !writable() ? '<div class="notice">' + icon("lock") + " У вас доступ читателя: просмотр и скачивание файлов.</div>" : ""}${!trash && !folder && state.view !== "favorites" ? `<div class="section-heading"><h2>Папки <span class="muted">${state.folders.length}</span></h2>${writable() ? btn("Новая папка", "folder-new", "small ghost", "plus") : ""}</div><div class="folder-grid">${folders || '<p class="muted">Здесь появятся папки этого пространства.</p>'}</div>` : ""}<div class="section-heading"><h2>${state.view === "favorites" ? "Отмеченные файлы" : trash ? "Удалённые файлы" : folder ? "Файлы в папке" : "Все файлы"} <span id="file-count" class="muted"></span></h2><div class="filter-row"><button class="chip ${state.filter === "all" ? "selected" : ""}" data-action="filter" data-filter="all">Все</button><button class="chip ${state.filter === "docs" ? "selected" : ""}" data-action="filter" data-filter="docs">Документы</button><button class="chip ${state.filter === "images" ? "selected" : ""}" data-action="filter" data-filter="images">Изображения</button></div></div><div id="file-list"></div>${!trash && state.view !== "favorites" && writable() ? `<div class="drop-zone" tabindex="0" role="button" aria-label="Выбрать файлы для загрузки" data-action="upload">${icon("upload")}<span><strong>Перетащите файлы</strong> или выберите на компьютере <span class="hide-mobile">· до 20 МБ на файл</span></span></div><div id="upload-status" class="upload-status" role="status"></div>` : ""}`,
  );
  if (isProject)
    $(".page-heading > .row").insertAdjacentHTML(
      "afterbegin",
      btn(
        trash ? "К файлам" : "Корзина проекта",
        "project-trash",
        "ghost",
        trash ? "files" : "trash",
      ),
    );
  renderFiles();
}
function renderFiles() {
  if (!$("#file-list")) return;
  const trash = state.view === "trash" || !!state.projectTrash;
  const list = state.files.filter(
    (f) =>
      f.trashed === trash &&
      (state.view !== "favorites" || f.favorite) &&
      (!state.folderId || f.folderId === state.folderId) &&
      f.name.toLowerCase().includes(state.query.toLowerCase()) &&
      (state.filter === "all" ||
        (state.filter === "images") === /\.(png|jpe?g)$/i.test(f.name)),
  );
  $("#file-count").textContent = list.length;
  if (!list.length) {
    $("#file-list").innerHTML = empty(
      state.query
        ? "Ничего не найдено"
        : trash
          ? "Корзина пуста"
          : "Здесь пока нет файлов",
      state.query
        ? "Попробуйте другое название или измените фильтр."
        : trash
          ? "Удалённые файлы появятся здесь. Вы сможете их восстановить."
          : "Загрузите материалы с компьютера, чтобы начать работу.",
    );
    return;
  }
  $("#file-list").innerHTML = `<div class="table-wrap file-table"><table><thead><tr><th>Название</th><th class="hide-medium">Контроль</th><th class="hide-mobile">Размер</th><th class="hide-mobile">Изменён</th><th class="actions">Действия</th></tr></thead><tbody>${list.map(fileRow).join("")}</tbody></table></div>`;
}

function fileRow(f){
  const trash=state.view==="trash"||!!state.projectTrash,isFinal=state.projectDetail?.finalFileId===f.id,checksum=f.checksum?f.checksum.slice(0,10):"—";
  return `<tr class="${isFinal?"final-row":""}"><td><div class="file-name">${fileType(f)}<div><strong>${esc(f.name)} ${isFinal?'<span class="badge final-badge">Итоговый</span>':""}</strong><small class="mobile-size">${prettySize(f.size)} · v${f.versionCount||1}</small></div></div></td><td class="hide-medium"><div class="file-control"><span>${icon("versions")} v${f.versionCount||1}</span><span title="SHA-256: ${esc(f.checksum||"")}">${icon("shield")} ${esc(checksum)}</span></div></td><td class="muted hide-mobile no-wrap">${prettySize(f.size)}</td><td class="muted hide-mobile no-wrap">${prettyDate(f.updatedAt)}</td><td class="actions">${trash?(writable()?ib("Восстановить","restore",f.id,"restore"):"")+(owner()?ib("Удалить навсегда","purge",f.id,"trash"):""):`${writable()?ib(f.favorite?"Убрать из избранного":"В избранное","favorite",f.id,"star"):""}<a class="icon-btn" title="Скачать" aria-label="Скачать ${esc(f.name)}" href="/api/files/${f.id}/download">${icon("download")}</a>${ib("История версий","versions",f.id,"versions")}${owner()?ib("Поделиться","share",f.id,"link"):""}${state.projectId&&owner()&&!isFinal?ib("Сделать итоговым","set-final",f.id,"flag"):""}${writable()?ib("Изменить файл","file-edit",f.id,"more"):""}`}</td></tr>`;
}
function projectsPage() {
  shell(
    `<div class="page-heading"><div><div class="page-kicker">Student workspace</div><h1>Учебные проекты</h1><p>От материалов и задач — до единой ссылки преподавателю.</p></div>${btn("Создать проект", "project-new", "primary", "plus")}</div><section class="projects-intro"><div><span>${icon("spark")}</span><h2>Один проект — одна полка.</h2><p>Курс, дедлайн, команда, версии и итоговый файл связаны между собой.</p></div><div class="project-legend"><span><i class="status-dot"></i> В работе</span><span><i class="ready-dot"></i> Готов</span><span><i class="sent-dot"></i> Передан</span></div></section><div class="project-grid rich-project-grid">${state.projects.map((p) => {const progress=p.tasks?Math.round((p.completedTasks/p.tasks)*100):0;return `<a class="project-card cover-${esc(p.cover||"orb")} accent-${esc(p.accent||"blue")}" href="#project/${p.id}"><div class="project-card-visual"><span class="project-orb"></span><span class="badge project-status">${projectStatuses[p.status]||"В работе"}</span><span class="project-role">${roles[p.role]}</span></div><div class="project-card-copy"><p class="project-course">${esc(p.course||"Учебный проект")}</p><h2>${esc(p.name)}</h2><p>${esc(p.description||"Общее пространство команды")}</p><div class="project-progress"><div><i style="width:${progress}%"></i></div><span>${progress}%</span></div><div class="project-bottom"><span>${icon("team")} ${p.members} / ${p.memberLimit||5}</span><span>${icon("calendar")} ${p.deadline?prettyDate(p.deadline):"Без дедлайна"}</span>${icon("arrow")}</div></div></a>`;}).join("")}</div>${!state.projects.length ? empty("Вместе удобнее", "Создайте проект, укажите предмет и дедлайн, затем добавьте команду.", btn("Создать первый проект", "project-new", "primary", "plus")) : ""}<div class="role-explainer"><div><b>OWNER</b><span>Настраивает проект и сдачу</span></div><div><b>MEMBER</b><span>Работает с файлами и задачами</span></div><div><b>READER</b><span>Просматривает и скачивает</span></div></div>`,
  );
}

async function projectPage(){
  const [detail,tasks,members]=await Promise.all([api(`/projects/${state.projectId}`),api(`/projects/${state.projectId}/tasks`),api(`/projects/${state.projectId}/members`)]);state.projectDetail=detail;state.tasks=tasks;state.members=members;
  const p=detail,canWrite=p.role!=="READER",isOwner=p.role==="OWNER",progress=p.tasks?Math.round((p.completedTasks/p.tasks)*100):0,finalFile=state.files.find(f=>f.id===p.finalFileId),activeFiles=state.files.filter(f=>!f.trashed);
  const folderCards=state.folders.map(f=>`<article class="folder-card"><div class="folder-top"><span class="${esc(f.color)}">${icon("folder")}</span>${canWrite?ib("Настройки папки","folder-edit",f.id,"more"):""}</div><button class="folder-name" data-action="open-folder" data-id="${f.id}">${esc(f.name)}</button><small>${activeFiles.filter(x=>x.folderId===f.id).length} файлов</small></article>`).join("");
  shell(`<div class="breadcrumb"><a href="#projects">Учебные проекты</a><span>/</span><span>${esc(p.name)}</span></div>
  <section class="project-hero cover-${esc(p.cover)} accent-${esc(p.accent)}"><div class="project-hero-grid"></div><div class="project-orb large"></div><div class="project-hero-copy"><div class="row project-tags"><span class="badge">${projectStatuses[p.status]}</span><span class="badge">${roles[p.role]}</span></div><p class="project-course">${esc(p.course||"Учебный проект")}</p><h1>${esc(p.name)}</h1><p>${esc(p.description||"Общее пространство для материалов и результата команды.")}</p><div class="project-meta"><span>${icon("calendar")}<b>${p.deadline?prettyDate(p.deadline):"Без дедлайна"}</b><small>Дедлайн</small></span><span>${icon("book")}<b>${esc(p.teacher||"Не указан")}</b><small>Преподаватель</small></span><span>${icon("team")}<b>${p.members} / ${p.memberLimit}</b><small>Команда</small></span></div></div><div class="project-hero-actions">${isOwner?btn("Оформление","project-edit","glass","palette"):""}<a class="btn glass" href="/api/projects/${p.id}/export">${icon("package")} Экспорт ZIP</a>${btn("Участники","members","glass","team")}</div></section>
  ${!canWrite?`<div class="notice">${icon("lock")} Режим читателя: вы можете смотреть задачи, версии и скачивать материалы.</div>`:""}
  <div class="project-dashboard"><section class="panel checklist-panel"><div class="panel-head"><div><div class="page-kicker">Чек‑лист сдачи</div><h2>${p.completedTasks} из ${p.tasks} готово</h2></div><div class="radial-progress" style="--value:${progress}"><span>${progress}%</span></div></div><div class="project-progress wide"><div><i style="width:${progress}%"></i></div></div><div class="task-list">${tasks.map(t=>`<div class="task-row ${t.completed?"completed":""}"><button class="task-check" data-action="task-toggle" data-id="${t.id}" data-completed="${!t.completed}" ${!canWrite?"disabled":""}>${t.completed?icon("check"):""}</button><div><strong>${esc(t.title)}</strong><small>${t.assignee?`Исполнитель: ${esc(t.assignee)}`:"Без исполнителя"}${t.dueAt?` · до ${prettyDate(t.dueAt)}`:""}</small></div>${canWrite?ib("Удалить задачу","task-delete",t.id,"close"):""}</div>`).join("")}</div>${canWrite?`<form class="quick-task" id="task-form"><input name="title" required maxlength="180" placeholder="Добавить шаг перед сдачей"><button class="icon-btn" aria-label="Добавить">${icon("plus")}</button></form>`:""}</section>
  <aside class="project-side"><section class="panel submission-panel"><span class="panel-icon">${icon("flag")}</span><div class="page-kicker">Итог проекта</div><h2>${finalFile?esc(finalFile.name):"Файл не выбран"}</h2><p>${finalFile?`Версия ${finalFile.versionCount} · ${prettySize(finalFile.size)}`:"Выберите готовый файл в таблице ниже — он попадёт в карточку для преподавателя."}</p>${finalFile?`<div class="final-integrity">${icon("shield")} SHA‑256 · ${esc(finalFile.checksum?.slice(0,14)||"—")}</div>`:""}${isOwner?btn(finalFile?"Ссылка преподавателю":"Сначала выберите файл","submission",finalFile?"primary":"ghost","link"):""}</section>
  <section class="panel team-compact"><div class="row between"><div><div class="page-kicker">Команда</div><h2>${members.length} участника</h2></div><button class="icon-btn" data-action="members">${icon("arrow")}</button></div><div class="avatar-stack">${members.map(m=>`<span class="avatar" title="${esc(m.name)} · ${roles[m.role]}">${esc(m.initials)}</span>`).join("")}</div><p>${members.map(m=>esc(m.name.split(" ")[0])).join(" · ")}</p></section></aside></div>
  <div class="section-heading project-files-heading"><div><div class="page-kicker">Материалы</div><h2>Файлы проекта <span id="file-count" class="muted"></span></h2></div><div class="row">${canWrite?btn("Новая папка","folder-new","small ghost","plus")+btn("Загрузить","upload","small primary","upload"):""}</div></div>
  ${state.folderId?`<div class="breadcrumb folder-crumb"><button data-action="folder-back">Все папки</button><span>/</span><span>${esc(state.folders.find(f=>f.id===state.folderId)?.name||"")}</span></div>`:`<div class="folder-grid compact-folders">${folderCards||'<p class="muted">Создайте папку для структуры проекта.</p>'}</div>`}
  <div class="filter-row project-filters"><button class="chip ${state.filter==="all"?"selected":""}" data-action="filter" data-filter="all">Все</button><button class="chip ${state.filter==="docs"?"selected":""}" data-action="filter" data-filter="docs">Документы</button><button class="chip ${state.filter==="images"?"selected":""}" data-action="filter" data-filter="images">Изображения</button><button class="chip ${state.projectTrash?"selected":""}" data-action="project-trash">${icon("trash")} Корзина</button></div><div id="file-list"></div>${canWrite&&!state.projectTrash?`<div class="drop-zone" tabindex="0" role="button" data-action="upload">${icon("upload")}<span><strong>Перетащите материалы проекта</strong> или выберите на компьютере</span></div><div id="upload-status" class="upload-status"></div>`:""}`);
  renderFiles();setupDrop();
  if($("#task-form"))$("#task-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=$("button",form);button.disabled=true;try{await api(`/projects/${p.id}/tasks`,{method:"POST",body:{title:form.title.value}});await projectPage();toast("Задача добавлена");}catch(error){toast(error.message,true);button.disabled=false;}};
}
function settingsPage() {
  shell(
    `<div class="page-heading"><div><div class="page-kicker">Персонализация</div><h1>Настройки</h1><p>Профиль, оформление и сведения о пространстве.</p></div><a class="btn ghost" href="#security">${icon("shield")} Безопасность аккаунта</a></div><div class="settings-grid"><section class="panel profile-panel"><div class="settings-avatar">${esc(state.user.name.slice(0,2).toUpperCase())}<span></span></div><h2>Профиль и внешний вид</h2><form id="settings-form"><label>Имя<input name="name" required maxlength="80" value="${esc(state.user.name)}"></label><label>Email<input value="${esc(state.user.email)}" disabled></label><div class="form-cols"><label>Тема<select name="theme"><option value="dark">Тёмная</option><option value="light">Светлая</option></select></label><label>Акцент<select name="accent"><option value="blue">Небесный</option><option value="violet">Фиолетовый</option><option value="mint">Мятный</option></select></label></div><p class="form-error" role="alert"></p><button class="btn primary" type="submit">Сохранить настройки</button></form></section><section class="panel storage-panel"><div class="row between"><div><div class="page-kicker">Тариф</div><h2>${plans[state.usage.plan]}</h2></div><span class="storage-ring">${Math.round((state.usage.used/state.usage.quota)*100)||0}%</span></div><div class="plan-number">${prettySize(state.usage.quota)}</div><p>Доступный объём личного пространства. Все версии файлов учитываются в квоте.</p><div class="progress"><span style="width:${Math.min(100, (state.usage.used / state.usage.quota) * 100)}%"></span></div><div class="storage-facts"><span>${icon("lock")} AES‑256‑GCM<br><small>Шифрование объектов</small></span><span>${icon("versions")} ${state.files.reduce((n,f)=>n+(f.versionCount||1),0)} версий<br><small>С учётом истории</small></span></div><div class="notice">Учебная версия не принимает реальные платежи. Тариф назначает администратор.</div></section></div>`,
  );
  const f = $("#settings-form");
  f.theme.value = state.user.theme;
  f.accent.value = state.user.accent;
  f.onsubmit = async (e) => {
    e.preventDefault();
    $("button", f).disabled = true;
    try {
      state.user = await api("/me", {
        method: "PATCH",
        body: Object.fromEntries(new FormData(f)),
      });
      applyAppearance();
      settingsPage();
      toast("Настройки сохранены");
    } catch (e) {
      $(".form-error", f).textContent = e.message;
    } finally {
      if ($("button", f)) $("button", f).disabled = false;
    }
  };
}

const activityLabels={ACCOUNT_REGISTERED:"Создан аккаунт",LOGIN_SUCCEEDED:"Вход в аккаунт",PROFILE_UPDATED:"Обновлён профиль",FILE_UPLOADED:"Загружен файл",FILE_VERSION_ADDED:"Добавлена версия",FILE_TRASHED:"Файл перемещён в корзину",FILE_RESTORED:"Файл восстановлен",FILE_PURGED:"Файл удалён навсегда",FOLDER_CREATED:"Создана папка",FOLDER_DELETED:"Удалена папка",SHARE_CREATED:"Создана ссылка",SHARE_REVOKED:"Ссылка отозвана",PROJECT_CREATED:"Создан проект",PROJECT_UPDATED:"Обновлён проект",MEMBER_ADDED:"Добавлен участник",MEMBER_REMOVED:"Удалён участник",MEMBER_ROLE_CHANGED:"Изменена роль",TASK_CREATED:"Добавлена задача",TASK_COMPLETED:"Задача выполнена",TASK_UPDATED:"Обновлена задача",TASK_DELETED:"Удалена задача",FINAL_FILE_SELECTED:"Выбран итоговый файл",SUBMISSION_LINK_CREATED:"Создана ссылка преподавателю",SUBMISSION_LINK_REVOKED:"Ссылка преподавателю отозвана",TWO_FACTOR_SETUP_STARTED:"Начата настройка 2FA",TWO_FACTOR_ENABLED:"Включена 2FA",TWO_FACTOR_DISABLED:"Отключена 2FA",PASSWORD_CHANGED:"Изменён пароль",PLAN_CHANGED:"Изменён тариф"};

async function activityPage(){
  const events=await api("/activity?limit=100");state.activity=events;
  shell(`<div class="page-heading"><div><div class="page-kicker">Audit trail</div><h1>Журнал действий</h1><p>Значимые события личного пространства и доступных проектов.</p></div><span class="badge active">${icon("shield")} ${events.length} событий</span></div><section class="activity-summary"><div>${icon("eye")}<span><b>Прозрачность</b>Видно кто, что и когда изменил</span></div><div>${icon("lock")}<span><b>Без содержимого</b>Журнал не раскрывает данные файлов</span></div><div>${icon("activity")}<span><b>До 100 событий</b>Последние действия сверху</span></div></section><div class="timeline">${events.map((e,i)=>`<article class="timeline-event"><span class="timeline-marker">${icon(e.action.includes("LOGIN")||e.action.includes("TWO_FACTOR")||e.action.includes("PASSWORD")?"shield":e.action.includes("PROJECT")||e.action.includes("TASK")||e.action.includes("MEMBER")?"team":"files")}</span><div><div class="row between"><h3>${esc(activityLabels[e.action]||e.action)}</h3><time>${prettyFullDate(e.createdAt)}</time></div><p><b>${esc(e.actor)}</b>${e.details?` · ${esc(e.details)}`:""}</p><span class="event-code">${esc(e.action)}</span></div></article>`).join("")||empty("Событий пока нет","После загрузки файла или создания проекта здесь появится первая запись.")}</div>`);
}

async function securityPage(){
  const info=await api("/security/overview");
  shell(`<div class="page-heading"><div><div class="page-kicker">Account protection</div><h1>Безопасность</h1><p>Второй фактор, пароль и понятная схема защиты данных.</p></div><span class="security-score">${info.twoFactorEnabled?"4/4":"3/4"}<small>уровень защиты</small></span></div><div class="security-dashboard"><section class="panel security-account"><div class="panel-head"><div><div class="page-kicker">Вход в аккаунт</div><h2>Двухфакторная защита</h2></div><span class="badge ${info.twoFactorEnabled?"active":""}">${info.twoFactorEnabled?"Включена":"Не включена"}</span></div><p>TOTP-код из приложения-аутентификатора защищает аккаунт, даже если пароль стал известен.</p><div class="two-factor-visual"><div>${icon("lock")}<span></span></div><i></i><div class="phone-mock">048 291<small>обновится через 30 сек.</small></div></div>${info.twoFactorEnabled?btn("Отключить 2FA","2fa-disable","danger ghost","lock"):btn("Настроить 2FA","2fa-setup","primary","shield")}</section><section class="panel password-panel"><div class="page-kicker">Учётные данные</div><h2>Изменить пароль</h2><p>Используйте уникальную фразу длиной не менее 10 символов.</p><form id="password-form"><label>Текущий пароль<input type="password" name="currentPassword" required autocomplete="current-password"></label><label>Новый пароль<input type="password" name="newPassword" required minlength="10" maxlength="128" autocomplete="new-password"></label><p class="form-error"></p><button class="btn ghost" type="submit">Обновить пароль</button></form></section></div><section class="crypto-map"><div class="crypto-title"><div class="page-kicker">Cryptography map</div><h2>Что именно защищает SkyShelf</h2></div>${[["Пароль",info.passwordAlgorithm,"Необратимый хеш + соль"],["Файлы",info.fileEncryption,"Случайный nonce для каждого объекта"],["Целостность",info.integrity,"Проверка перед каждой отдачей"],["Публичные ссылки","SHA‑256","Исходный токен не хранится"],["Сессия","CSRF + HttpOnly","Защита браузерной сессии"]].map((x,i)=>`<article><b>0${i+1}</b><span>${icon(i===1?"files":i===2?"check":"shield")}</span><div><small>${x[0]}</small><h3>${esc(x[1])}</h3><p>${x[2]}</p></div></article>`).join("")}</section><div class="security-note">${icon("shield")}<p><strong>Честная граница модели:</strong> это серверное шифрование данных «на диске», а не end‑to‑end. Сервер расшифровывает файл только после проверки сессии и прав доступа.</p></div>`);
  $("#password-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=$("button",form);button.disabled=true;try{await api("/security/password",{method:"POST",body:Object.fromEntries(new FormData(form))});form.reset();toast("Пароль обновлён");}catch(error){$(".form-error",form).textContent=error.message;}finally{button.disabled=false;}};
}
function planSelect(type, id, plan) {
  return `<select aria-label="Тариф" data-plan-type="${type}" data-id="${id}">${Object.entries(
    plans,
  )
    .map(
      ([key, label]) =>
        `<option value="${key}" ${key === plan ? "selected" : ""}>${label}</option>`,
    )
    .join("")}</select>`;
}
async function adminPage() {
  const [users, stats, projects] = await Promise.all([
    api("/admin/users"),
    api("/admin/stats"),
    api("/admin/projects"),
  ]);
  shell(
    `<div class="page-heading"><div><div class="page-kicker">Service console</div><h1>Администрирование</h1><p>Аккаунты, проекты, аудит и тестовые тарифы.</p></div><span class="badge">${icon("shield")} Администратор</span></div><div class="stats admin-stats"><div class="stat"><p>Пользователи</p><strong>${stats.users}</strong></div><div class="stat"><p>Проекты</p><strong>${stats.projects}</strong></div><div class="stat"><p>Файлы / версии</p><strong>${stats.files} <small>/ ${stats.versions}</small></strong></div><div class="stat"><p>События аудита</p><strong>${stats.auditEvents}</strong></div><div class="stat"><p>Общий объём версий</p><strong>${prettySize(stats.bytes)}</strong></div></div><div class="notice">${icon("lock")} Права администратора не открывают содержимое чужих документов. Консоль показывает только метаданные аккаунтов, проектов и тарифов.</div><div class="section-heading"><h2>Пользователи</h2></div><div class="table-wrap admin-table"><table><thead><tr><th>Аккаунт</th><th>Роль</th><th>Тариф</th><th>2FA</th><th>Статус</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td><strong>${esc(u.name)}</strong><br><span class="muted">${esc(u.email)}</span></td><td>${roles[u.role]}</td><td>${planSelect("users", u.id, u.plan)}</td><td>${u.twoFactorEnabled?'<span class="badge active">Включена</span>':'<span class="muted">—</span>'}</td><td><span class="badge ${u.blocked ? "" : "active"}">${u.blocked ? "Заблокирован" : "Активен"}</span></td><td>${u.role !== "ADMIN" ? `<button class="btn small ${u.blocked ? "" : "danger"}" data-action="block" data-id="${u.id}" data-blocked="${!u.blocked}">${u.blocked ? "Разблокировать" : "Заблокировать"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div><div class="section-heading"><h2>Тарифы учебных проектов</h2></div><div class="table-wrap admin-table"><table><thead><tr><th>Проект</th><th>Тестовый тариф</th></tr></thead><tbody>${projects.map((p) => `<tr><td>${esc(p.name)}</td><td>${planSelect("projects", p.id, p.plan)}</td></tr>`).join("") || '<tr><td colspan="2">Пока нет проектов</td></tr>'}</tbody></table></div>`,
  );
  app.querySelectorAll("[data-plan-type]").forEach(
    (el) =>
      (el.onchange = async () => {
        el.disabled = true;
        try {
          await api(`/admin/${el.dataset.planType}/${el.dataset.id}/plan`, {
            method: "PATCH",
            body: { plan: el.value },
          });
          toast("Тестовый тариф назначен");
        } catch (e) {
          toast(e.message, true);
          await adminPage();
        } finally {
          el.disabled = false;
        }
      }),
  );
}
function openModal(title, html) {
  modal.innerHTML = `<div class="dialog-head"><h2 id="modal-title">${title}</h2><button class="icon-btn" data-action="modal-close" aria-label="Закрыть">${icon("close")}</button></div>${html}`;
  if (!modal.open) modal.showModal();
}
function formModal(title, fields, onSave, extra = "") {
  openModal(
    title,
    `<form class="dialog-form" id="dialog-form">${fields}<p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="btn ghost" data-action="modal-close">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div>${extra}</form>`,
  );
  $("#dialog-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      submit = $("button[type=submit]", form);
    submit.disabled = true;
    try {
      await onSave(Object.fromEntries(new FormData(form)));
      modal.close();
      await refresh();
    } catch (e) {
      $(".form-error", form).textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  };
}
const colorOptions = (color) =>
  ["blue", "violet", "mint", "amber", "cyan", "rose"]
    .map(
      (c, i) =>
        `<option value="${c}" ${c === color ? "selected" : ""}>${["Синий", "Фиолетовый", "Мятный", "Золотистый", "Бирюзовый", "Розовый"][i]}</option>`,
    )
    .join("");
function folderDialog(id) {
  const f = state.folders.find((f) => f.id === id);
  formModal(
    f ? "Настройки папки" : "Новая папка",
    `<label>Название<input name="name" required maxlength="120" value="${esc(f?.name || "")}" placeholder="Например, Курсовая работа"></label><label>Цвет папки<select name="color">${colorOptions(f?.color || "blue")}</select></label>`,
    async (data) => {
      await api(f ? `/folders/${id}` : "/folders", {
        method: f ? "PATCH" : "POST",
        body: { ...data, projectId: state.projectId },
      });
      toast(f ? "Папка обновлена" : "Папка создана");
    },
    f
      ? `<button type="button" class="btn danger ghost" data-action="folder-delete" data-id="${id}">Удалить пустую папку</button>`
      : "",
  );
}
function fileDialog(id) {
  const f = state.files.find((f) => f.id === id);
  if (!f) return;
  formModal(
    "Управление файлом",
    `<label>Название<input name="name" required maxlength="180" value="${esc(f.name)}"></label><label>Папка<select name="folderId"><option value="">Вне папки</option>${state.folders.map((d) => `<option value="${d.id}" ${d.id === f.folderId ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label><p class="help">При переименовании сохраните расширение файла.</p>`,
    async (data) => {
      await api(`/files/${id}`, { method: "PATCH", body: data });
      toast("Файл обновлён");
    },
    `<button type="button" class="btn danger ghost" data-action="trash-file" data-id="${id}">${icon("trash")} Переместить в корзину</button>`,
  );
}
async function shareDialog(id) {
  const f = state.files.find((f) => f.id === id),
    links = await api(`/files/${id}/share`);
  openModal(
    "Поделиться файлом",
    `<div class="share-file-head">${fileType(f)}<div><strong>${esc(f?.name)}</strong><span>${prettySize(f?.size||0)} · AES‑256‑GCM</span></div></div>${links[0]?`<div class="active-link">${icon("link")}<div><strong>Ссылка уже активна</strong><span>до ${prettyFullDate(links[0].expiresAt)} · скачиваний ${links[0].downloadCount}${links[0].maxDownloads?` / ${links[0].maxDownloads}`:""}${links[0].passwordRequired?" · с паролем":""}</span></div><button class="btn small danger ghost" data-action="revoke" data-id="${id}">Отозвать</button></div>`:""}<p class="dialog-description">Новая ссылка заменит предыдущую. Исходный токен показывается только один раз и не хранится в базе данных.</p><form class="dialog-form" id="share-form"><div class="form-cols"><label>Срок действия<select name="hours"><option value="24">24 часа</option><option value="72">3 дня</option><option value="168">7 дней</option><option value="1">1 час</option></select></label><label>Лимит скачиваний<input name="maxDownloads" type="number" min="0" max="1000" value="0"><span class="label-hint">0 — без лимита</span></label></div><label>Пароль ссылки <span class="label-hint">необязательно</span><input name="password" type="password" minlength="4" maxlength="64" placeholder="От 4 символов"></label><p class="form-error" role="alert"></p><button type="submit" class="btn primary">${links.length ? "Перевыпустить ссылку" : "Создать защищённую ссылку"}</button></form><div id="share-output" class="share-output"></div>`,
  );
  const output = (s) => {
    $("#share-output").innerHTML =
      `<div class="success-callout">${icon("check")}<div><strong>Ссылка создана</strong><span>Скопируйте сейчас: после закрытия токен нельзя показать повторно.</span></div></div><label>Публичная ссылка<input id="share-url" readonly value="${esc(location.origin + location.pathname + "#share/" + s.token)}"></label><p>Действует до ${prettyFullDate(s.expiresAt)}${s.passwordRequired?" · защищена паролем":""}${s.maxDownloads?` · до ${s.maxDownloads} скачиваний`:""}</p><div class="row"><button class="btn ghost danger small" data-action="revoke" data-id="${id}">Отозвать</button><button class="btn small" data-action="copy-link">${icon("copy")} Копировать</button></div>`;
  };
  $("#share-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget,
      b = $("button", f);
    b.disabled = true;
    try {
      output(
        await api(`/files/${id}/share`, {
          method: "POST",
          body: { hours: Number(f.hours.value), password:f.password.value, maxDownloads:Number(f.maxDownloads.value) },
        }),
      );
      toast("Ссылка создана");
    } catch (e) {
      $(".form-error", f).textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
}

async function versionsDialog(id){
  const file=state.files.find(f=>f.id===id),versions=await api(`/files/${id}/versions`),can=writable();
  openModal("История версий",`<div class="share-file-head">${fileType(file)}<div><strong>${esc(file.name)}</strong><span>${versions.length} ${versions.length===1?"версия":"версии"} · контроль SHA‑256</span></div></div><div class="version-history">${versions.map((v,index)=>`<article class="version-item ${index===0?"current":""}"><div class="version-number">v${v.version}</div><div><strong>${index===0?"Текущая версия":esc(v.note||"Версия "+v.version)}</strong><span>${prettyFullDate(v.createdAt)} · ${esc(v.author)} · ${prettySize(v.size)}</span><code>${esc(v.checksum?.slice(0,20)||"—")}…</code></div><div><a class="icon-btn" title="Скачать версию" href="/api/files/${id}/versions/${v.id}/download">${icon("download")}</a>${can&&index>0?`<button class="icon-btn" title="Восстановить как новую" data-action="version-restore" data-file="${id}" data-version="${v.id}">${icon("restore")}</button>`:""}</div></article>`).join("")}</div>${can?`<form class="dialog-form version-upload" id="version-form"><div class="page-kicker">Новая редакция</div><label>Файл того же типа<input name="file" type="file" required accept=".${esc(file.name.split(".").pop())}"></label><label>Комментарий<input name="note" maxlength="240" placeholder="Что изменилось в этой версии"></label><p class="form-error"></p><button class="btn primary" type="submit">${icon("upload")} Добавить версию</button></form>`:""}`);
  if($("#version-form"))$("#version-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=$("button",form),data=new FormData(form);button.disabled=true;try{await api(`/files/${id}/versions`,{method:"POST",body:data});modal.close();await refresh();toast("Новая версия сохранена");}catch(error){$(".form-error",form).textContent=error.message;button.disabled=false;}};
}

function projectEditDialog(){
  const p=state.projectDetail;if(!p)return;formModal("Оформление проекта",`<label>Название<input name="name" required maxlength="120" value="${esc(p.name)}"></label><label>Короткое описание<textarea name="description" maxlength="700" rows="3">${esc(p.description)}</textarea></label><div class="form-cols"><label>Предмет / курс<input name="course" maxlength="120" value="${esc(p.course)}"></label><label>Преподаватель<input name="teacher" maxlength="120" value="${esc(p.teacher)}"></label></div><label>Дедлайн<input name="deadline" type="datetime-local" value="${p.deadline?new Date(new Date(p.deadline).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):""}"></label><div class="form-cols"><label>Акцент<select name="accent">${colorOptions(p.accent)}</select></label><label>Обложка<select name="cover"><option value="orb" ${p.cover==="orb"?"selected":""}>Стеклянная сфера</option><option value="aurora" ${p.cover==="aurora"?"selected":""}>Аврора</option><option value="grid" ${p.cover==="grid"?"selected":""}>Техническая сетка</option><option value="minimal" ${p.cover==="minimal"?"selected":""}>Минимализм</option></select></label></div>`,async data=>{await api(`/projects/${p.id}`,{method:"PATCH",body:{...data,deadline:data.deadline?new Date(data.deadline).toISOString():null}});toast("Проект обновлён");});
}

async function submissionDialog(){
  const p=state.projectDetail,links=await api(`/projects/${p.id}/submissions`);openModal("Ссылка преподавателю",`<div class="submission-preview"><span>${icon("flag")}</span><div><div class="page-kicker">Submission mode</div><h3>${esc(p.name)}</h3><p>Публичная карточка покажет описание, состав команды и только отмеченный итоговый файл.</p></div></div>${links[0]?`<div class="active-link">${icon("eye")}<div><strong>Карточка активна</strong><span>до ${prettyFullDate(links[0].expiresAt)} · просмотров ${links[0].views}</span></div><button class="btn small danger ghost" data-action="submission-revoke">Отозвать</button></div>`:""}<form class="dialog-form" id="submission-form"><label>Срок доступа<select name="hours"><option value="168">7 дней</option><option value="72">3 дня</option><option value="336">14 дней</option><option value="720">30 дней</option></select></label><p class="form-error"></p><button class="btn primary" type="submit">${links.length?"Перевыпустить":"Создать"} ссылку</button></form><div id="submission-output" class="share-output"></div>`);
  $("#submission-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=$("button",form);button.disabled=true;try{const data=await api(`/projects/${p.id}/submissions`,{method:"POST",body:{hours:Number(form.hours.value)}}),url=location.origin+location.pathname+"#submit/"+data.token;$("#submission-output").innerHTML=`<div class="success-callout">${icon("check")}<div><strong>Карточка готова</strong><span>Скопируйте ссылку сейчас — токен показывается один раз.</span></div></div><label>Ссылка преподавателю<input id="share-url" readonly value="${esc(url)}"></label><button class="btn small" data-action="copy-link">${icon("copy")} Копировать</button>`;toast("Ссылка преподавателю создана");}catch(error){$(".form-error",form).textContent=error.message;}finally{button.disabled=false;}};
}
async function membersDialog() {
  const list = await api(`/projects/${state.projectId}/members`),
    can = owner();
  openModal(
    "Участники проекта",
    `<p class="dialog-description">${list.length} из ${state.projectDetail?.memberLimit||project()?.memberLimit||5} участников. Добавляйте людей, которые уже зарегистрировались в SkyShelf.</p><div class="role-help"><span><b>Участник</b> файлы и задачи</span><span><b>Читатель</b> просмотр и скачивание</span></div><div class="member-list">${list.map((m) => `<div class="member-row"><span class="avatar">${esc(m.initials||m.name.slice(0, 2).toUpperCase())}</span><div class="member-name"><strong>${esc(m.name)}</strong><small>${esc(m.email)}</small></div>${can && m.role !== "OWNER" ? `<select data-member="${m.id}" aria-label="Роль ${esc(m.name)}"><option value="MEMBER" ${m.role === "MEMBER" ? "selected" : ""}>Участник</option><option value="READER" ${m.role === "READER" ? "selected" : ""}>Читатель</option></select>${ib("Удалить участника", "member-remove", m.id, "close")}` : `<span class="badge">${roles[m.role]}</span>`}</div>`).join("")}</div>${can ? '<form id="member-form" class="dialog-form"><label>Email участника<input name="email" type="email" required placeholder="teammate@example.com"></label><label>Роль<select name="role"><option value="MEMBER">Участник — загрузка и изменение</option><option value="READER">Читатель — только скачивание</option></select></label><p class="form-error" role="alert"></p><button class="btn primary" type="submit">Добавить в проект</button></form>' : ""}`,
  );
  if (can)
    $("#member-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      $("button", f).disabled = true;
      try {
        await api(`/projects/${state.projectId}/members`, {
          method: "POST",
          body: Object.fromEntries(new FormData(f)),
        });
        await loadWorkspace();
        await membersDialog();
        workspacePage();
        toast("Участник добавлен");
      } catch (e) {
        $(".form-error", f).textContent = e.message;
        $("button", f).disabled = false;
      }
    };
  modal.querySelectorAll("[data-member]").forEach(
    (el) =>
      (el.onchange = async () => {
        el.disabled = true;
        try {
          await api(
            `/projects/${state.projectId}/members/${el.dataset.member}`,
            { method: "PATCH", body: { role: el.value } },
          );
          toast("Роль изменена");
        } catch (e) {
          toast(e.message, true);
          await membersDialog();
        } finally {
          el.disabled = false;
        }
      }),
  );
}
function confirmModal(title, text, callback) {
  openModal(
    title,
    `<p class="dialog-description">${text}</p><p class="form-error" role="alert"></p><div class="dialog-actions"><button class="btn ghost" data-action="modal-close">Отмена</button><button class="btn danger" id="confirm-action">Подтвердить</button></div>`,
  );
  $("#confirm-action").onclick = async (e) => {
    e.target.disabled = true;
    try {
      await callback();
      modal.close();
      await refresh();
    } catch (err) {
      $(".form-error", modal).textContent = err.message;
      e.target.disabled = false;
    }
  };
}
async function publicShare(token) {
  let content;
  try {
    const file = await api(`/public/${encodeURIComponent(token)}`);
    content = `<div class="public-file-icon">${icon("files")}</div><div class="page-kicker">Secure file transfer</div><h1>${esc(file.name)}</h1><p>${prettySize(file.size)} · действует до ${prettyFullDate(file.expiresAt)}</p><div class="public-security-row"><span>${icon("shield")} Проверка целостности</span><span>${icon("clock")} Временный доступ</span>${file.maxDownloads?`<span>${icon("download")} Осталось: ${file.remainingDownloads}</span>`:""}</div>${file.passwordRequired?`<form id="public-password-form" class="public-password"><label>Пароль ссылки<input name="password" type="password" required autofocus placeholder="Введите пароль"></label><p class="form-error"></p><button class="btn primary" type="submit">${icon("download")} Проверить и скачать</button></form>`:`<a class="btn primary large" href="/api/public/${encodeURIComponent(token)}/download">${icon("download")} Скачать файл</a>`}<small>SkyShelf не показывает содержимое файла до проверки доступа.</small>`;
  } catch {
    content = `${icon("lock")}<h1>Ссылка недоступна</h1><p>Срок действия истёк, владелец отозвал доступ или файл удалён.</p><a class="btn" href="#home">На главную</a>`;
  }
  app.innerHTML = `<div class="public-shell public-share-shell">${publicNav()}<main class="public-download"><div class="download-glow"></div>${content}</main><footer class="public-foot"><span>SkyShelf · защищённая передача</span><span>ЭФБО-14-24</span></footer></div>`;
  if($("#public-password-form"))$("#public-password-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=$("button",form);button.disabled=true;try{await downloadProtected(`/public/${encodeURIComponent(token)}/download`,form.password.value);toast("Скачивание началось");}catch(error){$(".form-error",form).textContent=error.message;}finally{button.disabled=false;}};
}

async function downloadProtected(path,password){
  if(!state.csrf)await csrf();const res=await fetch("/api"+path,{method:"POST",headers:{"Content-Type":"application/json",[state.csrf.header]:state.csrf.token},credentials:"same-origin",body:JSON.stringify({password})});if(!res.ok){const data=await res.json().catch(()=>({}));throw new Error(data.message||"Не удалось скачать файл");}const blob=await res.blob(),disposition=res.headers.get("content-disposition")||"",match=disposition.match(/filename\*=UTF-8''([^;]+)/i)||disposition.match(/filename="?([^";]+)"?/i),name=match?decodeURIComponent(match[1]):"SkyShelf-file";const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function publicSubmission(token){
  let content;try{const p=await api(`/public/projects/${encodeURIComponent(token)}`),file=p.finalFile;content=`<section class="teacher-card cover-${esc(p.cover)} accent-${esc(p.accent)}"><div class="teacher-cover"><div class="project-orb large"></div><span class="badge">${icon("flag")} Итоговый проект</span><h1>${esc(p.name)}</h1><p>${esc(p.course||"Учебный проект")}</p></div><div class="teacher-body"><div class="teacher-description"><div class="page-kicker">Описание</div><h2>Работа команды</h2><p>${esc(p.description||"Описание проекта не указано.")}</p><div class="teacher-meta"><span>${icon("book")}<b>${esc(p.teacher||"Преподаватель")}</b><small>Получатель</small></span><span>${icon("calendar")}<b>${p.deadline?prettyDate(p.deadline):"—"}</b><small>Дедлайн</small></span><span>${icon("eye")}<b>${p.views}</b><small>Просмотров</small></span></div></div><aside><div class="final-file-public">${fileType(file)}<div><div class="page-kicker">Итоговый файл</div><h3>${esc(file.name)}</h3><p>${prettySize(file.size)} · версия ${file.versionCount}</p><code>SHA‑256 · ${esc(file.checksum?.slice(0,16)||"—")}…</code></div></div><a class="btn primary large" href="/api/public/projects/${encodeURIComponent(token)}/download">${icon("download")} Скачать результат</a></aside></div><div class="teacher-team"><div><div class="page-kicker">Команда</div><h3>${p.members.length} участника</h3></div>${p.members.map(m=>`<span><i class="avatar">${esc(m.name.slice(0,2).toUpperCase())}</i><b>${esc(m.name)}</b><small>${roles[m.role]}</small></span>`).join("")}</div><footer>${icon("shield")} Целостность файла проверена SkyShelf · ссылка действует до ${prettyFullDate(p.expiresAt)}</footer></section>`;}catch{content=`<main class="public-download">${icon("lock")}<h1>Карточка недоступна</h1><p>Срок ссылки истёк, доступ отозван или итоговый файл удалён.</p><a class="btn" href="#home">На главную</a></main>`;}app.innerHTML=`<div class="public-shell teacher-shell">${publicNav()}${content}</div>`;
}

async function setupTwoFactor(){
  const data=await api("/security/2fa/setup",{method:"POST"});openModal("Подключение 2FA",`<div class="twofa-steps"><span class="active">1</span><i></i><span class="active">2</span><i></i><span>3</span></div><p class="dialog-description">1. Откройте Google Authenticator, Microsoft Authenticator, 1Password или другое TOTP-приложение.<br>2. Добавьте ключ вручную и введите текущий код.</p><div class="secret-box"><span>Секретный ключ</span><code id="totp-secret">${esc(data.secret)}</code><button class="icon-btn" data-action="copy-secret">${icon("copy")}</button></div><details><summary>Показать технический URI</summary><code class="uri-code">${esc(data.uri)}</code></details><form class="dialog-form" id="totp-enable-form"><label>6-значный код<input name="code" required pattern="[0-9]{6}" maxlength="6" inputmode="numeric" autocomplete="one-time-code" placeholder="000000"></label><p class="form-error"></p><button class="btn primary" type="submit">Проверить и включить</button></form>`);$("#totp-enable-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=$("button",form);button.disabled=true;try{await api("/security/2fa/enable",{method:"POST",body:{code:form.code.value}});state.user=await api("/me");modal.close();await securityPage();toast("Двухфакторная защита включена");}catch(error){$(".form-error",form).textContent=error.message;button.disabled=false;}};
}

function disableTwoFactor(){formModal("Отключить 2FA",`<div class="notice danger-notice">После отключения для входа будет достаточно одного пароля.</div><label>Текущий пароль<input type="password" name="password" required></label><label>Код из приложения<input name="code" required pattern="[0-9]{6}" maxlength="6" inputmode="numeric"></label>`,async data=>{await api("/security/2fa/disable",{method:"POST",body:data});state.user=await api("/me");toast("Двухфакторная защита отключена");});}
async function uploadFiles(files) {
  if (state.uploading) return;
  if (!writable()) return toast("У вас доступ только для чтения.", true);
  const selected = [...files];
  if (!selected.length) return;
  state.uploading = true;
  let done = 0;
  const projectId = state.projectId,
    folderId = state.folderId;
  try {
    for (const file of selected) {
      if (file.size > 20 * 1024 * 1024)
        throw new Error(`${file.name}: размер больше 20 МБ.`);
      const status = $("#upload-status");
      if (status)
        status.textContent = `Загружаем ${done + 1} из ${selected.length}: ${file.name}`;
      const form = new FormData();
      form.append("file", file);
      if (folderId) form.append("folderId", folderId);
      if (projectId) form.append("projectId", projectId);
      await api("/files", { method: "POST", body: form });
      done++;
    }
    toast(`Загружено файлов: ${done}`);
  } catch (e) {
    toast(`${e.message}${done ? " Уже загружено: " + done : ""}`, true);
  } finally {
    state.uploading = false;
    $("#upload-input").value = "";
    await refresh();
  }
}
function setupDrop() {
  const zone = $(".drop-zone");
  if (!zone) return;
  zone.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("#upload-input").click();
    }
  };
  zone.ondragover = (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  };
  zone.ondragleave = () => zone.classList.remove("dragover");
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    uploadFiles(e.dataTransfer.files);
  };
}
$("#upload-input").onchange = (e) => uploadFiles(e.target.files);
async function refresh() {
  await loadWorkspace();
  if (state.view === "project") await projectPage();
  else if (["files", "favorites", "trash"].includes(state.view)) workspacePage();
  else if (state.view === "projects") projectsPage();
  else if (state.view === "admin") await adminPage();
  else if (state.view === "settings") settingsPage();
  else if (state.view === "activity") await activityPage();
  else if (state.view === "security") await securityPage();
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action, id } = target.dataset;
  try {
    switch (action) {
      case "scroll-section": {
        const section=document.getElementById(target.dataset.section);if(section){event.preventDefault();section.scrollIntoView({behavior:"smooth",block:"start"});}else location.hash="#home";break;
      }
      case "menu":
        $(".sidebar").classList.toggle("open");
        break;
      case "modal-close":
        modal.close();
        break;
      case "logout":
        await api("/auth/logout", { method: "POST" });
        state.user = null;
        state.csrf = null;
        applyAppearance();
        location.hash = "#home";
        toast("Вы вышли из аккаунта");
        break;
      case "upload":
        $("#upload-input").click();
        break;
      case "filter":
        state.filter = target.dataset.filter;
        if(state.view==="project") await projectPage(); else workspacePage();
        break;
      case "open-folder":
        state.folderId = id;
        if(state.view==="project") await projectPage(); else workspacePage();
        break;
      case "folder-back":
        state.folderId = null;
        if(state.view==="project") await projectPage(); else workspacePage();
        break;
      case "folder-new":
        folderDialog();
        break;
      case "folder-edit":
        folderDialog(id);
        break;
      case "folder-delete":
        confirmModal(
          "Удалить папку?",
          "Удалить можно только пустую папку. Файлы из неё, включая корзину, сначала нужно переместить.",
          async () => {
            await api(`/folders/${id}`, { method: "DELETE" });
            toast("Папка удалена");
          },
        );
        break;
      case "file-edit":
        fileDialog(id);
        break;
      case "favorite": {
        const file=state.files.find(f=>f.id===id);await api(`/files/${id}`,{method:"PATCH",body:{favorite:!file.favorite}});await refresh();toast(file.favorite?"Убрано из избранного":"Добавлено в избранное");break;
      }
      case "versions":
        await versionsDialog(id);
        break;
      case "version-restore":
        await api(`/files/${target.dataset.file}/versions/${target.dataset.version}/restore`,{method:"POST"});modal.close();await refresh();toast("Версия восстановлена как новая");
        break;
      case "set-final":
        await api(`/projects/${state.projectId}/final/${id}`,{method:"POST"});await refresh();toast("Итоговый файл отмечен");
        break;
      case "trash-file":
        await api(`/files/${id}`, { method: "DELETE" });
        modal.close();
        await refresh();
        toast("Файл перемещён в корзину. Ссылки отозваны.");
        break;
      case "restore":
        await api(`/files/${id}`, {
          method: "PATCH",
          body: { trashed: false },
        });
        await refresh();
        toast("Файл восстановлен");
        break;
      case "purge":
        confirmModal(
          "Удалить навсегда?",
          "Файл будет удалён из хранилища без возможности восстановления через корзину.",
          async () => {
            await api(`/files/${id}/permanent`, { method: "DELETE" });
            toast("Файл удалён навсегда");
          },
        );
        break;
      case "share":
        await shareDialog(id);
        break;
      case "copy-link": {
        const input = $("#share-url");
        try {
          await navigator.clipboard.writeText(input.value);
          toast("Ссылка скопирована");
        } catch {
          input.select();
          toast("Ссылка выделена. Нажмите Ctrl+C.");
        }
        break;
      }
      case "revoke":
        await api(`/files/${id}/share`, { method: "DELETE" });
        await shareDialog(id);
        toast("Доступ по ссылке отозван");
        break;
      case "project-new":
        formModal(
          "Новый учебный проект",
          `<label>Название проекта<input name="name" required maxlength="120" placeholder="Например, Курсовая по СПО"></label><label>Короткое описание<textarea name="description" maxlength="700" rows="3" placeholder="Что создаёт команда"></textarea></label><div class="form-cols"><label>Предмет / курс<input name="course" maxlength="120" placeholder="Создание ПО"></label><label>Преподаватель<input name="teacher" maxlength="120" placeholder="Фамилия И.О."></label></div><label>Дедлайн<input name="deadline" type="datetime-local"></label><div class="form-cols"><label>Акцент<select name="accent">${colorOptions("blue")}</select></label><label>Обложка<select name="cover"><option value="orb">Стеклянная сфера</option><option value="aurora">Аврора</option><option value="grid">Техническая сетка</option><option value="minimal">Минимализм</option></select></label></div>`,
          async (data) => {
            await api("/projects", { method: "POST", body: {...data,deadline:data.deadline?new Date(data.deadline).toISOString():null} });
            toast("Учебный проект создан");
          },
        );
        break;
      case "project-edit":
        projectEditDialog();
        break;
      case "members":
        await membersDialog();
        break;
      case "project-trash":
        state.projectTrash = !state.projectTrash;
        state.folderId = null;
        await projectPage();
        break;
      case "task-toggle":
        await api(`/projects/${state.projectId}/tasks/${id}`,{method:"PATCH",body:{completed:target.dataset.completed==="true"}});await projectPage();
        break;
      case "task-delete":
        confirmModal("Удалить шаг?","Задача исчезнет из чек-листа проекта.",async()=>{await api(`/projects/${state.projectId}/tasks/${id}`,{method:"DELETE"});toast("Задача удалена");});
        break;
      case "submission":
        if(state.projectDetail?.finalFileId)await submissionDialog();
        break;
      case "submission-revoke":
        await api(`/projects/${state.projectId}/submissions`,{method:"DELETE"});await submissionDialog();toast("Ссылка преподавателю отозвана");
        break;
      case "2fa-setup":
        await setupTwoFactor();
        break;
      case "2fa-disable":
        disableTwoFactor();
        break;
      case "copy-secret": {
        const value=$("#totp-secret").textContent;try{await navigator.clipboard.writeText(value);toast("Секрет скопирован");}catch{toast("Выделите ключ и скопируйте вручную",true);}break;
      }
      case "member-remove":
        confirmModal(
          "Удалить участника?",
          "Пользователь потеряет доступ к проекту. Загруженные им материалы останутся в общем пространстве.",
          async () => {
            await api(`/projects/${state.projectId}/members/${id}`, {
              method: "DELETE",
            });
            toast("Доступ участника отозван");
          },
        );
        break;
      case "block":
        confirmModal(
          target.dataset.blocked === "true"
            ? "Заблокировать аккаунт?"
            : "Разблокировать аккаунт?",
          target.dataset.blocked === "true"
            ? "Пользователь потеряет доступ к сервису. Его данные сохранятся."
            : "Пользователь снова сможет войти и работать с файлами.",
          async () => {
            await api(`/admin/users/${id}`, {
              method: "PATCH",
              body: { blocked: target.dataset.blocked === "true" },
            });
            toast("Статус аккаунта обновлён");
          },
        );
        break;
    }
  } catch (error) {
    toast(error.message, true);
  }
});
async function route() {
  const epoch = ++routeEpoch;
  modal.close();
  document.body.classList.remove("landing-mode","cursor-hover");window.onpointermove=null;window.onscroll=null;
  const [page = "home", id] = location.hash.slice(1).split("/");
  if (page === "home" || !page) {
    landing();
    return;
  }
  if (page === "login" || page === "register") {
    authPage(page === "register");
    return;
  }
  if (page === "share") {
    await publicShare(id || "");
    return;
  }
  if (page === "submit") {
    await publicSubmission(id || "");
    return;
  }
  if (!state.user) {
    location.hash = "#login";
    return;
  }
  state.view = [
    "files",
    "favorites",
    "projects",
    "project",
    "trash",
    "activity",
    "security",
    "settings",
    "admin",
  ].includes(page)
    ? page
    : "files";
  state.projectId = page === "project" ? id : null;
  state.projectTrash = false;
  state.projectDetail = null;
  state.folderId = null;
  state.query = "";
  state.filter = "all";
  try {
    await loadWorkspace();
    if (epoch !== routeEpoch) return;
    if (page === "projects") projectsPage();
    else if (page === "project") await projectPage();
    else if (page === "activity") await activityPage();
    else if (page === "security") await securityPage();
    else if (page === "settings") settingsPage();
    else if (page === "admin") await adminPage();
    else workspacePage();
  } catch (e) {
    if (!state.user) {
      location.hash = "#login";
      toast("Сессия завершена. Войдите снова.", true);
    } else {
      shell(
        empty(
          "Не удалось открыть раздел",
          esc(e.message),
          '<a class="btn" href="#files">К моим файлам</a>',
        ),
      );
    }
  }
}
window.addEventListener("hashchange", route);
(async () => {
  try {
    await csrf();
    state.user = await api("/me");
  } catch {
    /* Гость или сервер ещё запускается. */
  }
  applyAppearance();
  await route();
})();

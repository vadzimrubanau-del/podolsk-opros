"use strict";

const URG_TEXT = { "А": "Срочно: блокирует этап 1", "Б": "До этапа 2", "В": "До этапов 3–4" };
const GROUPS = [
  { key: "lead", title: "Руководство" },
  { key: "floor", title: "Начальники смен и склад" },
  { key: "log", title: "Логисты" },
  { key: "it", title: "IT и учёт" },
];
const ACCEPT_ATTR = ".pdf,.png,.jpg,.jpeg,.webp,.heic,.gif,.csv,.txt,.xlsx,.xls,.docx,.doc,.mp4,.mov";
const MAX_FILE = 50 * 1024 * 1024;
const REFRESH_MS = 20000;

const state = { code: "", questions: [], answers: {}, files: {}, decided: [], groupWho: {}, filter: "all", syncedAt: null };
const drafts = {}; // текст, который печатают прямо сейчас: обновление с сервера его не затирает
const timers = {};
const saving = {};
const hints = {}; // сообщения о загрузке файлов переживают перерисовку карточки
const uploading = {}; // сколько файлов вопроса сейчас загружается

const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };

const msk = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso) => { try { return msk.format(new Date(iso)) + " МСК"; } catch { return ""; } };
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(n / 1024)) + " КБ");

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(action, payload = {}) {
  let res;
  try {
    res = await fetch(window.OPROS_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, code: state.code, ...payload }),
    });
  } catch {
    throw new ApiError(0, "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && action !== "login") logout("Код доступа сменился. Введите новый код.");
    throw new ApiError(res.status, body.error || "Ошибка сервера (" + res.status + ")");
  }
  return body;
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}

function setStatus(kind, text) {
  const box = document.getElementById("status");
  box.replaceChildren();
  if (text) box.append(el("div", { class: "notice " + kind, text }));
}

function qState(id) {
  const a = state.answers[id];
  if (a && a.status === "approved") return "approved";
  const text = (drafts[id] ?? (a && a.text) ?? "").trim();
  return text || (state.files[id] || []).length ? "draft" : "empty";
}

// ---------- Загрузка и обновление ----------

// Обновления идут и по таймеру, и после каждого действия. Ответы могут прийти не по порядку —
// применяем только ответ на самый поздний запрос, иначе на экране мелькает устаревшее состояние.
let refreshSeq = 0;
let appliedSeq = 0;

async function refresh() {
  const seq = ++refreshSeq;
  const data = await api("state");
  if (seq < appliedSeq) return;
  appliedSeq = seq;
  state.questions = data.questions;
  state.decided = data.decided || [];
  state.groupWho = data.groupWho || {};
  state.answers = Object.fromEntries(data.answers.map((a) => [a.question_id, a]));
  state.files = {};
  for (const f of data.files) (state.files[f.question_id] ||= []).push(f);
  state.syncedAt = new Date().toISOString();
  render();
}

async function safeRefresh() {
  try { await refresh(); setStatus("", ""); } catch (e) { if (e.status !== 401) setStatus("err", e.message); }
}

setInterval(() => {
  if (state.code && document.visibilityState === "visible") safeRefresh();
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (state.code && document.visibilityState === "visible") safeRefresh();
});

// ---------- Действия ----------

async function saveText(id) {
  const text = drafts[id];
  if (text === undefined || saving[id]) return;
  saving[id] = true;
  const mark = document.getElementById("save-" + id);
  if (mark) mark.textContent = "Сохраняю…";
  try {
    const res = await api("save", { qid: id, text });
    state.answers[id] = { ...(state.answers[id] || {}), question_id: id, text, status: "draft", updated_at: res.savedAt };
    if (drafts[id] === text) delete drafts[id];
    const m = document.getElementById("save-" + id);
    if (m) m.textContent = "Сохранено " + fmtDate(res.savedAt);
  } catch (e) {
    const m = document.getElementById("save-" + id);
    if (m) m.textContent = e.message;
  } finally {
    saving[id] = false;
    if (drafts[id] !== undefined && drafts[id] !== text) saveText(id);
  }
}

async function approve(id, nameInput, errBox, btn) {
  const name = nameInput.value.trim().replace(/\s+/g, " ");
  const text = (drafts[id] ?? (state.answers[id] || {}).text ?? "").trim();
  errBox.textContent = "";
  if (uploading[id]) { errBox.textContent = "Дождитесь окончания загрузки файлов, потом утверждайте."; return; }
  if (!text && !(state.files[id] || []).length) { errBox.textContent = "Сначала напишите ответ или прикрепите файл."; return; }
  if (name.split(" ").length < 2) { errBox.textContent = "Укажите имя и фамилию утверждающего, например: Иван Петров."; nameInput.focus(); return; }
  lsSet("opros.approver", name);
  clearTimeout(timers[id]);
  btn.disabled = true;
  try {
    await api("approve", { qid: id, name, text });
    delete drafts[id];
    await refresh();
  } catch (e) {
    errBox.textContent = e.message;
    btn.disabled = false;
  }
}

async function reopen(id) {
  try {
    await api("reopen", { qid: id });
    await refresh();
    document.getElementById("ans-" + id)?.focus();
  } catch (e) { setStatus("err", e.message); }
}

async function upload(id, fileList) {
  const say = (t) => { hints[id] = t; const h = document.getElementById("hint-" + id); if (h) h.textContent = t; };
  const problems = [];
  const list = [...fileList];
  uploading[id] = (uploading[id] || 0) + list.length;
  for (const f of list) {
    if (f.size > MAX_FILE) { problems.push(`«${f.name}» больше 50 МБ — сожмите фото или разбейте документ.`); uploading[id]--; continue; }
    say(`Загружаю «${f.name}»…`);
    try {
      const up = await api("upload_url", { qid: id, name: f.name, size: f.size });
      const put = await fetch(up.signedUrl, { method: "PUT", headers: { "content-type": up.contentType, "x-upsert": "false" }, body: f });
      if (!put.ok) throw new ApiError(put.status, `«${f.name}» не загрузился. Попробуйте ещё раз.`);
      await api("file_done", { qid: id, path: up.path, name: f.name, size: f.size });
      await refresh();
    } catch (e) {
      problems.push(e.message);
    } finally {
      uploading[id]--;
    }
  }
  say(problems.length ? problems.join(" ") : "Файлы прикреплены.");
}

async function removeFile(file, btn) {
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Точно удалить?";
    setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ""; btn.textContent = "Удалить"; } }, 4000);
    return;
  }
  btn.disabled = true;
  try { await api("delete_file", { id: file.id }); await refresh(); }
  catch (e) { setStatus("err", e.message); btn.disabled = false; }
}

// ---------- Отрисовка ----------

function fileRow(f, locked) {
  const isImg = (f.content_type || "").startsWith("image/") && f.content_type !== "image/heic";
  const thumb = isImg && f.url ? el("img", { src: f.url, alt: "" }) : el("span", { class: "ftype", text: (f.name.split(".").pop() || "").toUpperCase().slice(0, 4) });
  const link = f.url ? el("a", { href: f.url, target: "_blank", rel: "noopener", text: f.name }) : el("span", { text: f.name });
  const del = !locked ? el("button", { class: "btn small danger", type: "button", text: "Удалить" }) : null;
  if (del) del.addEventListener("click", () => removeFile(f, del));
  return el("li", {}, thumb, link, el("span", { class: "meta", text: fmtSize(Number(f.size_bytes) || 0) }), del);
}

function card(Q) {
  const a = state.answers[Q.id] || {};
  const st = qState(Q.id);
  const approved = st === "approved";
  const files = state.files[Q.id] || [];

  const ta = el("textarea", { id: "ans-" + Q.id, "aria-label": "Ответ на " + Q.id, readonly: approved, placeholder: approved ? "" : "Ваш ответ…" });
  ta.value = drafts[Q.id] ?? a.text ?? "";
  ta.addEventListener("input", () => {
    drafts[Q.id] = ta.value;
    clearTimeout(timers[Q.id]);
    timers[Q.id] = setTimeout(() => saveText(Q.id), 1200);
    const p = document.getElementById("pill-" + Q.id);
    const s = qState(Q.id);
    if (p) { p.className = "pill state-" + s; p.textContent = s === "draft" ? "Ждёт утверждения" : "Без ответа"; }
    updateSummary();
  });
  ta.addEventListener("blur", () => { if (drafts[Q.id] !== undefined) { clearTimeout(timers[Q.id]); saveText(Q.id); } });

  const saved = el("div", { class: "savestate", id: "save-" + Q.id, text: a.updated_at && !approved ? "Сохранено " + fmtDate(a.updated_at) : "" });
  const fileHint = el("div", { class: "savestate", role: "status", id: "hint-" + Q.id, text: hints[Q.id] || "" });

  let drop = null;
  if (!approved) {
    const input = el("input", { type: "file", multiple: true, accept: ACCEPT_ATTR, hidden: true });
    input.addEventListener("change", () => { upload(Q.id, input.files); input.value = ""; });
    const pick = el("button", { class: "btn small", type: "button", text: "Прикрепить файл" });
    pick.addEventListener("click", () => input.click());
    drop = el("div", { class: "drop" }, pick, el("span", { text: "или перетащите сюда · PDF, фото, Excel, Word, CSV до 50 МБ" }), input);
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload(Q.id, e.dataTransfer.files); });
  }

  let footer;
  if (approved) {
    const edit = el("button", { class: "btn small", type: "button", text: "Изменить ответ" });
    edit.addEventListener("click", () => {
      if (edit.dataset.armed !== "1") { edit.dataset.armed = "1"; edit.textContent = "Снять утверждение и изменить?"; return; }
      reopen(Q.id);
    });
    footer = el("div", { class: "approved-box" },
      el("div", { class: "who" }, "Утверждено: " + (a.approved_by || "—"), el("span", { text: a.approved_at ? fmtDate(a.approved_at) : "" })),
      edit);
  } else {
    const nameId = "name-" + Q.id;
    const name = el("input", { type: "text", id: nameId, autocomplete: "name", placeholder: "Например: Иван Петров" });
    name.value = lsGet("opros.approver");
    const err = el("p", { class: "err", role: "alert" });
    const btn = el("button", { class: "btn primary", type: "button", text: "Утвердить" });
    btn.addEventListener("click", () => approve(Q.id, name, err, btn));
    footer = el("div", { class: "approve" },
      el("div", {}, el("label", { class: "lbl", for: nameId }, "Имя и фамилия утверждающего ", el("span", { class: "req", text: "*" })), name),
      btn, err);
  }

  return el("article", { class: "q", "data-urg": Q.urgency, "data-state": st, id: Q.id },
    el("div", { class: "stripe", "aria-hidden": "true" }),
    el("div", { class: "q-body" },
      el("div", { class: "q-head" },
        el("span", { class: "qid", text: Q.id }),
        el("span", { class: "pill urg-" + Q.urgency, text: URG_TEXT[Q.urgency] }),
        el("span", { class: "pill state-" + st, id: "pill-" + Q.id, text: approved ? "Утверждено" : st === "draft" ? "Ждёт утверждения" : "Без ответа" })),
      el("h3", { text: Q.text }),
      el("p", { class: "why", text: "Зачем: " + Q.why }),
      el("p", { class: "attach-hint" }, el("b", { text: "Приложить: " }), Q.attach),
      Q.caution ? el("p", { class: "caution", text: Q.caution }) : null,
      el("div", {}, el("label", { class: "lbl", for: "ans-" + Q.id, text: "Ответ" }), ta, saved),
      el("div", { class: "files" },
        files.length ? el("ul", { class: "file-list" }, files.map((f) => fileRow(f, approved))) : null,
        drop, fileHint),
      footer));
}

function counts() {
  const c = { all: state.questions.length, empty: 0, draft: 0, approved: 0, urgent: 0, urgOpen: 0 };
  for (const Q of state.questions) {
    const s = qState(Q.id);
    c[s]++;
    if (Q.urgency === "А") { c.urgent++; if (s !== "approved") c.urgOpen++; }
  }
  return c;
}

function updateSummary() {
  const c = counts();
  const pct = (n) => (c.all ? (100 * n) / c.all : 0) + "%";
  document.getElementById("m-count").textContent = `${c.approved} / ${c.all}`;
  document.getElementById("m-ok").textContent = c.approved;
  document.getElementById("m-draft").textContent = c.draft;
  document.getElementById("m-empty").textContent = c.empty;
  document.getElementById("m-urg").textContent = c.urgOpen;
  document.getElementById("m-a").style.width = pct(c.approved);
  document.getElementById("m-d").style.width = pct(c.draft);
  document.getElementById("m-bar").setAttribute("aria-label", `Утверждено ${c.approved} из ${c.all}`);
  for (const k of ["all", "empty", "draft", "approved", "urgent"]) document.getElementById("f-" + k).textContent = c[k];
  document.getElementById("synced").textContent = state.syncedAt ? "Обновлено " + fmtDate(state.syncedAt) + " · обновляется само" : "";
}

function render() {
  const ae = document.activeElement;
  const active = ae && ae.id;
  const sel = ae && typeof ae.selectionStart === "number" ? [ae.selectionStart, ae.selectionEnd, ae.scrollTop, ae.value] : null;
  const nodes = [];
  for (const G of GROUPS) {
    const qs = state.questions.filter((Q) => Q.grp === G.key).filter((Q) => {
      if (state.filter === "all") return true;
      if (state.filter === "urgent") return Q.urgency === "А";
      return qState(Q.id) === state.filter;
    });
    if (!qs.length) continue;
    nodes.push(el("h2", { class: "group" }, G.title, el("small", { text: state.groupWho[G.key] || "" })));
    for (const Q of qs) nodes.push(card(Q));
  }
  if (!nodes.length) nodes.push(el("p", { class: "lead", text: "В этом фильтре вопросов нет." }));
  document.getElementById("list").replaceChildren(...nodes);
  const dec = document.getElementById("decided");
  dec.hidden = !state.decided.length;
  dec.replaceChildren(el("span", { class: "eyebrow", text: "Уже решено" }),
    ...state.decided.map((d) => el("p", {}, el("code", { text: d.id }), " " + d.text)));
  updateSummary();
  if (active) {
    const n = document.getElementById(active);
    if (n && n !== document.body) {
      // Имя утверждающего ещё не сохранено на сервере — возвращаем введённое.
      if (sel && n.tagName === "INPUT") n.value = sel[3];
      n.focus({ preventScroll: true });
      if (sel && typeof n.setSelectionRange === "function") { try { n.setSelectionRange(sel[0], sel[1]); n.scrollTop = sel[2]; } catch {} }
    }
  }
}

document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
  state.filter = b.dataset.f;
  document.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  render();
}));

// ---------- Вход ----------

function showLogin(message) {
  document.getElementById("app").hidden = true;
  document.getElementById("login").hidden = false;
  document.getElementById("login-err").textContent = message || "";
  document.getElementById("code").focus();
}

function logout(message) {
  state.code = "";
  lsSet("opros.code", "");
  showLogin(message);
}

async function enter(code) {
  state.code = code.trim().toUpperCase().replace(/\s+/g, "");
  await api("login");
  lsSet("opros.code", state.code);
  document.getElementById("login").hidden = true;
  document.getElementById("app").hidden = false;
  await refresh();
}

document.getElementById("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  document.getElementById("login-err").textContent = "";
  try { await enter(document.getElementById("code").value); }
  catch (err) { state.code = ""; document.getElementById("login-err").textContent = err.message; }
  finally { btn.disabled = false; }
});
document.getElementById("logout").addEventListener("click", () => logout(""));

(async () => {
  const saved = lsGet("opros.code");
  if (!saved) return showLogin();
  try { await enter(saved); } catch (e) { logout(e.status === 401 ? "" : e.message); }
})();

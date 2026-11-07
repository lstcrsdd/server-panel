'use strict';
/* Заметки, сценарии и расписание. Загружается до app.js: классы страниц нужны
   в PAGES/TABS, а функции app.js (h, api, modal…) вызываются уже во время работы. */

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
})();

function srvName(id, fallback) {
  const s = S.by.get(id);
  return s ? s.name : fallback || id;
}

const pad2 = (x) => String(x).padStart(2, '0');

// «сегодня 14:05», «завтра 04:00», «пн, 9 нояб. 04:00»
function whenText(ms) {
  const d = new Date(ms), now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((day - today) / 86400e3);
  const t = Fmt.clock(ms);
  if (diff === 0) return 'сегодня ' + t;
  if (diff === -1) return 'вчера ' + t;
  if (diff === 1) return 'завтра ' + t;
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  const wd = Math.abs(diff) < 7 ? d.toLocaleDateString('ru-RU', { weekday: 'short' }) + ', ' : '';
  return wd + d.toLocaleDateString('ru-RU', opts) + ' ' + t;
}

function relText(ms) {
  const sec = (ms - Date.now()) / 1000;
  return sec >= 0 ? 'через ' + Fmt.dur(sec) : Fmt.dur(-sec) + ' назад';
}

function firstLine(s) {
  return (s || '').split('\n').find((l) => l.trim()) || '';
}

// текст с кликабельными ссылками
function linkify(text) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return parts.map((p, i) => (i % 2 ? h('a', { href: p, target: '_blank', rel: 'noopener noreferrer' }, p) : p));
}

function serverPicker(selected) {
  const sel = new Set(selected || []);
  const el = h('div', { class: 'pick' });
  const listeners = [];
  for (const s of S.servers.filter((x) => !x.hidden)) {
    const cb = h('input', { type: 'checkbox', checked: sel.has(s.id) });
    cb.addEventListener('change', () => {
      if (cb.checked) sel.add(s.id); else sel.delete(s.id);
      listeners.forEach((f) => f());
    });
    el.append(h('label', { class: 'check pick-item' + (s.status === 'offline' ? ' dim' : '') }, cb, h('span', { class: 'dot ' + s.status }), s.name));
  }
  return {
    el,
    get: () => S.servers.filter((s) => sel.has(s.id)).map((s) => s.id),
    remove(id) { sel.delete(id); const i = [...el.querySelectorAll('input')]; S.servers.filter((x) => !x.hidden).forEach((s, k) => { if (s.id === id) i[k].checked = false; }); listeners.forEach((f) => f()); },
    onChange: (f) => listeners.push(f),
  };
}

/* ---------- выполнение на нескольких серверах (команды и сценарии) ---------- */
function runCard({ title, ids, body, onRemove }) {
  const prog = h('span', { class: 'muted' });
  const out = h('div', { class: 'run-body' });
  const el = h('div', { class: 'card run' },
    h('div', { class: 'run-head' }, title, h('span', { class: 'grow' }), prog,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { el.remove(); if (onRemove) onRemove(el); } }, 'Убрать')),
    out);
  const results = new Map();
  const render = () => {
    prog.textContent = results.size < ids.length
      ? `выполнено ${results.size} из ${ids.length}…`
      : `${ids.length} ${Fmt.plural(ids.length, 'сервер', 'сервера', 'серверов')} · ${Fmt.clock(Date.now())}`;
    // одинаковый вывод показываем один раз
    const groups = new Map();
    for (const id of ids) {
      const r = results.get(id);
      const key = r ? (r.error ? 'E' + r.error : r.code + '\u0000' + r.output) : '\u0001pending';
      if (!groups.has(key)) groups.set(key, { r, ids: [] });
      groups.get(key).ids.push(id);
    }
    out.replaceChildren(...[...groups.values()].map((g) => {
      const names = g.ids.map((id) => h('a', { class: 'pchip', href: '#/s/' + encodeURIComponent(id) }, srvName(id)));
      if (!g.r) return h('div', { class: 'rgroup' }, h('div', { class: 'rgroup-head' }, names, h('span', { class: 'muted' }, h('span', { class: 'spinner' }), NB + 'выполняется…')));
      const r = g.r;
      const badge = r.error ? h('span', { class: 'badge crit' }, 'ошибка') : h('span', { class: 'badge ' + (r.code ? 'warn' : 'good') }, `код ${r.code}`);
      return h('div', { class: 'rgroup' },
        h('div', { class: 'rgroup-head' }, names, badge, groups.size > 1 && g.ids.length > 1 ? h('span', { class: 'muted' }, 'одинаковый вывод') : null,
          r.ms != null ? h('span', { class: 'muted' }, `${Fmt.int(r.ms)} мс`) : null),
        r.error ? h('div', { class: 'bad-ink', style: { fontSize: '13px' } }, r.error) : null,
        r.output ? h('pre', { class: 'cout rout' }, r.output) : r.error ? null : h('div', { class: 'muted', style: { fontSize: '12.5px' } }, '(нет вывода)'),
        r.truncated ? h('div', { class: 'muted', style: { fontSize: '12px' } }, 'вывод обрезан до 2 МБ') : null);
    }));
  };
  render();
  const done = Promise.all(ids.map(async (id) => {
    try {
      results.set(id, await api(`/servers/${encodeURIComponent(id)}/exec`, { method: 'POST', body }));
    } catch (e) {
      results.set(id, { error: e.message });
    }
    render();
  }));
  return { el, done };
}

/* ================= заметки ================= */
function setNotes(list) {
  S.notes = list || [];
  if (S.page && S.page.onNotes) S.page.onNotes();
}

async function reloadNotes() {
  try { setNotes((await api('/notes')).notes); } catch (e) { /* придёт событием */ }
}

function sortNotes(list) {
  return list.slice().sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
}

function notesOf(id) { return S.notes.filter((n) => n.server === id); }

async function patchNote(n, patch) {
  try {
    await api('/notes/' + n.id, { method: 'PUT', body: patch });
    reloadNotes();
  } catch (e) { toast(e.message, 'bad'); }
}

function noteCard(n, { showServer } = {}) {
  const label = n.title || firstLine(n.text).slice(0, 60);
  const pin = h('button', {
    class: 'btn ghost sm icon-only note-pin' + (n.pinned ? ' on' : ''), type: 'button',
    title: n.pinned ? 'Открепить' : 'Закрепить', 'aria-label': (n.pinned ? 'Открепить: ' : 'Закрепить: ') + label, 'aria-pressed': String(!!n.pinned),
    onclick: () => patchNote(n, { pinned: !n.pinned }),
  }, icon('pin'));
  let where = null;
  if (showServer) {
    if (!n.server) where = h('span', { class: 'tag' }, 'общая');
    else if (S.by.has(n.server)) where = h('a', { class: 'pchip', href: `#/s/${encodeURIComponent(n.server)}/notes` }, srvName(n.server));
    else where = h('span', { class: 'pchip dim', title: 'Сервер удалён из панели' }, (n.serverName || n.server) + ' (удалён)');
  }
  const el = h('div', { class: 'card note' + (n.pinned ? ' pinned' : '') },
    h('div', { class: 'note-head' },
      h('button', { class: 'note-open', type: 'button', onclick: () => noteDialog(n), 'aria-label': 'Открыть заметку: ' + label },
        n.title ? h('span', { class: 'note-title' }, n.title) : h('span', { class: 'note-title muted' }, 'Без заголовка')),
      pin),
    n.text ? h('div', { class: 'note-text' }, linkify(n.text)) : null,
    h('div', { class: 'note-meta' }, where, h('span', { class: 'muted' }, 'изменена ' + whenText(n.updated))));
  el.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) noteDialog(n); });
  return el;
}

function notesEmpty(text) {
  return h('div', { class: 'card empty' }, h('b', null, 'Заметок пока нет'), text);
}

function noteDialog(n = {}) {
  const isNew = !n.id;
  const title = h('input', { class: 'input', value: n.title || '', maxlength: '200', placeholder: 'Например: что настроено на сервере', autocomplete: 'off' });
  const text = h('textarea', { class: 'input note-edit', rows: '12' });
  text.value = n.text || '';
  const opts = [h('option', { value: '' }, 'Общая — без сервера')];
  for (const s of S.servers) opts.push(h('option', { value: s.id, selected: s.id === n.server }, s.name));
  if (n.server && !S.by.has(n.server)) opts.push(h('option', { value: n.server, selected: true }, (n.serverName || n.server) + ' (удалён)'));
  const srvSel = h('select', { class: 'input' }, opts);
  const pin = h('input', { type: 'checkbox', checked: !!n.pinned });
  const err = h('div', { class: 'bad-ink', style: { fontSize: '12.5px' } });
  let dirty = false;
  [title, text].forEach((i) => i.addEventListener('input', () => { dirty = true; }));
  [srvSel, pin].forEach((i) => i.addEventListener('change', () => { dirty = true; }));
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Сохранить');
  async function save() {
    const body = { title: title.value, text: text.value, server: srvSel.value, pinned: pin.checked };
    if (!body.title.trim() && !body.text.trim()) { err.textContent = 'Заметка пустая'; return; }
    saveBtn.disabled = true;
    try {
      await (isNew ? api('/notes', { method: 'POST', body }) : api('/notes/' + n.id, { method: 'PUT', body }));
      dirty = false;
      m.close(true);
      toast(isNew ? 'Заметка сохранена' : 'Заметка обновлена');
      reloadNotes();
    } catch (e) { err.textContent = e.message; }
    saveBtn.disabled = false;
  }
  saveBtn.addEventListener('click', save);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
  const del = isNew ? null : h('button', {
    class: 'btn danger', type: 'button', style: { marginRight: 'auto' },
    onclick: async () => {
      const ok = await confirmDialog({ title: 'Удалить заметку?', text: n.title || firstLine(n.text).slice(0, 120), ok: 'Удалить', danger: true });
      if (!ok) return;
      try { await api('/notes/' + n.id, { method: 'DELETE' }); m.close(true); toast('Заметка удалена'); reloadNotes(); } catch (e) { toast(e.message, 'bad'); }
    },
  }, 'Удалить');
  const m = modal({
    title: isNew ? 'Новая заметка' : 'Заметка',
    wide: true,
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Заголовок'), title),
      h('label', { class: 'field' }, h('span', null, 'Текст'), text,
        h('span', { class: 'hint' }, 'Хранится только на этом компьютере, на сервер не записывается. Пароли сюда лучше не класть. ⌘/Ctrl+Enter — сохранить.')),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', null, 'Сервер'), srvSel),
        h('label', { class: 'check', style: { alignSelf: 'end', paddingBottom: '8px' } }, pin, 'Закрепить — показывать на странице сервера')),
      err),
    foot: [del, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), saveBtn],
    beforeClose: () => {
      if (!dirty) return true;
      confirmDialog({ title: 'Закрыть без сохранения?', text: 'Изменения в заметке будут потеряны.', ok: 'Закрыть', danger: true }).then((ok) => { if (ok) m.close(true); });
      return false;
    },
  });
  if (!isNew) setTimeout(() => text.focus(), 40);
}

// закреплённые заметки под заголовком страницы сервера
function pinnedNotesStrip(id) {
  const ns = sortNotes(notesOf(id).filter((n) => n.pinned));
  if (!ns.length) return null;
  return h('div', { class: 'pin-strip' },
    ns.slice(0, 3).map((n) => h('button', { class: 'pin-note', type: 'button', onclick: () => noteDialog(n), title: firstLine(n.text) || n.title },
      icon('pin'), h('span', null, n.title || firstLine(n.text)))),
    ns.length > 3 ? h('a', { class: 'pin-more', href: `#/s/${encodeURIComponent(id)}/notes` }, `ещё ${ns.length - 3}`) : null);
}

function noteBadge(id) {
  const n = notesOf(id).length;
  return n ? h('span', { class: 'note-badge', title: `${n} ${Fmt.plural(n, 'заметка', 'заметки', 'заметок')}` }, icon('note'), String(n)) : null;
}

function notesTab(page) {
  const id = page.id;
  const list = h('div');
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      h('span', { class: 'ink2', style: { fontSize: '13px' } }, 'Заметки об этом сервере — хранятся только на этом компьютере'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => noteDialog({ server: id }) }, icon('plus'), 'Новая заметка')),
    list);
  const render = () => {
    const ns = sortNotes(notesOf(id));
    list.replaceChildren(ns.length
      ? h('div', { class: 'notes-grid' }, ns.map((n) => noteCard(n)))
      : notesEmpty('Например: что и зачем настроено на сервере, контакты хостинга, план работ.'));
  };
  render();
  return { el, onNotes: render };
}

class NotesPage {
  constructor() {
    this.kind = 'notes';
    this.q = '';
    this.filter = store.get('notesFilter', 'all');
    this.el = h('div', { class: 'page' });
    this.filterSel = h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Какие заметки показывать' });
    this.filterSel.addEventListener('change', () => { this.filter = this.filterSel.value; store.set('notesFilter', this.filter); this.renderList(); });
    this.listEl = h('div');
    this.el.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, 'Заметки'),
          h('div', { class: 'head-meta' }, h('span', null, 'Хранятся только на этом компьютере — на серверы не записываются'))),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => noteDialog({ server: this.filter !== 'all' && this.filter !== 'general' ? this.filter : '' }) }, icon('plus'), 'Новая заметка'))),
      h('div', { class: 'toolbar' },
        h('input', { class: 'input search', type: 'search', placeholder: 'Поиск по заметкам', oninput: (e) => { this.q = e.target.value.trim().toLowerCase(); this.renderList(); } }),
        this.filterSel),
      this.listEl);
    this.render();
  }

  onNotes() { this.render(); }
  onData() { this.render(); }
  destroy() {}

  render() {
    const count = (f) => S.notes.filter(f).length;
    const opts = [['all', `Все заметки · ${S.notes.length}`], ['general', `Общие · ${count((n) => !n.server)}`]];
    for (const s of S.servers) {
      const c = count((n) => n.server === s.id);
      if (c || this.filter === s.id) opts.push([s.id, `${s.name} · ${c}`]);
    }
    if (!opts.some(([v]) => v === this.filter)) this.filter = 'all';
    this.filterSel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v, selected: v === this.filter }, l)));
    this.renderList();
  }

  renderList() {
    let ns = S.notes;
    if (this.filter === 'general') ns = ns.filter((n) => !n.server);
    else if (this.filter !== 'all') ns = ns.filter((n) => n.server === this.filter);
    if (this.q) ns = ns.filter((n) => (n.title + '\n' + n.text + '\n' + srvName(n.server, n.serverName)).toLowerCase().includes(this.q));
    ns = sortNotes(ns);
    if (!S.notes.length) {
      this.listEl.replaceChildren(notesEmpty('Общие заметки и заметки о серверах: что и зачем настроено, контакты хостинга, план работ. Заметку о конкретном сервере удобно добавить на его странице, во вкладке «Заметки».'));
      return;
    }
    this.listEl.replaceChildren(ns.length
      ? h('div', { class: 'notes-grid' }, ns.map((n) => noteCard(n, { showServer: true })))
      : h('div', { class: 'card empty' }, 'Ничего не найдено'));
  }
}

/* ================= сценарии ================= */
const SCN_TEMPLATES = [
  { name: 'Место на диске и самые большие папки', script: 'df -h /\necho\ndu -xh --max-depth=2 / 2>/dev/null | sort -rh | head -15', sudo: true, timeout: 600 },
  { name: 'Очистить старые журналы systemd', desc: 'Оставить журналы за последние 7 дней', script: 'journalctl --vacuum-time=7d', sudo: true },
  { name: 'Очистить кэш apt', script: 'apt-get clean\ndf -h /', sudo: true },
  { name: 'Службы с ошибками', script: 'systemctl --failed --no-legend --plain\necho "всего: $(systemctl --failed --no-legend --plain | wc -l)"' },
  { name: 'Перезапустить службу и проверить', desc: 'Замените xray на нужную службу', script: 'systemctl restart xray\nsleep 2\nsystemctl is-active xray', sudo: true },
];
const SCN_TIMEOUTS = [[120, '2 минуты'], [600, '10 минут'], [1800, '30 минут'], [3600, '1 час']];

function setScenarios(list) {
  S.scenarios = list || [];
  if (S.page && S.page.onScenarios) S.page.onScenarios();
}

async function reloadScenarios() {
  try { setScenarios((await api('/scenarios')).scenarios); } catch (e) { /* придёт событием */ }
}

function scenarioDialog(sc = {}) {
  const isNew = !sc.id;
  const nameIn = h('input', { class: 'input', value: sc.name || '', maxlength: '120', placeholder: 'Например: очистить журналы', autocomplete: 'off' });
  const descIn = h('input', { class: 'input', value: sc.desc || '', maxlength: '300', placeholder: 'Необязательно', autocomplete: 'off' });
  const scriptIn = h('textarea', { class: 'input mono scn-edit', rows: '12', spellcheck: 'false', autocomplete: 'off', placeholder: 'systemctl restart xray\nsystemctl is-active xray' });
  scriptIn.value = sc.script || '';
  const sudo = h('input', { type: 'checkbox', checked: !!sc.sudo });
  const tSel = h('select', { class: 'input' }, SCN_TIMEOUTS.map(([v, l]) => h('option', { value: String(v), selected: v === (sc.timeout || 600) }, l)));
  const err = h('div', { class: 'bad-ink', style: { fontSize: '12.5px' } });
  let dirty = false;
  [nameIn, descIn, scriptIn].forEach((i) => i.addEventListener('input', () => { dirty = true; }));
  scriptIn.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const s = scriptIn.selectionStart;
      scriptIn.setRangeText('  ', s, scriptIn.selectionEnd, 'end');
      dirty = true;
    }
  });
  let tpl = null;
  if (isNew) {
    const tplSel = h('select', { class: 'input' }, h('option', { value: '' }, 'Пустой'), SCN_TEMPLATES.map((t, i) => h('option', { value: String(i) }, t.name)));
    tplSel.addEventListener('change', () => {
      const t = SCN_TEMPLATES[Number(tplSel.value)];
      if (!t) return;
      nameIn.value = t.name; descIn.value = t.desc || ''; scriptIn.value = t.script; sudo.checked = !!t.sudo;
      tSel.value = String(t.timeout || 600);
      dirty = true;
    });
    tpl = h('label', { class: 'field' }, h('span', null, 'Начать с шаблона'), tplSel);
  }
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Сохранить');
  saveBtn.addEventListener('click', async () => {
    const body = { name: nameIn.value, desc: descIn.value, script: scriptIn.value, sudo: sudo.checked, timeout: Number(tSel.value) };
    if (!body.name.trim()) { err.textContent = 'Укажите название'; nameIn.focus(); return; }
    if (!body.script.trim()) { err.textContent = 'Пустой скрипт'; scriptIn.focus(); return; }
    saveBtn.disabled = true;
    try {
      await (isNew ? api('/scenarios', { method: 'POST', body }) : api('/scenarios/' + sc.id, { method: 'PUT', body }));
      dirty = false;
      m.close(true);
      toast(isNew ? 'Сценарий сохранён' : 'Сценарий обновлён');
      reloadScenarios();
    } catch (e) { err.textContent = e.message; }
    saveBtn.disabled = false;
  });
  const m = modal({
    title: isNew ? 'Новый сценарий' : 'Сценарий',
    wide: true,
    body: h('div', { class: 'form' },
      tpl,
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', null, 'Название'), nameIn),
        h('label', { class: 'field' }, h('span', null, 'Описание'), descIn)),
      h('label', { class: 'field' }, h('span', null, 'Скрипт'), scriptIn,
        h('span', { class: 'hint' }, 'Выполняется через bash (или sh, если bash нет), без интерактивного ввода. Код выхода не 0 — ошибка.')),
      h('div', { class: 'row' },
        h('label', { class: 'check', style: { alignSelf: 'end', paddingBottom: '8px' } }, sudo, 'От root (через sudo, если вход не под root)'),
        h('label', { class: 'field' }, h('span', null, 'Ограничение времени'), tSel)),
      !isNew ? h('div', { class: 'hint' }, 'Задания в расписании хранят на сервере свою копию скрипта — после правки сценария запланируйте его заново.') : null,
      err),
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), saveBtn],
    beforeClose: () => {
      if (!dirty) return true;
      confirmDialog({ title: 'Закрыть без сохранения?', text: 'Изменения в сценарии будут потеряны.', ok: 'Закрыть', danger: true }).then((ok) => { if (ok) m.close(true); });
      return false;
    },
  });
}

async function deleteScenario(sc) {
  const ok = await confirmDialog({
    title: `Удалить сценарий «${sc.name}»?`,
    text: 'Задания в расписании, созданные из него, продолжат работать: копия скрипта лежит на сервере. Их можно удалить на странице «Расписание».',
    ok: 'Удалить', danger: true,
  });
  if (!ok) return;
  try { await api('/scenarios/' + sc.id, { method: 'DELETE' }); toast('Сценарий удалён'); reloadScenarios(); } catch (e) { toast(e.message, 'bad'); }
}

function runScenarioDialog(sc) {
  const last = store.get('scnSel.' + sc.id, null) || store.get('cmdSel', []);
  const picker = serverPicker(last.filter((id) => S.by.has(id)));
  const runBtn = h('button', { class: 'btn primary', type: 'button' }, 'Запустить');
  const upd = () => {
    const n = picker.get().length;
    runBtn.disabled = !n;
    runBtn.textContent = n > 1 ? `Запустить на ${n} ${Fmt.plural(n, 'сервере', 'серверах', 'серверах')}` : 'Запустить';
  };
  picker.onChange(upd);
  upd();
  runBtn.addEventListener('click', () => {
    const ids = picker.get();
    store.set('scnSel.' + sc.id, ids);
    m.close();
    startScenarioRun(sc, ids);
  });
  const lines = sc.script.split('\n');
  const m = modal({
    title: `Запустить «${sc.name}»`,
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'field' }, h('span', null, 'Серверы'), picker.el),
      h('details', { class: 'scn-details' }, h('summary', null, `Скрипт · ${lines.length} ${Fmt.plural(lines.length, 'строка', 'строки', 'строк')}`), h('pre', { class: 'pre' }, sc.script)),
      sc.sudo ? h('div', { class: 'alert warn' }, icon('warn'), h('div', null, 'Сценарий выполнится от root.')) : null),
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), runBtn],
  });
}

function startScenarioRun(sc, ids) {
  if (!ids.length) return;
  const title = h('div', { class: 'run-title' }, icon('play'), h('b', null, sc.name), sc.sudo ? h('span', { class: 'tag' }, 'от root') : null);
  const r = runCard({
    title, ids,
    body: { cmd: sc.script, sudo: !!sc.sudo, timeout: sc.timeout || 600 },
    onRemove: (el) => { S.scnRuns = S.scnRuns.filter((x) => x.el !== el); },
  });
  S.scnRuns.unshift(r);
  if (S.scnRuns.length > 30) S.scnRuns.pop().el.remove();
  if (S.page && S.page.kind === 'scenarios') S.page.runsEl.prepend(r.el);
  else location.hash = '#/scenarios';
}

function scenarioCard(sc) {
  const lines = sc.script.split('\n');
  const preview = lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '');
  const more = h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': `Ещё: ${sc.name}`, title: 'Ещё' }, icon('dots'));
  more.addEventListener('click', () => popMenu(more, [
    { label: 'Изменить', run: () => scenarioDialog(sc) },
    { label: 'Сделать копию', run: () => scenarioDialog({ ...sc, id: undefined, name: sc.name + ' (копия)' }) },
    '-',
    { label: 'Удалить', danger: true, run: () => deleteScenario(sc) },
  ]));
  return h('div', { class: 'card scn' },
    h('div', { class: 'scn-head' },
      h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'card-title' }, sc.name), sc.desc ? h('div', { class: 'card-sub' }, sc.desc) : null),
      sc.sudo ? h('span', { class: 'tag' }, 'от root') : null),
    h('pre', { class: 'scn-script' }, preview),
    h('div', { class: 'scn-actions' },
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => runScenarioDialog(sc) }, icon('play'), 'Запустить…'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => scheduleDialog({ kind: 'scenario', target: sc.id }) }, icon('clock'), 'По расписанию…'),
      h('span', { class: 'grow' }), more));
}

class ScenariosPage {
  constructor() {
    this.kind = 'scenarios';
    this.el = h('div', { class: 'page' });
    this.listEl = h('div');
    this.runsEl = h('div', { class: 'runs' });
    this.el.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, 'Сценарии'),
          h('div', { class: 'head-meta' }, h('span', null, 'Сохранённые скрипты: запуск на нескольких серверах сразу или по расписанию'))),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => scenarioDialog() }, icon('plus'), 'Новый сценарий'))),
      this.listEl, this.runsEl);
    for (const r of S.scnRuns) this.runsEl.append(r.el);
    this.render();
  }

  onScenarios() { this.render(); }
  destroy() {}

  render() {
    const list = S.scenarios.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    this.listEl.replaceChildren(list.length
      ? h('div', { class: 'scn-grid' }, list.map((sc) => scenarioCard(sc)))
      : h('div', { class: 'card empty' }, h('b', null, 'Сценариев пока нет'),
        'Сохраните скрипт, который часто запускаете: очистка журналов, перезапуск служб, проверка места. Есть готовые шаблоны.',
        h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn primary', type: 'button', onclick: () => scenarioDialog() }, icon('plus'), 'Новый сценарий'))));
  }
}

/* ================= расписание ================= */
const KIND_TEXT = { reboot: 'Перезагрузка сервера', service: 'Перезапуск службы', scenario: 'Сценарий' };
const WEEK = [['Mon', 'пн'], ['Tue', 'вт'], ['Wed', 'ср'], ['Thu', 'чт'], ['Fri', 'пт'], ['Sat', 'сб'], ['Sun', 'вс']];

function specText(t) {
  const m = /^(?:([A-Za-z,]+) )?(\S+) (\d\d:\d\d):\d\d(?: (\S+))?$/.exec(t.spec || '');
  if (!m) return t.spec || '—';
  const [, days, date, time, tz] = m;
  const tzs = tz && tz !== BROWSER_TZ ? ` (${tz})` : '';
  const dm = /^(\d{4})-(\d\d)-(\d\d)$/.exec(date);
  if (dm) return `один раз, ${new Date(+dm[1], +dm[2] - 1, +dm[3]).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${time}${tzs}`;
  if (days) {
    const set = days.split(',');
    if (set.length === 7) return `каждый день в ${time}${tzs}`;
    return WEEK.filter(([k]) => set.includes(k)).map(([, v]) => v).join(', ') + ` в ${time}${tzs}`;
  }
  const md = /^\*-\*-(\d\d)$/.exec(date);
  if (md) return `${Number(md[1])}-го числа каждого месяца в ${time}${tzs}`;
  return `каждый день в ${time}${tzs}`;
}

function taskTarget(t) {
  if (t.kind === 'service') return (t.target || '').replace(/\.service$/, '');
  if (t.kind === 'scenario') return t.targetName || 'сценарий';
  return '';
}

async function taskAction(sid, t, action, after) {
  try {
    await api(`/servers/${encodeURIComponent(sid)}/schedule/${t.id}/action`, { method: 'POST', body: { action } });
    toast(action === 'run' ? `«${t.name}» запущено` : action === 'pause' ? `«${t.name}» на паузе` : `«${t.name}» снова по расписанию`);
  } catch (e) { toast(e.message, 'bad'); }
  if (after) after();
}

async function deleteTask(sid, t, after) {
  const ok = await confirmDialog({
    title: `Удалить задание «${t.name}»?`,
    text: `Сервер: ${srvName(sid)}. Таймер и его файлы будут удалены с сервера.`,
    ok: 'Удалить', danger: true,
  });
  if (!ok) return;
  try {
    await api(`/servers/${encodeURIComponent(sid)}/schedule/${t.id}`, { method: 'DELETE' });
    toast('Задание удалено');
  } catch (e) { toast(e.message, 'bad'); }
  if (after) after();
}

// localLog — строки journalctl -o short-iso: время сервера (UTC) → местное,
// имя хоста убираем, оно одинаковое во всех строках.
function localLog(text) {
  return text.split('\n').map((line) => {
    const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)([+-]\d\d):?(\d\d) \S+ (.*)$/);
    if (!m) return line;
    const d = new Date(`${m[1]}${m[2]}:${m[3]}`);
    if (isNaN(d)) return line;
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}  ${m[4]}`;
  }).join('\n');
}

function taskLogDialog(sid, t) {
  const pre = h('pre', { class: 'cout', style: { maxHeight: '60vh', margin: 0 } }, 'Загрузка…');
  const m = modal({
    title: `Журнал: ${t.name}`, lead: `${srvName(sid)} · последние записи journalctl`, wide: true, body: pre,
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Закрыть')],
  });
  api(`/servers/${encodeURIComponent(sid)}/schedule/${t.id}/log`)
    .then((r) => { pre.textContent = r.log ? localLog(r.log) : 'Записей пока нет — задание ещё не запускалось.'; })
    .catch((e) => { pre.textContent = e.message; });
}

function resultBadge(t) {
  if (t.running) return h('span', { class: 'muted' }, h('span', { class: 'spinner' }), NB + 'выполняется');
  if (!t.ran) return h('span', { class: 'muted' }, t.kind === 'reboot' && t.repeat === 'once' && !t.next ? '—' : 'ещё не запускалось');
  const ok = t.result === 'success';
  return h('div', null, whenText(t.ran * 1000),
    h('div', null, h('span', { class: 'badge ' + (ok ? 'good' : 'crit') }, ok ? 'успешно' : t.result === 'exit-code' ? `ошибка, код ${t.exitCode}` : t.result === 'timeout' ? 'не уложилось во время' : t.result || 'ошибка')));
}

function scheduleView({ ids, showServer }) {
  const st = { data: new Map(), busy: false };
  const errBox = h('div');
  const tbody = h('tbody');
  const table = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl sched' },
    h('thead', null, h('tr', null,
      showServer ? h('th', null, 'Сервер') : null,
      h('th', null, 'Задание'), h('th', null, 'Когда'), h('th', null, 'Следующий запуск'), h('th', null, 'Последний запуск'),
      h('th', null, h('span', { class: 'sr-only' }, 'Действия')))),
    tbody));
  const emptyBox = h('div');
  const el = h('div', null, errBox, emptyBox, table);

  async function load() {
    if (st.busy) return;
    st.busy = true;
    const list = ids();
    if (!st.data.size) tbody.replaceChildren(h('tr', null, h('td', { colspan: showServer ? '6' : '5', class: 'empty' }, h('span', { class: 'spinner' }), NB + ' Загрузка расписания…')));
    const fresh = new Map();
    await Promise.all(list.map(async (sid) => {
      const s = S.by.get(sid);
      if (s && s.status === 'offline') { fresh.set(sid, { error: 'нет связи' }); return; }
      try { fresh.set(sid, await api(`/servers/${encodeURIComponent(sid)}/schedule`)); } catch (e) { fresh.set(sid, { error: e.message }); }
    }));
    st.data = fresh;
    st.busy = false;
    render();
  }

  function render() {
    const rows = [];
    const errs = [];
    for (const [sid, d] of st.data) {
      if (d.error) { errs.push([sid, d.error]); continue; }
      for (const t of d.tasks || []) rows.push([sid, t]);
    }
    rows.sort((a, b) => ((a[1].next || Infinity) - (b[1].next || Infinity)) || a[1].created - b[1].created);
    errBox.replaceChildren(...errs.map(([sid, e]) => h('div', { class: 'alert warn', style: { marginBottom: '10px' } }, icon('warn'),
      h('div', null, showServer ? h('b', null, srvName(sid) + ': ') : null, e))));
    if (!showServer) {
      const d = st.data.values().next().value;
      if (d && !d.error && !d.privileged) errBox.append(h('div', { class: 'alert warn', style: { marginBottom: '10px' } }, icon('warn'), h('div', null, 'Нет прав root или sudo без пароля — создавать задания на этом сервере нельзя.')));
    }
    table.hidden = !rows.length;
    emptyBox.replaceChildren(rows.length || (st.data.size && errs.length === st.data.size) ? '' : h('div', { class: 'card empty' }, h('b', null, 'Заданий пока нет'),
      'Можно запланировать перезагрузку, перезапуск службы или сценарий — один раз или регулярно.'));
    tbody.replaceChildren(...rows.map(([sid, t]) => {
      const target = taskTarget(t);
      const more = h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': `Ещё: ${t.name}`, title: 'Ещё' }, icon('dots'));
      more.addEventListener('click', () => {
        // у разового задания, время которого прошло, ставить на паузу нечего
        const spent = t.repeat === 'once' && t.enabled && !t.next;
        const items = [
          t.kind !== 'reboot' ? { label: 'Запустить сейчас', run: () => taskAction(sid, t, 'run', () => setTimeout(load, 1500)) } : null,
          spent ? null : t.enabled ? { label: 'Приостановить', run: () => taskAction(sid, t, 'pause', load) } : { label: 'Возобновить', run: () => taskAction(sid, t, 'resume', load) },
        ].filter(Boolean);
        popMenu(more, [...items, ...(items.length ? ['-'] : []), { label: 'Удалить', danger: true, run: () => deleteTask(sid, t, load) }]);
      });
      let next;
      if (!t.enabled) next = h('span', { class: 'badge warn' }, 'на паузе');
      else if (t.next) next = h('div', null, whenText(t.next * 1000), h('div', { class: 'desc' }, relText(t.next * 1000)));
      else next = h('span', { class: 'muted' }, t.repeat === 'once' ? 'время прошло' : '—');
      return h('tr', { class: t.enabled ? '' : 'is-paused' },
        showServer ? h('td', null, h('a', { class: 'pchip', href: `#/s/${encodeURIComponent(sid)}/schedule` }, srvName(sid))) : null,
        h('td', { class: 'name-cell' }, h('b', null, t.name),
          h('div', { class: 'desc' }, KIND_TEXT[t.kind] || t.kind, target && target !== t.name ? ': ' + target : '', t.runAs ? ` · от ${t.runAs}` : '')),
        h('td', { class: 'ink2' }, specText(t)),
        h('td', null, next),
        h('td', null, resultBadge(t)),
        h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => taskLogDialog(sid, t) }, 'Журнал'), more));
    }));
  }

  load();
  return { el, load };
}

function scheduleDialog(opts = {}) {
  let kind = opts.kind || 'reboot';
  let repeat = 'daily';
  const days = new Set(['Mon']);
  const nameIn = h('input', { class: 'input', maxlength: '120', placeholder: 'Необязательно — подставится само', autocomplete: 'off' });
  const kindSeg = seg([['reboot', 'Перезагрузить сервер'], ['service', 'Перезапустить службу'], ['scenario', 'Выполнить сценарий']], kind, (v) => { kind = v; sync(); });
  const dl = 'svc-dl-' + Math.random().toString(36).slice(2, 8);
  const svcList = h('datalist', { id: dl });
  const svcIn = h('input', { class: 'input mono', list: dl, placeholder: 'например, xray', autocomplete: 'off', spellcheck: 'false', value: opts.kind === 'service' ? (opts.target || '').replace(/\.service$/, '') : '' });
  const scnSel = h('select', { class: 'input' }, S.scenarios.map((sc) => h('option', { value: sc.id, selected: sc.id === opts.target }, sc.name)));
  const repSeg = seg([['once', 'Один раз'], ['daily', 'Каждый день'], ['weekly', 'По дням недели'], ['monthly', 'Раз в месяц']], repeat, (v) => { repeat = v; sync(); });
  const tm = new Date(Date.now() + 86400e3);
  const dateIn = h('input', { class: 'input', type: 'date', value: `${tm.getFullYear()}-${pad2(tm.getMonth() + 1)}-${pad2(tm.getDate())}` });
  const timeIn = h('input', { class: 'input', type: 'time', value: '04:00' });
  const mdayIn = h('input', { class: 'input', type: 'number', min: '1', max: '28', value: '1' });
  const dayBtns = WEEK.map(([k, l]) => {
    const b = h('button', { type: 'button', class: 'daybtn' + (days.has(k) ? ' on' : ''), 'aria-pressed': String(days.has(k)) }, l);
    b.addEventListener('click', () => {
      if (days.has(k)) days.delete(k); else days.add(k);
      b.classList.toggle('on', days.has(k));
      b.setAttribute('aria-pressed', String(days.has(k)));
    });
    return b;
  });
  const picker = serverPicker(opts.servers || []);
  const svcField = h('label', { class: 'field' }, h('span', null, 'Служба'), svcIn, svcList);
  const scnField = h('label', { class: 'field' }, h('span', null, 'Сценарий'), S.scenarios.length ? scnSel
    : h('div', { class: 'hint' }, 'Сценариев пока нет — создайте его на странице «Сценарии».'));
  const dateField = h('label', { class: 'field' }, h('span', null, 'Дата'), dateIn);
  const daysField = h('div', { class: 'field' }, h('span', null, 'Дни недели'), h('div', { class: 'days' }, dayBtns));
  const mdayField = h('label', { class: 'field' }, h('span', null, 'Число месяца (1–28)'), mdayIn);
  const warn = h('div');
  const err = h('div', { class: 'bad-ink', style: { fontSize: '12.5px' } });
  const results = h('div');
  const okBtn = h('button', { class: 'btn primary', type: 'button' }, 'Запланировать');

  let svcLoaded = false;
  async function loadServices() {
    if (svcLoaded) return;
    const sid = picker.get()[0];
    if (!sid) return;
    svcLoaded = true;
    try {
      const r = await api(`/servers/${encodeURIComponent(sid)}/services`);
      const list = (r.services || []).sort((a, b) => (b.sub === 'running') - (a.sub === 'running') || a.unit.localeCompare(b.unit));
      svcList.replaceChildren(...list.map((s) => h('option', { value: s.unit.replace(/\.service$/, '') }, s.description || '')));
    } catch (e) { svcLoaded = false; }
  }

  function sync() {
    svcField.hidden = kind !== 'service';
    scnField.hidden = kind !== 'scenario';
    dateField.hidden = repeat !== 'once';
    daysField.hidden = repeat !== 'weekly';
    mdayField.hidden = repeat !== 'monthly';
    if (kind === 'service') loadServices();
    const n = picker.get().length;
    warn.replaceChildren(kind === 'reboot'
      ? h('div', { class: 'alert warn' }, icon('warn'), h('div', null, `${n > 1 ? 'Серверы будут перезагружены' : 'Сервер будет перезагружен'} в это время без дополнительного подтверждения. Если панель в этот момент выключена — всё равно: задание выполняет сам сервер.`))
      : '');
    okBtn.textContent = n > 1 ? `Запланировать на ${n} ${Fmt.plural(n, 'сервере', 'серверах', 'серверах')}` : 'Запланировать';
    okBtn.disabled = !n;
  }
  picker.onChange(sync);

  okBtn.addEventListener('click', async () => {
    err.textContent = '';
    const ids = picker.get();
    if (!ids.length) { err.textContent = 'Выберите сервер'; return; }
    let target = '';
    if (kind === 'service') {
      const v = svcIn.value.trim();
      if (!v) { err.textContent = 'Укажите службу'; svcIn.focus(); return; }
      target = v.endsWith('.service') ? v : v + '.service';
    } else if (kind === 'scenario') {
      if (!S.scenarios.length) { err.textContent = 'Нет сценариев'; return; }
      target = scnSel.value;
    }
    if (!timeIn.value) { err.textContent = 'Укажите время'; return; }
    if (repeat === 'weekly' && !days.size) { err.textContent = 'Выберите дни недели'; return; }
    const body = {
      name: nameIn.value, kind, target, repeat,
      date: dateIn.value, time: timeIn.value.slice(0, 5),
      days: WEEK.map(([k]) => k).filter((k) => days.has(k)),
      monthDay: Number(mdayIn.value), tz: BROWSER_TZ,
    };
    okBtn.disabled = true;
    const prev = okBtn.textContent;
    okBtn.textContent = 'Создаю…';
    const res = await Promise.all(ids.map(async (sid) => {
      try { await api(`/servers/${encodeURIComponent(sid)}/schedule`, { method: 'POST', body }); return [sid, null]; } catch (e) { return [sid, e.message]; }
    }));
    okBtn.textContent = prev;
    const bad = res.filter(([, e]) => e);
    const good = res.filter(([, e]) => !e);
    // успешные убираем из выбора, чтобы повтор не создал задание второй раз
    good.forEach(([sid]) => picker.remove(sid));
    if (good.length && opts.onDone) opts.onDone();
    if (S.page && S.page.onSchedule) S.page.onSchedule();
    if (!bad.length) {
      m.close();
      toast(good.length > 1 ? `Задание создано на ${good.length} ${Fmt.plural(good.length, 'сервере', 'серверах', 'серверах')}` : 'Задание создано');
      return;
    }
    results.replaceChildren(h('div', { class: 'alert bad' }, h('div', null,
      good.length ? h('div', null, 'Создано: ', good.map(([sid]) => srvName(sid)).join(', ')) : null,
      bad.map(([sid, e]) => h('div', null, h('b', null, srvName(sid) + ': '), e)))));
    sync();
  });

  const m = modal({
    title: 'Запланировать',
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'field' }, h('span', null, 'Что сделать'), kindSeg.el),
      svcField, scnField,
      h('div', { class: 'field' }, h('span', null, 'Когда'), repSeg.el),
      h('div', { class: 'row' }, dateField, daysField, mdayField, h('label', { class: 'field' }, h('span', null, 'Время'), timeIn)),
      h('div', { class: 'hint' }, `Время — по вашему часовому поясу (${BROWSER_TZ}); сервер пересчитает его сам.`),
      h('div', { class: 'field' }, h('span', null, 'Серверы'), picker.el),
      h('label', { class: 'field' }, h('span', null, 'Название'), nameIn),
      warn, err, results),
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), okBtn],
  });
  sync();
}

function scheduleTab(page) {
  const id = page.id;
  const view = scheduleView({ ids: () => [id] });
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      h('span', { class: 'ink2', style: { fontSize: '13px' } }, 'Задания хранятся на сервере как таймеры systemd и выполняются, даже если панель выключена'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', type: 'button', onclick: () => view.load() }, icon('refresh'), 'Обновить'),
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => scheduleDialog({ servers: [id], onDone: view.load }) }, icon('plus'), 'Запланировать')),
    view.el);
  return { el, onSchedule: view.load };
}

class SchedulePage {
  constructor() {
    this.kind = 'schedule';
    this.el = h('div', { class: 'page' });
    this.view = scheduleView({ ids: () => S.servers.filter((s) => !s.hidden).map((s) => s.id), showServer: true });
    this.el.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, 'Расписание'),
          h('div', { class: 'head-meta' }, h('span', null, 'Задания хранятся на серверах как таймеры systemd и выполняются, даже если панель выключена'))),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => this.view.load() }, icon('refresh'), 'Обновить'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => scheduleDialog({ onDone: () => this.view.load() }) }, icon('plus'), 'Запланировать'))),
      this.view.el);
  }

  onSchedule() { this.view.load(); }
  destroy() {}
}

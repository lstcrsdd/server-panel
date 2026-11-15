'use strict';

const TOKEN = document.querySelector('meta[name="panel-token"]').content;
const RANGES = { '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const RANGE_LABELS = [['5m', L('5 мин')], ['15m', L('15 мин')], ['1h', L('1 час')], ['6h', L('6 часов')], ['24h', L('24 часа')], ['7d', L('7 дней')], ['30d', L('30 дней')]];
const SPARK_N = 150;
const NB = ' ';
// служба с ошибкой: упала или падает и перезапускается по кругу (Restart=…, «activating (auto-restart)»)
const unitBad = (u) => u.active === 'failed' || /^auto-restart/.test(u.sub || '');

const store = {
  get(k, d) { try { const v = localStorage.getItem('sp.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('sp.' + k, JSON.stringify(v)); } catch (e) { /* нет хранилища */ } },
};

/* ---------- DOM ---------- */
const $ = (s, r = document) => r.querySelector(s);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  gear: '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>',
  refresh: '<path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9"/><path d="M15.5 3.8v3.4h-3.4"/>',
  power: '<path d="M10 3v6.5"/><path d="M6.2 5.6a6 6 0 1 0 7.6 0"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5M10 6.6v.01"/>',
  dots: '<circle cx="5" cy="10" r="1.3" class="fill"/><circle cx="10" cy="10" r="1.3" class="fill"/><circle cx="15" cy="10" r="1.3" class="fill"/>',
  copy: '<rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7"/>',
  warn: '<path d="M10 3.5l7.2 12.5H2.8z"/><path d="M10 8.5v3.4M10 14v.01"/>',
  term: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M6.5 8.5l2.2 1.8-2.2 1.8M10.5 12.5h3"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  up: '<path d="M5.5 12l4.5-4.5 4.5 4.5"/>',
  down: '<path d="M5.5 8l4.5 4.5 4.5-4.5"/>',
  pin: '<path d="M7.5 3.5h5M8.5 3.5v4.2L6 10.5v1.5h8v-1.5l-2.5-2.8V3.5M10 12v4.5"/>',
  note: '<path d="M5 3.5h7l3 3v10H5z"/><path d="M11.5 3.5v3.5H15M7.5 10.5h5M7.5 13.5h3.5"/>',
  clock: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.6"/>',
  play: '<path d="M7 5.2v9.6L14.5 10z"/>',
  bell: '<path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z"/><path d="M8.5 17.2a1.6 1.6 0 0 0 3 0"/>',
  send: '<path d="M17 3.5L2.8 9.3l5.6 2.3 2.3 5.6z"/><path d="M8.4 11.6L17 3.5"/>',
  check: '<path d="M5 10.5l3.2 3.2L15 6.8"/>',
  ok: '<circle cx="10" cy="10" r="6.5"/><path d="M7.2 10.2l2 2 3.8-4.2"/>',
  cross: '<circle cx="10" cy="10" r="6.5"/><path d="M7.6 7.6l4.8 4.8M12.4 7.6l-4.8 4.8"/>',
  pause: '<circle cx="10" cy="10" r="6.5"/><path d="M8.4 7.6v4.8M11.6 7.6v4.8"/>',
  search: '<circle cx="9" cy="9" r="5"/><path d="M13 13l3.5 3.5"/>',
  chev: '<path d="M7.5 5l5 5-5 5"/>',
  star: '<path d="M10 3.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 14l-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z"/>',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('class', 'ico');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const headers = { 'X-Panel-Token': TOKEN };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch (e) {
    throw new Error(L('Нет связи с панелью — она запущена?'));
  }
  if (res.status === 401) {
    showRestartBanner();
    throw new Error(L('Панель была перезапущена — обновите страницу'));
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  if (!res.ok) {
    const err = new Error(data.error || L('Ошибка ') + res.status);
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------- уведомления, окна, меню ---------- */
function toast(msg, kind = 'good', detail) {
  const cls = kind === 'good' ? 'online' : kind === 'warn' ? 'connecting' : 'offline';
  const t = h('div', { class: 'toast', role: 'status' },
    h('span', { class: 'dot ' + cls }),
    h('div', { style: { minWidth: 0 } }, h('div', null, msg), detail ? h('pre', null, detail) : null));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 10000 : 4500);
}

function modal({ title, lead, body, foot, wide, cls, onClose, beforeClose }) {
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') + (cls ? ' ' + cls : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h2', null, title), lead ? h('p', { class: 'lead' }, lead) : null, body || null,
    foot ? h('div', { class: 'modal-foot' }, foot) : null);
  const bd = h('div', { class: 'backdrop' }, box);
  const onKey = (e) => {
    const all = document.querySelectorAll('.backdrop');
    if (e.key === 'Escape' && all[all.length - 1] === bd && !openMenu) close();
  };
  function close(force) {
    if (force !== true && beforeClose && beforeClose() === false) return;
    bd.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  }
  bd.addEventListener('mousedown', (e) => { if (e.target === bd) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(bd);
  setTimeout(() => {
    const f = box.querySelector('input:not([type=checkbox]), select, textarea') || box.querySelector('.modal-foot .btn:last-child');
    if (f) f.focus();
  }, 30);
  return { close, box };
}

function promptDialog({ title, label, value = '', ok = 'OK', hint, validate }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, autocomplete: 'off', spellcheck: 'false' });
    const err = h('div', { class: 'bad-ink', style: { fontSize: '12.5px' } });
    const finish = (v) => {
      if (v !== null && validate) { const e = validate(v); if (e) { err.textContent = e; return; } }
      if (!done) { done = true; resolve(v); }
      m.close();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    const m = modal({
      title,
      body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'hint' }, hint) : null), err),
      foot: [h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, L('Отмена')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish(input.value.trim()) }, ok)],
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    setTimeout(() => { input.focus(); const dot = value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 40);
  });
}

function confirmDialog({ title, text, warn, ok = L('Подтвердить'), danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } m.close(); };
    const okBtn = h('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), type: 'button', onclick: () => finish(true) }, ok);
    const m = modal({
      title,
      body: h('div', { class: 'form' },
        text ? h('div', { class: 'ink2' }, text) : null,
        warn ? h('div', { class: 'alert warn' }, icon('warn'), h('div', null, warn)) : null),
      foot: [h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, L('Отмена')), okBtn],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
    setTimeout(() => okBtn.focus(), 40);
  });
}

let openMenu = null;
function popMenu(anchor, items) {
  if (openMenu) openMenu();
  const m = h('div', { class: 'menu', role: 'menu' },
    items.map((it) => (it === '-' ? h('hr') : h('button', {
      type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
      onclick: () => { close(); it.run(); },
    }, it.label))));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
  m.style.top = (r.bottom + 4 + mh > window.innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
  const onDoc = (e) => { if (!m.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    m.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey);
    openMenu = null;
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
  });
  openMenu = close;
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast(L('Скопировано')), () => toast(L('Не удалось скопировать'), 'bad'));
}

let bannerShown = false;
function showRestartBanner() {
  if (bannerShown) return;
  bannerShown = true;
  const b = h('div', { class: 'banner' }, L('Панель была перезапущена — страницу нужно обновить.'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => location.reload() }, L('Обновить')));
  $('#main').prepend(b);
}

/* ---------- общие элементы ---------- */
const STATUS_TEXT = { online: L('онлайн'), connecting: L('подключение…'), offline: L('нет связи'), off: L('мониторинг выключен') };

// Состояние сервера одним словом и его причины: связь, активные оповещения, службы с ошибкой.
// level: ok | warn | down | wait (подключение) | off (мониторинг выключен)
const LEVEL_RANK = { down: 0, warn: 1, wait: 2, ok: 3, off: 4 };
const LEVEL_TEXT = { ok: L('в норме'), warn: L('внимание'), down: L('нет связи'), wait: L('подключение'), off: L('выключен') };
const LEVEL_ICON = { ok: 'ok', warn: 'warn', down: 'cross', wait: 'clock', off: 'pause' };
function srvState(s) {
  if (s.status === 'off') return { level: 'off', why: [], since: 0 };
  if (s.status !== 'online' && s.status !== 'offline') return { level: 'wait', why: [], since: 0 };
  const fires = S.firing.filter((f) => f.server === s.id);
  if (s.status === 'offline') {
    const f = fires.find((x) => x.kind === 'offline');
    return { level: 'down', why: [s.error || L('нет связи')], since: (f && f.since) || s.since || 0 };
  }
  const why = fires.map((f) => f.text);
  for (const u of s.units || []) {
    if (unitBad(u) && !fires.some((f) => f.subject === u.unit)) why.push(L('служба {0}: ошибка', u.unit.replace(/\.service$/, '')));
  }
  return { level: why.length ? 'warn' : 'ok', why, since: fires.length ? Math.min(...fires.map((f) => f.since)) : 0 };
}
// «13 ч», «3 д» — сколько длится состояние
function sinceShort(ms) {
  if (!ms) return '';
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 90) return L('только что');
  if (sec < 5400) return L('{0}{1}мин', Math.round(sec / 60), NB);
  if (sec < 172800) return L('{0}{1}ч', Math.round(sec / 3600), NB);
  return L('{0}{1}д', Math.round(sec / 86400), NB);
}
function sortIcon(asc) {
  const i = icon(asc ? 'up' : 'down');
  i.classList.add('arrow');
  return i;
}
function levelBadge(st) {
  const sm = sinceShort(st.since);
  return h('span', { class: 'lvl lvl-' + st.level }, icon(LEVEL_ICON[st.level]), h('span', { class: 'lvl-t' }, LEVEL_TEXT[st.level]),
    sm && st.level !== 'ok' ? h('small', null, sm) : null);
}

function statusChip(srv) {
  return h('span', { class: 'st' }, h('span', { class: 'dot ' + srv.status }), STATUS_TEXT[srv.status] || srv.status);
}

function meter(pct) {
  const i = h('i');
  const el = h('div', { class: 'meter' }, i);
  const set = (p) => {
    p = Math.max(0, Math.min(100, p || 0));
    i.style.width = p + '%';
    el.classList.toggle('warn', p >= 75 && p < 90);
    el.classList.toggle('crit', p >= 90);
  };
  set(pct);
  return { el, set };
}

function seg(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'group' });
  const btns = options.map(([v, label]) => {
    const b = h('button', { type: 'button', class: v === value ? 'on' : '', 'aria-pressed': String(v === value), onclick: () => { set(v); onChange(v); } }, label);
    el.append(b);
    return [v, b];
  });
  function set(v) {
    for (const [bv, b] of btns) { b.classList.toggle('on', bv === v); b.setAttribute('aria-pressed', String(bv === v)); }
  }
  return { el, set, btns };
}

function rootFS(m) {
  if (!m || !m.fs || !m.fs.length) return null;
  return m.fs.find((f) => f.mount === '/') || m.fs[0];
}

// разделы с данными — без загрузочных /boot и /boot/efi; корень первым
function dataFS(m) {
  const all = (m && m.fs) || [];
  const list = all.filter((f) => !/^\/boot(\/|$)|^\/efi$/.test(f.mount));
  return (list.length ? list : all).slice().sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

// самый заполненный раздел — по нему судят, не пора ли чистить диск
function fullestFS(m) {
  return dataFS(m).reduce((a, f) => (!a || f.pct > a.pct ? f : a), null);
}

function memPct(m) { return m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0; }

/* ---------- состояние ---------- */
const S = {
  servers: [],
  by: new Map(),
  interval: 2000,
  page: null,
  cmdRuns: [],
  cmdHist: [],
  firing: [],
  seenEvents: new Set(),
  setup: null,
  notes: [],
  scenarios: [],
  scnRuns: [],
  avail: { start: 0, slot: 1800, rows: {} },
};

function ingestServers(list) {
  const old = S.by;
  S.servers = list;
  S.by = new Map();
  for (const s of list) {
    const prev = old.get(s.id);
    s.spark = s.spark && s.spark.length ? s.spark : (prev ? prev.spark : []);
    if (!s.latest && prev && prev.latest && s.status === 'online') s.latest = prev.latest;
    S.by.set(s.id, s);
  }
}

/* ---------- поток событий ---------- */
let es = null;
function connect() {
  es = new EventSource('/api/stream?token=' + encodeURIComponent(TOKEN));
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    S.interval = d.interval || 2000;
    ingestServers(d.servers);
    S.firing = d.firing || [];
    S.setup = d.setup || null;
    S.notes = d.notes || [];
    S.scenarios = d.scenarios || [];
    if (d.avail) S.avail = d.avail;
    if (d.lang && d.lang !== I18N.lang) syncLang(I18N.lang);
    updateAlertBadge();
    setConn(true);
    renderSidebar();
    route(true);
  });
  es.addEventListener('servers', (e) => {
    ingestServers(JSON.parse(e.data));
    renderSidebar();
    route(true);
    refreshSetup();
  });
  es.addEventListener('notes', (e) => setNotes(JSON.parse(e.data)));
  es.addEventListener('scenarios', (e) => setScenarios(JSON.parse(e.data)));
  es.addEventListener('checks', (e) => {
    const d = JSON.parse(e.data);
    if (S.page && S.page.onChecks) S.page.onChecks(d);
  });
  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    const s = S.by.get(d.id);
    if (!s) return;
    s.status = d.status;
    s.error = d.error;
    s.since = d.since;
    if (d.info) s.info = d.info;
    if (d.status !== 'online') s.latest = s.latest && d.status === 'connecting' ? s.latest : null;
    updateSideRow(s);
    if (S.page && S.page.onStatus) S.page.onStatus(s);
  });
  es.addEventListener('frame', (e) => {
    const d = JSON.parse(e.data);
    const s = S.by.get(d.id);
    if (!s) return;
    s.latest = d.m;
    s.spark.push(d.p);
    if (s.spark.length > SPARK_N) s.spark.splice(0, s.spark.length - SPARK_N);
    updateSideRow(s);
    if (S.page && S.page.onFrame) S.page.onFrame(s, d.p, d.m);
  });
  es.addEventListener('units', (e) => {
    const d = JSON.parse(e.data);
    const s = S.by.get(d.id);
    if (!s) return;
    s.units = d.units;
    if (S.page && S.page.onUnits) S.page.onUnits(s);
  });
  es.addEventListener('avail', (e) => {
    S.avail = JSON.parse(e.data);
    if (S.page && S.page.onAvail) S.page.onAvail();
  });
  es.addEventListener('alerts', (e) => {
    const d = JSON.parse(e.data);
    S.firing = d.firing || [];
    updateAlertBadge();
    for (const x of S.servers) updateSideRow(x);
    const ev = d.event;
    if (ev && ev.state === 'fire' && !S.seenEvents.has(ev.id)) {
      S.seenEvents.add(ev.id);
      toast(`${ev.name}: ${ev.text}`, 'bad');
    }
    if (S.page && S.page.onAlerts) S.page.onAlerts(d);
  });
  es.onopen = () => setConn(true);
  es.onerror = () => {
    setConn(false);
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      api('/ping').then(() => setTimeout(connect, 2000), () => setTimeout(connect, 5000));
    }
  };
}

function setConn(ok) {
  const c = $('#conn');
  c.className = 'conn ' + (ok ? 'ok' : 'bad');
  c.title = ok ? L('Связь с панелью есть') : L('Нет связи с панелью');
}

/* ---------- боковая панель ---------- */
const sideRows = new Map();

function renderSidebar() {
  const list = $('#srv-list');
  list.replaceChildren();
  sideRows.clear();
  const visible = S.servers.filter((s) => !s.hidden);
  const groups = groupServers(visible);
  const titled = groups.some(([g]) => g);
  const flt = $('#srv-filter');
  flt.hidden = visible.length <= 12;
  const q = flt.hidden ? '' : flt.value.trim().toLowerCase();
  for (const [g, all] of groups) {
    const items = q ? all.filter((x) => x.name.toLowerCase().includes(q)) : all;
    if (!items.length) continue;
    if (titled) list.append(h('div', { class: 'srv-group' }, g || L('Без группы')));
    for (const s of items) renderSideRow(list, s);
  }
  if (!visible.length) list.append(h('div', { class: 'muted', style: { padding: '8px 10px', fontSize: '13px' } }, L('Серверов пока нет')));
  const online = S.servers.filter((s) => s.status === 'online').length;
  $('#fleet-count').textContent = `${online}/${visible.length}`;
  highlightSidebar();
}

function renderSideRow(list, s) {
  const dot = h('span', { class: 'dot ' + s.status });
  const name = h('span', { class: 'srv-name' }, s.name);
  const val = h('span', { class: 'srv-val' });
  const row = h('a', { class: 'srv', href: '#/s/' + encodeURIComponent(s.id) }, dot, name, val);
  list.append(row);
  sideRows.set(s.id, { row, dot, val });
  updateSideRow(s);
}

function updateSideRow(s) {
  const r = sideRows.get(s.id);
  if (!r) return;
  const st = srvState(s);
  r.dot.className = 'dot ' + (st.level === 'warn' ? 'warn' : s.status);
  r.row.classList.toggle('dim', s.status === 'off');
  const online = s.status === 'online' && s.latest;
  r.val.textContent = online ? Fmt.pct0(s.latest.cpu) : s.status === 'off' ? L('выкл.') : s.status === 'connecting' ? '…' : L('нет связи');
  r.row.title = [s.name, LEVEL_TEXT[st.level], ...st.why].join('\n');
  const visible = S.servers.filter((x) => !x.hidden);
  $('#fleet-count').textContent = `${visible.filter((x) => x.status === 'online').length}/${visible.length}`;
}

function updateAlertBadge() {
  const b = $('#alerts-count');
  const n = S.firing.length;
  b.hidden = !n;
  b.textContent = n ? String(n) : '';
  b.title = n ? S.firing.map((f) => `${f.name}: ${f.text}`).join('\n') : '';
  const cf = S.firing.filter((f) => f.server.startsWith('check:'));
  const cb = $('#checks-count');
  cb.hidden = !cf.length;
  cb.textContent = cf.length ? String(cf.length) : '';
  cb.title = cf.map((f) => `${f.name}: ${f.text}`).join('\n');
}

function highlightSidebar() {
  const r = parseRoute();
  for (const a of document.querySelectorAll('.side-nav .nav-item')) a.classList.toggle('active', a.id === 'nav-' + r.view);
  // на узком экране разделы — строка с прокруткой: выбранный должен быть виден
  const nav = $('.side-nav'), act = nav && nav.querySelector('.nav-item.active');
  if (act && nav.scrollWidth > nav.clientWidth) {
    const nr = nav.getBoundingClientRect(), ar = act.getBoundingClientRect();
    if (ar.left < nr.left || ar.right > nr.right) nav.scrollLeft += ar.left - nr.left - 16;
  }
  for (const [id, row] of sideRows) row.row.classList.toggle('active', r.view === 'server' && r.id === id);
  // «Сервер» — главное действие только там, где работают со списком серверов
  const add = $('#btn-add');
  if (add) add.classList.toggle('primary', r.view === 'fleet' || r.view === 'manage');
}

/* ---------- маршруты ---------- */
function parseRoute() {
  const m = location.hash.match(/^#\/s\/([^/]+)(?:\/([a-z]+))?/);
  if (m) return { view: 'server', id: decodeURIComponent(m[1]), tab: m[2] || 'overview' };
  const v = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
  if (v === 'scenarios') return { view: 'commands' };
  if (v && PAGES[v]) return { view: v };
  return { view: 'fleet' };
}

function route(dataChanged) {
  const r = parseRoute();
  const main = $('#main');
  const p = S.page;
  if (!dataChanged) stripTip.hide(); // подсказка полоски не должна пережить переход
  if (r.view === 'server' && !S.by.has(r.id)) {
    if (S.servers.length) { location.hash = '#/'; return; }
  }
  if (p && r.view === 'server' && p.kind === 'server' && p.id === r.id) {
    if (dataChanged) p.refreshHead();
    p.setTab(r.tab);
  } else if (p && r.view !== 'server' && p.kind === r.view) {
    if (dataChanged && p.onData) p.onData();
  } else {
    if (p && p.destroy) p.destroy();
    S.page = r.view === 'server' ? new ServerPage(r.id, r.tab) : new (PAGES[r.view] || FleetPage)();
    main.replaceChildren(S.page.el);
    $('#scroll').scrollTop = 0;
  }
  highlightSidebar();
}

/* ---------- главный экран: табло ---------- */
const AVAIL_TEXT = { 0: L('нет данных'), 1: L('в норме'), 2: L('внимание'), 3: L('нет связи') };
// [ключ, подпись, числовая, короткая подпись для телефона]
const FLEET_COLS = [
  ['state', L('Состояние')], ['name', L('Сервер')], ['avail', L('Доступность за сутки')],
  ['cpu', L('Процессор'), 1, L('ЦП')], ['mem', L('Память'), 1, L('ОЗУ')], ['disk', L('Диск'), 1], ['net', L('Сеть'), 1], ['uptime', L('Работает'), 1],
];
// Узкий экран теряет колонки целиком. Решает JS, а не display: none в CSS:
// при table-layout: fixed скрытая ячейка оставляет пустую колонку, которая
// отнимает место у имени.
// Пороги подобраны так, чтобы имени сервера оставалось не меньше ~180 px.
const FLEET_DROP = [['net', '(max-width: 1360px)'], ['uptime', '(max-width: 1180px)'], ['avail', '(max-width: 1100px)']];
const PHONE = '(max-width: 700px)';

// Полоска доступности: 48 получасовых делений, новые справа. Один элемент с
// градиентом вместо 48 узлов на строку — табло с сотнями серверов
// перерисовывается без задержки. Подсказку по делению рисует stripTip.
const AVAIL_FILL = { 0: 'var(--slot-nd)', 1: 'var(--slot)', 2: 'var(--warning)', 3: 'var(--critical)' };
// процент — доля времени на связи; предупреждения видны цветом делений
function availStats(id) {
  const row = (S.avail.rows || {})[id] || '';
  let known = 0, up = 0;
  for (const c of row) if (c !== '0') { known++; if (c !== '3') up++; }
  return { row, known, pct: known ? up / known * 100 : -1 };
}
function availPct(v) { return v >= 99.95 ? '100' + NB + '%' : Fmt.pct(Math.min(v, 99.9)); }
function availStrip(id, compact) {
  const { row, known, pct } = availStats(id);
  const w = compact ? 1.5 : 2.5, step = w + 1;
  const el = h('span', { class: 'strip' + (compact ? ' compact' : ''), role: 'img' });
  if (!row) { el.classList.add('none'); el.setAttribute('aria-label', L('Данных о доступности пока нет')); return el; }
  const stops = [];
  for (let i = 0; i < row.length; i++) {
    const x = i * step;
    stops.push(`${AVAIL_FILL[row[i]] || AVAIL_FILL[0]} ${x}px ${x + w}px`, `transparent ${x + w}px ${x + step}px`);
  }
  el.style.width = row.length * step - 1 + 'px';
  el.style.backgroundImage = `linear-gradient(90deg, ${stops.join(', ')})`;
  el.dataset.id = id;
  el.dataset.step = String(step);
  el.setAttribute('aria-label', known ? L('За сутки на связи {0} времени наблюдения', availPct(pct)) : L('Данных о доступности пока нет'));
  return el;
}

// подсказка «14:00–14:30 · в норме» над делением под курсором или пальцем
const stripTip = (() => {
  let tip = null, cur = null;
  const hide = () => { if (cur) cur.classList.remove('hov'); cur = null; if (tip) tip.hidden = true; };
  // строку перерисовали — полоски под курсором больше нет в документе
  setInterval(() => { if (cur && !cur.isConnected) hide(); }, 500);
  const show = (e) => {
    const el = e.target.closest && e.target.closest('.strip[data-id]');
    if (!el) { hide(); return; }
    const row = (S.avail.rows || {})[el.dataset.id] || '';
    const step = +el.dataset.step || 3.5, r = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(row.length - 1, Math.floor((e.clientX - r.left) / step)));
    if (!row) { hide(); return; }
    const slot = (S.avail.slot || 1800) * 1000, end = (S.avail.start || 0) * 1000 + slot, t0 = end - (row.length - i) * slot;
    const hm = (ms) => new Date(ms).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
    if (!tip) { tip = h('div', { class: 'strip-tip', role: 'tooltip' }); document.body.append(tip); }
    if (cur && cur !== el) cur.classList.remove('hov');
    cur = el;
    el.classList.add('hov');
    el.style.setProperty('--hx', i * step + 'px');
    tip.textContent = `${hm(t0)}–${hm(t0 + slot)} · ${AVAIL_TEXT[row[i]] || AVAIL_TEXT[0]}`;
    tip.hidden = false;
    const x = r.left + i * step, tw = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(x - tw / 2, window.innerWidth - tw - 8)) + 'px';
    tip.style.top = r.top - tip.offsetHeight - 6 + 'px';
  };
  document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') show(e); });
  document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') show(e); });
  document.addEventListener('scroll', hide, true);
  return { hide };
})();

class FleetPage {
  constructor() {
    this.kind = 'fleet';
    this.el = h('div', { class: 'page fleet-page' });
    this.rows = new Map();
    this.flt = store.get('fleetFilter', 'all');
    this.grp = store.get('fleetGroup', '');
    this.sort = store.get('fleetSort', { key: 'state', dir: 1 });
    this.closed = new Set(store.get('fleetClosed', []));
    this.q = '';
    this.sumEl = h('p', { class: 'fleet-sum', 'aria-live': 'polite' });
    this.toolsEl = h('div', { class: 'fleet-tools' });
    this.bodyEl = h('div');
    this.el.append(
      h('div', { class: 'page-head' }, h('div', { class: 'head-main' }, h('h1', null, L('Все серверы')), this.sumEl), this.toolsEl),
      this.bodyEl);
    this.tick = setInterval(() => this.render(), 60e3); // «13 ч» и полоска стареют сами
    this.mq = [...FLEET_DROP.map(([, q]) => q), PHONE].map((q) => { const m = matchMedia(q), f = () => this.render(); m.addEventListener('change', f); return [m, f]; });
    this.render();
  }

  cols() { return FLEET_COLS.filter(([k]) => !FLEET_DROP.some(([c, q]) => c === k && matchMedia(q).matches)); }

  onData() { this.render(); }
  onNotes() { this.render(); }
  onSetup() { if (!S.servers.some((s) => !s.hidden) || this.onboarding) this.render(); }
  onUnits() { this.renderSoon(); }
  onStatus() { this.renderSoon(); }
  onAlerts() { this.renderSoon(); }
  onAvail() { this.renderSoon(); }
  onFrame(srv) { this.updateRow(srv); this.sumSoon(); }
  destroy() { clearInterval(this.tick); clearTimeout(this.rT); clearTimeout(this.sT); for (const [m, f] of this.mq) m.removeEventListener('change', f); }

  renderSoon() { if (!this.rT) this.rT = setTimeout(() => { this.rT = 0; this.render(); }, 150); }
  sumSoon() { if (!this.sT) this.sT = setTimeout(() => { this.sT = 0; this.updateSum(); }, 1000); }

  visible() { return S.servers.filter((s) => !s.hidden); }

  metric(s, key) {
    const m = s.status === 'online' && s.latest;
    if (!m) return -1;
    if (key === 'cpu') return m.cpu;
    if (key === 'mem') return memPct(m);
    if (key === 'disk') { const f = dataFS(m).length > 1 ? fullestFS(m) : rootFS(m); return f ? f.pct : -1; }
    if (key === 'net') return m.netRx + m.netTx;
    if (key === 'uptime') return m.uptime || 0;
    if (key === 'avail') return availStats(s.id).pct;
    return 0;
  }

  sorted(list) {
    const { key, dir } = this.sort;
    const byName = (a, b) => a.name.localeCompare(b.name, I18N.locale, { numeric: true });
    return list.slice().sort((a, b) => {
      if (key === 'state') return (LEVEL_RANK[a._st.level] - LEVEL_RANK[b._st.level]) * dir || byName(a, b);
      if (key === 'name') return byName(a, b) * dir;
      // числовые колонки: по умолчанию большие значения наверху; серверы без данных — в конце
      const x = this.metric(a, key), y = this.metric(b, key);
      if ((x < 0) !== (y < 0)) return x < 0 ? 1 : -1;
      if (key === 'avail') return (x - y) * dir || byName(a, b); // по умолчанию сверху худшие
      return (y - x) * dir || byName(a, b);
    });
  }

  setSort(key) {
    this.sort = this.sort.key === key ? { key, dir: -this.sort.dir } : { key, dir: 1 };
    store.set('fleetSort', this.sort);
    this.render();
  }

  render() {
    const vis = this.visible();
    const hidden = S.servers.filter((s) => s.hidden);
    for (const s of vis) s._st = srvState(s);
    this.onboarding = !vis.length;
    this.renderTools(vis);
    this.updateSum();
    this.rows.clear();
    if (!vis.length) { this.bodyEl.replaceChildren(onboardingCard(), this.hiddenBlock(hidden)); return; }

    const q = this.q.trim().toLowerCase();
    let list = vis;
    if (this.flt === 'bad') list = list.filter((s) => s._st.level === 'down' || s._st.level === 'warn');
    else if (this.flt === 'down') list = list.filter((s) => s._st.level === 'down');
    if (this.grp) list = list.filter((s) => (s.group || '') === (this.grp === '\u0000' ? '' : this.grp));
    if (q) list = list.filter((s) => [s.name, s.host, s.group, s.info && s.info.os].some((v) => v && String(v).toLowerCase().includes(q)));
    if (!list.length) {
      this.bodyEl.replaceChildren(h('div', { class: 'card empty' }, h('b', null, L('Под этот фильтр ничего не подошло')),
        h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn', type: 'button', onclick: () => this.resetFilters() }, L('Сбросить фильтр')))),
      this.hiddenBlock(hidden));
      return;
    }

    const tbody = h('tbody');
    const cols = this.cols();
    this.shown = new Set(cols.map(([k]) => k));
    const groups = groupServers(list);
    const titled = groups.some(([g]) => g);
    const section = (key, title, note, items) => {
      const open = !this.closed.has(key);
      const btn = h('button', { class: 'grp-btn', type: 'button', 'aria-expanded': String(open), onclick: () => {
        if (this.closed.has(key)) this.closed.delete(key); else this.closed.add(key);
        store.set('fleetClosed', [...this.closed]); this.render();
      } }, icon('chev'), h('span', null, title), h('i', null, note));
      tbody.append(h('tr', { class: 'grp' }, h('th', { colspan: String(cols.length), scope: 'rowgroup' }, btn)));
      if (open) for (const s of items) tbody.append(this.row(s));
    };
    const bySt = this.sort.key === 'state' && this.sort.dir === 1;
    const bad = bySt ? list.filter((s) => s._st.level === 'down' || s._st.level === 'warn') : [];
    if (bad.length) section('!', L('Требуют внимания'), String(bad.length), this.sorted(bad));
    for (const [g, all] of groups) {
      const items = this.sorted(bad.length ? all.filter((s) => !bad.includes(s)) : all);
      const okN = all.filter((s) => s._st.level === 'ok').length;
      const note = okN === all.length ? L('{0} · все в норме', all.length) : L('в норме {0} из {1}', okN, all.length);
      if (titled || bad.length) { if (items.length || titled) section('g:' + g, g || (titled ? L('Без группы') : L('Остальные')), note, items); }
      else for (const s of items) tbody.append(this.row(s));
    }

    // dir 1 — порядок колонки по умолчанию: имя и состояние по возрастанию (А→Я,
    // сначала худшие), числа по убыванию (самые нагруженные наверху)
    const asc = (k) => ((k === 'name' || k === 'state') ? this.sort.dir === 1 : this.sort.dir === -1);
    const arrow = (k) => (this.sort.key === k ? sortIcon(asc(k)) : null);
    const head = h('tr', null, cols.map(([k, label, num, short]) => h('th', {
      class: 'c-' + k + (num ? ' num' : ''), scope: 'col',
      'aria-sort': this.sort.key === k ? (asc(k) ? 'ascending' : 'descending') : null,
    }, h('button', { class: 'th-btn', type: 'button', onclick: () => this.setSort(k), 'aria-label': label },
      short ? [h('span', { class: 'th-full' }, label), h('span', { class: 'th-short' }, short)] : label, arrow(k)))));
    const tbl = h('table', { class: 'board' + (this.shown.has('avail') ? '' : ' stacked') }, h('caption', { class: 'vh' }, L('Серверы: состояние, доступность за сутки и нагрузка')), h('thead', null, head), tbody);
    tbl.addEventListener('keydown', (e) => this.rowKeys(e));
    this.bodyEl.replaceChildren(h('div', { class: 'board-wrap' }, tbl), this.hiddenBlock(hidden));
  }

  row(s) {
    const st = s._st;
    const href = '#/s/' + encodeURIComponent(s.id);
    const info = s.info || {};
    const meta = [s.user ? `${s.user}@${s.host}` : s.host, info.os, info.cores ? `${info.cores}${NB}${Fmt.plural(info.cores, 'ядро', 'ядра', 'ядер')}` : null].filter(Boolean).join(' · ');
    const link = h('a', { class: 'bname', href, title: meta }, s.name);
    const nameCell = h('td', { class: 'c-name' }, h('span', { class: 'bname-row' }, link, noteBadge(s.id)));
    if (st.why.length) {
      nameCell.append(h('span', { class: 'bwhy', title: st.why.join('\n') },
        h('span', { class: 'bwhy-t' }, st.why[0], st.why.length > 1 ? h('i', null, L(' · ещё {0}', st.why.length - 1)) : null,
          // на телефоне колонка состояния — только значок, длительность переезжает сюда
          st.since ? h('i', { class: 'bwhy-since' }, ' · ' + sinceShort(st.since)) : null),
        st.level === 'down' ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => reconnect(s.id) }, icon('refresh'), L('Переподключить')) : null));
    } else if (st.level === 'off') {
      nameCell.append(h('span', { class: 'bwhy' }, h('span', { class: 'bwhy-t' }, L('Метрики не собираются')),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => patchServer(s.id, { monitor: true }) }, L('Включить мониторинг'))));
    }
    const ref = {
      cpu: h('td', { class: 'c-cpu num' }), mem: h('td', { class: 'c-mem num' }), disk: h('td', { class: 'c-disk num' }),
      net: h('td', { class: 'c-net num' }), up: h('td', { class: 'c-uptime num' }),
    };
    const av = availStats(s.id);
    if (!this.shown.has('avail')) {
      const phone = matchMedia(PHONE).matches;
      nameCell.append(h('span', { class: 'bmob' }, availStrip(s.id, phone), !phone && av.pct >= 0 ? h('span', { class: 'avail-pct' + (av.pct < 99 ? ' low' : '') }, availPct(av.pct)) : null));
    }
    const cells = {
      state: h('td', { class: 'c-state' }, levelBadge(st)), name: nameCell,
      avail: this.shown.has('avail') ? h('td', { class: 'c-avail' }, h('span', { class: 'avail' }, availStrip(s.id), av.pct >= 0 ? h('span', { class: 'avail-pct' + (av.pct < 99 ? ' low' : '') }, availPct(av.pct)) : null)) : null,
      cpu: ref.cpu, mem: ref.mem, disk: ref.disk, net: ref.net, uptime: ref.up,
    };
    const tr = h('tr', { class: 'brow lvl-row-' + st.level + (st.level === 'ok' ? ' calm' : '') }, FLEET_COLS.filter(([k]) => this.shown.has(k)).map(([k]) => cells[k]));
    tr.addEventListener('click', (e) => { if (!e.target.closest('a, button')) location.hash = href; });
    this.rows.set(s.id, ref);
    this.updateRow(s);
    return tr;
  }

  updateRow(s) {
    const ref = this.rows.get(s.id);
    if (!ref) return;
    const m = s.status === 'online' && s.latest;
    const pc = (td, v, warn, crit) => {
      if (v == null || v < 0) { td.textContent = '—'; td.className = td.className.replace(/ (warn|crit)\b/g, ''); return; }
      td.textContent = Fmt.pct0(v);
      td.classList.toggle('warn', v >= warn && v < crit);
      td.classList.toggle('crit', v >= crit);
    };
    if (!m) { for (const k of ['cpu', 'mem', 'disk', 'net', 'up']) ref[k].textContent = '—'; return; }
    pc(ref.cpu, m.cpu, 85, 95);
    pc(ref.mem, memPct(m), 85, 95);
    const parts = dataFS(m), fs = parts.length > 1 ? fullestFS(m) : rootFS(m);
    pc(ref.disk, fs ? fs.pct : null, 85, 95);
    ref.disk.title = parts.map((f) => L('{0}: {1} · {2} из {3}', f.mount, Fmt.pct0(f.pct), Fmt.bytes(f.used), Fmt.bytes(f.size))).join('\n');
    ref.net.replaceChildren(h('span', null, '↓' + NB + Fmt.bits(m.netRx * 8)), h('span', null, '↑' + NB + Fmt.bits(m.netTx * 8)));
    ref.up.textContent = Fmt.dur(m.uptime);
  }

  // стрелки вверх и вниз ходят по строкам, не трогая остальную страницу
  rowKeys(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const links = [...this.bodyEl.querySelectorAll('a.bname')];
    const i = links.indexOf(document.activeElement);
    if (i < 0) return;
    const next = links[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  }

  renderTools(vis) {
    const n = (f) => vis.filter(f).length;
    const chips = [['all', L('Все'), vis.length], ['bad', L('С проблемами'), n((s) => s._st.level === 'down' || s._st.level === 'warn')], ['down', L('Нет связи'), n((s) => s._st.level === 'down')]];
    const groups = serverGroups();
    const sig = JSON.stringify([chips, groups, this.flt, this.grp]);
    if (sig === this.toolsSig) return; // не пересоздаём поле фильтра, пока в нём печатают
    this.toolsSig = sig;
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': L('Показать') }, chips.map(([k, label, c]) => h('button', {
      type: 'button', class: this.flt === k ? 'on' : '', 'aria-pressed': String(this.flt === k),
      onclick: () => { this.flt = k; store.set('fleetFilter', k); this.render(); },
    }, label, h('span', { class: 'muted' }, NB + c))));
    let sel = null;
    if (groups.length) {
      sel = h('select', { class: 'input', 'aria-label': L('Группа') }, h('option', { value: '' }, L('Все группы')),
        groups.map((g) => h('option', { value: g, selected: g === this.grp }, g)),
        vis.some((s) => !s.group) ? h('option', { value: '\u0000', selected: this.grp === '\u0000' }, L('Без группы')) : null);
      sel.addEventListener('change', () => { this.grp = sel.value; store.set('fleetGroup', this.grp); this.render(); });
    }
    const q = h('input', { class: 'input fleet-q', type: 'search', placeholder: L('Фильтр: имя, адрес, группа'), 'aria-label': L('Фильтр серверов'), value: this.q, autocomplete: 'off', spellcheck: 'false' });
    q.addEventListener('input', () => { this.q = q.value; this.renderSoon(); });
    this.qEl = q;
    this.toolsEl.replaceChildren(seg, sel || '', vis.length > 6 ? q : '');
  }

  resetFilters() {
    this.flt = 'all'; this.grp = ''; this.q = '';
    store.set('fleetFilter', 'all'); store.set('fleetGroup', '');
    this.toolsSig = '';
    this.render();
  }

  updateSum() {
    const vis = this.visible();
    if (!vis.length) { this.sumEl.textContent = L('Мониторинг и управление по SSH — на серверы ничего не устанавливается'); return; }
    const on = vis.filter((s) => s.status === 'online');
    const bad = vis.filter((s) => { const l = srvState(s).level; return l === 'down' || l === 'warn'; }).length;
    const live = on.filter((s) => s.latest);
    const rx = live.reduce((a, x) => a + x.latest.netRx, 0), tx = live.reduce((a, x) => a + x.latest.netTx, 0);
    this.sumEl.replaceChildren(
      L('{0}{1}{2}, {3} на связи. ', vis.length, NB, Fmt.plural(vis.length, 'сервер', 'сервера', 'серверов'), on.length),
      bad ? h('b', { class: 'warn-ink' }, L('{0}{1}{2} внимания', bad, NB, Fmt.plural(bad, 'требует', 'требуют', 'требуют'))) : h('span', null, L('Всё в порядке')),
      live.length ? h('span', { class: 'muted fleet-net' }, L(' · трафик ↓{0}{1} ↑{2}{3}', NB, Fmt.bits(rx * 8), NB, Fmt.bits(tx * 8))) : '');
  }

  hiddenBlock(hidden) {
    if (!hidden.length) return '';
    return h('details', { class: 'fleet-hidden' },
      h('summary', null, L('Скрытые серверы ({0})', hidden.length)),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('tbody', null, hidden.map((x) => h('tr', null,
        h('td', null, h('b', null, x.name)), h('td', { class: 'muted' }, (x.user ? x.user + '@' : '') + x.host),
        h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => patchServer(x.id, { hidden: false, monitor: true }) }, L('Показать')))))))));
  }
}

/* ---------- оповещения ---------- */
const ALERT_KIND = { offline: L('связь'), cpu: L('процессор'), mem: L('память'), disk: L('диск'), failed: L('служба'), vpn: 'VPN', temp: L('перегрев'), check: L('проверка'), cert: L('сертификат') };

function sinceText(ms) {
  const sec = (Date.now() - ms) / 1000;
  return sec < 60 ? L('только что') : Fmt.dur(sec) + L(' назад');
}

class AlertsPage {
  constructor() {
    this.kind = 'alerts';
    this.el = h('div', { class: 'page' });
    this.cfg = null;
    this.events = [];
    this.notify = true;
    this.firingEl = h('div');
    this.eventsEl = h('tbody');
    this.muteEl = h('div', { class: 'mute-list' });
    this.wdEl = h('div', { class: 'wd-list' });
    this.formEl = h('div', null, h('div', { class: 'card empty' }, h('span', { class: 'spinner' }), L(' Загрузка…')));
    this.noteEl = h('div');
    this.el.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, L('Оповещения')),
          h('div', { class: 'head-meta' }, h('span', null, L('Панель проверяет серверы каждые 10 секунд и сообщает о проблемах, пока она запущена на этом компьютере'))))),
      this.noteEl,
      h('div', { class: 'section-title', style: { marginTop: '0' } }, L('Сейчас')),
      this.firingEl,
      this.formEl,
      h('div', { class: 'section-title' }, L('Журнал'),
        h('button', { class: 'btn ghost sm', type: 'button', style: { marginLeft: 'auto' }, onclick: () => this.clearEvents() }, L('Очистить'))),
      h('div', { class: 'card flush' }, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, L('Когда')), h('th', null, L('Сервер')), h('th', null, L('Событие')), h('th', null, L('Доставка')))),
        this.eventsEl))));
    this.renderFiring();
    this.load();
    this.tick = setInterval(() => this.renderFiring(), 30e3);
  }

  async load() {
    try {
      const d = await api('/alerts');
      this.cfg = d.config;
      this.events = d.events || [];
      this.notify = d.notify;
      S.firing = d.firing || [];
      updateAlertBadge();
    } catch (e) {
      this.formEl.replaceChildren(h('div', { class: 'alert bad' }, e.message));
      return;
    }
    this.noteEl.replaceChildren(this.notify ? '' : h('div', { class: 'alert warn', style: { marginBottom: '16px' } }, icon('warn'),
      h('div', null, L('Панель запущена с флагом -notify=false: оповещения записываются в журнал, но никуда не отправляются.'))));
    this.renderFiring();
    this.renderForm();
    this.renderEvents();
  }

  renderFiring() {
    const list = S.firing;
    if (!list.length) {
      this.firingEl.replaceChildren(h('div', { class: 'card ok-card' }, h('span', { class: 'dot online' }), L('Всё в порядке — активных оповещений нет')));
      return;
    }
    this.firingEl.replaceChildren(h('div', { class: 'card flush' }, h('div', { class: 'firing' }, list.map((f) => h('a', { class: 'fire-row', href: f.server.startsWith('check:') ? '#/checks' : '#/s/' + encodeURIComponent(f.server) },
      h('span', { class: 'dot offline' }),
      h('b', null, f.name),
      h('span', { class: 'fire-text' }, f.text),
      h('span', { class: 'badge' }, ALERT_KIND[f.kind] || f.kind),
      h('span', { class: 'muted fire-since', title: Fmt.dateTime(f.since) }, sinceText(f.since)))))));
  }

  renderEvents() {
    if (!this.events.length) {
      this.eventsEl.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'muted', style: { textAlign: 'center', padding: '18px' } }, L('Событий пока не было'))));
      return;
    }
    this.eventsEl.replaceChildren(...this.events.map((e) => h('tr', null,
      h('td', { class: 'nowrap muted' }, Fmt.dateTime(e.t, false)),
      h('td', { class: 'nowrap' }, e.name || '—'),
      h('td', null, h('span', { class: 'ev' }, h('span', { class: 'dot ' + (e.state === 'ok' ? 'online' : 'offline') }), e.text)),
      h('td', { class: e.err ? 'bad-ink' : 'muted' }, e.err || e.sent || (e.state === 'test' ? '' : L('отправляется…'))))));
  }

  onAlerts(d) {
    this.renderFiring();
    if (d.event) {
      const i = this.events.findIndex((x) => x.id === d.event.id);
      if (i >= 0) this.events[i] = d.event; else this.events.unshift(d.event);
      this.renderEvents();
    }
  }

  onData() {
    this.renderMute();
    // сервер появился, пропал или сменил связь — строки сторожа запрашиваются заново
    if (this.wdKey != null && this.wdKey !== this.wdSig()) this.renderWatch();
  }

  wdSig() { return S.servers.filter((s) => !s.hidden).map((s) => `${s.id}:${s.status === 'online' ? 1 : 0}:${s.name}`).join(','); }

  renderMute() {
    const vis = S.servers.filter((s) => !s.hidden);
    if (!vis.length) {
      this.muteEl.replaceChildren(h('div', { class: 'muted', style: { fontSize: '13px' } }, L('Серверов пока нет')));
      return;
    }
    this.muteEl.replaceChildren(...vis.map((s) => {
      const on = !s.mute && s.monitor;
      const b = h('button', {
        type: 'button', class: 'pick' + (on ? ' on' : ''), 'aria-pressed': String(on), disabled: !s.monitor,
        title: s.monitor ? (on ? L('Нажмите, чтобы не присылать оповещения по этому серверу') : L('Нажмите, чтобы присылать оповещения')) : L('Мониторинг выключен — сервер не проверяется'),
      }, h('span', { class: 'pick-box' }, icon('check')), s.name);
      b.addEventListener('click', () => {
        const next = !b.classList.contains('on');
        b.classList.toggle('on', next);
        b.setAttribute('aria-pressed', String(next));
        patchServer(s.id, { mute: !next });
      });
      return b;
    }));
  }

  renderForm() {
    const c = JSON.parse(JSON.stringify(this.cfg));
    const R = c.rules, CH = c.channels;
    let tokenSet = !!c.tgTokenSet;
    const page = this;
    const fmtN = (x) => String(x).replace('.', ',');
    const TOKEN_SAVED = L('сохранён — вставьте новый, чтобы заменить');

    // ---- автосохранение: каждое изменение уходит на сервер само ----
    const saveState = h('span', { class: 'save-state', role: 'status', 'aria-live': 'polite' });
    const setState = (text, cls = '') => {
      saveState.className = 'save-state' + (cls ? ' ' + cls : '');
      saveState.replaceChildren(...(cls === 'ok' ? [icon('check')] : []), text);
    };
    setState(L('Изменения сохраняются сами'));
    const invalid = new Set();
    let timer = 0, saving = false, again = false;
    const later = (ms = 700) => { clearTimeout(timer); timer = setTimeout(save, ms); };
    const tgReady = () => !!((tokenSet || CH.tgToken) && CH.tgChat);

    async function save() {
      clearTimeout(timer);
      if (invalid.size) { setState(L('Не сохранено — исправьте поле, выделенное красным'), 'bad'); return; }
      if (saving) { again = true; return; }
      saving = true;
      setState(L('Сохраняю…'));
      const body = JSON.parse(JSON.stringify(c));
      // Telegram включится, когда будут и токен, и chat id; остальное сохраняем сразу
      if (CH.telegram && !tgReady()) body.channels.telegram = false;
      try {
        const r = await api('/alerts/config', { method: 'PUT', body });
        page.cfg = r.config;
        if (CH.tgToken) {
          tokenSet = true;
          CH.tgToken = '';
          tokenIn.value = '';
          tokenIn.placeholder = TOKEN_SAVED;
        }
        if (CH.telegram && !tgReady()) setState(L('Сохранено. Telegram заработает, когда будут токен и chat id'), 'warn');
        else setState(L('Сохранено'), 'ok');
        if (S.servers.some((s) => s.info && s.info.watchdog)) {
          clearTimeout(page.wdT);
          page.wdT = setTimeout(() => page.renderWatch(), 12e3);
        }
      } catch (e) {
        setState(L('Не сохранено: ') + e.message, 'bad');
      } finally {
        saving = false;
        syncTg();
        if (again) { again = false; save(); }
      }
    }

    // ---- поле-число с единицей измерения внутри ----
    const unitIn = (obj, key, { min, max, step = 1, unit, label, onCheck }) => {
      const i = h('input', { type: 'number', value: String(obj[key] ?? ''), min: String(min), max: String(max), step: String(step), inputmode: 'decimal', 'aria-label': label });
      const box = h('label', { class: 'unit-in' }, i, h('span', { 'aria-hidden': 'true' }, unit));
      const check = () => {
        const v = parseFloat(String(i.value).replace(',', '.'));
        const ok = Number.isFinite(v) && v >= min && v <= max;
        box.classList.toggle('invalid', !ok);
        box.dataset.err = ok ? '' : L('Нужно число от {0} до {1}', fmtN(min), fmtN(max));
        if (ok) { invalid.delete(i); obj[key] = v; } else invalid.add(i);
        if (onCheck) onCheck();
        return ok;
      };
      i.addEventListener('input', () => { if (check()) later(); else clearTimeout(timer); });
      i.addEventListener('change', () => { if (check()) save(); else setState(L('Не сохранено — исправьте поле, выделенное красным'), 'bad'); });
      return { box, input: i };
    };

    // ---- правила ----
    let uid = 0;
    const ruleRow = ({ r, key, title, pct, min, days, minLow = 0, text, hint }) => {
      const id = `ar-${key}-${++uid}`;
      const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id, checked: !!r[key] });
      const desc = h('div', { class: 'arule-desc' });
      let p = null, m = null;
      const sync = () => {
        const on = sw.checked;
        row.classList.toggle('off', !on);
        const bad = [p, m].find((x) => x && x.box.classList.contains('invalid'));
        desc.classList.toggle('bad-ink', !!bad);
        desc.textContent = bad ? bad.box.dataset.err : text(r);
      };
      if (pct) p = unitIn(r, 'pct', { min: 1, max: 100, unit: '%', label: L('{0}: порог в процентах', title), onCheck: () => sync() });
      if (days) p = unitIn(r, 'days', { min: 1, max: 365, unit: L('дн'), label: L('{0}: за сколько дней', title), onCheck: () => sync() });
      if (min) m = unitIn(r, 'min', { min: minLow, max: 1440, step: 0.5, unit: L('мин'), label: L('{0}: сколько минут', title), onCheck: () => sync() });
      const slot = (x, label) => h('div', { class: 'ap' + (x ? '' : ' ap-none') }, x ? [h('span', { class: 'ap-label' }, label), x.box] : null);
      const row = h('div', { class: 'arule' },
        sw,
        h('div', { class: 'arule-main', title: hint || null }, h('label', { class: 'arule-title', for: id }, title), desc),
        (pct || min || days) ? h('div', { class: 'arule-params' }, slot(p, L('порог')), slot(m, L('время'))) : null);
      sw.addEventListener('change', () => { r[key] = sw.checked; sync(); save(); });
      sync();
      return row;
    };
    const after = (n) => (n > 0 ? L('дольше {0} мин', fmtN(n)) : L('сразу'));
    if (!R.temp) R.temp = { on: true, min: 5 };
    if (!R.check) R.check = { on: true, min: 3 };
    if (!R.cert) R.cert = { on: true, days: 14 };

    const rules = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Когда сообщать')),
        h('div', { class: 'card-sub' }, L('Включите нужные проверки и задайте пороги')))),
      h('div', { class: 'arules' },
        h('div', { class: 'arule arule-head', 'aria-hidden': 'true' }, h('span'), h('span'), h('span', null, L('Порог')), h('span', null, L('Время'))),
        ruleRow({ r: R.offline, key: 'on', title: L('Сервер недоступен'), min: true,
          text: (x) => L('Нет связи с сервером {0}', after(x.min)) }),
        ruleRow({ r: R.cpu, key: 'on', title: L('Высокая нагрузка на процессор'), pct: true, min: true, minLow: 0.5,
          text: (x) => L('Загрузка выше {0} % в среднем за {1} мин', fmtN(x.pct), fmtN(x.min)) }),
        ruleRow({ r: R.mem, key: 'on', title: L('Заканчивается память'), pct: true, min: true, minLow: 0.5,
          text: (x) => L('Занято больше {0} % в среднем за {1} мин', fmtN(x.pct), fmtN(x.min)) }),
        ruleRow({ r: R.disk, key: 'on', title: L('Заканчивается место на диске'), pct: true,
          text: (x) => L('Любой раздел заполнен больше чем на {0} %', fmtN(x.pct)) }),
        ruleRow({ r: R.failed, key: 'on', title: L('Служба упала с ошибкой'),
          text: () => L('Служба systemd в состоянии failed дольше 50 секунд') }),
        ruleRow({ r: R.vpn, key: 'on', title: L('VPN перестал работать'), min: true,
          hint: L('xray, AmneziaWG, WireGuard, MTProto, sing-box, Hysteria и другие — если панель видела службу работающей, а потом она остановилась'),
          text: (x) => L('VPN-служба не работает {0}', after(x.min)) }),
        ruleRow({ r: R.temp, key: 'on', title: L('Перегрев'), min: true,
          hint: L('Порог — критическая температура из датчика, а если датчик её не сообщает: процессор и видеокарта 95 °C, SSD 80 °C, HDD 60 °C'),
          text: (x) => L('Процессор, видеокарта или диск горячее порога {0}', after(x.min)) }),
        ruleRow({ r: R.check, key: 'on', title: L('Сайт или порт не отвечает'), min: true,
          hint: L('Проверки со страницы «Сайты и порты» — панель выполняет их с этого компьютера раз в минуту'),
          text: (x) => L('Проверка со страницы «Сайты и порты» не проходит {0}', after(x.min)) }),
        ruleRow({ r: R.cert, key: 'on', title: L('Сертификат скоро истекает'), days: true,
          text: (x) => L('Осталось меньше {0} или сертификат не проходит проверку', plural(x.days, 'дня', 'дней', 'дней')) })),
      h('div', { class: 'arules arules-extra' },
        ruleRow({ r: R, key: 'recovery', title: L('Сообщать о восстановлении'),
          text: () => L('Отдельное сообщение, когда проблема прошла') })));

    // ---- каналы ----
    const tokenIn = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: tokenSet ? TOKEN_SAVED : '123456789:AA…', 'aria-label': L('Токен бота') });
    const chatIn = h('input', { class: 'input mono', value: CH.tgChat || '', autocomplete: 'off', spellcheck: 'false', placeholder: L('например 123456789'), 'aria-label': 'Chat id' });
    const tokenErr = h('span', { class: 'hint bad-ink', hidden: true });
    const chatErr = h('span', { class: 'hint bad-ink', hidden: true });
    const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, CHAT_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/;
    const fieldCheck = (input, errEl, re, msg) => {
      const v = input.value.trim();
      const ok = !v || re.test(v);
      input.classList.toggle('invalid', !ok);
      errEl.hidden = ok;
      errEl.textContent = ok ? '' : msg;
      if (ok) invalid.delete(input); else invalid.add(input);
      return ok;
    };
    tokenIn.addEventListener('input', () => { if (!tokenIn.value.trim()) fieldCheck(tokenIn, tokenErr, TOKEN_RE, ''); });
    tokenIn.addEventListener('change', () => {
      if (!fieldCheck(tokenIn, tokenErr, TOKEN_RE, L('Токен выглядит неверно: нужен вид 123456789:AA…'))) return;
      CH.tgToken = tokenIn.value.trim();
      if (CH.tgToken) save();
    });
    chatIn.addEventListener('input', () => { if (!chatIn.value.trim()) fieldCheck(chatIn, chatErr, CHAT_RE, ''); });
    chatIn.addEventListener('change', () => {
      if (!fieldCheck(chatIn, chatErr, CHAT_RE, L('Chat id — это число (123456789 или -100…) или @имя_канала'))) return;
      CH.tgChat = chatIn.value.trim();
      save();
    });
    const chatsEl = h('div', { class: 'chips', style: { margin: '2px 0 0' } });
    const findBtn = h('button', { class: 'btn', type: 'button', onclick: findChats }, L('Найти'));

    async function findChats() {
      chatsEl.replaceChildren(h('span', { class: 'muted' }, h('span', { class: 'spinner' }), NB + L('Ищу…')));
      try {
        const r = await api('/alerts/telegram-chats', { method: 'POST', body: { token: tokenIn.value.trim() } });
        const chats = r.chats || [];
        if (!chats.length) {
          chatsEl.replaceChildren(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, L('Сообщений боту не найдено — напишите ему и нажмите «Найти» ещё раз.')));
          return;
        }
        chatsEl.replaceChildren(...chats.map((ch) => h('button', {
          class: 'chip', type: 'button', title: ch.id,
          onclick: () => { chatIn.value = ch.id; fieldCheck(chatIn, chatErr, CHAT_RE, ''); CH.tgChat = ch.id; chatsEl.replaceChildren(); save(); },
        }, `${ch.title || ch.type} · ${ch.id}`)));
      } catch (e) {
        chatsEl.replaceChildren(h('span', { class: 'bad-ink', style: { fontSize: '12.5px' } }, e.message));
      }
    }

    async function test(channel) {
      try {
        await api('/alerts/test', { method: 'POST', body: { channel, token: tokenIn.value.trim(), chat: chatIn.value.trim() } });
        toast(channel === 'telegram' ? L('Проверочное сообщение отправлено в Telegram') : L('Проверочное уведомление отправлено'));
      } catch (e) { toast(L('Не удалось отправить'), 'bad', e.message); }
    }

    const step = (n, ...kids) => h('div', { class: 'tg-step' }, h('span', { class: 'tg-n', 'aria-hidden': 'true' }, String(n)), h('div', { class: 'field' }, ...kids));
    const tgSetup = h('div', { class: 'tg-setup' },
      step(1, h('span', null, L('Токен бота')), tokenIn,
        h('span', { class: 'hint' }, L('Создайте бота у @BotFather в Telegram и вставьте сюда его токен. Он хранится только на этом компьютере.')), tokenErr),
      step(2, h('span', null, L('Кому писать')), h('div', { class: 'inline' }, chatIn, findBtn),
        h('span', { class: 'hint' }, L('Напишите своему боту любое сообщение и нажмите «Найти». Для группы — добавьте бота в группу и напишите там.')), chatErr, chatsEl),
      step(3, h('span', null, L('Проверка')),
        h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: () => test('telegram') }, L('Отправить проверочное сообщение')))));

    const chanRow = ({ ico, key, title, desc, extra }) => {
      const id = `ch-${key}-${++uid}`;
      const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id, checked: !!CH[key] });
      sw.addEventListener('change', () => { CH[key] = sw.checked; syncTg(); save(); });
      return { sw, el: h('div', { class: 'chan' },
        h('span', { class: 'chan-ico', 'aria-hidden': 'true' }, icon(ico)),
        h('div', { class: 'arule-main' }, h('label', { class: 'arule-title', for: id }, title), desc),
        extra || h('span'),
        sw) };
    };
    const local = chanRow({ ico: 'bell', key: 'macos', title: L('Уведомления {0}', osName()),
      desc: h('div', { class: 'arule-desc' }, L('На этом компьютере')),
      extra: h('button', { class: 'btn ghost sm', type: 'button', onclick: () => test('macos') }, L('Проверить')) });
    const tgDesc = h('div', { class: 'arule-desc' });
    const tgTest = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => test('telegram') }, L('Проверить'));
    const tg = chanRow({ ico: 'send', key: 'telegram', title: 'Telegram', desc: tgDesc, extra: tgTest });
    function syncTg() {
      const ready = tgReady();
      tgDesc.textContent = ready ? L('Бот подключён · чат {0}', CH.tgChat) : L('Сообщения от вашего бота');
      tgTest.hidden = !ready;
      // настройка видна, пока Telegram включён и не готов, — или по кнопке «Настроить»
      tgSetup.hidden = !(CH.telegram && (!ready || tgOpen));
      tgEdit.hidden = !(CH.telegram && ready && !tgOpen);
      if (page.wdSync) page.wdSync();
    }
    let tgOpen = false;
    const tgEdit = h('button', { class: 'btn ghost sm tg-edit', type: 'button', onclick: () => { tgOpen = true; syncTg(); tokenIn.focus(); } }, L('Изменить бота или чат'));
    syncTg();

    const channels = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Куда присылать')))),
      h('div', { class: 'chans' }, local.el, tg.el, tgEdit, tgSetup));

    const servers = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Какие серверы проверять')),
        h('div', { class: 'card-sub' }, L('Оповещения приходят только по отмеченным')))),
      this.muteEl);
    this.renderMute();

    // ---- сторож на серверах ----
    const W = c.watch || (c.watch = {});
    if (W.restartVpn == null) W.restartVpn = true;
    const wdNote = h('div', { class: 'alert warn wd-note' }, icon('warn'),
      h('div', null, L('Сторож пишет в Telegram — сначала подключите его в карточке «Куда присылать».')));
    this.wdReady = () => !!CH.telegram && tgReady();
    this.wdSync = () => {
      wdNote.hidden = this.wdReady();
      for (const b of this.wdEl.querySelectorAll('[data-wd-install]')) b.disabled = !this.wdReady();
    };
    const wdRefresh = h('button', { class: 'btn ghost sm icon-only', type: 'button', title: L('Обновить состояние'), 'aria-label': L('Обновить состояние сторожей'), onclick: () => this.renderWatch() }, icon('refresh'));
    const watch = h('div', { class: 'card wd-card' },
      h('div', { class: 'card-head' },
        h('div', null, h('div', { class: 'card-title' }, L('Сторож на серверах')),
          h('div', { class: 'card-sub' }, L('Проверяет сервер сам, раз в минуту, и пишет в Telegram — даже когда этот компьютер выключен'))),
        h('div', { class: 'right' }, wdRefresh)),
      h('p', { class: 'wd-about' },
        L('Сторож — небольшой скрипт с таймером systemd на самом сервере. Он следит за тем, что включено в «Когда сообщать»: VPN-службы, службы с ошибкой, место на дисках, перегрев, — и сообщает о перезагрузке. '),
        L('Пока на сервере стоит сторож, панель не дублирует эти события в Telegram. Что сервер недоступен, по-прежнему сообщает панель: сам о себе сервер этого не скажет.')),
      wdNote,
      h('div', { class: 'arules arules-extra wd-opts' },
        ruleRow({ r: W, key: 'restartVpn', title: L('Перезапускать упавшие VPN-службы'),
          text: () => L('Если VPN-служба упала, сторож перезапустит её и напишет, помогло ли. Не чаще раза в 10 минут и не больше трёх раз в час') }),
        ruleRow({ r: W, key: 'restartOther', title: L('Перезапускать и другие упавшие службы'),
          text: () => L('Только постоянно работающие службы — разовые задачи (Type=oneshot) сторож не трогает') })),
      this.wdEl);
    this.wdSync();
    this.renderWatch();

    this.formEl.replaceChildren(
      h('div', { class: 'section-title' }, L('Настройки'), h('span', { class: 'grow' }), saveState),
      h('div', { class: 'alerts-grid' }, rules, h('div', { class: 'alerts-side' }, channels, servers)),
      watch);
  }

  // состояние сторожа на каждом сервере — у каждого свой запрос по SSH
  renderWatch() {
    clearTimeout(this.wdT);
    this.wdKey = this.wdSig();
    const vis = S.servers.filter((s) => !s.hidden);
    if (!vis.length) { this.wdEl.replaceChildren(h('div', { class: 'muted', style: { fontSize: '13px' } }, L('Серверов пока нет'))); return; }
    this.wdEl.replaceChildren(...vis.map((s) => this.wdRow(s)));
    if (this.wdSync) this.wdSync();
  }

  wdRow(s) {
    const id = s.id;
    const st = h('div', { class: 'wd-st' });
    const acts = h('div', { class: 'wd-acts' });
    const row = h('div', { class: 'wd-row' }, h('span', { class: 'dot ' + s.status }),
      h('div', { class: 'wd-main' }, h('div', { class: 'wd-name' }, s.name), st), acts);
    const ago = (sec) => (sec < 60 ? L('{0} с назад', Math.max(0, Math.round(sec))) : Fmt.dur(sec) + L(' назад'));
    const btn = (label, cls, fn, extra) => h('button', Object.assign({ class: 'btn sm ' + cls, type: 'button', onclick: fn }, extra || {}), label);
    const busy = (text) => { st.replaceChildren(h('span', { class: 'spinner' }), NB + text); acts.replaceChildren(); };
    const load = async () => {
      try { show(await api(`/servers/${encodeURIComponent(id)}/watchdog`)); } catch (e) { show({ error: e.message }); }
    };
    const act = async (action, okText) => {
      try {
        const d = await api(`/servers/${encodeURIComponent(id)}/watchdog`, { method: 'POST', body: { action } });
        if (okText) toast(okText);
        if (d && d.installed !== undefined) show(d); else load();
      } catch (e) {
        toast(e.message, 'bad');
        load();
      }
    };
    const install = async (again) => {
      const restart = W2();
      const ok = await confirmDialog({
        title: again ? L('Обновить сторожа на {0}?', s.name) : L('Поставить сторожа на {0}?', s.name),
        text: h('div', null,
          h('p', { style: { margin: '0 0 8px' } }, L('Панель запишет на сервер скрипт и настройки в /etc/server-panel-watchdog и таймер systemd server-panel-watchdog. Раз в минуту сторож проверяет сервер и пишет в Telegram ваш бот. '), restart),
          h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, L('Токен бота хранится на сервере в файле, который может прочитать только root.'))),
        ok: again ? L('Обновить') : L('Поставить'),
      });
      if (!ok) return;
      busy(again ? L('обновляю…') : L('ставлю…'));
      await act('install', again ? L('Сторож на {0} обновлён', s.name) : L('Сторож стоит на {0}: первая проверка — через 10 секунд', s.name));
      this.wdT = setTimeout(() => this.renderWatch(), 15e3);
    };
    const remove = async () => {
      const ok = await confirmDialog({
        title: L('Убрать сторожа с {0}?', s.name),
        text: L('Таймер, скрипт и настройки сторожа будут удалены с сервера. О событиях этого сервера в Telegram снова будет сообщать панель — пока она запущена.'),
        ok: L('Убрать'), danger: true,
      });
      if (!ok) return;
      busy(L('убираю…'));
      act('remove', L('Сторож убран с {0}', s.name));
    };
    const test = async () => { busy(L('отправляю…')); act('test', L('Проверочное сообщение отправлено')); };
    const W2 = () => {
      const w = (this.cfg && this.cfg.watch) || {};
      const vpn = w.restartVpn !== false, other = !!w.restartOther;
      if (vpn && other) return L('Упавшие службы он перезапускает сам.');
      if (vpn) return L('Упавшие VPN-службы он перезапускает сам.');
      if (other) return L('Упавшие службы, кроме VPN, он перезапускает сам.');
      return L('Сам он ничего не перезапускает — только сообщает.');
    };
    const show = (d) => {
      const lines = [];
      const a = [];
      if (d.offline) {
        lines.push(h('span', { class: 'muted' }, s.info && s.info.watchdog ? L('сторож стоит · нет связи с сервером') : L('нет связи с сервером')));
      } else if (d.error) {
        lines.push(h('span', { class: 'bad-ink' }, d.error));
        a.push(btn(L('Повторить'), 'ghost', load));
      } else if (d.foreign) {
        lines.push(h('span', { class: 'warn-ink' }, L('уже есть чужой {0} с тем же именем — панель его не трогает, сторож не ставится', d.foreign)));
      } else if (!d.installed) {
        if (!d.root) lines.push(h('span', { class: 'muted' }, L('нужен root или sudo без пароля')));
        else if (!d.systemd) lines.push(h('span', { class: 'muted' }, L('на сервере нет systemd')));
        else if (!d.curl) lines.push(h('span', { class: 'muted' }, L('на сервере нет curl — установите его (apt install curl)')));
        else {
          lines.push(h('span', { class: 'muted' }, L('не стоит')));
          a.push(btn(L('Поставить'), '', () => install(false), { 'data-wd-install': '1', disabled: !this.wdReady() }));
        }
      } else {
        const age = d.run && d.now ? d.now - d.run : null;
        if (!d.active) lines.push(h('span', { class: 'bad-ink' }, L('таймер выключен — сторож не запускается')));
        else if (age == null) lines.push(h('span', { class: 'muted' }, L('стоит · первая проверка вот-вот')));
        else if (age > 300) lines.push(h('span', { class: 'warn-ink' }, L('стоит · последняя проверка {0}', ago(age))));
        else lines.push(h('span', { class: 'good-ink' }, L('работает · проверка {0}', ago(age))));
        if (d.stale) lines.push(h('span', { class: 'muted' }, L('настройки на сервере старые')));
        if (d.err) lines.push(h('span', { class: 'bad-ink' }, L('не может написать в Telegram: {0}', d.err) + (d.queue ? L(' · ждут отправки: {0}', d.queue) : '')));
        if (d.firing && d.firing.length) lines.push(h('span', null, L('сейчас: ') + d.firing.join('; ')));
        if (d.stale) a.push(btn(L('Обновить'), 'primary', () => install(true), { 'data-wd-install': '1', disabled: !this.wdReady() }));
        a.push(btn(L('Проверить'), 'ghost', test, { title: L('Сторож пришлёт в Telegram проверочное сообщение') }));
        a.push(btn(L('Убрать'), 'ghost', remove));
      }
      st.replaceChildren(...lines.flatMap((x, i) => (i ? [h('span', { class: 'wd-sep', 'aria-hidden': 'true' }, ' · '), x] : [x])));
      acts.replaceChildren(...a);
    };
    if (s.status !== 'online') show({ offline: true });
    else { busy(L('проверяю…')); load(); }
    return row;
  }

  async clearEvents() {
    if (!this.events.length) return;
    const ok = await confirmDialog({ title: L('Очистить журнал оповещений?'), text: L('Активные оповещения останутся.'), ok: L('Очистить') });
    if (!ok) return;
    try { await api('/alerts/events', { method: 'DELETE' }); this.events = []; this.renderEvents(); } catch (e) { toast(e.message, 'bad'); }
  }

  destroy() { clearInterval(this.tick); clearTimeout(this.wdT); }
}

/* ---------- команды: разовые и сохранённые ---------- */
class CommandsPage {
  constructor() {
    this.kind = 'commands';
    this.el = h('div', { class: 'page' });
    this.sel = new Set(store.get('cmdSel', []));
    this.sudo = store.get('cmdSudo', false);
    this.hi = -1;
    this.q = '';
    this.libEl = h('div');
    this.pinEl = h('div', { class: 'chips cmd-pins' });
    this.pickEl = h('div', { class: 'pick' });
    this.runsEl = h('div', { class: 'runs' });
    this.input = h('textarea', { class: 'input cmd-in', rows: '2', placeholder: L('Команда или короткий скрипт, например: systemctl is-active xray'), 'aria-label': L('Команда'), spellcheck: 'false', autocomplete: 'off' });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.run(this.input.value); }
      else if (e.key === 'ArrowUp' && !this.input.value.includes('\n') && S.cmdHist.length) {
        e.preventDefault(); this.hi = this.hi < 0 ? S.cmdHist.length - 1 : Math.max(0, this.hi - 1); this.input.value = S.cmdHist[this.hi];
      } else if (e.key === 'ArrowDown' && this.hi >= 0) {
        e.preventDefault(); this.hi = this.hi + 1 >= S.cmdHist.length ? -1 : this.hi + 1; this.input.value = this.hi < 0 ? '' : S.cmdHist[this.hi];
      }
    });
    const sudoCb = h('input', { type: 'checkbox', checked: this.sudo });
    sudoCb.addEventListener('change', () => { this.sudo = sudoCb.checked; store.set('cmdSudo', this.sudo); });
    this.runBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => this.run(this.input.value) }, L('Выполнить'));
    this.newBtn = h('button', { class: 'btn', type: 'button', onclick: () => scenarioDialog() }, icon('plus'), L('Новая команда'));
    this.el.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, L('Команды')),
          h('div', { class: 'head-meta' }, h('span', null, L('Разовая команда или сохранённая — на одном или нескольких серверах сразу, по SSH. Терминал — на странице сервера.')))),
        h('div', { class: 'head-actions' }, this.newBtn)),
      h('h2', { class: 'section-title' }, L('Сохранённые команды')),
      this.libEl,
      h('h2', { class: 'section-title' }, L('Разовая команда')),
      h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Серверы'))),
          h('div', { class: 'vact' },
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => this.selectAll(true) }, L('Все на связи')),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => this.selectAll(false) }, L('Снять выбор')))),
        this.pickEl,
        this.pinEl,
        h('div', { class: 'cmd-row' }, this.input,
          h('div', { class: 'cmd-side' }, h('label', { class: 'check', title: L('Для серверов, где вы подключены не под root') }, sudoCb, L('через sudo')), this.runBtn,
            h('button', {
              class: 'btn ghost sm', type: 'button', title: L('Сохранить эту команду, чтобы запускать одним нажатием'),
              onclick: () => scenarioDialog({ script: this.input.value.trim() || S.cmdHist[S.cmdHist.length - 1] || '', sudo: this.sudo, pinned: true }),
            }, icon('star'), L('Сохранить')))),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, L('Enter — выполнить, Shift+Enter — новая строка, ↑ — предыдущие команды. Без интерактивного режима, до 120 секунд; для редакторов и top — вкладка «Терминал» на странице сервера.'))),
      this.runsEl);
    this.renderPick();
    this.renderLib();
    for (const r of [...S.scnRuns, ...S.cmdRuns]) this.runsEl.append(r.el);
  }

  onData() { this.renderPick(); }
  onStatus() { this.renderPick(); }
  onScenarios() { this.renderLib(); }

  picked() { return S.servers.filter((s) => this.sel.has(s.id)).map((s) => s.id); }

  renderLib() {
    const all = S.scenarios.slice().sort((a, b) => (!!b.pinned - !!a.pinned) || a.name.localeCompare(b.name, I18N.locale));
    // закреплённые и встроенные быстрые команды — кнопками над полем ввода
    this.pinEl.replaceChildren(
      ...all.filter((sc) => sc.pinned).map((sc) => h('button', { class: 'chip pinned', type: 'button', title: sc.script, onclick: () => runScenario(sc, this.picked()) }, icon('play'), sc.name)),
      ...QUICK.map((q) => h('button', { class: 'chip mono', type: 'button', onclick: () => this.run(q, true) }, q)));
    this.newBtn.hidden = !all.length; // пока библиотека пуста, кнопка есть в её карточке
    if (!all.length) {
      this.libEl.replaceChildren(h('div', { class: 'card empty', style: { marginBottom: '16px' } }, h('b', null, L('Сохранённых команд пока нет')),
        L('Сохраните то, что запускаете часто: перезапуск службы, проверку места, очистку журналов. Закреплённая команда станет кнопкой здесь, на странице каждого сервера и в палитре (') + MOD_KEY + 'K).',
        h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn', type: 'button', onclick: () => scenarioDialog() }, icon('plus'), L('Новая команда')))));
      return;
    }
    const q = this.q.trim().toLowerCase();
    const list = q ? all.filter((sc) => [sc.name, sc.desc, sc.script].some((v) => v && v.toLowerCase().includes(q))) : all;
    const row = (sc) => {
      const pin = h('button', { class: 'btn ghost sm icon-only pin-btn' + (sc.pinned ? ' on' : ''), type: 'button', 'aria-pressed': String(!!sc.pinned),
        'aria-label': (sc.pinned ? L('Открепить: ') : L('Закрепить: ')) + sc.name, title: sc.pinned ? L('Закреплена — открепить') : L('Закрепить: кнопка здесь, на странице сервера и в палитре'),
        onclick: () => saveScenarioPatch(sc, { pinned: !sc.pinned }) }, icon('star'));
      const more = h('button', { class: 'btn ghost sm icon-only', type: 'button', 'aria-label': L('Ещё: {0}', sc.name), title: L('Ещё') }, icon('dots'));
      more.addEventListener('click', () => popMenu(more, [
        { label: L('Изменить'), run: () => scenarioDialog(sc) },
        { label: L('Сделать копию'), run: () => scenarioDialog({ ...sc, id: undefined, name: sc.name + L(' (копия)') }) },
        { label: L('По расписанию…'), run: () => scheduleDialog({ kind: 'scenario', target: sc.id }) },
        '-',
        { label: L('Удалить'), danger: true, run: () => deleteScenario(sc) },
      ]));
      const where = sc.servers && sc.servers.length
        ? `${sc.servers.length}${NB}${Fmt.plural(sc.servers.length, 'сервер', 'сервера', 'серверов')}`
        : L('спросить при запуске');
      return h('tr', null,
        h('td', { class: 'c-pin' }, pin),
        h('td', { class: 'name-cell' }, h('b', null, sc.name), sc.sudo ? h('span', { class: 'tag' }, L('от root')) : null, sc.quick ? h('span', { class: 'tag' }, L('без подтверждения')) : null,
          sc.desc ? h('div', { class: 'desc' }, sc.desc) : null),
        h('td', { class: 'cmd', title: sc.script }, sc.script.split('\n')[0] + (sc.script.includes('\n') ? ' …' : '')),
        h('td', { class: 'muted nowrap', title: (sc.servers || []).map(srvName).join('\n') }, where),
        h('td', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => runScenario(sc) }, icon('play'), L('Запустить')), more));
    };
    const flt = all.length > 8 ? h('input', { class: 'input search', type: 'search', placeholder: L('Найти команду'), 'aria-label': L('Найти сохранённую команду'), value: this.q }) : null;
    if (flt) flt.addEventListener('input', () => { this.q = flt.value; this.renderLib(); const n = this.libEl.querySelector('input'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
    this.libEl.replaceChildren(
      flt ? h('div', { class: 'toolbar' }, flt, h('span', { class: 'count' }, L('{0} из {1}', list.length, all.length))) : '',
      h('div', { class: 'tbl-wrap', style: { marginBottom: '20px' } }, h('table', { class: 'tbl cmd-lib' },
        h('thead', null, h('tr', null, h('th', { class: 'c-pin' }, h('span', { class: 'vh' }, L('Закрепить'))), h('th', null, L('Название')), h('th', null, L('Команда')), h('th', null, L('Серверы')), h('th', null, h('span', { class: 'vh' }, L('Действия'))))),
        h('tbody', null, list.length ? list.map(row) : h('tr', null, h('td', { colspan: '5', class: 'muted' }, L('Ничего не нашлось')))))));
  }

  renderPick() {
    const vis = S.servers.filter((s) => !s.hidden);
    for (const id of [...this.sel]) if (!S.by.has(id)) this.sel.delete(id);
    this.pickEl.replaceChildren(...vis.map((s) => {
      const cb = h('input', { type: 'checkbox', checked: this.sel.has(s.id) });
      cb.addEventListener('change', () => { if (cb.checked) this.sel.add(s.id); else this.sel.delete(s.id); this.saveSel(); this.updBtn(); });
      return h('label', { class: 'check pick-item' + (s.status === 'offline' ? ' dim' : '') }, cb, h('span', { class: 'dot ' + s.status }), s.name);
    }));
    this.updBtn();
  }

  updBtn() {
    const n = this.sel.size;
    this.runBtn.textContent = n > 1 ? L('Выполнить на {0} {1}', n, Fmt.plural(n, 'сервере', 'серверах', 'серверах')) : L('Выполнить');
    this.runBtn.disabled = !n;
  }

  saveSel() { store.set('cmdSel', [...this.sel]); }

  selectAll(on) {
    this.sel = new Set(on ? S.servers.filter((s) => !s.hidden && s.status === 'online').map((s) => s.id) : []);
    this.saveSel();
    this.renderPick();
  }

  async run(cmd, quick) {
    cmd = cmd.trim();
    const ids = this.picked();
    if (!cmd) return;
    if (!ids.length) { toast(L('Выберите хотя бы один сервер'), 'bad'); return; }
    if (ids.length > 1 && !quick) {
      const ok = await confirmDialog({
        title: L('Выполнить на {0} {1}?', ids.length, Fmt.plural(ids.length, 'сервере', 'серверах', 'серверах')),
        text: h('div', null, h('pre', { class: 'pre', style: { margin: '0 0 10px' } }, cmd), L('Серверы: '), ids.map((i) => S.by.get(i).name).join(', ')),
        ok: L('Выполнить'),
      });
      if (!ok) return;
    }
    this.input.value = '';
    this.hi = -1;
    if (S.cmdHist[S.cmdHist.length - 1] !== cmd) S.cmdHist.push(cmd);
    if (S.cmdHist.length > 100) S.cmdHist.shift();
    const sudo = this.sudo;
    const r = runCard({
      title: h('pre', { class: 'run-cmd' }, (sudo ? '# ' : '$ ') + cmd),
      ids, body: { cmd, sudo },
      onRemove: (el) => { S.cmdRuns = S.cmdRuns.filter((x) => x.el !== el); },
    });
    S.cmdRuns.unshift(r);
    if (S.cmdRuns.length > 30) S.cmdRuns.pop().el.remove();
    this.runsEl.prepend(r.el);
    await r.done;
  }

  destroy() {}
}

const PAGES = { fleet: FleetPage, alerts: AlertsPage, checks: ChecksPage, commands: CommandsPage, schedule: SchedulePage, notes: NotesPage, manage: ManagePage };

/* ---------- страница сервера ---------- */
const TAB_DEFS = [
  ['overview', L('Обзор')],
  ['procs', L('Процессы')],
  ['services', L('Службы')],
  ['vpn', 'VPN'],
  ['files', L('Файлы')],
  ['logs', L('Журнал')],
  ['network', L('Сеть')],
  ['docker', 'Docker'],
  ['system', L('Система')],
  ['schedule', L('Расписание')],
  ['notes', L('Заметки')],
  ['term', L('Терминал')],
];

class ServerPage {
  // «Команды»: закреплённые сохранённые команды запускаются сразу на этом сервере
  cmdMenuBtn(s) {
    const btn = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu' }, icon('play'), L('Команды'));
    btn.addEventListener('click', () => {
      const all = S.scenarios.slice().sort((a, b) => (!!b.pinned - !!a.pinned) || a.name.localeCompare(b.name, I18N.locale));
      const items = [];
      all.slice(0, 14).forEach((sc, i) => {
        if (i && !sc.pinned && all[i - 1].pinned) items.push('-');
        items.push({ label: sc.pinned ? [icon('star'), sc.name] : sc.name, run: () => runScenario(sc, [s.id]) });
      });
      if (items.length) items.push('-');
      items.push({ label: L('Новая команда…'), run: () => scenarioDialog({ pinned: true }) }, { label: L('Все команды'), run: () => { location.hash = '#/commands'; } });
      popMenu(btn, items);
    });
    return btn;
  }

  constructor(id, tab) {
    this.kind = 'server';
    this.id = id;
    this.el = h('div', { class: 'page' });
    this.headEl = h('div');
    this.alertEl = h('div');
    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    this.body = h('div');
    this.el.append(this.headEl, this.alertEl, this.tabsEl, this.body);
    this.tab = null;
    this.ctrl = null;
    this.refreshHead();
    this.setTab(tab);
  }

  get srv() { return S.by.get(this.id); }

  onAlerts() { this.refreshHead(); }

  onAvail() {
    if (!this.availEl) return;
    const av = availStats(this.id);
    this.availEl.replaceChildren(availStrip(this.id), av.pct >= 0 ? h('span', { class: 'avail-pct' + (av.pct < 99 ? ' low' : '') }, L('{0} за сутки', availPct(av.pct))) : '');
  }

  refreshHead() {
    const s = this.srv;
    if (!s) {
      this.headEl.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), L(' Загрузка…')));
      return;
    }
    const info = s.info || {};
    const addr = (s.user ? s.user + '@' : '') + s.host + (s.port && s.port !== 22 ? ':' + s.port : '');
    this.uptimeEl = h('span');
    const meta = [
      h('span', { class: 'mono' }, addr),
      info.os ? h('span', null, info.os) : null,
      info.kernel ? h('span', null, L('ядро ') + info.kernel) : null,
      info.cpu ? h('span', { title: info.cpu }, `${info.cpu.replace(/\s+\d+-Core Processor$/, '')} × ${info.cores}`) : null,
      info.virt ? h('span', null, info.virt) : null,
      this.uptimeEl,
    ];
    this.headEl.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('div', { class: 'head-title' }, h('h1', { class: 'mono-h' }, s.name), levelBadge(srvState(s)), this.availEl = h('span', { class: 'avail head-avail' })),
          h('div', { class: 'head-meta' }, meta)),
        h('div', { class: 'head-actions' },
          this.cmdMenuBtn(s),
          h('button', { class: 'btn', type: 'button', onclick: () => reconnect(s.id), title: L('Переподключиться') }, icon('refresh'), L('Переподключить')),
          h('button', { class: 'btn danger', type: 'button', onclick: () => rebootDialog(s) }, icon('power'), L('Перезагрузить')),
          h('button', { class: 'btn icon-only', type: 'button', onclick: () => settingsDialog(s), title: L('Настройки сервера'), 'aria-label': L('Настройки сервера') }, icon('gear')))),
      ...[pinnedNotesStrip(s.id)].filter(Boolean));
    this.updateUptime();
    this.onAvail();

    this.alertEl.replaceChildren();
    if (s.status === 'offline') {
      this.alertEl.append(h('div', { class: 'alert bad', style: { marginBottom: '16px' } }, h('span', { class: 'badge crit' }, L('нет связи')),
        h('div', null, s.error || L('Сервер недоступен'), L('. Панель переподключится автоматически.'))));
    } else if (s.status === 'off') {
      this.alertEl.append(h('div', { class: 'alert warn', style: { marginBottom: '16px', alignItems: 'center' } },
        h('div', { style: { flex: 1 } }, L('Мониторинг выключен — графики не обновляются. Процессы, службы, журнал и консоль работают.')),
        h('button', { class: 'btn sm', type: 'button', onclick: () => patchServer(s.id, { monitor: true }) }, L('Включить'))));
    }
    this.renderTabs();
  }

  updateUptime() {
    const s = this.srv;
    if (!this.uptimeEl || !s) return;
    this.uptimeEl.textContent = s.latest ? L('работает ') + Fmt.dur(s.latest.uptime) : '';
  }

  renderTabs() {
    const s = this.srv;
    const docker = s && s.info && s.info.docker;
    const x = this.tabsEl.scrollLeft;
    this.tabsEl.replaceChildren();
    for (const [key, label] of TAB_DEFS) {
      if (key === 'docker' && !docker) continue;
      if (key === 'vpn' && s && s.units && !s.units.some((u) => u.vpn) && this.tab !== 'vpn') continue;
      const n = key === 'notes' ? notesOf(this.id).length : 0;
      this.tabsEl.append(h('button', {
        type: 'button', role: 'tab', class: 'tab' + (key === this.tab ? ' active' : ''), 'aria-selected': String(key === this.tab),
        onclick: () => { location.hash = `#/s/${encodeURIComponent(this.id)}/${key}`; },
      }, label, n ? h('span', { class: 'tab-count' }, String(n)) : null));
    }
    this.tabsEl.scrollLeft = x;
  }

  // на узком экране ряд вкладок прокручивается — показываем выбранную
  revealTab() {
    requestAnimationFrame(() => {
      const t = this.tabsEl, a = t.querySelector('.tab.active');
      if (!a) return;
      const tr = t.getBoundingClientRect(), ar = a.getBoundingClientRect();
      if (ar.left < tr.left) t.scrollLeft += ar.left - tr.left - 24;
      else if (ar.right > tr.right) t.scrollLeft += ar.right - tr.right + 24;
    });
  }

  setTab(tab) {
    if (!TABS[tab]) tab = 'overview';
    if (this.tab === tab && this.ctrl) return;
    if (this.ctrl && this.ctrl.destroy) this.ctrl.destroy();
    this.tab = tab;
    this.ctrl = this.srv ? TABS[tab](this) : null;
    this.body.replaceChildren(this.ctrl ? this.ctrl.el : '');
    this.renderTabs();
    this.revealTab();
  }

  onFrame(srv, p, m) {
    if (srv.id !== this.id) return;
    this.updateUptime();
    if (this.ctrl && this.ctrl.onFrame) this.ctrl.onFrame(p, m);
  }

  onUnits(srv) {
    if (srv.id === this.id) this.renderTabs();
  }

  onNotes() {
    this.refreshHead();
    if (this.ctrl && this.ctrl.onNotes) this.ctrl.onNotes();
  }

  onSchedule() {
    if (this.ctrl && this.ctrl.onSchedule) this.ctrl.onSchedule();
  }

  onStatus(srv) {
    if (srv.id !== this.id) return;
    this.refreshHead();
    if (this.ctrl && this.ctrl.onStatus) this.ctrl.onStatus();
  }

  destroy() { if (this.ctrl && this.ctrl.destroy) this.ctrl.destroy(); }
}

/* ---------- вкладка «Обзор» ---------- */
function kpiTile(label) {
  const v = h('div', { class: 'kpi-value' }, '—');
  const sub = h('div', { class: 'kpi-sub' }, NB);
  const m = meter(0);
  const lab = h('div', { class: 'kpi-label' }, label);
  const el = h('div', { class: 'card kpi' }, lab, v, sub, m.el);
  return {
    el, m,
    label(t) { if (lab.textContent !== t) lab.textContent = t; },
    set(main, small, subText, pct) {
      v.replaceChildren(main, small ? h('small', null, small) : '');
      sub.textContent = subText || NB;
      sub.title = subText || '';
      if (pct == null) m.el.hidden = true; else { m.el.hidden = false; m.set(pct); }
    },
  };
}

function chartCard(title, chart, sub) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, title), sub ? h('div', { class: 'card-sub' }, sub) : null), h('div', { class: 'right' }, chart.legend())),
    chart.el);
}

// Классы ширины вместо @container: ResizeObserver отмечает, какие пороги ширина
// элемента перешла (см. комментарий у .ov в style.css).
function widthClasses(el, steps) {
  const ro = new ResizeObserver(([e]) => {
    const w = e.contentRect.width;
    if (!w) return;
    for (const [cls, test] of steps) el.classList.toggle(cls, test(w));
  });
  ro.observe(el);
  return ro;
}

function overviewTab(page) {
  const id = page.id;
  const srv = () => S.by.get(id);
  let range = store.get('range', '15m');
  if (!RANGES[range]) range = '15m';
  let pts = [];
  let step = S.interval;
  let reloadT = 0;
  let destroyed = false;

  const k = {
    cpu: kpiTile(L('Процессор')), mem: kpiTile(L('Память')), disk: kpiTile(L('Диск /')),
    load: kpiTile(L('Нагрузка (load average)')), net: kpiTile(L('Сеть, входящий')), tcp: kpiTile(L('Соединения TCP')),
  };
  const lastMT = () => { for (let i = pts.length - 1; i >= 0; i--) if (pts[i].mt) return pts[i].mt; return srv() && srv().latest ? srv().latest.memTotal : 0; };
  const cores = () => (srv() && srv().info && srv().info.cores) || 1;

  const charts = {
    cpu: new TimeChart({
      title: L('Загрузка процессора'), stacked: true, max: () => 100, fmt: (v) => Fmt.pct(v), axis: (v) => Fmt.int(v) + NB + '%',
      series: [
        { label: L('Пользователь'), color: 's1', get: (p) => p.u },
        { label: L('Система'), color: 's2', get: (p) => p.s },
        { label: L('Ожидание I/O'), color: 's3', get: (p) => p.w },
        { label: 'Steal', color: 's4', get: (p) => p.st },
      ],
      total: (p) => p.c, totalLabel: L('Загрузка'),
      extra: (p) => (p.a ? [[L('Пик за минуту'), Fmt.pct(p.cx || 0)]] : []),
    }),
    mem: new TimeChart({
      title: L('Память'), stacked: true, base: 1024, max: () => lastMT() || null,
      fmt: (v) => Fmt.bytes(v), axis: Fmt.axisBytes,
      series: [
        { label: L('Используется'), color: 's1', get: (p) => p.mu },
        { label: L('Кэш и буферы'), color: 's2', get: (p) => p.mc },
      ],
      total: (p) => p.mt, totalLabel: L('Всего'),
    }),
    net: new TimeChart({
      title: L('Сеть'), base: 1000, minTop: 8000, fmt: (v) => Fmt.bits(v), axis: Fmt.axisBits,
      series: [
        { label: L('Входящий'), color: 's1', kind: 'line', get: (p) => p.rx * 8 },
        { label: L('Исходящий'), color: 's2', kind: 'line', get: (p) => p.tx * 8 },
      ],
    }),
    disk: new TimeChart({
      title: L('Диск'), base: 1024, minTop: 1024, fmt: (v) => Fmt.rate(v), axis: Fmt.axisRate,
      series: [
        { label: L('Чтение'), color: 's1', kind: 'line', get: (p) => p.dr },
        { label: L('Запись'), color: 's2', kind: 'line', get: (p) => p.dw },
      ],
    }),
    load: new TimeChart({
      title: 'Load average', height: 150, minTop: 1, fmt: (v) => Fmt.num(v, 2), axis: (v) => Fmt.num(v, 2),
      series: [{ label: L('Load average (1 мин)'), color: 's1', kind: 'line', get: (p) => p.l }],
    }),
    tcp: new TimeChart({
      title: L('Соединения TCP'), height: 150, minTop: 10, fmt: (v) => Fmt.int(v), axis: (v) => Fmt.int(v),
      series: [{ label: L('Соединений TCP'), color: 's1', kind: 'line', get: (p) => p.tcp }],
    }),
  };

  const coresEl = h('div', { class: 'cores' });
  const coresSub = h('div', { class: 'card-sub' }, L('загрузка каждого ядра сейчас'));
  const coresAxis = h('div', { class: 'cores-axis' });
  const fsEl = h('div');
  const ifEl = h('tbody');
  const rangeNote = h('span', { class: 'muted', style: { fontSize: '12.5px' } });

  const rangeSeg = seg(RANGE_LABELS, range, (v) => { range = v; store.set('range', v); load(); });
  const hw = hardwareSection(id);

  const chartGrid = h('div', { class: 'grid two' },
    chartCard(L('Процессор'), charts.cpu),
    chartCard(L('Память'), charts.mem),
    chartCard(L('Сеть'), charts.net, L('бит/с, без виртуальных интерфейсов')),
    chartCard(L('Диск, ввод-вывод'), charts.disk),
    chartCard('Load average', charts.load, L('средняя очередь задач за 1 минуту')),
    chartCard(L('Соединения TCP'), charts.tcp));

  // температуры: график появляется, когда у сервера есть датчики; серии — только те, что есть.
  // Цвет закреплён за компонентом, а не за порядком: процессор всегда s1, плата s2 и т. д.
  const TEMP_SERIES = [
    ['cpu', 'tc', { label: L('Процессор'), color: 's1', kind: 'line', get: (p) => p.tc }],
    ['board', 'tb', { label: L('Плата'), color: 's2', kind: 'line', get: (p) => p.tb }],
    ['gpu', 'tg', { label: L('Видеокарта'), color: 's3', kind: 'line', get: (p) => p.tg }],
    ['disk', 'td', { label: L('Диски'), color: 's4', kind: 'line', get: (p) => p.td }],
  ];
  let tempKey = '';
  let tempCard = null;
  function ensureTempChart(temps) {
    const T = temps || [];
    const now = {
      cpu: !!tempMain(T, 'cpu'),
      board: T.some((t) => t.kind === 'board' && !CPU_LIKE.test(t.label || '')),
      gpu: T.some((t) => t.kind === 'gpu'),
      disk: T.some((t) => t.kind === 'disk'),
    };
    const kinds = TEMP_SERIES.filter(([kind, key]) => now[kind] || pts.some((p) => p[key] > 0));
    const key = kinds.map((x) => x[0]).join(',');
    if (key === tempKey) return;
    tempKey = key;
    if (charts.temp) { charts.temp.destroy(); delete charts.temp; }
    if (tempCard) { tempCard.remove(); tempCard = null; }
    if (!kinds.length) return;
    charts.temp = new TimeChart({
      title: L('Температура'), sparse: true, floor: true, fill: false, minTop: 20,
      fmt: (v) => `${Fmt.num(v, 1)}${NB}°C`, axis: (v) => `${Fmt.int(v)}${NB}°C`,
      series: kinds.map((x) => x[2]),
    });
    tempCard = chartCard(L('Температура'), charts.temp, kinds.some((x) => x[0] === 'disk') ? L('диски — самый горячий из них') : null);
    tempCard.classList.add('wide');
    chartGrid.append(tempCard);
    redraw();
  }

  const el = h('div', { class: 'ov' },
    h('div', { class: 'grid kpis' }, Object.values(k).map((t) => t.el)),
    hw.el,
    h('div', { class: 'toolbar' }, h('span', { class: 'ink2', style: { fontSize: '13px' } }, L('Период')), rangeSeg.el, rangeNote),
    chartGrid,
    h('div', { class: 'grid two', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Ядра процессора')), coresSub)), coresEl, coresAxis),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, L('Файловые системы'))), fsEl)),
    h('div', { class: 'grid', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, L('Сетевые интерфейсы'))),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, L('Интерфейс')), h('th', { class: 'num' }, '↓'), h('th', { class: 'num' }, '↑'), h('th', { class: 'num' }, L('Всего ↓ / ↑')))), ifEl)))));

  const widthRO = widthClasses(el, [['w-s', (w) => w <= 560], ['w-m', (w) => w >= 600], ['w-l', (w) => w >= 1080], ['w-xl', (w) => w >= 1280]]);

  function redraw() {
    const now = Date.now();
    const t0 = now - RANGES[range];
    for (const c of Object.values(charts)) c.set(pts, t0, now, step);
  }

  async function load() {
    clearTimeout(reloadT);
    for (const c of Object.values(charts)) c.el.classList.add('loading');
    try {
      const d = await api(`/servers/${encodeURIComponent(id)}/history?range=${range}`);
      if (destroyed) return;
      pts = d.points || [];
      step = d.step || S.interval;
      const covered = pts.length ? (Date.now() - pts[0].t) : 0;
      rangeNote.textContent = RANGES[range] > 3600e3 && covered < RANGES[range] * 0.9
        ? L('история собирается, пока панель запущена') : '';
    } catch (e) {
      rangeNote.textContent = e.message;
    }
    for (const c of Object.values(charts)) c.el.classList.remove('loading');
    ensureTempChart(srv() && srv().latest && srv().latest.temps);
    redraw();
    if (RANGES[range] > 3600e3) reloadT = setTimeout(load, RANGES[range] > 86400e3 ? 300e3 : 60e3);
  }

  function renderNow(m) {
    const s = srv();
    if (!m) {
      for (const t of Object.values(k)) t.set('—', '', s && s.status !== 'online' ? STATUS_TEXT[s.status] : NB, null);
      return;
    }
    k.cpu.set(Fmt.pct(m.cpu), '', L('польз. {0} · сист. {1} · I/O {2}', Fmt.pct0(m.user), Fmt.pct0(m.system), Fmt.pct0(m.iowait)) + (m.steal >= 1 ? ` · steal ${Fmt.pct0(m.steal)}` : ''), m.cpu);
    k.mem.set(Fmt.bytes(m.memUsed), L(' из {0}', Fmt.bytes(m.memTotal)), L('кэш {0}', Fmt.bytes(m.memCache)) + (m.swapTotal ? L(' · swap {0} из {1}', Fmt.bytes(m.swapUsed), Fmt.bytes(m.swapTotal)) : L(' · swap нет')), memPct(m));
    const parts = dataFS(m);
    if (parts.length > 1) {
      const top = fullestFS(m);
      k.disk.label(L('Диски · {0} {1}', parts.length, Fmt.plural(parts.length, 'раздел', 'раздела', 'разделов')));
      k.disk.set(Fmt.pct(top.pct), L(' на ') + top.mount, parts.filter((f) => f !== top).map((f) => `${f.mount} ${Fmt.pct0(f.pct)}`).join(' · '), top.pct);
      k.disk.el.title = parts.map((f) => L('{0}: {1} из {2}, свободно {3}', f.mount, Fmt.bytes(f.used), Fmt.bytes(f.size), Fmt.bytes(f.avail))).join('\n');
    } else {
      const fs = rootFS(m);
      k.disk.label(L('Диск ') + (fs ? fs.mount : '/'));
      k.disk.el.title = '';
      if (fs) k.disk.set(Fmt.pct(fs.pct), '', L('{0} из {1} · свободно {2}', Fmt.bytes(fs.used), Fmt.bytes(fs.size), Fmt.bytes(fs.avail)), fs.pct);
      else k.disk.set('—', '', L('нет данных'), null);
    }
    const c = cores();
    k.load.set(Fmt.num(m.load[0], 2), '', L('5 мин {0} · 15 мин {1} · ядер {2}', Fmt.num(m.load[1], 2), Fmt.num(m.load[2], 2), c), (m.load[0] / c) * 100);
    k.net.set(Fmt.bits(m.netRx * 8), '', L('исходящий {0} · диск {1}', Fmt.bits(m.netTx * 8), Fmt.rate(m.diskR + m.diskW)), null);
    k.tcp.set(Fmt.int(m.tcp), '', L('процессов {0} · выполняется {1}', Fmt.int(m.procs), Fmt.int(m.procsRun)), null);
    hw.temps(m.temps);
    ensureTempChart(m.temps);

    // ядра
    const n = (m.cores || []).length;
    if (coresEl.children.length !== n) {
      coresEl.replaceChildren(...(m.cores || []).map(() => h('div', { class: 'core' }, h('i'))));
      coresAxis.replaceChildren(h('span', null, '0'), h('span', null, n > 1 ? String(n - 1) : ''));
    }
    let maxI = 0, sum = 0;
    (m.cores || []).forEach((v, i) => {
      const c2 = coresEl.children[i];
      c2.firstChild.style.height = Math.max(1, v) + '%';
      c2.title = L('Ядро {0}: {1}', i, Fmt.pct(v));
      sum += v;
      if (v > m.cores[maxI]) maxI = i;
    });
    if (n) coresSub.textContent = n === 1 ? L('одно ядро · сейчас {0}', Fmt.pct(m.cores[0])) : L('{0} {1} · в среднем {2} · больше всего ядро {3} ({4})', n, Fmt.plural(n, 'ядро', 'ядра', 'ядер'), Fmt.pct(sum / n), maxI, Fmt.pct(m.cores[maxI]));
    // файловые системы
    const boot = (f) => /^\/boot(\/|$)|^\/efi$/.test(f.mount);
    const fsList = (m.fs || []).slice().sort((a, b) => (boot(a) - boot(b)) || (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
    fsEl.replaceChildren(...fsList.map((f) => {
      const mt = meter(f.pct);
      return h('div', { class: 'fs-row' },
        h('div', { class: 'fs-name', title: f.dev }, f.mount, h('span', { class: 'muted' }, f.dev.replace('/dev/', ''))),
        h('div', { class: 'fs-val' }, `${Fmt.bytes(f.used)} / ${Fmt.bytes(f.size)} · ${Fmt.pct0(f.pct)}`), mt.el);
    }));
    if (!(m.fs || []).length) fsEl.replaceChildren(h('div', { class: 'muted' }, L('нет данных')));
    renderIfaces(ifEl, m);
  }

  load();
  renderNow(srv() && srv().latest);

  return {
    el,
    onFrame(p, m) {
      renderNow(m);
      if (RANGES[range] <= 3600e3) {
        pts.push(p);
        const cut = Date.now() - RANGES[range] - step * 2;
        let i = 0;
        while (i < pts.length && pts[i].t < cut) i++;
        if (i) pts.splice(0, i);
      }
      redraw();
    },
    onStatus() { renderNow(srv() && srv().latest); if (srv() && srv().status === 'online') hw.reload(); },
    destroy() {
      destroyed = true;
      widthRO.disconnect();
      hw.destroy();
      clearTimeout(reloadT);
      for (const c of Object.values(charts)) c.destroy();
    },
  };
}

function renderIfaces(tbody, m) {
  const list = (m && m.ifaces || []).filter((x) => x.name !== 'lo');
  tbody.replaceChildren(...list.map((x) => h('tr', null,
    h('td', null, h('b', { style: { fontWeight: 500 } }, x.name), x.virtual ? h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '12px' } }, L('вирт.')) : null),
    h('td', { class: 'num' }, Fmt.bits(x.rx * 8)),
    h('td', { class: 'num' }, Fmt.bits(x.tx * 8)),
    h('td', { class: 'num muted' }, `${Fmt.bytes(x.rxTotal)} / ${Fmt.bytes(x.txTotal)}`))));
  if (!list.length) tbody.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'muted' }, L('нет данных'))));
}

/* ---------- вкладка «Процессы» ---------- */
function procsTab(page) {
  const id = page.id;
  const st = { sort: store.get('procSort', { k: 'cpu', d: -1 }), q: '', kernel: false, auto: true, data: null, timer: 0, busy: false, dead: false };
  const tbody = h('tbody');
  const count = h('span', { class: 'count' });
  const errBox = h('div');
  const cols = [
    ['pid', 'PID', 'num'], ['name', L('Процесс'), ''], ['user', L('Пользователь'), ''], ['cpu', 'CPU %', 'num'],
    ['mem', L('Память %'), 'num'], ['rss', 'RSS', 'num'], ['threads', L('Потоки'), 'num'], ['elapsed', L('Работает'), 'num'], [null, '', ''],
  ];
  const thead = h('tr');
  function renderHead() {
    // заголовок сортируется кнопкой — так до него можно дойти с клавиатуры
    const sortBy = (key) => { st.sort = { k: key, d: st.sort.k === key ? -st.sort.d : (key === 'name' || key === 'user' ? 1 : -1) }; store.set('procSort', st.sort); renderHead(); render(); };
    thead.replaceChildren(...cols.map(([key, label, cls]) => h('th', {
      class: (cls ? cls + ' ' : '') + (key ? 'sortable' : ''), scope: 'col',
      'aria-sort': key && st.sort.k === key ? (st.sort.d > 0 ? 'ascending' : 'descending') : null,
    }, key ? h('button', { class: 'th-btn', type: 'button', onclick: () => sortBy(key) }, label, st.sort.k === key ? sortIcon(st.sort.d > 0) : null) : label)));
  }
  renderHead();

  const search = h('input', { class: 'input search', type: 'search', placeholder: L('Поиск: имя, команда, пользователь, PID'), oninput: (e) => { st.q = e.target.value.trim().toLowerCase(); render(); } });
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      search,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { st.kernel = e.target.checked; render(); } }), L('Потоки ядра')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { st.auto = e.target.checked; schedule(); } }), L('Автообновление')),
      h('span', { class: 'grow' }), count,
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), L('Обновить'))),
    errBox,
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, thead), tbody)));

  function schedule() {
    clearTimeout(st.timer);
    if (st.auto && !st.dead) st.timer = setTimeout(load, 4000);
  }

  async function load() {
    if (st.busy) return;
    st.busy = true;
    clearTimeout(st.timer);
    if (!st.data) tbody.replaceChildren(h('tr', null, h('td', { colspan: '9', class: 'empty' }, h('span', { class: 'spinner' }), NB + L(' Загрузка процессов…'))));
    try {
      st.data = await api(`/servers/${encodeURIComponent(id)}/procs`);
      errBox.replaceChildren();
      render();
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
    }
    st.busy = false;
    schedule();
  }

  function render() {
    if (!st.data) return;
    let list = st.data.procs || [];
    const total = list.length;
    if (!st.kernel) list = list.filter((p) => !p.kernel);
    if (st.q) list = list.filter((p) => String(p.pid) === st.q || p.name.toLowerCase().includes(st.q) || p.cmd.toLowerCase().includes(st.q) || (p.user || '').toLowerCase().includes(st.q));
    const { k, d } = st.sort;
    list = list.slice().sort((a, b) => {
      const x = a[k], y = b[k];
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d;
    });
    count.textContent = L('показано {0} из {1}', Math.min(list.length, 300), total);
    tbody.replaceChildren(...list.slice(0, 300).map((p) => h('tr', null,
      h('td', { class: 'num muted' }, p.pid),
      h('td', { class: 'name-cell' }, h('b', null, p.name), h('div', { class: 'cmd', title: p.cmd }, p.cmd)),
      h('td', null, p.user || '—'),
      h('td', { class: 'num' }, Fmt.num(p.cpu)),
      h('td', { class: 'num' }, Fmt.num(p.mem)),
      h('td', { class: 'num' }, Fmt.bytes(p.rss)),
      h('td', { class: 'num' }, p.threads),
      h('td', { class: 'num muted' }, Fmt.dur(p.elapsed)),
      h('td', { class: 'actions' }, p.kernel || p.pid <= 1 ? null : h('span', { class: 'row-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => kill(p, 'TERM') }, L('Завершить')),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => kill(p, 'KILL') }, 'Kill'))))));
    if (!list.length) tbody.replaceChildren(h('tr', null, h('td', { colspan: '9', class: 'empty' }, L('Ничего не найдено'))));
  }

  async function kill(p, sig) {
    const ok = await confirmDialog({
      title: sig === 'KILL' ? L('Принудительно завершить процесс?') : L('Завершить процесс?'),
      text: h('div', null, h('b', null, p.name), L(' (PID {0}, пользователь {1})', p.pid, p.user || '?'), h('div', { class: 'cmd mono', style: { marginTop: '8px', wordBreak: 'break-all' } }, p.cmd)),
      warn: sig === 'KILL' ? L('Сигнал KILL нельзя перехватить: процесс не успеет сохранить данные.') : null,
      ok: sig === 'KILL' ? L('Отправить KILL') : L('Отправить TERM'), danger: true,
    });
    if (!ok) return;
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/procs/kill`, { method: 'POST', body: { pid: p.pid, signal: sig } });
      if (r.ok) toast(L('Сигнал {0} отправлен процессу {1} ({2})', sig, p.name, p.pid));
      else toast(L('Не удалось завершить процесс'), 'bad', r.error);
    } catch (e) { toast(e.message, 'bad'); }
    setTimeout(load, 700);
  }

  load();
  return { el, destroy() { st.dead = true; clearTimeout(st.timer); } };
}

/* ---------- вкладка «Службы» ---------- */
const RISKY_UNITS = /^(ssh|sshd|tailscaled|networking|systemd-networkd|NetworkManager|systemd-resolved|dbus|dbus-broker|systemd-logind|wg-quick@.*|netplan.*)\.service$/;

function serviceState(s) {
  if (s.active === 'failed') return ['bad', L('ошибка')];
  if (unitBad(s)) return ['bad', L('падает и перезапускается')];
  if (s.active === 'active' && s.sub === 'running') return ['good', L('работает')];
  if (s.active === 'active' && s.sub === 'exited') return ['good', L('выполнена')];
  if (s.active === 'active') return ['good', s.sub];
  if (s.active === 'activating') return ['warn', L('запускается')];
  if (s.active === 'deactivating') return ['warn', L('останавливается')];
  if (s.active === 'reloading') return ['warn', L('перезагружается')];
  return ['idle', L('остановлена')];
}
const ENABLED_TEXT = { enabled: L('включён'), disabled: L('выключен'), static: L('статический'), masked: L('заблокирован'), indirect: L('косвенный'), generated: L('сгенерирован'), alias: L('псевдоним'), 'enabled-runtime': L('включён (временно)'), transient: L('временный') };

function servicesTab(page) {
  const id = page.id;
  const st = { data: null, q: '', filter: 'all', busy: false };
  const tbody = h('tbody');
  const errBox = h('div');
  const failedBox = h('div');
  const filterSeg = seg([['all', L('Все')], ['running', L('Работают')], ['failed', L('С ошибкой')], ['stopped', L('Остановлены')]], 'all', (v) => { st.filter = v; render(); });
  const count = h('span', { class: 'count' });
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      h('input', { class: 'input search', type: 'search', placeholder: L('Поиск службы'), oninput: (e) => { st.q = e.target.value.trim().toLowerCase(); render(); } }),
      filterSeg.el, h('span', { class: 'grow' }), count,
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), L('Обновить'))),
    errBox, failedBox,
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, L('Служба')), h('th', null, L('Состояние')), h('th', null, L('Автозапуск')), h('th'))), tbody)));

  async function load() {
    if (st.busy) return;
    st.busy = true;
    if (!st.data) tbody.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'empty' }, h('span', { class: 'spinner' }), NB + L(' Загрузка служб…'))));
    try {
      st.data = (await api(`/servers/${encodeURIComponent(id)}/services`)).services || [];
      page.services = st.data;
      errBox.replaceChildren();
      render();
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
    }
    st.busy = false;
  }

  function render() {
    const all = st.data || [];
    const failed = all.filter(unitBad);
    const running = all.filter((s) => s.active === 'active' && s.sub === 'running');
    filterSeg.btns.forEach(([v, b]) => {
      const n = v === 'all' ? all.length : v === 'running' ? running.length : v === 'failed' ? failed.length : all.filter((s) => s.active === 'inactive').length;
      b.replaceChildren(b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent.replace(/\s\d+$/, '') : '', h('span', { class: 'muted' }, NB + n));
    });
    failedBox.replaceChildren(failed.length ? h('div', { class: 'alert bad', style: { marginBottom: '12px' } },
      h('span', { class: 'badge crit' }, `${failed.length} ${Fmt.plural(failed.length, 'ошибка', 'ошибки', 'ошибок')}`),
      h('div', null, L('С ошибкой: '), failed.map((s) => s.unit.replace(/\.service$/, '')).join(', '))) : '');
    let list = all;
    if (st.filter === 'running') list = running;
    else if (st.filter === 'failed') list = failed;
    else if (st.filter === 'stopped') list = all.filter((s) => s.active === 'inactive');
    if (st.q) list = list.filter((s) => s.unit.toLowerCase().includes(st.q) || s.description.toLowerCase().includes(st.q));
    count.textContent = L('{0} из {1}', list.length, all.length);
    tbody.replaceChildren(...list.map((s) => {
      const [cls, text] = serviceState(s);
      const active = s.active === 'active' || s.active === 'activating' || s.active === 'reloading';
      const more = h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': L('Ещё: {0}', s.unit), title: L('Ещё') }, icon('dots'));
      more.addEventListener('click', () => popMenu(more, [
        { label: L('Журнал службы'), run: () => openLogs(s.unit) },
        { label: L('Перечитать конфигурацию (reload)'), run: () => act(s, 'reload') },
        { label: L('Перезапуск по расписанию…'), run: () => scheduleDialog({ servers: [id], kind: 'service', target: s.unit }) },
        '-',
        s.enabled === 'enabled' ? { label: L('Выключить автозапуск'), run: () => act(s, 'disable') } : { label: L('Включить автозапуск'), run: () => act(s, 'enable') },
      ]));
      return h('tr', null,
        h('td', { class: 'name-cell' }, h('b', null, s.unit.replace(/\.service$/, '')), h('div', { class: 'desc', title: s.description }, s.description || NB)),
        h('td', null, h('span', { class: 'st ' + cls }, h('span', { class: 'dot' }), text), s.active === 'active' && s.sub !== 'running' && s.sub !== 'exited' ? h('span', { class: 'muted' }, ' ' + s.sub) : null),
        h('td', { class: 'ink2' }, ENABLED_TEXT[s.enabled] || s.enabled || '—'),
        h('td', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => act(s, 'restart') }, L('Перезапустить')),
          active
            ? h('button', { class: 'btn sm', type: 'button', onclick: () => act(s, 'stop') }, L('Остановить'))
            : h('button', { class: 'btn sm', type: 'button', onclick: () => act(s, 'start') }, L('Запустить')),
          more));
    }));
    if (!list.length) tbody.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'empty' }, all.length ? L('Ничего не найдено') : L('Службы systemd не найдены'))));
  }

  function openLogs(unit) {
    page.logUnit = unit;
    location.hash = `#/s/${encodeURIComponent(id)}/logs`;
  }

  async function act(s, action) {
    await serviceAction(page, s.unit, action);
    load();
  }

  load();
  return { el };
}

const SVC_ACT = {
  start: [L('Запустить'), L('запущена')], stop: [L('Остановить'), L('остановлена')], restart: [L('Перезапустить'), L('перезапущена')],
  reload: [L('Перечитать конфигурацию'), L('перечитала конфигурацию')], enable: [L('Включить автозапуск'), L('добавлена в автозапуск')], disable: [L('Выключить автозапуск'), L('убрана из автозапуска')],
};

async function serviceAction(page, unit, action, extraWarn) {
  const name = unit.replace(/\.service$/, '');
  const A = SVC_ACT[action];
  const risky = RISKY_UNITS.test(unit) && (action === 'stop' || action === 'restart' || action === 'disable');
  if (action !== 'start' && action !== 'enable') {
    const ok = await confirmDialog({
      title: `${A[0]} «${name}»?`,
      text: L('Сервер: {0}. Команда: systemctl {1} {2}', page.srv.name, action, unit),
      warn: risky ? L('Эта служба отвечает за сеть или удалённый доступ — её остановка может оборвать подключение к серверу.') : extraWarn || null,
      ok: A[0], danger: action === 'stop' || action === 'disable' || risky,
    });
    if (!ok) return false;
  }
  toast(`${A[0]}: ${name}…`, 'warn');
  try {
    const r = await api(`/servers/${encodeURIComponent(page.id)}/services/action`, { method: 'POST', body: { unit, action } });
    if (r.ok) toast(L('Служба {0} {1}', name, A[1]));
    else toast(L('Не получилось: {0} {1}', A[0].toLowerCase(), name), 'bad', r.error);
    return r.ok;
  } catch (e) { toast(e.message, 'bad'); return false; }
}

/* ---------- вкладка «Файлы» ---------- */
const FILE_ICON = {
  d: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.2l1.6 1.6h6.2A1.5 1.5 0 0 1 17 8.1v6.4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/>',
  f: '<path d="M5.5 3h6l3.5 3.5v9A1.5 1.5 0 0 1 13.5 17h-8A1.5 1.5 0 0 1 4 15.5v-11A1.5 1.5 0 0 1 5.5 3z"/><path d="M11.5 3v3.5H15"/>',
  l: '<path d="M8.5 11.5l3-3"/><path d="M9.5 6.5l1.2-1.2a2.8 2.8 0 0 1 4 4l-1.2 1.2M10.5 13.5l-1.2 1.2a2.8 2.8 0 0 1-4-4l1.2-1.2"/>',
};
function fileIcon(t) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('class', 'ico ficon ' + t);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = FILE_ICON[t] || FILE_ICON.f;
  return s;
}

function fmtMode(type, mode) {
  const n = parseInt(mode, 8);
  if (isNaN(n)) return mode || '';
  const r = (b, c) => (n & b ? c : '-');
  let x = (type === 'd' ? 'd' : type === 'l' ? 'l' : '-') + r(256, 'r') + r(128, 'w') + r(64, 'x') + r(32, 'r') + r(16, 'w') + r(8, 'x') + r(4, 'r') + r(2, 'w') + r(1, 'x');
  if (n & 2048) x = x.slice(0, 3) + (n & 64 ? 's' : 'S') + x.slice(4);
  if (n & 1024) x = x.slice(0, 6) + (n & 8 ? 's' : 'S') + x.slice(7);
  if (n & 512) x = x.slice(0, 9) + (n & 1 ? 't' : 'T');
  return x;
}

function fileTime(sec) {
  const d = new Date(sec * 1000);
  const p = (x) => String(x).padStart(2, '0');
  if (d.getFullYear() !== new Date().getFullYear()) return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  return Fmt.dateTime(sec * 1000, false);
}

const pathJoin = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
const pathDir = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const pathBase = (p) => p.slice(p.lastIndexOf('/') + 1);
const validName = (v) => (!v ? L('Введите имя') : v.includes('/') ? L('Имя не может содержать «/»') : v === '.' || v === '..' ? L('Недопустимое имя') : '');

function filesTab(page) {
  const id = page.id;
  const info = (page.srv && page.srv.info) || {};
  const canSudo = info.uid !== 0 && info.sudo;
  const home = info.uid === 0 ? '/root' : info.user ? '/home/' + info.user : '/';
  const st = {
    path: store.get('files:' + id, home), entries: [], busy: false,
    root: canSudo && store.get('filesRoot:' + id, false), q: '',
  };
  const jump = page.filePath;
  const jumpUnit = page.fileUnit;
  page.filePath = '';
  page.fileUnit = '';
  if (jump) {
    st.path = pathDir(jump);
    if (canSudo) st.root = true;
  }

  const pathIn = h('input', { class: 'input mono path-in', spellcheck: 'false', autocomplete: 'off' });
  pathIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(pathIn.value.trim()); });
  const crumbs = h('div', { class: 'crumbs' });
  const tbody = h('tbody');
  const errBox = h('div');
  const count = h('span', { class: 'count' });
  const rootCb = h('input', { type: 'checkbox', checked: st.root });
  rootCb.addEventListener('change', () => { st.root = rootCb.checked; store.set('filesRoot:' + id, st.root); load(); });
  const upInput = h('input', { type: 'file', multiple: true, hidden: true });
  upInput.addEventListener('change', () => { upload([...upInput.files]); upInput.value = ''; });
  const filterIn = h('input', { class: 'input search', type: 'search', placeholder: L('Фильтр по имени'), oninput: (e) => { st.q = e.target.value.trim().toLowerCase(); render(); } });

  const places = [[L('Домашняя'), home], ['/etc', '/etc'], ['systemd', '/etc/systemd/system'], ['/usr/local/etc', '/usr/local/etc'], ['/opt', '/opt'], ['/var/log', '/var/log'], ['/tmp', '/tmp']];
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn sm', type: 'button', title: L('На уровень выше'), onclick: () => go(pathDir(st.path)) }, icon('up'), L('Наверх')),
      pathIn,
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), L('Обновить')),
      canSudo ? h('label', { class: 'check', title: L('Выполнять через sudo -n') }, rootCb, L('как root')) : null),
    h('div', { class: 'toolbar' },
      h('div', { class: 'chips', style: { margin: 0 } }, places.map(([l, p]) => h('button', { class: 'chip', type: 'button', onclick: () => go(p) }, l))),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', type: 'button', onclick: () => newFolder() }, L('Новая папка')),
      h('button', { class: 'btn sm', type: 'button', onclick: () => newFile() }, L('Новый файл')),
      h('button', { class: 'btn sm', type: 'button', onclick: () => upInput.click() }, L('Загрузить')), upInput),
    crumbs, errBox,
    h('div', { class: 'toolbar', style: { marginBottom: '8px' } }, filterIn, h('span', { class: 'grow' }), count),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl files' },
      h('thead', null, h('tr', null, h('th', null, L('Имя')), h('th', { class: 'num' }, L('Размер')), h('th', null, L('Изменён')), h('th', null, L('Права')), h('th', null, L('Владелец')), h('th'))),
      tbody)));

  const q = () => (st.root ? '&root=1' : '');
  const url = (what, p) => `/servers/${encodeURIComponent(id)}/files/${what}?path=${encodeURIComponent(p)}${q()}`;

  function go(p) {
    if (!p) return;
    if (!p.startsWith('/')) p = pathJoin(st.path, p);
    st.path = p;
    st.q = '';
    filterIn.value = '';
    load();
  }

  async function load() {
    if (st.busy) return;
    st.busy = true;
    pathIn.value = st.path;
    renderCrumbs();
    tbody.replaceChildren(h('tr', null, h('td', { colspan: '6', class: 'empty' }, h('span', { class: 'spinner' }), NB + L(' Загрузка…'))));
    try {
      const d = await api(url('list', st.path));
      st.path = d.path;
      st.entries = d.entries;
      store.set('files:' + id, st.path);
      errBox.replaceChildren(d.truncated ? h('div', { class: 'alert warn', style: { marginBottom: '10px' } }, L('Файлов очень много — показана только часть.')) : '');
      pathIn.value = st.path;
      renderCrumbs();
      render();
    } catch (e) {
      st.entries = [];
      tbody.replaceChildren();
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '10px' } }, `${st.path}: ${e.message}`));
      count.textContent = '';
    }
    st.busy = false;
  }

  function renderCrumbs() {
    const parts = st.path.split('/').filter(Boolean);
    const items = [h('button', { class: 'crumb', type: 'button', onclick: () => go('/') }, '/')];
    parts.forEach((p, i) => {
      const full = '/' + parts.slice(0, i + 1).join('/');
      if (i) items.push(h('span', { class: 'muted' }, '/'));
      items.push(h('button', { class: 'crumb', type: 'button', onclick: () => go(full) }, p));
    });
    crumbs.replaceChildren(...items);
  }

  const isDir = (e) => e.type === 'd' || (e.type === 'l' && e.target === 'd');

  function render() {
    let list = st.entries;
    if (st.q) list = list.filter((e) => e.name.toLowerCase().includes(st.q));
    count.textContent = st.q ? L('{0} из {1}', list.length, st.entries.length) : `${st.entries.length} ${Fmt.plural(st.entries.length, 'объект', 'объекта', 'объектов')}`;
    if (!list.length) {
      tbody.replaceChildren(h('tr', null, h('td', { colspan: '6', class: 'empty' }, st.entries.length ? L('Ничего не найдено') : L('Папка пуста'))));
      return;
    }
    tbody.replaceChildren(...list.map((e) => {
      const full = pathJoin(st.path, e.name);
      const dir = isDir(e);
      const more = h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': L('Ещё'), title: L('Ещё') }, icon('dots'));
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        popMenu(more, [
          dir ? { label: L('Открыть'), run: () => go(full) } : { label: L('Открыть в редакторе'), run: () => openFile(full) },
          !dir && e.type !== 'd' ? { label: L('Скачать'), run: () => download(full) } : null,
          { label: L('Копировать путь'), run: () => copyText(full) },
          '-',
          { label: L('Переименовать'), run: () => rename(e) },
          { label: L('Удалить'), danger: true, run: () => remove(e) },
        ].filter(Boolean));
      });
      // не «dot»: этот класс занят точкой статуса (8×8 px), строка схлопнулась бы в кружок
      const tr = h('tr', { class: 'frow' + (e.name.startsWith('.') ? ' fhidden' : ''), tabindex: '0' },
        // flex — на внутреннем div, не на td: ячейка с display:flex в Safari выпадает из таблицы и не тянется на высоту строки
        h('td', { class: 'fname' }, h('div', { class: 'fname-in' },
          fileIcon(e.type === 'l' ? 'l' : dir ? 'd' : 'f'), h('span', null, e.name),
          e.type === 'l' ? h('span', { class: 'muted mono flink' }, '→ ' + e.link) : null)),
        h('td', { class: 'num' }, dir ? '' : Fmt.bytes(e.size)),
        h('td', { class: 'nowrap muted' }, fileTime(e.mtime)),
        h('td', { class: 'mono muted', title: e.mode }, fmtMode(e.type, e.mode)),
        h('td', { class: 'muted' }, e.user === e.group ? e.user : `${e.user}:${e.group}`),
        h('td', { class: 'actions' }, more));
      const open = () => (dir ? go(full) : e.type === 'f' || e.type === 'l' ? openFile(full) : null);
      tr.addEventListener('click', (ev) => { if (!ev.target.closest('button')) open(); });
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
      return tr;
    }));
  }

  function download(p) {
    const a = h('a', { href: '/api' + url('download', p) + '&token=' + encodeURIComponent(TOKEN), download: pathBase(p) });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function upload(files) {
    for (const f of files) {
      const target = pathJoin(st.path, f.name);
      let overwrite = false;
      if (st.entries.some((e) => e.name === f.name)) {
        overwrite = await confirmDialog({ title: L('Заменить «{0}»?', f.name), text: L('В {0} уже есть файл с таким именем.', st.path), ok: L('Заменить'), danger: true });
        if (!overwrite) continue;
      }
      toast(L('Загрузка {0} ({1})…', f.name, Fmt.bytes(f.size)), 'warn');
      try {
        const res = await fetch('/api' + url('upload', target) + (overwrite ? '&overwrite=1' : ''), {
          method: 'POST', headers: { 'X-Panel-Token': TOKEN, 'Content-Type': 'application/octet-stream' }, body: f,
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || L('Ошибка ') + res.status);
        toast(L('{0} загружен', f.name));
      } catch (e) { toast(L('Не удалось загрузить {0}', f.name), 'bad', e.message); }
    }
    load();
  }

  async function op(body, okText) {
    try {
      await api(`/servers/${encodeURIComponent(id)}/files/op${st.root ? '?root=1' : ''}`, { method: 'POST', body });
      if (okText) toast(okText);
      load();
      return true;
    } catch (e) { toast(e.message, 'bad'); return false; }
  }

  async function newFolder() {
    const name = await promptDialog({ title: L('Новая папка'), label: L('Имя папки в {0}', st.path), ok: L('Создать'), validate: validName });
    if (name) op({ op: 'mkdir', path: pathJoin(st.path, name) }, L('Папка создана'));
  }

  async function newFile() {
    const name = await promptDialog({ title: L('Новый файл'), label: L('Имя файла в {0}', st.path), ok: L('Создать'), validate: validName });
    if (!name) return;
    if (st.entries.some((e) => e.name === name)) { toast(L('Такой файл уже есть'), 'bad'); return; }
    fileEditor(page, { path: pathJoin(st.path, name), content: '', sha: '', isNew: true, root: st.root, onSaved: load });
  }

  async function rename(e) {
    const name = await promptDialog({ title: L('Переименовать'), label: L('Новое имя для «{0}»', e.name), value: e.name, ok: L('Переименовать'), validate: validName });
    if (!name || name === e.name) return;
    op({ op: 'rename', path: pathJoin(st.path, e.name), to: pathJoin(st.path, name) }, L('Переименовано'));
  }

  async function remove(e) {
    const dir = e.type === 'd';
    const ok = await confirmDialog({
      title: L('Удалить «{0}»?', e.name), text: L('{0} — удаление нельзя отменить.', pathJoin(st.path, e.name)),
      warn: dir ? L('Папка будет удалена вместе со всем содержимым.') : null, ok: L('Удалить'), danger: true,
    });
    if (ok) op({ op: 'delete', path: pathJoin(st.path, e.name) }, L('Удалено'));
  }

  async function openFile(p, unit) {
    toast(L('Открываю ') + pathBase(p) + '…', 'warn');
    try {
      const d = await api(url('read', p));
      if (d.tooBig || d.binary) {
        const m = modal({
          title: pathBase(p),
          body: h('div', { class: 'form' }, h('div', { class: 'ink2' }, d.tooBig ? L('Файл слишком большой для редактора ({0}, можно до 2 МБ).', Fmt.bytes(d.size)) : L('Это двоичный файл — его можно только скачать.'))),
          foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, L('Закрыть')), h('button', { class: 'btn primary', type: 'button', onclick: () => { download(p); m.close(); } }, L('Скачать'))],
        });
        return;
      }
      fileEditor(page, Object.assign(d, { root: st.root, unit, onSaved: () => { if (pathDir(p) === st.path) load(); }, onDownload: () => download(p) }));
    } catch (e) {
      toast(L('Не удалось открыть {0}', pathBase(p)), 'bad', e.message + (canSudo && !st.root && /доступ/.test(e.message) ? L('\nВключите «как root».') : ''));
    }
  }

  load().then(() => { if (jump) openFile(jump, jumpUnit); });
  return { el };
}

function fileEditor(page, f) {
  const id = page.id;
  let sha = f.sha || '';
  let saved = f.content || '';
  let before = null; // содержимое до последнего сохранения — для «Вернуть как было»
  const name = pathBase(f.path);
  const isJSON = /\.json$/i.test(name);
  const indent = /\.(json|ya?ml)$/i.test(name) ? '  ' : '\t';
  const ta = h('textarea', { class: 'editor-area', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off' });
  ta.value = saved;
  const stat = h('span', { class: 'muted' });
  const warnBox = h('div');
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, f.isNew ? L('Создать') : L('Сохранить'));
  const restartBtn = f.unit ? h('button', { class: 'btn', type: 'button' }, L('Сохранить и перезапустить {0}', f.unit.replace(/\.service$/, ''))) : null;
  const undoBtn = h('button', { class: 'btn ghost left', type: 'button', hidden: true }, L('Вернуть как было'));
  const dirty = () => ta.value !== saved;
  const meta = f.isNew ? L('новый файл') : [Fmt.bytes(f.size), fmtMode('f', f.mode), `${f.user}:${f.group}`, L('изменён ') + fileTime(f.mtime)].join(' · ');

  function upd() {
    const lines = ta.value.split('\n').length;
    stat.textContent = `${lines} ${Fmt.plural(lines, 'строка', 'строки', 'строк')}` + (dirty() ? L(' · есть несохранённые изменения') : '');
    saveBtn.disabled = !dirty() && !f.isNew;
    if (restartBtn) restartBtn.disabled = false;
  }
  ta.addEventListener('input', upd);
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const s0 = ta.selectionStart, s1 = ta.selectionEnd;
      ta.setRangeText(indent, s0, s1, 'end');
      upd();
    }
  });

  const m = modal({
    title: name, cls: 'editor',
    lead: h('span', null, h('span', { class: 'mono' }, f.path), ' · ', meta, f.root ? L(' · как root') : ''),
    body: h('div', { class: 'editor-body' }, warnBox, ta, h('div', { class: 'editor-status' }, stat, h('span', { class: 'muted' }, L('⌘S — сохранить')))),
    foot: [undoBtn, f.onDownload ? h('button', { class: 'btn ghost', type: 'button', onclick: () => f.onDownload() }, L('Скачать')) : null,
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, L('Закрыть')), restartBtn, saveBtn],
    beforeClose: () => {
      if (!dirty()) return true;
      confirmDialog({ title: L('Закрыть без сохранения?'), text: L('Изменения в файле будут потеряны.'), ok: L('Закрыть'), danger: true }).then((ok) => { if (ok) m.close(true); });
      return false;
    },
  });
  upd();
  setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 50);

  async function write(content, expectSha) {
    return api(`/servers/${encodeURIComponent(id)}/files/write${f.root ? '?root=1' : ''}`, { method: 'POST', body: { path: f.path, content, sha: expectSha } });
  }

  async function save(restart) {
    const text = ta.value;
    warnBox.replaceChildren();
    if (isJSON && text.trim()) {
      try { JSON.parse(text); } catch (e) {
        const ok = await confirmDialog({ title: L('В JSON есть ошибка'), text: e.message, warn: L('Программа может не запуститься с таким файлом (если только она не допускает комментарии в JSON, как xray).'), ok: L('Сохранить всё равно'), danger: true });
        if (!ok) return;
      }
    }
    saveBtn.disabled = true;
    try {
      const r = await write(text, f.isNew ? '' : sha);
      before = f.isNew ? null : saved;
      sha = r.sha;
      saved = text;
      f.isNew = false;
      saveBtn.textContent = L('Сохранить');
      undoBtn.hidden = before === null;
      toast(L('{0} сохранён', name));
      if (f.onSaved) f.onSaved();
      if (restart && f.unit) {
        const ok = await serviceAction(page, f.unit, 'restart', L('Клиенты VPN на несколько секунд потеряют соединение.'));
        if (ok) warnBox.replaceChildren(h('div', { class: 'alert good-alert' }, L('Служба {0} перезапущена. Проверьте журнал, что она запустилась без ошибок.', f.unit.replace(/\.service$/, ''))));
      }
    } catch (e) {
      warnBox.replaceChildren(h('div', { class: 'alert bad' }, L('Не сохранено: ') + e.message));
    }
    upd();
  }
  saveBtn.addEventListener('click', () => save(false));
  if (restartBtn) restartBtn.addEventListener('click', () => save(true));
  undoBtn.addEventListener('click', async () => {
    if (before === null) return;
    const ok = await confirmDialog({ title: L('Вернуть файл как было?'), text: L('На сервер будет записано содержимое до вашего последнего сохранения.'), ok: L('Вернуть') });
    if (!ok) return;
    try {
      const r = await write(before, sha);
      sha = r.sha;
      saved = before;
      ta.value = before;
      before = null;
      undoBtn.hidden = true;
      toast(L('{0}: возвращено как было', name));
      if (f.onSaved) f.onSaved();
    } catch (e) { warnBox.replaceChildren(h('div', { class: 'alert bad' }, L('Не получилось: ') + e.message)); }
    upd();
  });
}

/* ---------- вкладка «VPN» ---------- */
function vpnTab(page) {
  const id = page.id;
  const st = { data: null, timer: 0, busy: false, dead: false, open: new Set() };
  const k = { svc: kpiTile(L('VPN-службы')), conns: kpiTile(L('TCP-соединения клиентов')), ips: kpiTile(L('Клиентские IP')), wg: kpiTile('WireGuard / AmneziaWG') };
  const listEl = h('div', { class: 'vlist' });
  const stoppedEl = h('div');
  const errBox = h('div');
  const upd = h('span', { class: 'count' });
  const el = h('div', null,
    h('div', { class: 'grid kpis' }, Object.values(k).map((t) => t.el)),
    h('div', { class: 'toolbar' }, h('span', { class: 'ink2', style: { fontSize: '13px' } }, L('Службы VPN и прокси, найденные по названию')), h('span', { class: 'grow' }), upd,
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), L('Обновить'))),
    errBox, listEl, stoppedEl);

  const short = (u) => u.replace(/\.service$/, '');
  const openLogs = (unit) => { page.logUnit = unit; location.hash = `#/s/${encodeURIComponent(id)}/logs`; };
  const openConfig = (path, unit) => { page.filePath = path; page.fileUnit = unit || ''; location.hash = `#/s/${encodeURIComponent(id)}/files`; };

  async function load() {
    if (st.busy || st.dead) return;
    st.busy = true;
    clearTimeout(st.timer);
    if (!st.data) listEl.replaceChildren(h('div', { class: 'card empty' }, h('span', { class: 'spinner' }), NB + L(' Собираю сведения о VPN-службах…')));
    try {
      st.data = await api(`/servers/${encodeURIComponent(id)}/vpn`);
      errBox.replaceChildren(st.data.privileged ? '' : h('div', { class: 'alert warn', style: { marginBottom: '12px' } }, icon('warn'),
        h('div', null, L('Нет прав root или sudo без пароля — порты служб и пиры WireGuard могут быть видны не полностью.'))));
      render();
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
    }
    st.busy = false;
    if (!st.dead) st.timer = setTimeout(() => { if (document.hidden) { st.timer = setTimeout(load, 5000); } else load(); }, 15000);
  }

  function portChip(p) {
    const local = p.addr === '127.0.0.1' || p.addr === '::1' || p.addr === 'localhost';
    const label = `${p.proto.toUpperCase()} ${p.port}`;
    const extra = p.proto === 'tcp' && !local ? (p.conns ? ` · ${Fmt.int(p.conns)} ${Fmt.plural(p.conns, 'соединение', 'соединения', 'соединений')}${p.ips ? ` · ${p.ips} IP` : ''}` : L(' · нет соединений')) : local ? L(' · только локально') : '';
    return h('span', { class: 'pchip' + (local ? ' dim' : ''), title: `${p.addr || '*'}:${p.port}` }, h('b', null, label), extra);
  }

  function wgBlock(w) {
    const showAll = st.open.has(w.name);
    const peers = showAll ? w.list : w.list.slice(0, 8);
    const now = Date.now();
    return h('div', { class: 'wg' },
      h('div', { class: 'wg-head' }, h('b', null, w.name), w.port ? h('span', { class: 'muted' }, L('порт {0}', w.port)) : null,
        h('span', null, L('пиров {0}, активны {1}', w.peers, w.active)), h('span', { class: 'muted' }, `↓ ${Fmt.bytes(w.rx)} · ↑ ${Fmt.bytes(w.tx)}`)),
      w.list.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, L('Пир')), h('th', null, L('Адрес')), h('th', null, L('Разрешённые IP')), h('th', null, L('Рукопожатие')), h('th', { class: 'num' }, '↓ / ↑'))),
        h('tbody', null, peers.map((p) => {
          const age = p.handshake ? (now - p.handshake) / 1000 : null;
          return h('tr', null,
            h('td', { class: 'mono' }, p.key),
            h('td', { class: 'mono' }, p.endpoint || '—'),
            h('td', { class: 'mono' }, p.allowed || '—'),
            h('td', null, h('span', { class: 'st ' + (age != null && age < 180 ? 'good' : 'idle') }, h('span', { class: 'dot' }), age == null ? L('не было') : Fmt.dur(age) + L(' назад'))),
            h('td', { class: 'num' }, `${Fmt.bytes(p.rx)} / ${Fmt.bytes(p.tx)}`));
        })))) : null,
      w.list.length > 8 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { if (showAll) st.open.delete(w.name); else st.open.add(w.name); render(); } },
        showAll ? L('Свернуть') : L('Показать всех ({0})', w.list.length)) : null);
  }

  function card(s) {
    const [cls, text] = serviceState(s);
    const ports = s.ports.filter((p) => !p.eph);
    const eph = s.ports.length - ports.length;
    const stats = [
      s.since ? [L('Работает'), Fmt.dur(s.since)] : null,
      s.mem ? [L('Память'), Fmt.bytes(s.mem)] : null,
      s.cpuSec ? [L('Время CPU'), Fmt.dur(s.cpuSec)] : null,
      [L('Перезапусков'), String(s.restarts || 0)],
      s.version ? [L('Версия'), s.version] : null,
      s.pid ? ['PID', String(s.pid)] : null,
    ].filter(Boolean);
    return h('div', { class: 'card vcard' },
      h('div', { class: 'vhead' },
        h('div', { class: 'vname' }, h('b', null, short(s.unit)), h('span', { class: 'st ' + cls }, h('span', { class: 'dot' }), text),
          s.restarts > 0 ? h('span', { class: 'badge warn', title: L('systemd перезапускал службу после сбоев') }, L('перезапусков: {0}', s.restarts)) : null),
        h('div', { class: 'vact' },
          s.config ? h('button', { class: 'btn sm', type: 'button', title: s.config, onclick: () => openConfig(s.config, s.unit) }, L('Конфиг')) : null,
          h('button', { class: 'btn sm', type: 'button', onclick: () => openLogs(s.unit) }, L('Журнал')),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await serviceAction(page, s.unit, 'restart', L('Клиенты VPN на несколько секунд потеряют соединение.'))) load(); } }, L('Перезапустить')))),
      s.description && s.description !== s.unit ? h('div', { class: 'vdesc' }, s.description) : null,
      h('div', { class: 'vstats' }, stats.map(([a, b]) => h('span', null, h('span', { class: 'muted' }, a + ' '), b))),
      ports.length || eph ? h('div', { class: 'pchips' }, ports.map(portChip), eph ? h('span', { class: 'muted', style: { fontSize: '12px', alignSelf: 'center' } }, L('+ {0} исходящих UDP-сокетов', eph)) : null) : null,
      s.config ? h('div', { class: 'vline' }, h('span', { class: 'muted' }, L('Конфиг ')), h('span', { class: 'mono' }, s.config)) : null,
      s.exec ? h('div', { class: 'vline', title: s.exec }, h('span', { class: 'muted' }, L('Команда ')), h('span', { class: 'mono' }, s.exec)) : null,
      (s.wg || []).map(wgBlock));
  }

  function render() {
    const d = st.data;
    const all = d.services || [];
    const running = all.filter((s) => !unitBad(s) && (s.active === 'active' || s.active === 'activating' || s.active === 'reloading'));
    const stopped = all.filter((s) => !running.includes(s));
    const conns = all.reduce((a, s) => a + s.ports.reduce((b, p) => b + (p.conns || 0), 0), 0);
    const ips = all.reduce((a, s) => a + s.ports.reduce((b, p) => b + (p.ips || 0), 0), 0);
    const failed = all.filter(unitBad);
    k.svc.set(String(running.length), L(' из {0}', all.length), failed.length ? L('с ошибкой: {0}', failed.map((s) => short(s.unit)).join(', ')) : stopped.length ? L('остановлены: {0}', stopped.map((s) => short(s.unit)).join(', ')) : L('все работают'), null);
    k.conns.set(Fmt.int(conns), '', L('установленные TCP-соединения на портах VPN'), null);
    k.ips.set(Fmt.int(ips), '', L('разные адреса, по каждому порту отдельно'), null);
    const wg = d.wg || [];
    const wgPeers = wg.reduce((a, w) => a + w.peers, 0), wgActive = wg.reduce((a, w) => a + w.active, 0);
    k.wg.set(wg.length ? `${wgActive}` : '—', wg.length ? L(' из {0}', wgPeers) : '', wg.length ? L('активных пиров на {0} {1}', wg.length, Fmt.plural(wg.length, 'интерфейсе', 'интерфейсах', 'интерфейсах')) : L('интерфейсов не найдено'), null);
    upd.textContent = L('обновлено ') + Fmt.clock(d.t, true);

    // интерфейсы WireGuard без своей службы (например, поднятые вручную)
    const own = new Set(all.flatMap((s) => (s.wg || []).map((w) => w.name)));
    const loose = wg.filter((w) => !own.has(w.name));

    if (!all.length && !loose.length) {
      listEl.replaceChildren(h('div', { class: 'card empty' }, h('b', null, L('VPN-службы не найдены')),
        L('Панель ищет службы systemd с названиями xray, sing-box, hysteria, AmneziaWG, WireGuard, mtg, OpenVPN и других.')));
      stoppedEl.replaceChildren();
      return;
    }
    listEl.replaceChildren(...running.map(card), ...failed.map(card),
      loose.length ? h('div', { class: 'card vcard' }, h('div', { class: 'vhead' }, h('div', { class: 'vname' }, h('b', null, L('Интерфейсы WireGuard')))), loose.map(wgBlock)) : '');
    const idle = stopped.filter((s) => !unitBad(s));
    stoppedEl.replaceChildren(idle.length ? h('div', null,
      h('div', { class: 'section-title' }, L('Остановлены ({0})', idle.length)),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('tbody', null, idle.map((s) => h('tr', null,
        h('td', { class: 'name-cell' }, h('b', null, short(s.unit)), h('div', { class: 'desc' }, s.description || NB)),
        h('td', null, h('span', { class: 'st idle' }, h('span', { class: 'dot' }), ENABLED_TEXT[s.enabled] ? L('автозапуск {0}', ENABLED_TEXT[s.enabled]) : L('остановлена'))),
        h('td', { class: 'actions' },
          s.config ? h('button', { class: 'btn sm', type: 'button', onclick: () => openConfig(s.config) }, L('Конфиг')) : null,
          h('button', { class: 'btn sm', type: 'button', onclick: () => openLogs(s.unit) }, L('Журнал')),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await serviceAction(page, s.unit, 'start')) load(); } }, L('Запустить'))))))))) : '');
  }

  load();
  return { el, destroy() { st.dead = true; clearTimeout(st.timer); } };
}

/* ---------- вкладка «Журнал» ---------- */
function logsTab(page) {
  const id = page.id;
  const st = { unit: page.logUnit || '', prio: '', lines: 300, follow: false, q: '', entries: [], cursor: '', timer: 0, dead: false, busy: false, plain: false };
  page.logUnit = '';
  const box = h('div', { class: 'logbox', role: 'log' });
  const errBox = h('div');
  const count = h('span', { class: 'count' });
  const dl = h('datalist', { id: 'units-' + id.replace(/[^a-z0-9]/gi, '') });
  const unitIn = h('input', { class: 'input', style: { width: '220px' }, placeholder: L('Все службы'), list: dl.id, value: st.unit.replace(/\.service$/, '') });
  unitIn.addEventListener('change', () => { st.unit = unitIn.value.trim(); reload(); });
  const prioSel = h('select', { class: 'input', onchange: (e) => { st.prio = e.target.value; reload(); } },
    h('option', { value: '' }, L('Все уровни')), h('option', { value: '4' }, L('Предупреждения и выше')), h('option', { value: '3' }, L('Только ошибки')));
  const linesSel = h('select', { class: 'input', onchange: (e) => { st.lines = +e.target.value; reload(); } },
    [200, 300, 1000, 3000].map((n) => h('option', { value: String(n), selected: n === st.lines }, L('{0} строк', n))));
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      unitIn, dl, prioSel, linesSel,
      h('input', { class: 'input', type: 'search', placeholder: L('Фильтр по тексту'), style: { width: '200px' }, oninput: (e) => { st.q = e.target.value.toLowerCase(); render(); } }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { st.follow = e.target.checked; schedule(); } }), L('Следить')),
      h('span', { class: 'grow' }), count,
      h('button', { class: 'btn sm', type: 'button', onclick: reload }, icon('refresh'), L('Обновить'))),
    errBox, box);

  const fillUnits = (list) => dl.replaceChildren(h('option', { value: 'kernel' }, L('Сообщения ядра')), ...list.map((s) => h('option', { value: s.unit.replace(/\.service$/, '') })));
  if (page.services) fillUnits(page.services);
  else api(`/servers/${encodeURIComponent(id)}/services`).then((d) => { page.services = d.services || []; fillUnits(page.services); }, () => {});

  function schedule() {
    clearTimeout(st.timer);
    if (st.follow && !st.dead) st.timer = setTimeout(() => load(true), 2500);
  }

  function reload() { st.entries = []; st.cursor = ''; box.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), NB + L(' Загрузка журнала…'))); load(false); }

  async function load(more) {
    if (st.busy) return;
    st.busy = true;
    const qs = new URLSearchParams({ lines: String(more ? 500 : st.lines) });
    if (st.unit) qs.set('unit', st.unit === 'kernel' || st.unit.endsWith('.service') ? st.unit : st.unit + '.service');
    if (st.prio) qs.set('prio', st.prio);
    if (more && st.cursor) qs.set('after', st.cursor);
    try {
      const d = await api(`/servers/${encodeURIComponent(id)}/logs?${qs}`);
      if (st.dead) return;
      st.plain = !!d.plain;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      st.entries = more ? st.entries.concat(d.entries) : d.entries;
      if (st.entries.length > 5000) st.entries = st.entries.slice(-5000);
      if (d.cursor) st.cursor = d.cursor;
      errBox.replaceChildren(d.notes && d.notes.length && !d.entries.length && !more ? h('div', { class: 'alert warn', style: { marginBottom: '12px' } }, d.notes.join(' ')) : '');
      render(!more || atBottom);
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
    }
    st.busy = false;
    schedule();
  }

  function badge(p) {
    if (p <= 2) return h('span', { class: 'badge crit' }, L('крит.'));
    if (p === 3) return h('span', { class: 'badge crit' }, L('ошибка'));
    if (p === 4) return h('span', { class: 'badge warn' }, L('внимание'));
    return h('span');
  }

  function render(scroll) {
    let list = st.entries;
    if (st.q) list = list.filter((e) => e.m.toLowerCase().includes(st.q) || (e.id || '').toLowerCase().includes(st.q));
    count.textContent = L('{0} записей', list.length);
    const frag = document.createDocumentFragment();
    for (const e of list) {
      if (st.plain) { frag.append(h('div', { class: 'log-plain' }, e.m)); continue; }
      frag.append(h('div', { class: 'log-line p' + e.p },
        h('span', { class: 'log-time', title: new Date(e.t).toLocaleString(I18N.locale) }, Fmt.dateTime(e.t)),
        badge(e.p),
        h('span', { class: 'log-id', title: (e.u || '') + (e.pid ? ' · PID ' + e.pid : '') }, e.id || e.u || ''),
        h('span', { class: 'log-msg' }, e.m)));
    }
    box.replaceChildren(frag);
    if (!list.length) box.append(h('div', { class: 'empty' }, L('Записей нет')));
    if (scroll) box.scrollTop = box.scrollHeight;
  }

  reload();
  return { el, destroy() { st.dead = true; clearTimeout(st.timer); } };
}

/* ---------- вкладка «Сеть» ---------- */
function networkTab(page) {
  const id = page.id;
  const st = { timer: 0, dead: false, busy: false };
  const k = { rx: kpiTile(L('Входящий трафик')), tx: kpiTile(L('Исходящий трафик')), est: kpiTile(L('Установленные TCP')), peers: kpiTile(L('Уникальные адреса')) };
  const inEl = h('div', { class: 'list-bars' });
  const outEl = h('div', { class: 'list-bars' });
  const peersEl = h('div', { class: 'list-bars' });
  const listenBody = h('tbody');
  const ifBody = h('tbody');
  const errBox = h('div');
  const el = h('div', null,
    h('div', { class: 'grid kpis' }, Object.values(k).map((t) => t.el)),
    errBox,
    h('div', { class: 'grid three' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Входящие подключения')), h('div', { class: 'card-sub' }, L('по локальному порту')))), inEl),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Исходящие подключения')), h('div', { class: 'card-sub' }, L('по удалённому порту')))), outEl),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Активные адреса')), h('div', { class: 'card-sub' }, L('больше всего TCP-соединений')))), peersEl)),
    h('div', { class: 'grid two', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, L('Открытые порты')), h('div', { class: 'right' }, h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), L('Обновить')))),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, L('Протокол')), h('th', null, L('Адрес')), h('th', { class: 'num' }, L('Порт')), h('th', null, L('Процесс')))), listenBody))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, L('Сетевые интерфейсы'))),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, L('Интерфейс')), h('th', { class: 'num' }, '↓'), h('th', { class: 'num' }, '↑'), h('th', { class: 'num' }, L('Всего ↓ / ↑')))), ifBody)))));

  function bars(target, list, fmtKey) {
    const max = Math.max(1, ...list.map((x) => x.count));
    target.replaceChildren(...list.map((x) => {
      const m = meter((x.count / max) * 100);
      m.el.classList.remove('warn', 'crit');
      return h('div', { class: 'lb' }, h('span', { class: 'lb-k' }, fmtKey(x.key)), h('span', { class: 'lb-v' }, Fmt.int(x.count)), m.el);
    }));
    if (!list.length) target.replaceChildren(h('div', { class: 'muted' }, L('нет соединений')));
  }

  function live(m) {
    if (!m) return;
    k.rx.set(Fmt.bits(m.netRx * 8), '', L('сейчас'), null);
    k.tx.set(Fmt.bits(m.netTx * 8), '', L('сейчас'), null);
    renderIfaces(ifBody, m);
  }

  async function load() {
    if (st.busy) return;
    st.busy = true;
    clearTimeout(st.timer);
    try {
      const d = await api(`/servers/${encodeURIComponent(id)}/network`);
      if (st.dead) return;
      errBox.replaceChildren();
      k.est.set(Fmt.int(d.established), '', L('входящих {0} · исходящих {1}', Fmt.int(d.inbound), Fmt.int(d.outbound)), null);
      k.peers.set(Fmt.int(d.uniquePeers), '', L('IP-адресов с активными TCP'), null);
      bars(inEl, d.localPorts || [], (p) => L('порт ') + p);
      bars(outEl, d.remotePorts || [], (p) => L('порт ') + p);
      bars(peersEl, d.peers || [], (p) => p);
      listenBody.replaceChildren(...(d.listen || []).map((l) => h('tr', null,
        h('td', null, l.proto), h('td', { class: 'mono' }, l.addr), h('td', { class: 'num' }, l.port),
        h('td', { class: 'ink2' }, (l.procs || []).join(', ') || '—'))));
      if (!(d.listen || []).length) listenBody.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'muted' }, L('нет данных (нужны права root или sudo)'))));
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
    }
    st.busy = false;
    if (!st.dead) st.timer = setTimeout(load, 10000);
  }

  live(page.srv && page.srv.latest);
  load();
  return { el, onFrame(p, m) { live(m); }, destroy() { st.dead = true; clearTimeout(st.timer); } };
}

/* ---------- вкладка «Docker» ---------- */
function dockerTab(page) {
  const id = page.id;
  const st = { timer: 0, dead: false, busy: false };
  const tbody = h('tbody');
  const errBox = h('div');
  const el = h('div', null,
    h('div', { class: 'toolbar' }, h('span', { class: 'grow' }), h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), L('Обновить'))),
    errBox,
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, L('Контейнер')), h('th', null, L('Состояние')), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, L('Память')), h('th', null, L('Порты')), h('th'))), tbody)));

  async function load() {
    if (st.busy) return;
    st.busy = true;
    clearTimeout(st.timer);
    try {
      const d = await api(`/servers/${encodeURIComponent(id)}/docker`);
      if (st.dead) return;
      errBox.replaceChildren();
      const stats = new Map();
      for (const s of d.stats || []) { stats.set(s.ID || s.Container, s); if (s.Name) stats.set(s.Name, s); }
      tbody.replaceChildren(...(d.containers || []).map((c) => {
        const s = stats.get(c.ID) || stats.get(c.Names) || {};
        const running = c.State === 'running';
        const cls = running ? 'good' : c.State === 'paused' || c.State === 'restarting' ? 'warn' : c.State === 'exited' && !/\(0\)/.test(c.Status || '') ? 'bad' : 'idle';
        const name = (c.Names || c.ID || '').split(',')[0];
        return h('tr', null,
          h('td', { class: 'name-cell' }, h('b', null, name), h('div', { class: 'desc', title: c.Image }, c.Image)),
          h('td', null, h('span', { class: 'st ' + cls }, h('span', { class: 'dot' }), c.Status || c.State)),
          h('td', { class: 'num' }, s.CPUPerc || '—'),
          h('td', { class: 'num' }, s.MemUsage ? s.MemUsage.split('/')[0].trim() : '—'),
          h('td', { class: 'mono', style: { fontSize: '12px', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: c.Ports }, c.Ports || '—'),
          h('td', { class: 'actions' },
            h('button', { class: 'btn sm', type: 'button', onclick: () => logs(name) }, L('Логи')),
            h('button', { class: 'btn sm', type: 'button', onclick: () => act(name, 'restart') }, L('Перезапустить')),
            running ? h('button', { class: 'btn sm', type: 'button', onclick: () => act(name, 'stop') }, L('Остановить'))
              : h('button', { class: 'btn sm', type: 'button', onclick: () => act(name, 'start') }, L('Запустить'))));
      }));
      if (!(d.containers || []).length) tbody.replaceChildren(h('tr', null, h('td', { colspan: '6', class: 'empty' }, L('Контейнеров нет'))));
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
    }
    st.busy = false;
    if (!st.dead) st.timer = setTimeout(load, 15000);
  }

  async function act(name, action) {
    if (action !== 'start') {
      const ok = await confirmDialog({ title: L('{0} контейнер «{1}»?', action === 'stop' ? L('Остановить') : L('Перезапустить'), name), ok: action === 'stop' ? L('Остановить') : L('Перезапустить'), danger: action === 'stop' });
      if (!ok) return;
    }
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/docker/action`, { method: 'POST', body: { container: name, action } });
      r.ok ? toast(L('Контейнер {0}: готово', name)) : toast(L('Контейнер {0}: ошибка', name), 'bad', r.error);
    } catch (e) { toast(e.message, 'bad'); }
    load();
  }

  async function logs(name) {
    const pre = h('pre', { class: 'pre' }, L('Загрузка…'));
    const closeBtn = h('button', { class: 'btn', type: 'button' }, L('Закрыть'));
    const md = modal({ title: L('Логи контейнера {0}', name), lead: L('Последние 500 строк'), body: pre, wide: true, foot: [closeBtn] });
    closeBtn.addEventListener('click', () => md.close());
    try {
      const d = await api(`/servers/${encodeURIComponent(id)}/docker/logs?container=${encodeURIComponent(name)}`);
      pre.textContent = d.output || L('(пусто)');
      pre.scrollTop = pre.scrollHeight;
    } catch (e) { pre.textContent = e.message; }
  }

  load();
  return { el, destroy() { st.dead = true; clearTimeout(st.timer); } };
}

/* ---------- вкладка «Консоль» ---------- */
const QUICK = ['uptime', 'free -h', 'df -h', 'systemctl --failed', 'top -bn1 | head -25', 'journalctl -p 3 -n 30 --no-pager', 'apt list --upgradable 2>/dev/null', 'last -n 15', 'ss -s'];

/* ---------- вкладка «Система»: обновления и безопасность ---------- */
const SSHD_ROWS = [
  ['port', L('Порт')], ['listenaddress', L('Адреса')], ['permitrootlogin', L('Вход под root')], ['passwordauthentication', L('Вход по паролю')],
  ['kbdinteractiveauthentication', L('Интерактивный вход')], ['pubkeyauthentication', L('Вход по ключу')], ['permitemptypasswords', L('Пустые пароли')],
  ['maxauthtries', L('Попыток за подключение')], ['x11forwarding', 'X11 forwarding'], ['allowusers', L('Разрешённые пользователи')], ['allowgroups', L('Разрешённые группы')],
];
const SSHD_VAL = { yes: L('да'), no: L('нет'), 'prohibit-password': L('только по ключу'), 'without-password': L('только по ключу'), 'forced-commands-only': L('только заданные команды') };

function sshdRisk(k, v) {
  if (k === 'permitemptypasswords' && v === 'yes') return ['bad', L('опасно')];
  if (k === 'passwordauthentication' && v === 'yes') return ['warn', L('лучше выключить: подбор паролей')];
  if (k === 'kbdinteractiveauthentication' && v === 'yes') return ['warn', L('может принимать пароли')];
  if (k === 'permitrootlogin' && v === 'yes') return ['warn', L('root может входить по паролю')];
  return null;
}

function systemTab(page) {
  const id = page.id;
  const st = { d: null, busy: false, dead: false, job: '', jobT: 0, showAll: false };
  const errBox = h('div');
  const body = h('div', null, h('div', { class: 'card empty' }, h('span', { class: 'spinner' }), NB + L(' Собираю сведения о системе…')));
  const jobBox = h('div');
  const el = h('div', null,
    h('div', { class: 'toolbar' }, h('span', { class: 'ink2', style: { fontSize: '13px' } }, L('Обновления пакетов, настройки SSH, попытки входа, fail2ban и ufw')), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), L('Обновить'))),
    errBox, jobBox, body);

  async function load() {
    if (st.busy || st.dead) return;
    st.busy = true;
    try {
      st.d = await api(`/servers/${encodeURIComponent(id)}/system`);
      errBox.replaceChildren(st.d.privileged ? '' : h('div', { class: 'alert warn', style: { marginBottom: '12px' } }, icon('warn'),
        h('div', null, L('Нет прав root или sudo без пароля — часть сведений (sshd, fail2ban, журнал входов) недоступна, обновлять пакеты нельзя.'))));
      render();
      if (st.d.job && !st.job) watchJob(st.d.job);
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
      body.replaceChildren();
    }
    st.busy = false;
  }

  const ago = (ms) => (ms ? Fmt.dur((Date.now() - ms) / 1000) + L(' назад') : L('неизвестно'));

  function updatesCard(d) {
    if (!d.apt) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, L('Обновления')), h('div', { class: 'muted', style: { marginTop: '8px' } }, L('На сервере нет apt — обновления этой системы панель не показывает.')));
    const n = d.upgrades.length;
    const list = st.showAll ? d.upgrades : d.upgrades.slice(0, 12);
    const auto = d.autoUpgrade && d.unattended && d.unattended.startsWith('enabled');
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('div', { class: 'card-title' }, L('Обновления пакетов')),
          h('div', { class: 'card-sub' }, L('список пакетов обновлён {0} · последняя установка {1}', ago(d.lastUpdate), ago(d.lastUpgrade)))),
        h('div', { class: 'vact' },
          h('button', { class: 'btn sm', type: 'button', disabled: !d.privileged || !!st.job, onclick: () => startJob('update') }, L('Проверить обновления')),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !d.privileged || !!st.job || !n, onclick: () => startJob('upgrade') }, L('Установить обновления')))),
      h('div', { class: 'sys-kpis' },
        h('div', null, h('div', { class: 'kpi-value' }, String(n)), h('div', { class: 'kpi-sub' }, n ? Fmt.plural(n, 'пакет можно обновить', 'пакета можно обновить', 'пакетов можно обновить') : L('всё обновлено'))),
        h('div', null, h('div', { class: 'kpi-value' + (d.security ? ' crit-ink' : '') }, String(d.security)), h('div', { class: 'kpi-sub' }, L('из них — исправления безопасности'))),
        h('div', null, h('div', { class: 'kpi-value small' }, h('span', { class: 'st ' + (auto ? 'good' : 'warn') }, h('span', { class: 'dot' }), auto ? L('включены') : L('выключены'))),
          h('div', { class: 'kpi-sub' }, L('автоматические обновления безопасности')))),
      d.reboot ? h('div', { class: 'alert warn', style: { alignItems: 'center' } }, icon('warn'),
        h('div', { style: { flex: 1 } }, L('Нужна перезагрузка, чтобы применились обновления') + (d.rebootPkgs && d.rebootPkgs.length ? ': ' + d.rebootPkgs.slice(0, 6).join(', ') + (d.rebootPkgs.length > 6 ? L(' и ещё {0}', d.rebootPkgs.length - 6) : '') : '') + '.'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => rebootDialog(page.srv) }, L('Перезагрузить…'))) : null,
      n ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, L('Пакет')), h('th', null, L('Сейчас')), h('th', null, L('Новая версия')), h('th'))),
        h('tbody', null, list.map((p) => h('tr', null,
          h('td', null, h('b', null, p.name)), h('td', { class: 'mono muted' }, p.from), h('td', { class: 'mono' }, p.to),
          h('td', null, p.security ? h('span', { class: 'badge crit' }, L('безопасность')) : null)))))) : null,
      n > 12 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.showAll = !st.showAll; render(); } }, st.showAll ? L('Свернуть') : L('Показать все ({0})', n)) : null);
  }

  function sshCard(d) {
    const keys = SSHD_ROWS.filter(([k]) => d.sshd[k]);
    if (!keys.length) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, L('SSH-сервер')), h('div', { class: 'muted', style: { marginTop: '8px' } }, L('Настройки sshd прочитать не удалось (нужны права root).')));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('SSH-сервер')), h('div', { class: 'card-sub' }, L('действующие настройки (sshd -T)')))),
      h('dl', { class: 'kv sys-kv' }, keys.flatMap(([k, label]) => {
        const v = d.sshd[k];
        const risk = sshdRisk(k, v);
        return [h('dt', null, label), h('dd', null, SSHD_VAL[v] || v, risk ? h('span', { class: 'badge ' + (risk[0] === 'bad' ? 'crit' : 'warn'), style: { marginLeft: '8px' } }, risk[1]) : null)];
      })));
  }

  function authCard(d) {
    const row = (it, max) => h('div', { class: 'bar-row' }, h('span', { class: 'mono bar-k', title: it.key }, it.key),
      h('span', { class: 'bar' }, h('i', { style: { width: Math.max(2, (it.n / max) * 100) + '%' } })), h('span', { class: 'bar-n' }, Fmt.int(it.n)));
    const maxIP = Math.max(1, ...d.authIps.map((x) => x.n)), maxU = Math.max(1, ...d.authUsers.map((x) => x.n));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Входы по SSH за 24 часа')),
        h('div', { class: 'card-sub' }, L('неудачных попыток {0} · успешных входов {1}', Fmt.int(d.authFail), Fmt.int(d.authOk))))),
      d.authFail ? h('div', { class: 'grid two', style: { gap: '20px' } },
        h('div', null, h('div', { class: 'mini-title' }, L('Чаще всего с адресов')), d.authIps.map((x) => row(x, maxIP))),
        h('div', null, h('div', { class: 'mini-title' }, L('Пробовали пользователей')), d.authUsers.map((x) => row(x, maxU)))) : h('div', { class: 'muted' }, L('Неудачных попыток не было.')),
      d.accepted.length ? h('div', { style: { marginTop: '14px' } }, h('div', { class: 'mini-title' }, L('Успешные входы (последние)')),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl compact' }, h('tbody', null, d.accepted.map((a) => h('tr', null,
          h('td', null, h('b', null, a.user)), h('td', { class: 'mono' }, a.ip), h('td', { class: 'muted' }, a.method === 'publickey' ? L('по ключу') : a.method === 'password' ? L('по паролю') : a.method),
          h('td', { class: 'num muted' }, a.n > 1 ? L('{0} раз', a.n) : ''),
          h('td', { class: 'muted nowrap' }, a.time ? L('последний ') + Fmt.dateTime(Date.parse(a.time), false) : ''))))))) : null);
  }

  function f2bCard(d) {
    if (!d.f2b) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'fail2ban'), h('div', { class: 'muted', style: { marginTop: '8px' } }, L('Не установлен. Он блокирует адреса, с которых подбирают пароли (apt install fail2ban).')));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'fail2ban'),
        h('div', { class: 'card-sub' }, h('span', { class: 'st ' + (d.f2bActive === 'active' ? 'good' : 'bad') }, h('span', { class: 'dot' }), d.f2bActive === 'active' ? L('работает') : (d.f2bActive || L('не запущен')))))),
      d.jails.length ? d.jails.map((j) => h('div', { class: 'jail' },
        h('div', { class: 'jail-head' }, h('b', null, j.name), h('span', { class: 'muted' }, L('заблокировано сейчас {0} · всего {1} · ошибок сейчас {2}', j.banned, j.totalBanned, j.failed))),
        j.ips.length ? h('div', { class: 'pchips' }, j.ips.slice(0, 60).map((ip) => h('span', { class: 'pchip' }, h('span', { class: 'mono' }, ip),
          h('button', { class: 'linkbtn', type: 'button', title: L('Разблокировать'), onclick: () => unban(j.name, ip) }, L('разбан')))),
        j.ips.length > 60 ? h('span', { class: 'muted', style: { fontSize: '12px' } }, L('и ещё {0}', j.ips.length - 60)) : null) : null)) : h('div', { class: 'muted' }, d.privileged ? L('Активных jail нет.') : L('Нужны права root.')));
  }

  function fwCard(d) {
    if (!d.ufw) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, L('Файрвол ufw')), h('div', { class: 'muted', style: { marginTop: '8px' } }, L('ufw не установлен (правила nftables/iptables панель не разбирает).')));
    const on = d.ufwStatus === 'active';
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, L('Файрвол ufw')),
        h('div', { class: 'card-sub' }, h('span', { class: 'st ' + (on ? 'good' : 'idle') }, h('span', { class: 'dot' }), on ? L('включён') : d.ufwStatus === 'inactive' ? L('выключен') : (d.ufwStatus || L('нет данных')))))),
      on && d.ufwText ? h('pre', { class: 'pre', style: { maxHeight: '300px' } }, d.ufwText) : null);
  }

  function render() {
    const d = st.d;
    body.replaceChildren(
      updatesCard(d),
      h('div', { class: 'grid two', style: { marginTop: '16px' } }, sshCard(d), authCard(d)),
      h('div', { class: 'grid two', style: { marginTop: '16px' } }, f2bCard(d), fwCard(d)));
  }

  async function unban(jail, ip) {
    const ok = await confirmDialog({ title: L('Разблокировать {0}?', ip), text: `fail2ban, jail «${jail}».`, ok: L('Разблокировать') });
    if (!ok) return;
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/system/unban`, { method: 'POST', body: { jail, ip } });
      if (r.ok) toast(L('{0} разблокирован', ip)); else toast(L('Не получилось'), 'bad', r.error);
    } catch (e) { toast(e.message, 'bad'); }
    load();
  }

  async function startJob(action) {
    if (action === 'upgrade') {
      const vpn = (page.srv.units || []).filter((u) => u.vpn && u.active === 'active').length;
      const ok = await confirmDialog({
        title: L('Установить обновления на {0}?', page.srv.name),
        text: L('apt-get update и apt-get upgrade. Конфигурационные файлы, которые вы меняли, сохранятся; удалять пакеты apt не будет. Задание работает на сервере само, его можно не ждать.'),
        warn: vpn ? L('Обновление может перезапустить службы, в том числе VPN — клиенты на несколько секунд потеряют связь.') : null,
        ok: L('Установить'),
      });
      if (!ok) return;
    }
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/system/apt`, { method: 'POST', body: { action } });
      if (r.already) toast(L('Обновление уже идёт — показываю его ход'), 'warn');
      watchJob(r.unit);
    } catch (e) { toast(L('Не удалось запустить'), 'bad', e.message); }
  }

  function watchJob(unit) {
    st.job = unit;
    if (st.d) render();
    const pre = h('pre', { class: 'pre job-log' }, '…');
    const head = h('div', { class: 'job-head' }, h('span', { class: 'spinner' }), h('b', null, unit.includes('apt') ? L('Обновление пакетов') : unit), h('span', { class: 'muted' }, L('идёт на сервере')));
    jobBox.replaceChildren(h('div', { class: 'card', style: { marginBottom: '16px' } }, head, pre));
    const poll = async () => {
      if (st.dead) return;
      try {
        const r = await api(`/servers/${encodeURIComponent(id)}/system/job?unit=${encodeURIComponent(unit)}`);
        const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = r.log || '…';
        if (atEnd) pre.scrollTop = pre.scrollHeight;
        if (!r.running) {
          const ok = r.exit === 0;
          head.replaceChildren(h('span', { class: 'st ' + (ok ? 'good' : 'bad') }, h('span', { class: 'dot' }), ok ? L('Готово') : r.exit > 0 ? L('Ошибка (код {0})', r.exit) : L('Задание завершилось')),
            h('span', { class: 'grow' }), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => jobBox.replaceChildren() }, L('Скрыть')));
          st.job = '';
          toast(ok ? L('{0}: пакеты обновлены', page.srv.name) : L('{0}: обновление завершилось с ошибкой', page.srv.name), ok ? 'good' : 'bad');
          load();
          return;
        }
      } catch (e) { pre.textContent += '\n' + e.message; }
      st.jobT = setTimeout(poll, 2500);
    };
    poll();
  }

  load();
  return { el, destroy() { st.dead = true; clearTimeout(st.jobT); } };
}

/* ---------- вкладка «Терминал» ---------- */
let xtermLoading = null;
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (xtermLoading) return xtermLoading;
  const load = (src) => new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = src;
    sc.onload = res;
    sc.onerror = () => { xtermLoading = null; rej(new Error(L('не удалось загрузить ') + src)); };
    document.head.append(sc);
  });
  document.head.append(h('link', { rel: 'stylesheet', href: 'vendor/xterm.css' }));
  xtermLoading = load('vendor/xterm.js').then(() => load('vendor/addon-fit.js'));
  return xtermLoading;
}

function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const base = { background: v('--console'), foreground: v('--ink'), cursor: v('--accent'), cursorAccent: v('--console'), selectionBackground: 'rgba(57, 135, 229, 0.35)' };
  if (effectiveTheme() === 'dark') return base;
  // светлая тема: стандартные цвета xterm (белый, жёлтый) плохо видны на светлом фоне
  return Object.assign(base, {
    black: '#1d1d1b', red: '#c4302b', green: '#2b7a2f', yellow: '#946200', blue: '#1c5cab', magenta: '#8e3fa8', cyan: '#0e7585', white: '#6b6a65',
    brightBlack: '#7a7974', brightRed: '#d03b3b', brightGreen: '#2f8f2f', brightYellow: '#a87200', brightBlue: '#2a78d6', brightMagenta: '#a54fc4', brightCyan: '#13899b', brightWhite: '#3d3c39',
  });
}

const b64bytes = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

function termTab(page) {
  const id = page.id;
  if (!S.termSel) S.termSel = new Map();
  const st = { sid: S.termSel.get(id) || '', sessions: [], term: null, fit: null, es: null, ro: null, queue: [], inflight: false, dead: false, cols: 0, rows: 0, done: false };
  const host = h('div', { class: 'term-host' });
  const statusEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } });
  const sessEl = h('div', { class: 'seg' });
  const closeBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => closeSession() }, L('Завершить сессию'));
  const el = h('div', null,
    h('div', { class: 'toolbar' }, sessEl,
      h('button', { class: 'btn sm', type: 'button', onclick: () => newSession() }, L('+ Новая сессия')),
      statusEl, h('span', { class: 'grow' }), closeBtn),
    host,
    h('div', { class: 'term-hint muted' }, L('Сессия продолжает работать, если уйти со вкладки, и закрывается через 15 минут без подключений. Копирование — выделите текст, вставка — ⌘V.')));

  function setStatus(text, cls) {
    statusEl.replaceChildren(cls ? h('span', { class: 'st ' + cls }, h('span', { class: 'dot' }), text) : text);
  }

  function renderSessions() {
    sessEl.replaceChildren(...st.sessions.map((x, i) => h('button', {
      type: 'button', class: x.id === st.sid ? 'on' : '', title: L('открыта ') + Fmt.dateTime(x.created, false),
      onclick: () => { if (x.id !== st.sid) attach(x.id); },
    }, L('Сессия {0}', i + 1) + (x.done ? L(' · завершена') : ''))));
    sessEl.hidden = st.sessions.length < 2;
    closeBtn.disabled = !st.sid;
  }

  function ensureTerm() {
    if (st.term) return;
    const t = new window.Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
      fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, macOptionIsMeta: true, theme: termTheme(),
    });
    const fit = new window.FitAddon.FitAddon();
    t.loadAddon(fit);
    t.open(host);
    st.term = t;
    st.fit = fit;
    sizeHost();
    t.onData((d) => { if (!st.done) { st.queue.push(d); flush(); } });
    st.ro = new ResizeObserver(() => scheduleFit());
    st.ro.observe(host);
    window.addEventListener('resize', sizeHost);
  }

  function sizeHost() {
    const top = host.getBoundingClientRect().top;
    host.style.height = Math.max(280, window.innerHeight - top - 46) + 'px';
  }

  let fitT = 0;
  function scheduleFit() {
    clearTimeout(fitT);
    fitT = setTimeout(() => {
      if (!st.term || st.dead) return;
      try { st.fit.fit(); } catch (e) { return; }
      const { cols, rows } = st.term;
      if (st.sid && !st.done && (cols !== st.cols || rows !== st.rows)) {
        st.cols = cols; st.rows = rows;
        api(`/term/${st.sid}/resize`, { method: 'POST', body: { cols, rows } }).catch(() => {});
      }
    }, 80);
  }

  async function flush() {
    if (st.inflight || !st.queue.length || !st.sid) return;
    st.inflight = true;
    const d = st.queue.join('');
    st.queue = [];
    try {
      await api(`/term/${st.sid}/input`, { method: 'POST', body: { d } });
    } catch (e) {
      setStatus(e.message, 'bad');
    }
    st.inflight = false;
    if (st.queue.length) flush();
  }

  function attach(sid) {
    if (st.es) { st.es.close(); st.es = null; }
    st.sid = sid;
    st.done = false;
    st.cols = st.rows = 0;
    S.termSel.set(id, sid);
    renderSessions();
    ensureTerm();
    st.term.reset();
    setStatus(L('подключение…'), 'warn');
    const es = new EventSource(`/api/term/${sid}/stream?token=${encodeURIComponent(TOKEN)}`);
    st.es = es;
    es.addEventListener('r', (e) => {
      st.term.reset();
      st.term.write(b64bytes(JSON.parse(e.data)));
      setStatus(L('подключено'), 'good');
      scheduleFit();
      st.term.focus();
    });
    es.addEventListener('o', (e) => st.term.write(b64bytes(JSON.parse(e.data))));
    es.addEventListener('x', (e) => {
      const d = JSON.parse(e.data);
      st.done = true;
      es.close();
      st.term.write(`\r\n\x1b[90m[${d.msg}]\x1b[0m\r\n`);
      setStatus(d.msg, 'idle');
      const x = st.sessions.find((s) => s.id === sid);
      if (x) { x.done = true; renderSessions(); }
    });
    es.onerror = () => {
      if (st.done || st.dead) return;
      setStatus(L('переподключение…'), 'warn');
      if (es.readyState === EventSource.CLOSED) setTimeout(() => { if (!st.dead && st.sid === sid) refresh(); }, 2000);
    };
  }

  async function newSession() {
    ensureTerm();
    let cols = 100, rows = 30;
    try { const d = st.fit.proposeDimensions(); if (d && d.cols) { cols = d.cols; rows = d.rows; } } catch (e) { /* размер по умолчанию */ }
    setStatus(L('открываю сессию…'), 'warn');
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/term`, { method: 'POST', body: { cols, rows } });
      st.sessions.push({ id: r.id, created: r.created, done: false });
      attach(r.id);
      st.cols = cols; st.rows = rows;
    } catch (e) { setStatus(e.message, 'bad'); }
  }

  async function closeSession() {
    if (!st.sid) return;
    const x = st.sessions.find((s) => s.id === st.sid);
    if (x && !x.done) {
      const ok = await confirmDialog({ title: L('Завершить сессию терминала?'), text: L('Запущенные в ней программы получат сигнал отбоя (SIGHUP).'), ok: L('Завершить'), danger: true });
      if (!ok) return;
    }
    try { await api(`/term/${st.sid}`, { method: 'DELETE' }); } catch (e) { /* уже закрыта */ }
    st.sessions = st.sessions.filter((s) => s.id !== st.sid);
    S.termSel.delete(id);
    st.sid = '';
    if (st.es) { st.es.close(); st.es = null; }
    const next = st.sessions.filter((s) => !s.done).pop();
    if (next) attach(next.id);
    else { renderSessions(); st.term.reset(); setStatus(L('нет открытых сессий')); }
  }

  async function refresh() {
    try {
      st.sessions = (await api(`/servers/${encodeURIComponent(id)}/term`)).sessions;
    } catch (e) { setStatus(e.message, 'bad'); return; }
    const want = st.sessions.find((s) => s.id === st.sid) || st.sessions.filter((s) => !s.done).pop();
    if (want) attach(want.id);
    else newSession();
  }

  loadXterm().then(() => { if (!st.dead) refresh(); }, (e) => setStatus(e.message, 'bad'));
  return {
    el,
    destroy() {
      st.dead = true;
      clearTimeout(fitT);
      if (st.es) st.es.close();
      if (st.ro) st.ro.disconnect();
      window.removeEventListener('resize', sizeHost);
      if (st.term) st.term.dispose();
    },
  };
}

const TABS = { overview: overviewTab, procs: procsTab, services: servicesTab, vpn: vpnTab, files: filesTab, logs: logsTab, network: networkTab, docker: dockerTab, system: systemTab, schedule: scheduleTab, notes: notesTab, term: termTab };

/* ---------- действия с серверами ---------- */
async function patchServer(id, body) {
  try {
    await api(`/servers/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  } catch (e) { toast(e.message, 'bad'); }
}

async function reconnect(id) {
  try {
    await api(`/servers/${encodeURIComponent(id)}/reconnect`, { method: 'POST', body: {} });
    toast(L('Переподключаюсь…'), 'warn');
  } catch (e) { toast(e.message, 'bad'); }
}

async function reloadConfig() {
  try {
    await api('/servers/reload', { method: 'POST', body: {} });
    toast(L('Список серверов обновлён из ~/.ssh/config'));
  } catch (e) { toast(e.message, 'bad'); }
}

function rebootDialog(s) {
  const input = h('input', { class: 'input', placeholder: s.name, autocomplete: 'off', spellcheck: 'false' });
  const btn = h('button', { class: 'btn danger solid', type: 'button', disabled: true }, L('Перезагрузить'));
  input.addEventListener('input', () => { btn.disabled = input.value.trim() !== s.name; });
  const m = modal({
    title: L('Перезагрузить {0}?', s.name),
    body: h('div', { class: 'form' },
      h('div', { class: 'alert warn' }, icon('warn'), h('div', null, L('Все службы и подключения к серверу прервутся на 1–3 минуты. Если сервер не поднимется, понадобится консоль хостинга.'))),
      h('label', { class: 'field' }, h('span', null, L('Для подтверждения введите название сервера: '), h('b', null, s.name)), input)),
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, L('Отмена')), btn],
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api(`/servers/${encodeURIComponent(s.id)}/reboot`, { method: 'POST', body: { confirm: input.value.trim() } });
      if (r.ok) { toast(L('{0}: перезагрузка запущена', s.name), 'warn'); m.close(); } else { toast(L('Перезагрузка не удалась'), 'bad', r.error); btn.disabled = false; }
    } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
  });
}

/* ---------- тема ---------- */
function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function themeChanged() {
  Theme.reset();
  if (S.page) { if (S.page.destroy) S.page.destroy(); S.page = null; route(); }
  renderSidebar();
}
$('#btn-theme').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sp.theme', next); } catch (e) { /* нет хранилища */ }
  themeChanged();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.documentElement.dataset.theme) themeChanged(); });

$('#btn-add').addEventListener('click', () => addServerDialog());
$('#cmdk').addEventListener('click', () => Palette.open());
$('#cmdk-kbd').textContent = IS_MAC ? '⌘K' : 'Ctrl K';
for (const b of document.querySelectorAll('#lang button')) {
  b.setAttribute('aria-pressed', String(b.dataset.lang === I18N.lang));
  b.addEventListener('click', () => { if (b.dataset.lang !== I18N.lang) setLang(b.dataset.lang); });
}
$('#srv-filter').addEventListener('input', renderSidebar);
$('#scroll').addEventListener('scroll', () => $('#scroll').classList.toggle('scrolled', $('#scroll').scrollTop > 4), { passive: true });
i18nStatic(document);
$('#btn-reload').addEventListener('click', reloadConfig);
window.addEventListener('hashchange', () => route());
window.addEventListener('resize', () => { for (const s of S.servers) updateSideRow(s); });

$('#main').replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), NB + L(' Подключение к панели…'))));
connect();

'use strict';

const TOKEN = document.querySelector('meta[name="panel-token"]').content;
const RANGES = { '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const RANGE_LABELS = [['5m', '5 мин'], ['15m', '15 мин'], ['1h', '1 час'], ['6h', '6 часов'], ['24h', '24 часа'], ['7d', '7 дней'], ['30d', '30 дней']];
const SPARK_N = 150;
const NB = ' ';

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
    throw new Error('Нет связи с панелью — она запущена?');
  }
  if (res.status === 401) {
    showRestartBanner();
    throw new Error('Панель была перезапущена — обновите страницу');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Ошибка ' + res.status);
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
      foot: [h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, 'Отмена'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish(input.value.trim()) }, ok)],
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    setTimeout(() => { input.focus(); const dot = value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 40);
  });
}

function confirmDialog({ title, text, warn, ok = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } m.close(); };
    const okBtn = h('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), type: 'button', onclick: () => finish(true) }, ok);
    const m = modal({
      title,
      body: h('div', { class: 'form' },
        text ? h('div', { class: 'ink2' }, text) : null,
        warn ? h('div', { class: 'alert warn' }, icon('warn'), h('div', null, warn)) : null),
      foot: [h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Отмена'), okBtn],
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
  navigator.clipboard.writeText(text).then(() => toast('Скопировано'), () => toast('Не удалось скопировать', 'bad'));
}

let bannerShown = false;
function showRestartBanner() {
  if (bannerShown) return;
  bannerShown = true;
  const b = h('div', { class: 'banner' }, 'Панель была перезапущена — страницу нужно обновить.',
    h('button', { class: 'btn sm', type: 'button', onclick: () => location.reload() }, 'Обновить'));
  $('#main').prepend(b);
}

/* ---------- общие элементы ---------- */
const STATUS_TEXT = { online: 'онлайн', connecting: 'подключение…', offline: 'нет связи', off: 'мониторинг выключен' };

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
  es.addEventListener('alerts', (e) => {
    const d = JSON.parse(e.data);
    S.firing = d.firing || [];
    updateAlertBadge();
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
  c.title = ok ? 'Связь с панелью есть' : 'Нет связи с панелью';
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
  for (const [g, items] of groups) {
    if (titled) list.append(h('div', { class: 'srv-group' }, g || 'Без группы'));
    for (const s of items) renderSideRow(list, s);
  }
  if (!visible.length) list.append(h('div', { class: 'muted', style: { padding: '8px 10px', fontSize: '13px' } }, 'Серверов пока нет'));
  const online = S.servers.filter((s) => s.status === 'online').length;
  $('#fleet-count').textContent = `${online}/${visible.length}`;
  highlightSidebar();
}

function renderSideRow(list, s) {
  const dot = h('span', { class: 'dot ' + s.status });
  const name = h('span', { class: 'srv-name' }, s.name);
  const val = h('span', { class: 'srv-val' });
  const cv = h('canvas', { 'aria-hidden': 'true' });
  const why = h('span', { class: 'why' });
  const sub = h('div', { class: 'srv-sub' }, cv, why);
  const row = h('a', { class: 'srv', href: '#/s/' + encodeURIComponent(s.id), title: s.name }, dot, name, val, sub);
  list.append(row);
  sideRows.set(s.id, { row, dot, val, cv, why });
  updateSideRow(s);
}

function updateSideRow(s) {
  const r = sideRows.get(s.id);
  if (!r) return;
  r.dot.className = 'dot ' + s.status;
  r.row.classList.toggle('dim', s.status === 'off');
  const online = s.status === 'online' && s.latest;
  r.val.textContent = online ? Fmt.pct0(s.latest.cpu) : s.status === 'off' ? 'выкл.' : s.status === 'connecting' ? '…' : 'офлайн';
  r.cv.hidden = !online;
  r.why.hidden = !!online;
  r.why.textContent = online ? '' : s.status === 'offline' ? (s.error || 'нет связи') : s.status === 'off' ? 'мониторинг выключен' : 'подключение…';
  if (online) drawSpark(r.cv, s.spark.map((p) => p.c), { max: 100, slots: SPARK_N, baseline: false });
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
}

/* ---------- маршруты ---------- */
function parseRoute() {
  const m = location.hash.match(/^#\/s\/([^/]+)(?:\/([a-z]+))?/);
  if (m) return { view: 'server', id: decodeURIComponent(m[1]), tab: m[2] || 'overview' };
  const v = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
  if (v && PAGES[v]) return { view: v };
  return { view: 'fleet' };
}

function route(dataChanged) {
  const r = parseRoute();
  const main = $('#main');
  const p = S.page;
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
    main.scrollTop = 0;
  }
  highlightSidebar();
}

/* ---------- сводка по всем серверам ---------- */
class FleetPage {
  constructor() {
    this.kind = 'fleet';
    this.el = h('div', { class: 'page' });
    this.cards = new Map();
    this.render();
  }

  onData() { this.render(); }
  onNotes() { this.render(); }

  onSetup() {
    const want = !S.servers.some((s) => !s.hidden);
    if (want || this.onboarding) this.render();
  }

  onUnits(srv) {
    const ref = this.cards.get(srv.id);
    if (ref) this.replaceCard(srv);
    this.updateSummary();
  }

  render() {
    const vis = S.servers.filter((s) => !s.hidden);
    const hidden = S.servers.filter((s) => s.hidden);
    this.cards.clear();
    this.sum = {
      online: h('div', { class: 'kpi-value' }), onlineSub: h('div', { class: 'kpi-sub' }),
      cpu: h('div', { class: 'kpi-value' }), cpuSub: h('div', { class: 'kpi-sub' }),
      net: h('div', { class: 'kpi-value' }), netSub: h('div', { class: 'kpi-sub' }),
      warn: h('div', { class: 'kpi-value' }), warnSub: h('div', { class: 'kpi-sub' }),
    };
    const s = this.sum;
    const groups = groupServers(vis);
    const titled = groups.some(([g]) => g);
    const grid = h('div');
    for (const [g, items] of groups) {
      if (titled) grid.append(h('div', { class: 'section-title' }, g || 'Без группы'));
      grid.append(h('div', { class: 'fleet' }, items.map((srv) => this.card(srv))));
    }
    this.onboarding = !vis.length;

    this.el.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, 'Все серверы'),
          h('div', { class: 'head-meta' }, h('span', null, 'Мониторинг и управление по SSH — на серверы ничего не устанавливается'))),
        h('div', { class: 'head-actions' },
          h('a', { class: 'btn', href: '#/manage' }, 'Управление'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => addServerDialog() }, icon('plus'), 'Добавить сервер'))),
      h('div', { class: 'summary' },
        h('div', { class: 'card kpi' }, h('div', { class: 'kpi-label' }, 'На связи'), s.online, s.onlineSub),
        h('div', { class: 'card kpi' }, h('div', { class: 'kpi-label' }, 'Средняя загрузка CPU'), s.cpu, s.cpuSub),
        h('div', { class: 'card kpi' }, h('div', { class: 'kpi-label' }, 'Трафик сейчас, входящий'), s.net, s.netSub),
        h('div', { class: 'card kpi' }, h('div', { class: 'kpi-label' }, 'Требуют внимания'), s.warn, s.warnSub)),
      vis.length ? grid : onboardingCard(),
      hidden.length ? h('div', null,
        h('div', { class: 'section-title' }, `Скрытые (${hidden.length})`),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('tbody', null, hidden.map((x) => h('tr', null,
          h('td', null, h('b', null, x.name)), h('td', { class: 'muted' }, (x.user ? x.user + '@' : '') + x.host),
          h('td', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => patchServer(x.id, { hidden: false, monitor: true }) }, 'Показать')))))))) : '',
    );
    this.updateSummary();
  }

  card(srv) {
    const live = srv.status === 'online' && srv.latest;
    const info = srv.info || {};
    const meta = [srv.user ? `${srv.user}@${srv.host}` : srv.host, info.os, info.cores ? `${info.cores}${NB}ядер` : null].filter(Boolean).join(' · ');
    const el = h('div', { class: 'card fcard' + (srv.status === 'off' ? ' off-card' : ''), tabindex: '0', role: 'link', 'aria-label': srv.name });
    const open = () => { location.hash = '#/s/' + encodeURIComponent(srv.id); };
    el.addEventListener('click', (e) => { if (!e.target.closest('button')) open(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    const head = h('div', { class: 'fcard-head' }, h('span', { class: 'fcard-name' }, srv.name), noteBadge(srv.id), statusChip(srv));
    el.append(head, h('div', { class: 'fcard-meta', title: meta }, meta));
    const ref = { el, srv };
    if (live || srv.status === 'connecting' && srv.latest) {
      const mk = (label) => { const m = meter(0); const v = h('span', { class: 'fm-v' }); const l = h('span', { class: 'fm-l' }, label); return { row: h('div', { class: 'fm' }, l, m.el, v), m, v, l }; };
      ref.cpu = mk('CPU'); ref.mem = mk('Память'); ref.disk = mk('Диск /');
      ref.net = h('div', { class: 'fnet' });
      ref.cv = h('canvas', { 'aria-hidden': 'true' });
      el.append(h('div', { class: 'fmeters' }, ref.cpu.row, ref.mem.row, ref.disk.row), ref.net, ref.cv);
      const failed = (srv.units || []).filter((u) => u.active === 'failed');
      if (failed.length) {
        el.append(h('div', { class: 'fwarn', title: failed.map((u) => u.unit).join('\n') }, icon('warn'),
          `${failed.length === 1 ? 'служба с ошибкой' : 'службы с ошибкой'}: ${failed.map((u) => u.unit.replace(/\.service$/, '')).join(', ')}`));
      }
      this.updateCard(ref);
    } else if (srv.status === 'off') {
      el.append(h('div', { class: 'err' }, 'Метрики не собираются.'),
        h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: () => patchServer(srv.id, { monitor: true }) }, 'Включить мониторинг')));
    } else if (srv.status === 'offline') {
      el.append(h('div', { class: 'err' }, srv.error || 'Нет связи'),
        h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: () => reconnect(srv.id) }, icon('refresh'), 'Переподключить')));
    } else {
      el.append(h('div', { class: 'err' }, h('span', { class: 'spinner' }), NB + ' Подключение…'));
    }
    this.cards.set(srv.id, ref);
    return el;
  }

  updateCard(ref) {
    const s = S.by.get(ref.srv.id);
    const m = s && s.latest;
    if (!m || !ref.cpu) return;
    ref.cpu.m.set(m.cpu); ref.cpu.v.textContent = Fmt.pct0(m.cpu);
    const mp = memPct(m);
    ref.mem.m.set(mp); ref.mem.v.textContent = Fmt.pct0(mp);
    const parts = dataFS(m);
    const fs = parts.length > 1 ? fullestFS(m) : rootFS(m);
    ref.disk.l.textContent = parts.length > 1 ? 'Диски' : 'Диск ' + (fs ? fs.mount : '/');
    ref.disk.row.title = parts.map((f) => `${f.mount}: ${Fmt.pct0(f.pct)} · ${Fmt.bytes(f.used)} из ${Fmt.bytes(f.size)}`).join('\n');
    ref.disk.m.set(fs ? fs.pct : 0); ref.disk.v.textContent = fs ? Fmt.pct0(fs.pct) : '—';
    const tc = tempMain(m.temps, 'cpu');
    ref.net.replaceChildren(
      h('span', null, '↓ ', h('b', null, Fmt.bits(m.netRx * 8))),
      h('span', null, '↑ ', h('b', null, Fmt.bits(m.netTx * 8))),
      h('span', null, 'TCP ', h('b', null, Fmt.int(m.tcp))),
      tc ? h('span', { title: 'Температура процессора' }, 'CPU ', h('b', null, tFmt(tc.c))) : '',
      h('span', null, 'аптайм ', h('b', null, Fmt.dur(m.uptime))));
    drawSpark(ref.cv, s.spark.map((p) => p.c), { max: 100, slots: SPARK_N });
  }

  updateSummary() {
    const vis = S.servers.filter((s) => !s.hidden);
    const on = vis.filter((s) => s.status === 'online' && s.latest);
    const s = this.sum;
    s.online.replaceChildren(String(on.length), h('small', null, ` из ${vis.length}`));
    const off = vis.filter((x) => x.status === 'offline');
    s.onlineSub.textContent = off.length ? 'нет связи: ' + off.map((x) => x.name).join(', ') : 'все серверы отвечают';
    const avg = on.length ? on.reduce((a, x) => a + x.latest.cpu, 0) / on.length : 0;
    s.cpu.textContent = on.length ? Fmt.pct(avg) : '—';
    const top = on.slice().sort((a, b) => b.latest.cpu - a.latest.cpu)[0];
    s.cpuSub.textContent = top ? `больше всего: ${top.name} (${Fmt.pct0(top.latest.cpu)})` : NB;
    const rx = on.reduce((a, x) => a + x.latest.netRx, 0), tx = on.reduce((a, x) => a + x.latest.netTx, 0);
    s.net.textContent = Fmt.bits(rx * 8);
    s.netSub.textContent = 'исходящий ' + Fmt.bits(tx * 8);
    const issues = [];
    for (const x of vis) {
      if (x.status === 'offline') { issues.push(`${x.name}: нет связи`); continue; }
      const m = x.latest;
      if (!m) continue;
      if (m.cpu >= 90) issues.push(`${x.name}: CPU ${Fmt.pct0(m.cpu)}`);
      if (memPct(m) >= 90) issues.push(`${x.name}: память ${Fmt.pct0(memPct(m))}`);
      for (const f of m.fs || []) if (f.pct >= 90) issues.push(`${x.name}: диск ${f.mount} ${Fmt.pct0(f.pct)}`);
      for (const u of x.units || []) if (u.active === 'failed') issues.push(`${x.name}: ${u.unit.replace(/\.service$/, '')} — ошибка`);
    }
    s.warn.textContent = String(issues.length);
    s.warnSub.textContent = issues.length ? issues.join(' · ') : 'всё в порядке';
    s.warnSub.title = issues.join('\n');
  }

  onFrame(srv) {
    const ref = this.cards.get(srv.id);
    if (ref && ref.cpu) this.updateCard(ref);
    else if (ref) this.replaceCard(srv);
    this.updateSummaryThrottled();
  }

  updateSummaryThrottled() {
    if (this.sumT) return;
    this.sumT = setTimeout(() => { this.sumT = 0; this.updateSummary(); }, 500);
  }

  onStatus(srv) {
    this.replaceCard(srv);
    this.updateSummary();
  }

  replaceCard(srv) {
    const ref = this.cards.get(srv.id);
    if (!ref) return;
    const fresh = this.card(srv);
    ref.el.replaceWith(fresh);
  }

  destroy() { clearTimeout(this.sumT); }
}

/* ---------- оповещения ---------- */
const ALERT_KIND = { offline: 'связь', cpu: 'процессор', mem: 'память', disk: 'диск', failed: 'служба', vpn: 'VPN', temp: 'перегрев', check: 'проверка', cert: 'сертификат' };

function sinceText(ms) {
  const sec = (Date.now() - ms) / 1000;
  return sec < 60 ? 'только что' : Fmt.dur(sec) + ' назад';
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
    this.formEl = h('div', null, h('div', { class: 'card empty' }, h('span', { class: 'spinner' }), ' Загрузка…'));
    this.noteEl = h('div');
    this.el.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, 'Оповещения'),
          h('div', { class: 'head-meta' }, h('span', null, 'Панель проверяет серверы каждые 10 секунд и сообщает о проблемах, пока она запущена на этом компьютере')))),
      this.noteEl,
      h('div', { class: 'section-title', style: { marginTop: '0' } }, 'Сейчас'),
      this.firingEl,
      this.formEl,
      h('div', { class: 'section-title' }, 'Журнал',
        h('button', { class: 'btn ghost sm', type: 'button', style: { marginLeft: 'auto' }, onclick: () => this.clearEvents() }, 'Очистить')),
      h('div', { class: 'card flush' }, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Когда'), h('th', null, 'Сервер'), h('th', null, 'Событие'), h('th', null, 'Доставка'))),
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
      h('div', null, 'Панель запущена с флагом -notify=false: оповещения записываются в журнал, но никуда не отправляются.')));
    this.renderFiring();
    this.renderForm();
    this.renderEvents();
  }

  renderFiring() {
    const list = S.firing;
    if (!list.length) {
      this.firingEl.replaceChildren(h('div', { class: 'card ok-card' }, h('span', { class: 'dot online' }), 'Всё в порядке — активных оповещений нет'));
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
      this.eventsEl.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'muted', style: { textAlign: 'center', padding: '18px' } }, 'Событий пока не было')));
      return;
    }
    this.eventsEl.replaceChildren(...this.events.map((e) => h('tr', null,
      h('td', { class: 'nowrap muted' }, Fmt.dateTime(e.t, false)),
      h('td', { class: 'nowrap' }, e.name || '—'),
      h('td', null, h('span', { class: 'ev' }, h('span', { class: 'dot ' + (e.state === 'ok' ? 'online' : 'offline') }), e.text)),
      h('td', { class: e.err ? 'bad-ink' : 'muted' }, e.err || e.sent || (e.state === 'test' ? '' : 'отправляется…')))));
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
      this.muteEl.replaceChildren(h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Серверов пока нет'));
      return;
    }
    this.muteEl.replaceChildren(...vis.map((s) => {
      const on = !s.mute && s.monitor;
      const b = h('button', {
        type: 'button', class: 'pick' + (on ? ' on' : ''), 'aria-pressed': String(on), disabled: !s.monitor,
        title: s.monitor ? (on ? 'Нажмите, чтобы не присылать оповещения по этому серверу' : 'Нажмите, чтобы присылать оповещения') : 'Мониторинг выключен — сервер не проверяется',
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
    const TOKEN_SAVED = 'сохранён — вставьте новый, чтобы заменить';

    // ---- автосохранение: каждое изменение уходит на сервер само ----
    const saveState = h('span', { class: 'save-state', role: 'status', 'aria-live': 'polite' });
    const setState = (text, cls = '') => {
      saveState.className = 'save-state' + (cls ? ' ' + cls : '');
      saveState.replaceChildren(...(cls === 'ok' ? [icon('check')] : []), text);
    };
    setState('Изменения сохраняются сами');
    const invalid = new Set();
    let timer = 0, saving = false, again = false;
    const later = (ms = 700) => { clearTimeout(timer); timer = setTimeout(save, ms); };
    const tgReady = () => !!((tokenSet || CH.tgToken) && CH.tgChat);

    async function save() {
      clearTimeout(timer);
      if (invalid.size) { setState('Не сохранено — исправьте поле, выделенное красным', 'bad'); return; }
      if (saving) { again = true; return; }
      saving = true;
      setState('Сохраняю…');
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
        if (CH.telegram && !tgReady()) setState('Сохранено. Telegram заработает, когда будут токен и chat id', 'warn');
        else setState('Сохранено', 'ok');
        if (S.servers.some((s) => s.info && s.info.watchdog)) {
          clearTimeout(page.wdT);
          page.wdT = setTimeout(() => page.renderWatch(), 12e3);
        }
      } catch (e) {
        setState('Не сохранено: ' + e.message, 'bad');
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
        box.dataset.err = ok ? '' : `Нужно число от ${fmtN(min)} до ${fmtN(max)}`;
        if (ok) { invalid.delete(i); obj[key] = v; } else invalid.add(i);
        if (onCheck) onCheck();
        return ok;
      };
      i.addEventListener('input', () => { if (check()) later(); else clearTimeout(timer); });
      i.addEventListener('change', () => { if (check()) save(); else setState('Не сохранено — исправьте поле, выделенное красным', 'bad'); });
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
      if (pct) p = unitIn(r, 'pct', { min: 1, max: 100, unit: '%', label: `${title}: порог в процентах`, onCheck: () => sync() });
      if (days) p = unitIn(r, 'days', { min: 1, max: 365, unit: 'дн', label: `${title}: за сколько дней`, onCheck: () => sync() });
      if (min) m = unitIn(r, 'min', { min: minLow, max: 1440, step: 0.5, unit: 'мин', label: `${title}: сколько минут`, onCheck: () => sync() });
      const slot = (x, label) => h('div', { class: 'ap' + (x ? '' : ' ap-none') }, x ? [h('span', { class: 'ap-label' }, label), x.box] : null);
      const row = h('div', { class: 'arule' },
        sw,
        h('div', { class: 'arule-main', title: hint || null }, h('label', { class: 'arule-title', for: id }, title), desc),
        (pct || min || days) ? h('div', { class: 'arule-params' }, slot(p, 'порог'), slot(m, 'время')) : null);
      sw.addEventListener('change', () => { r[key] = sw.checked; sync(); save(); });
      sync();
      return row;
    };
    const after = (n) => (n > 0 ? `дольше ${fmtN(n)} мин` : 'сразу');
    if (!R.temp) R.temp = { on: true, min: 5 };
    if (!R.check) R.check = { on: true, min: 3 };
    if (!R.cert) R.cert = { on: true, days: 14 };

    const rules = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Когда сообщать'),
        h('div', { class: 'card-sub' }, 'Включите нужные проверки и задайте пороги'))),
      h('div', { class: 'arules' },
        h('div', { class: 'arule arule-head', 'aria-hidden': 'true' }, h('span'), h('span'), h('span', null, 'Порог'), h('span', null, 'Время')),
        ruleRow({ r: R.offline, key: 'on', title: 'Сервер недоступен', min: true,
          text: (x) => `Нет связи с сервером ${after(x.min)}` }),
        ruleRow({ r: R.cpu, key: 'on', title: 'Высокая нагрузка на процессор', pct: true, min: true, minLow: 0.5,
          text: (x) => `Загрузка выше ${fmtN(x.pct)} % в среднем за ${fmtN(x.min)} мин` }),
        ruleRow({ r: R.mem, key: 'on', title: 'Заканчивается память', pct: true, min: true, minLow: 0.5,
          text: (x) => `Занято больше ${fmtN(x.pct)} % в среднем за ${fmtN(x.min)} мин` }),
        ruleRow({ r: R.disk, key: 'on', title: 'Заканчивается место на диске', pct: true,
          text: (x) => `Любой раздел заполнен больше чем на ${fmtN(x.pct)} %` }),
        ruleRow({ r: R.failed, key: 'on', title: 'Служба упала с ошибкой',
          text: () => 'Служба systemd в состоянии failed дольше 50 секунд' }),
        ruleRow({ r: R.vpn, key: 'on', title: 'VPN перестал работать', min: true,
          hint: 'xray, AmneziaWG, WireGuard, MTProto, sing-box, Hysteria и другие — если панель видела службу работающей, а потом она остановилась',
          text: (x) => `VPN-служба не работает ${after(x.min)}` }),
        ruleRow({ r: R.temp, key: 'on', title: 'Перегрев', min: true,
          hint: 'Порог — критическая температура из датчика, а если датчик её не сообщает: процессор и видеокарта 95 °C, SSD 80 °C, HDD 60 °C',
          text: (x) => `Процессор, видеокарта или диск горячее порога ${after(x.min)}` }),
        ruleRow({ r: R.check, key: 'on', title: 'Сайт или порт не отвечает', min: true,
          hint: 'Проверки со страницы «Сайты и порты» — панель выполняет их с этого компьютера раз в минуту',
          text: (x) => `Проверка со страницы «Сайты и порты» не проходит ${after(x.min)}` }),
        ruleRow({ r: R.cert, key: 'on', title: 'Сертификат скоро истекает', days: true,
          text: (x) => `Осталось меньше ${plural(x.days, 'дня', 'дней', 'дней')} или сертификат не проходит проверку` })),
      h('div', { class: 'arules arules-extra' },
        ruleRow({ r: R, key: 'recovery', title: 'Сообщать о восстановлении',
          text: () => 'Отдельное сообщение, когда проблема прошла' })));

    // ---- каналы ----
    const tokenIn = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: tokenSet ? TOKEN_SAVED : '123456789:AA…', 'aria-label': 'Токен бота' });
    const chatIn = h('input', { class: 'input mono', value: CH.tgChat || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'например 123456789', 'aria-label': 'Chat id' });
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
      if (!fieldCheck(tokenIn, tokenErr, TOKEN_RE, 'Токен выглядит неверно: нужен вид 123456789:AA…')) return;
      CH.tgToken = tokenIn.value.trim();
      if (CH.tgToken) save();
    });
    chatIn.addEventListener('input', () => { if (!chatIn.value.trim()) fieldCheck(chatIn, chatErr, CHAT_RE, ''); });
    chatIn.addEventListener('change', () => {
      if (!fieldCheck(chatIn, chatErr, CHAT_RE, 'Chat id — это число (123456789 или -100…) или @имя_канала')) return;
      CH.tgChat = chatIn.value.trim();
      save();
    });
    const chatsEl = h('div', { class: 'chips', style: { margin: '2px 0 0' } });
    const findBtn = h('button', { class: 'btn', type: 'button', onclick: findChats }, 'Найти');

    async function findChats() {
      chatsEl.replaceChildren(h('span', { class: 'muted' }, h('span', { class: 'spinner' }), NB + 'Ищу…'));
      try {
        const r = await api('/alerts/telegram-chats', { method: 'POST', body: { token: tokenIn.value.trim() } });
        const chats = r.chats || [];
        if (!chats.length) {
          chatsEl.replaceChildren(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Сообщений боту не найдено — напишите ему и нажмите «Найти» ещё раз.'));
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
        toast(channel === 'telegram' ? 'Проверочное сообщение отправлено в Telegram' : 'Проверочное уведомление отправлено');
      } catch (e) { toast('Не удалось отправить', 'bad', e.message); }
    }

    const step = (n, ...kids) => h('div', { class: 'tg-step' }, h('span', { class: 'tg-n', 'aria-hidden': 'true' }, String(n)), h('div', { class: 'field' }, ...kids));
    const tgSetup = h('div', { class: 'tg-setup' },
      step(1, h('span', null, 'Токен бота'), tokenIn,
        h('span', { class: 'hint' }, 'Создайте бота у @BotFather в Telegram и вставьте сюда его токен. Он хранится только на этом компьютере.'), tokenErr),
      step(2, h('span', null, 'Кому писать'), h('div', { class: 'inline' }, chatIn, findBtn),
        h('span', { class: 'hint' }, 'Напишите своему боту любое сообщение и нажмите «Найти». Для группы — добавьте бота в группу и напишите там.'), chatErr, chatsEl),
      step(3, h('span', null, 'Проверка'),
        h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: () => test('telegram') }, 'Отправить проверочное сообщение'))));

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
    const local = chanRow({ ico: 'bell', key: 'macos', title: `Уведомления ${osName()}`,
      desc: h('div', { class: 'arule-desc' }, 'На этом компьютере'),
      extra: h('button', { class: 'btn ghost sm', type: 'button', onclick: () => test('macos') }, 'Проверить') });
    const tgDesc = h('div', { class: 'arule-desc' });
    const tgTest = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => test('telegram') }, 'Проверить');
    const tg = chanRow({ ico: 'send', key: 'telegram', title: 'Telegram', desc: tgDesc, extra: tgTest });
    function syncTg() {
      const ready = tgReady();
      tgDesc.textContent = ready ? `Бот подключён · чат ${CH.tgChat}` : 'Сообщения от вашего бота';
      tgTest.hidden = !ready;
      // настройка видна, пока Telegram включён и не готов, — или по кнопке «Настроить»
      tgSetup.hidden = !(CH.telegram && (!ready || tgOpen));
      tgEdit.hidden = !(CH.telegram && ready && !tgOpen);
      if (page.wdSync) page.wdSync();
    }
    let tgOpen = false;
    const tgEdit = h('button', { class: 'btn ghost sm tg-edit', type: 'button', onclick: () => { tgOpen = true; syncTg(); tokenIn.focus(); } }, 'Изменить бота или чат');
    syncTg();

    const channels = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Куда присылать'))),
      h('div', { class: 'chans' }, local.el, tg.el, tgEdit, tgSetup));

    const servers = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Какие серверы проверять'),
        h('div', { class: 'card-sub' }, 'Оповещения приходят только по отмеченным'))),
      this.muteEl);
    this.renderMute();

    // ---- сторож на серверах ----
    const W = c.watch || (c.watch = {});
    if (W.restartVpn == null) W.restartVpn = true;
    const wdNote = h('div', { class: 'alert warn wd-note' }, icon('warn'),
      h('div', null, 'Сторож пишет в Telegram — сначала подключите его в карточке «Куда присылать».'));
    this.wdReady = () => !!CH.telegram && tgReady();
    this.wdSync = () => {
      wdNote.hidden = this.wdReady();
      for (const b of this.wdEl.querySelectorAll('[data-wd-install]')) b.disabled = !this.wdReady();
    };
    const wdRefresh = h('button', { class: 'btn ghost sm icon-only', type: 'button', title: 'Обновить состояние', 'aria-label': 'Обновить состояние сторожей', onclick: () => this.renderWatch() }, icon('refresh'));
    const watch = h('div', { class: 'card wd-card' },
      h('div', { class: 'card-head' },
        h('div', null, h('div', { class: 'card-title' }, 'Сторож на серверах'),
          h('div', { class: 'card-sub' }, 'Проверяет сервер сам, раз в минуту, и пишет в Telegram — даже когда этот компьютер выключен')),
        h('div', { class: 'right' }, wdRefresh)),
      h('p', { class: 'wd-about' },
        'Сторож — небольшой скрипт с таймером systemd на самом сервере. Он следит за тем, что включено в «Когда сообщать»: VPN-службы, службы с ошибкой, место на дисках, перегрев, — и сообщает о перезагрузке. ',
        'Пока на сервере стоит сторож, панель не дублирует эти события в Telegram. Что сервер недоступен, по-прежнему сообщает панель: сам о себе сервер этого не скажет.'),
      wdNote,
      h('div', { class: 'arules arules-extra wd-opts' },
        ruleRow({ r: W, key: 'restartVpn', title: 'Перезапускать упавшие VPN-службы',
          text: () => 'Если VPN-служба упала, сторож перезапустит её и напишет, помогло ли. Не чаще раза в 10 минут и не больше трёх раз в час' }),
        ruleRow({ r: W, key: 'restartOther', title: 'Перезапускать и другие упавшие службы',
          text: () => 'Только постоянно работающие службы — разовые задачи (Type=oneshot) сторож не трогает' })),
      this.wdEl);
    this.wdSync();
    this.renderWatch();

    this.formEl.replaceChildren(
      h('div', { class: 'section-title' }, 'Настройки', h('span', { class: 'grow' }), saveState),
      h('div', { class: 'alerts-grid' }, rules, h('div', { class: 'alerts-side' }, channels, servers)),
      watch);
  }

  // состояние сторожа на каждом сервере — у каждого свой запрос по SSH
  renderWatch() {
    clearTimeout(this.wdT);
    this.wdKey = this.wdSig();
    const vis = S.servers.filter((s) => !s.hidden);
    if (!vis.length) { this.wdEl.replaceChildren(h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Серверов пока нет')); return; }
    this.wdEl.replaceChildren(...vis.map((s) => this.wdRow(s)));
    if (this.wdSync) this.wdSync();
  }

  wdRow(s) {
    const id = s.id;
    const st = h('div', { class: 'wd-st' });
    const acts = h('div', { class: 'wd-acts' });
    const row = h('div', { class: 'wd-row' }, h('span', { class: 'dot ' + s.status }),
      h('div', { class: 'wd-main' }, h('div', { class: 'wd-name' }, s.name), st), acts);
    const ago = (sec) => (sec < 60 ? `${Math.max(0, Math.round(sec))} с назад` : Fmt.dur(sec) + ' назад');
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
        title: again ? `Обновить сторожа на ${s.name}?` : `Поставить сторожа на ${s.name}?`,
        text: h('div', null,
          h('p', { style: { margin: '0 0 8px' } }, 'Панель запишет на сервер скрипт и настройки в /etc/server-panel-watchdog и таймер systemd server-panel-watchdog. Раз в минуту сторож проверяет сервер и пишет в Telegram ваш бот. ', restart),
          h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, 'Токен бота хранится на сервере в файле, который может прочитать только root.')),
        ok: again ? 'Обновить' : 'Поставить',
      });
      if (!ok) return;
      busy(again ? 'обновляю…' : 'ставлю…');
      await act('install', again ? `Сторож на ${s.name} обновлён` : `Сторож стоит на ${s.name}: первая проверка — через 10 секунд`);
      this.wdT = setTimeout(() => this.renderWatch(), 15e3);
    };
    const remove = async () => {
      const ok = await confirmDialog({
        title: `Убрать сторожа с ${s.name}?`,
        text: 'Таймер, скрипт и настройки сторожа будут удалены с сервера. О событиях этого сервера в Telegram снова будет сообщать панель — пока она запущена.',
        ok: 'Убрать', danger: true,
      });
      if (!ok) return;
      busy('убираю…');
      act('remove', `Сторож убран с ${s.name}`);
    };
    const test = async () => { busy('отправляю…'); act('test', 'Проверочное сообщение отправлено'); };
    const W2 = () => {
      const w = (this.cfg && this.cfg.watch) || {};
      const vpn = w.restartVpn !== false, other = !!w.restartOther;
      if (vpn && other) return 'Упавшие службы он перезапускает сам.';
      if (vpn) return 'Упавшие VPN-службы он перезапускает сам.';
      if (other) return 'Упавшие службы, кроме VPN, он перезапускает сам.';
      return 'Сам он ничего не перезапускает — только сообщает.';
    };
    const show = (d) => {
      const lines = [];
      const a = [];
      if (d.offline) {
        lines.push(h('span', { class: 'muted' }, s.info && s.info.watchdog ? 'сторож стоит · нет связи с сервером' : 'нет связи с сервером'));
      } else if (d.error) {
        lines.push(h('span', { class: 'bad-ink' }, d.error));
        a.push(btn('Повторить', 'ghost', load));
      } else if (d.foreign) {
        lines.push(h('span', { class: 'warn-ink' }, `уже есть чужой ${d.foreign} с тем же именем — панель его не трогает, сторож не ставится`));
      } else if (!d.installed) {
        if (!d.root) lines.push(h('span', { class: 'muted' }, 'нужен root или sudo без пароля'));
        else if (!d.systemd) lines.push(h('span', { class: 'muted' }, 'на сервере нет systemd'));
        else if (!d.curl) lines.push(h('span', { class: 'muted' }, 'на сервере нет curl — установите его (apt install curl)'));
        else {
          lines.push(h('span', { class: 'muted' }, 'не стоит'));
          a.push(btn('Поставить', '', () => install(false), { 'data-wd-install': '1', disabled: !this.wdReady() }));
        }
      } else {
        const age = d.run && d.now ? d.now - d.run : null;
        if (!d.active) lines.push(h('span', { class: 'bad-ink' }, 'таймер выключен — сторож не запускается'));
        else if (age == null) lines.push(h('span', { class: 'muted' }, 'стоит · первая проверка вот-вот'));
        else if (age > 300) lines.push(h('span', { class: 'warn-ink' }, `стоит · последняя проверка ${ago(age)}`));
        else lines.push(h('span', { class: 'good-ink' }, `работает · проверка ${ago(age)}`));
        if (d.stale) lines.push(h('span', { class: 'muted' }, 'настройки на сервере старые'));
        if (d.err) lines.push(h('span', { class: 'bad-ink' }, `не может написать в Telegram: ${d.err}` + (d.queue ? ` · ждут отправки: ${d.queue}` : '')));
        if (d.firing && d.firing.length) lines.push(h('span', null, 'сейчас: ' + d.firing.join('; ')));
        if (d.stale) a.push(btn('Обновить', 'primary', () => install(true), { 'data-wd-install': '1', disabled: !this.wdReady() }));
        a.push(btn('Проверить', 'ghost', test, { title: 'Сторож пришлёт в Telegram проверочное сообщение' }));
        a.push(btn('Убрать', 'ghost', remove));
      }
      st.replaceChildren(...lines.flatMap((x, i) => (i ? [h('span', { class: 'wd-sep', 'aria-hidden': 'true' }, ' · '), x] : [x])));
      acts.replaceChildren(...a);
    };
    if (s.status !== 'online') show({ offline: true });
    else { busy('проверяю…'); load(); }
    return row;
  }

  async clearEvents() {
    if (!this.events.length) return;
    const ok = await confirmDialog({ title: 'Очистить журнал оповещений?', text: 'Активные оповещения останутся.', ok: 'Очистить' });
    if (!ok) return;
    try { await api('/alerts/events', { method: 'DELETE' }); this.events = []; this.renderEvents(); } catch (e) { toast(e.message, 'bad'); }
  }

  destroy() { clearInterval(this.tick); clearTimeout(this.wdT); }
}

/* ---------- команды на нескольких серверах ---------- */
class CommandsPage {
  constructor() {
    this.kind = 'commands';
    this.el = h('div', { class: 'page' });
    this.sel = new Set(store.get('cmdSel', []));
    this.sudo = store.get('cmdSudo', false);
    this.hi = -1;
    this.pickEl = h('div', { class: 'pick' });
    this.runsEl = h('div', { class: 'runs' });
    this.input = h('textarea', { class: 'input cmd-in', rows: '2', placeholder: 'Команда или короткий скрипт, например: systemctl is-active xray', spellcheck: 'false', autocomplete: 'off' });
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
    this.runBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => this.run(this.input.value) }, 'Выполнить');
    this.el.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, 'Команды'),
          h('div', { class: 'head-meta' }, h('span', null, 'Одна команда на нескольких серверах сразу — по SSH, без интерактивного режима, до 120 секунд')))),
      h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Серверы')),
          h('div', { class: 'vact' },
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => this.selectAll(true) }, 'Все на связи'),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => this.selectAll(false) }, 'Снять выбор'))),
        this.pickEl,
        h('div', { class: 'chips', style: { margin: '14px 0 10px' } }, QUICK.map((q) => h('button', { class: 'chip', type: 'button', onclick: () => this.run(q, true) }, q))),
        h('div', { class: 'cmd-row' }, this.input,
          h('div', { class: 'cmd-side' }, h('label', { class: 'check', title: 'Для серверов, где вы подключены не под root' }, sudoCb, 'через sudo'), this.runBtn,
            h('button', {
              class: 'btn ghost sm', type: 'button', title: 'Сохранить команду как сценарий',
              onclick: () => scenarioDialog({ script: this.input.value.trim() || S.cmdHist[S.cmdHist.length - 1] || '', sudo: this.sudo }),
            }, 'В сценарий'))),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, 'Enter — выполнить, Shift+Enter — новая строка, ↑ — предыдущие команды. Для редакторов и top откройте «Терминал» на странице сервера.')),
      this.runsEl);
    this.renderPick();
    for (const r of S.cmdRuns) this.runsEl.append(r.el);
  }

  onData() { this.renderPick(); }
  onStatus() { this.renderPick(); }

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
    this.runBtn.textContent = n > 1 ? `Выполнить на ${n} ${Fmt.plural(n, 'сервере', 'серверах', 'серверах')}` : 'Выполнить';
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
    const ids = S.servers.filter((s) => this.sel.has(s.id)).map((s) => s.id);
    if (!cmd) return;
    if (!ids.length) { toast('Выберите хотя бы один сервер', 'bad'); return; }
    if (ids.length > 1 && !quick) {
      const ok = await confirmDialog({
        title: `Выполнить на ${ids.length} ${Fmt.plural(ids.length, 'сервере', 'серверах', 'серверах')}?`,
        text: h('div', null, h('pre', { class: 'pre', style: { margin: '0 0 10px' } }, cmd), 'Серверы: ', ids.map((i) => S.by.get(i).name).join(', ')),
        ok: 'Выполнить',
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

const PAGES = { fleet: FleetPage, alerts: AlertsPage, checks: ChecksPage, commands: CommandsPage, scenarios: ScenariosPage, schedule: SchedulePage, notes: NotesPage, manage: ManagePage };

/* ---------- страница сервера ---------- */
const TAB_DEFS = [
  ['overview', 'Обзор'],
  ['procs', 'Процессы'],
  ['services', 'Службы'],
  ['vpn', 'VPN'],
  ['files', 'Файлы'],
  ['logs', 'Журнал'],
  ['network', 'Сеть'],
  ['docker', 'Docker'],
  ['system', 'Система'],
  ['schedule', 'Расписание'],
  ['notes', 'Заметки'],
  ['term', 'Терминал'],
];

class ServerPage {
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

  refreshHead() {
    const s = this.srv;
    if (!s) {
      this.headEl.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Загрузка…'));
      return;
    }
    const info = s.info || {};
    const addr = (s.user ? s.user + '@' : '') + s.host + (s.port && s.port !== 22 ? ':' + s.port : '');
    this.uptimeEl = h('span');
    const meta = [
      h('span', { class: 'mono' }, addr),
      info.os ? h('span', null, info.os) : null,
      info.kernel ? h('span', null, 'ядро ' + info.kernel) : null,
      info.cpu ? h('span', { title: info.cpu }, `${info.cpu.replace(/\s+\d+-Core Processor$/, '')} × ${info.cores}`) : null,
      info.virt ? h('span', null, info.virt) : null,
      this.uptimeEl,
    ];
    this.headEl.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('div', { class: 'head-title' }, h('h1', null, s.name), statusChip(s)),
          h('div', { class: 'head-meta' }, meta)),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => reconnect(s.id), title: 'Переподключиться' }, icon('refresh'), 'Переподключить'),
          h('button', { class: 'btn danger', type: 'button', onclick: () => rebootDialog(s) }, icon('power'), 'Перезагрузить'),
          h('button', { class: 'btn icon-only', type: 'button', onclick: () => settingsDialog(s), title: 'Настройки сервера', 'aria-label': 'Настройки сервера' }, icon('gear')))),
      ...[pinnedNotesStrip(s.id)].filter(Boolean));
    this.updateUptime();

    this.alertEl.replaceChildren();
    if (s.status === 'offline') {
      this.alertEl.append(h('div', { class: 'alert bad', style: { marginBottom: '16px' } }, h('span', { class: 'badge crit' }, 'нет связи'),
        h('div', null, s.error || 'Сервер недоступен', '. Панель переподключится автоматически.')));
    } else if (s.status === 'off') {
      this.alertEl.append(h('div', { class: 'alert warn', style: { marginBottom: '16px', alignItems: 'center' } },
        h('div', { style: { flex: 1 } }, 'Мониторинг выключен — графики не обновляются. Процессы, службы, журнал и консоль работают.'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => patchServer(s.id, { monitor: true }) }, 'Включить')));
    }
    this.renderTabs();
  }

  updateUptime() {
    const s = this.srv;
    if (!this.uptimeEl || !s) return;
    this.uptimeEl.textContent = s.latest ? 'работает ' + Fmt.dur(s.latest.uptime) : '';
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
    cpu: kpiTile('Процессор'), mem: kpiTile('Память'), disk: kpiTile('Диск /'),
    load: kpiTile('Нагрузка (load average)'), net: kpiTile('Сеть, входящий'), tcp: kpiTile('Соединения TCP'),
  };
  const lastMT = () => { for (let i = pts.length - 1; i >= 0; i--) if (pts[i].mt) return pts[i].mt; return srv() && srv().latest ? srv().latest.memTotal : 0; };
  const cores = () => (srv() && srv().info && srv().info.cores) || 1;

  const charts = {
    cpu: new TimeChart({
      title: 'Загрузка процессора', stacked: true, max: () => 100, fmt: (v) => Fmt.pct(v), axis: (v) => Fmt.int(v) + NB + '%',
      series: [
        { label: 'Пользователь', color: 's1', get: (p) => p.u },
        { label: 'Система', color: 's2', get: (p) => p.s },
        { label: 'Ожидание I/O', color: 's3', get: (p) => p.w },
        { label: 'Steal', color: 's4', get: (p) => p.st },
      ],
      total: (p) => p.c, totalLabel: 'Загрузка',
      extra: (p) => (p.a ? [['Пик за минуту', Fmt.pct(p.cx || 0)]] : []),
    }),
    mem: new TimeChart({
      title: 'Память', stacked: true, base: 1024, max: () => lastMT() || null,
      fmt: (v) => Fmt.bytes(v), axis: Fmt.axisBytes,
      series: [
        { label: 'Используется', color: 's1', get: (p) => p.mu },
        { label: 'Кэш и буферы', color: 's2', get: (p) => p.mc },
      ],
      total: (p) => p.mt, totalLabel: 'Всего',
    }),
    net: new TimeChart({
      title: 'Сеть', base: 1000, minTop: 8000, fmt: (v) => Fmt.bits(v), axis: Fmt.axisBits,
      series: [
        { label: 'Входящий', color: 's1', kind: 'line', get: (p) => p.rx * 8 },
        { label: 'Исходящий', color: 's2', kind: 'line', get: (p) => p.tx * 8 },
      ],
    }),
    disk: new TimeChart({
      title: 'Диск', base: 1024, minTop: 1024, fmt: (v) => Fmt.rate(v), axis: Fmt.axisRate,
      series: [
        { label: 'Чтение', color: 's1', kind: 'line', get: (p) => p.dr },
        { label: 'Запись', color: 's2', kind: 'line', get: (p) => p.dw },
      ],
    }),
    load: new TimeChart({
      title: 'Load average', height: 150, minTop: 1, fmt: (v) => Fmt.num(v, 2), axis: (v) => Fmt.num(v, 2),
      series: [{ label: 'Load average (1 мин)', color: 's1', kind: 'line', get: (p) => p.l }],
    }),
    tcp: new TimeChart({
      title: 'Соединения TCP', height: 150, minTop: 10, fmt: (v) => Fmt.int(v), axis: (v) => Fmt.int(v),
      series: [{ label: 'Соединений TCP', color: 's1', kind: 'line', get: (p) => p.tcp }],
    }),
  };

  const coresEl = h('div', { class: 'cores' });
  const coresSub = h('div', { class: 'card-sub' }, 'загрузка каждого ядра сейчас');
  const coresAxis = h('div', { class: 'cores-axis' });
  const fsEl = h('div');
  const ifEl = h('tbody');
  const rangeNote = h('span', { class: 'muted', style: { fontSize: '12.5px' } });

  const rangeSeg = seg(RANGE_LABELS, range, (v) => { range = v; store.set('range', v); load(); });
  const hw = hardwareSection(id);

  const chartGrid = h('div', { class: 'grid two' },
    chartCard('Процессор', charts.cpu),
    chartCard('Память', charts.mem),
    chartCard('Сеть', charts.net, 'бит/с, без виртуальных интерфейсов'),
    chartCard('Диск, ввод-вывод', charts.disk),
    chartCard('Load average', charts.load, 'средняя очередь задач за 1 минуту'),
    chartCard('Соединения TCP', charts.tcp));

  // температуры: график появляется, когда у сервера есть датчики; серии — только те, что есть.
  // Цвет закреплён за компонентом, а не за порядком: процессор всегда s1, плата s2 и т. д.
  const TEMP_SERIES = [
    ['cpu', 'tc', { label: 'Процессор', color: 's1', kind: 'line', get: (p) => p.tc }],
    ['board', 'tb', { label: 'Плата', color: 's2', kind: 'line', get: (p) => p.tb }],
    ['gpu', 'tg', { label: 'Видеокарта', color: 's3', kind: 'line', get: (p) => p.tg }],
    ['disk', 'td', { label: 'Диски', color: 's4', kind: 'line', get: (p) => p.td }],
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
      title: 'Температура', sparse: true, floor: true, fill: false, minTop: 20,
      fmt: (v) => `${Fmt.num(v, 1)}${NB}°C`, axis: (v) => `${Fmt.int(v)}${NB}°C`,
      series: kinds.map((x) => x[2]),
    });
    tempCard = chartCard('Температура', charts.temp, kinds.some((x) => x[0] === 'disk') ? 'диски — самый горячий из них' : null);
    tempCard.classList.add('wide');
    chartGrid.append(tempCard);
    redraw();
  }

  const el = h('div', { class: 'ov' },
    h('div', { class: 'grid kpis' }, Object.values(k).map((t) => t.el)),
    hw.el,
    h('div', { class: 'toolbar' }, h('span', { class: 'ink2', style: { fontSize: '13px' } }, 'Период'), rangeSeg.el, rangeNote),
    chartGrid,
    h('div', { class: 'grid two', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Ядра процессора'), coresSub)), coresEl, coresAxis),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'Файловые системы')), fsEl)),
    h('div', { class: 'grid', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'Сетевые интерфейсы')),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, 'Интерфейс'), h('th', { class: 'num' }, '↓'), h('th', { class: 'num' }, '↑'), h('th', { class: 'num' }, 'Всего ↓ / ↑'))), ifEl)))));

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
        ? 'история собирается, пока панель запущена' : '';
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
    k.cpu.set(Fmt.pct(m.cpu), '', `польз. ${Fmt.pct0(m.user)} · сист. ${Fmt.pct0(m.system)} · I/O ${Fmt.pct0(m.iowait)}` + (m.steal >= 1 ? ` · steal ${Fmt.pct0(m.steal)}` : ''), m.cpu);
    k.mem.set(Fmt.bytes(m.memUsed), ` из ${Fmt.bytes(m.memTotal)}`, `кэш ${Fmt.bytes(m.memCache)}` + (m.swapTotal ? ` · swap ${Fmt.bytes(m.swapUsed)} из ${Fmt.bytes(m.swapTotal)}` : ' · swap нет'), memPct(m));
    const parts = dataFS(m);
    if (parts.length > 1) {
      const top = fullestFS(m);
      k.disk.label(`Диски · ${parts.length} ${Fmt.plural(parts.length, 'раздел', 'раздела', 'разделов')}`);
      k.disk.set(Fmt.pct(top.pct), ' на ' + top.mount, parts.filter((f) => f !== top).map((f) => `${f.mount} ${Fmt.pct0(f.pct)}`).join(' · '), top.pct);
      k.disk.el.title = parts.map((f) => `${f.mount}: ${Fmt.bytes(f.used)} из ${Fmt.bytes(f.size)}, свободно ${Fmt.bytes(f.avail)}`).join('\n');
    } else {
      const fs = rootFS(m);
      k.disk.label('Диск ' + (fs ? fs.mount : '/'));
      k.disk.el.title = '';
      if (fs) k.disk.set(Fmt.pct(fs.pct), '', `${Fmt.bytes(fs.used)} из ${Fmt.bytes(fs.size)} · свободно ${Fmt.bytes(fs.avail)}`, fs.pct);
      else k.disk.set('—', '', 'нет данных', null);
    }
    const c = cores();
    k.load.set(Fmt.num(m.load[0], 2), '', `5 мин ${Fmt.num(m.load[1], 2)} · 15 мин ${Fmt.num(m.load[2], 2)} · ядер ${c}`, (m.load[0] / c) * 100);
    k.net.set(Fmt.bits(m.netRx * 8), '', `исходящий ${Fmt.bits(m.netTx * 8)} · диск ${Fmt.rate(m.diskR + m.diskW)}`, null);
    k.tcp.set(Fmt.int(m.tcp), '', `процессов ${Fmt.int(m.procs)} · выполняется ${Fmt.int(m.procsRun)}`, null);
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
      c2.title = `Ядро ${i}: ${Fmt.pct(v)}`;
      sum += v;
      if (v > m.cores[maxI]) maxI = i;
    });
    if (n) coresSub.textContent = n === 1 ? `одно ядро · сейчас ${Fmt.pct(m.cores[0])}` : `${n} ${Fmt.plural(n, 'ядро', 'ядра', 'ядер')} · в среднем ${Fmt.pct(sum / n)} · больше всего ядро ${maxI} (${Fmt.pct(m.cores[maxI])})`;
    // файловые системы
    const boot = (f) => /^\/boot(\/|$)|^\/efi$/.test(f.mount);
    const fsList = (m.fs || []).slice().sort((a, b) => (boot(a) - boot(b)) || (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
    fsEl.replaceChildren(...fsList.map((f) => {
      const mt = meter(f.pct);
      return h('div', { class: 'fs-row' },
        h('div', { class: 'fs-name', title: f.dev }, f.mount, h('span', { class: 'muted' }, f.dev.replace('/dev/', ''))),
        h('div', { class: 'fs-val' }, `${Fmt.bytes(f.used)} / ${Fmt.bytes(f.size)} · ${Fmt.pct0(f.pct)}`), mt.el);
    }));
    if (!(m.fs || []).length) fsEl.replaceChildren(h('div', { class: 'muted' }, 'нет данных'));
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
    h('td', null, h('b', { style: { fontWeight: 500 } }, x.name), x.virtual ? h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '12px' } }, 'вирт.') : null),
    h('td', { class: 'num' }, Fmt.bits(x.rx * 8)),
    h('td', { class: 'num' }, Fmt.bits(x.tx * 8)),
    h('td', { class: 'num muted' }, `${Fmt.bytes(x.rxTotal)} / ${Fmt.bytes(x.txTotal)}`))));
  if (!list.length) tbody.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'muted' }, 'нет данных')));
}

/* ---------- вкладка «Процессы» ---------- */
function procsTab(page) {
  const id = page.id;
  const st = { sort: store.get('procSort', { k: 'cpu', d: -1 }), q: '', kernel: false, auto: true, data: null, timer: 0, busy: false, dead: false };
  const tbody = h('tbody');
  const count = h('span', { class: 'count' });
  const errBox = h('div');
  const cols = [
    ['pid', 'PID', 'num'], ['name', 'Процесс', ''], ['user', 'Пользователь', ''], ['cpu', 'CPU %', 'num'],
    ['mem', 'Память %', 'num'], ['rss', 'RSS', 'num'], ['threads', 'Потоки', 'num'], ['elapsed', 'Работает', 'num'], [null, '', ''],
  ];
  const thead = h('tr');
  function renderHead() {
    thead.replaceChildren(...cols.map(([key, label, cls]) => h('th', {
      class: (cls ? cls + ' ' : '') + (key ? 'sortable' : ''),
      onclick: key ? () => { st.sort = { k: key, d: st.sort.k === key ? -st.sort.d : (key === 'name' || key === 'user' ? 1 : -1) }; store.set('procSort', st.sort); renderHead(); render(); } : null,
    }, label, key && st.sort.k === key ? h('span', { class: 'arrow' }, st.sort.d > 0 ? '↑' : '↓') : null)));
  }
  renderHead();

  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Поиск: имя, команда, пользователь, PID', oninput: (e) => { st.q = e.target.value.trim().toLowerCase(); render(); } });
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      search,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { st.kernel = e.target.checked; render(); } }), 'Потоки ядра'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { st.auto = e.target.checked; schedule(); } }), 'Автообновление'),
      h('span', { class: 'grow' }), count,
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), 'Обновить')),
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
    if (!st.data) tbody.replaceChildren(h('tr', null, h('td', { colspan: '9', class: 'empty' }, h('span', { class: 'spinner' }), NB + ' Загрузка процессов…')));
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
    count.textContent = `показано ${Math.min(list.length, 300)} из ${total}`;
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
        h('button', { class: 'btn sm', type: 'button', onclick: () => kill(p, 'TERM') }, 'Завершить'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => kill(p, 'KILL') }, 'Kill'))))));
    if (!list.length) tbody.replaceChildren(h('tr', null, h('td', { colspan: '9', class: 'empty' }, 'Ничего не найдено')));
  }

  async function kill(p, sig) {
    const ok = await confirmDialog({
      title: sig === 'KILL' ? 'Принудительно завершить процесс?' : 'Завершить процесс?',
      text: h('div', null, h('b', null, p.name), ` (PID ${p.pid}, пользователь ${p.user || '?'})`, h('div', { class: 'cmd mono', style: { marginTop: '8px', wordBreak: 'break-all' } }, p.cmd)),
      warn: sig === 'KILL' ? 'Сигнал KILL нельзя перехватить: процесс не успеет сохранить данные.' : null,
      ok: sig === 'KILL' ? 'Отправить KILL' : 'Отправить TERM', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/procs/kill`, { method: 'POST', body: { pid: p.pid, signal: sig } });
      if (r.ok) toast(`Сигнал ${sig} отправлен процессу ${p.name} (${p.pid})`);
      else toast('Не удалось завершить процесс', 'bad', r.error);
    } catch (e) { toast(e.message, 'bad'); }
    setTimeout(load, 700);
  }

  load();
  return { el, destroy() { st.dead = true; clearTimeout(st.timer); } };
}

/* ---------- вкладка «Службы» ---------- */
const RISKY_UNITS = /^(ssh|sshd|tailscaled|networking|systemd-networkd|NetworkManager|systemd-resolved|dbus|dbus-broker|systemd-logind|wg-quick@.*|netplan.*)\.service$/;

function serviceState(s) {
  if (s.active === 'failed') return ['bad', 'ошибка'];
  if (s.active === 'active' && s.sub === 'running') return ['good', 'работает'];
  if (s.active === 'active' && s.sub === 'exited') return ['good', 'выполнена'];
  if (s.active === 'active') return ['good', s.sub];
  if (s.active === 'activating') return ['warn', 'запускается'];
  if (s.active === 'deactivating') return ['warn', 'останавливается'];
  if (s.active === 'reloading') return ['warn', 'перезагружается'];
  return ['idle', 'остановлена'];
}
const ENABLED_TEXT = { enabled: 'включён', disabled: 'выключен', static: 'статический', masked: 'заблокирован', indirect: 'косвенный', generated: 'сгенерирован', alias: 'псевдоним', 'enabled-runtime': 'включён (временно)', transient: 'временный' };

function servicesTab(page) {
  const id = page.id;
  const st = { data: null, q: '', filter: 'all', busy: false };
  const tbody = h('tbody');
  const errBox = h('div');
  const failedBox = h('div');
  const filterSeg = seg([['all', 'Все'], ['running', 'Работают'], ['failed', 'С ошибкой'], ['stopped', 'Остановлены']], 'all', (v) => { st.filter = v; render(); });
  const count = h('span', { class: 'count' });
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      h('input', { class: 'input search', type: 'search', placeholder: 'Поиск службы', oninput: (e) => { st.q = e.target.value.trim().toLowerCase(); render(); } }),
      filterSeg.el, h('span', { class: 'grow' }), count,
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), 'Обновить')),
    errBox, failedBox,
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Служба'), h('th', null, 'Состояние'), h('th', null, 'Автозапуск'), h('th'))), tbody)));

  async function load() {
    if (st.busy) return;
    st.busy = true;
    if (!st.data) tbody.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'empty' }, h('span', { class: 'spinner' }), NB + ' Загрузка служб…')));
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
    const failed = all.filter((s) => s.active === 'failed');
    const running = all.filter((s) => s.active === 'active' && s.sub === 'running');
    filterSeg.btns.forEach(([v, b]) => {
      const n = v === 'all' ? all.length : v === 'running' ? running.length : v === 'failed' ? failed.length : all.filter((s) => s.active === 'inactive').length;
      b.replaceChildren(b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent.replace(/\s\d+$/, '') : '', h('span', { class: 'muted' }, NB + n));
    });
    failedBox.replaceChildren(failed.length ? h('div', { class: 'alert bad', style: { marginBottom: '12px' } },
      h('span', { class: 'badge crit' }, `${failed.length} ${Fmt.plural(failed.length, 'ошибка', 'ошибки', 'ошибок')}`),
      h('div', null, 'С ошибкой: ', failed.map((s) => s.unit.replace(/\.service$/, '')).join(', '))) : '');
    let list = all;
    if (st.filter === 'running') list = running;
    else if (st.filter === 'failed') list = failed;
    else if (st.filter === 'stopped') list = all.filter((s) => s.active === 'inactive');
    if (st.q) list = list.filter((s) => s.unit.toLowerCase().includes(st.q) || s.description.toLowerCase().includes(st.q));
    count.textContent = `${list.length} из ${all.length}`;
    tbody.replaceChildren(...list.map((s) => {
      const [cls, text] = serviceState(s);
      const active = s.active === 'active' || s.active === 'activating' || s.active === 'reloading';
      const more = h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': `Ещё: ${s.unit}`, title: 'Ещё' }, icon('dots'));
      more.addEventListener('click', () => popMenu(more, [
        { label: 'Журнал службы', run: () => openLogs(s.unit) },
        { label: 'Перечитать конфигурацию (reload)', run: () => act(s, 'reload') },
        { label: 'Перезапуск по расписанию…', run: () => scheduleDialog({ servers: [id], kind: 'service', target: s.unit }) },
        '-',
        s.enabled === 'enabled' ? { label: 'Выключить автозапуск', run: () => act(s, 'disable') } : { label: 'Включить автозапуск', run: () => act(s, 'enable') },
      ]));
      return h('tr', null,
        h('td', { class: 'name-cell' }, h('b', null, s.unit.replace(/\.service$/, '')), h('div', { class: 'desc', title: s.description }, s.description || NB)),
        h('td', null, h('span', { class: 'st ' + cls }, h('span', { class: 'dot' }), text), s.active === 'active' && s.sub !== 'running' && s.sub !== 'exited' ? h('span', { class: 'muted' }, ' ' + s.sub) : null),
        h('td', { class: 'ink2' }, ENABLED_TEXT[s.enabled] || s.enabled || '—'),
        h('td', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => act(s, 'restart') }, 'Перезапустить'),
          active
            ? h('button', { class: 'btn sm', type: 'button', onclick: () => act(s, 'stop') }, 'Остановить')
            : h('button', { class: 'btn sm', type: 'button', onclick: () => act(s, 'start') }, 'Запустить'),
          more));
    }));
    if (!list.length) tbody.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'empty' }, all.length ? 'Ничего не найдено' : 'Службы systemd не найдены')));
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
  start: ['Запустить', 'запущена'], stop: ['Остановить', 'остановлена'], restart: ['Перезапустить', 'перезапущена'],
  reload: ['Перечитать конфигурацию', 'перечитала конфигурацию'], enable: ['Включить автозапуск', 'добавлена в автозапуск'], disable: ['Выключить автозапуск', 'убрана из автозапуска'],
};

async function serviceAction(page, unit, action, extraWarn) {
  const name = unit.replace(/\.service$/, '');
  const A = SVC_ACT[action];
  const risky = RISKY_UNITS.test(unit) && (action === 'stop' || action === 'restart' || action === 'disable');
  if (action !== 'start' && action !== 'enable') {
    const ok = await confirmDialog({
      title: `${A[0]} «${name}»?`,
      text: `Сервер: ${page.srv.name}. Команда: systemctl ${action} ${unit}`,
      warn: risky ? 'Эта служба отвечает за сеть или удалённый доступ — её остановка может оборвать подключение к серверу.' : extraWarn || null,
      ok: A[0], danger: action === 'stop' || action === 'disable' || risky,
    });
    if (!ok) return false;
  }
  toast(`${A[0]}: ${name}…`, 'warn');
  try {
    const r = await api(`/servers/${encodeURIComponent(page.id)}/services/action`, { method: 'POST', body: { unit, action } });
    if (r.ok) toast(`Служба ${name} ${A[1]}`);
    else toast(`Не получилось: ${A[0].toLowerCase()} ${name}`, 'bad', r.error);
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
const validName = (v) => (!v ? 'Введите имя' : v.includes('/') ? 'Имя не может содержать «/»' : v === '.' || v === '..' ? 'Недопустимое имя' : '');

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
  const filterIn = h('input', { class: 'input search', type: 'search', placeholder: 'Фильтр по имени', oninput: (e) => { st.q = e.target.value.trim().toLowerCase(); render(); } });

  const places = [['Домашняя', home], ['/etc', '/etc'], ['systemd', '/etc/systemd/system'], ['/usr/local/etc', '/usr/local/etc'], ['/opt', '/opt'], ['/var/log', '/var/log'], ['/tmp', '/tmp']];
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn sm', type: 'button', title: 'На уровень выше', onclick: () => go(pathDir(st.path)) }, '↑ Наверх'),
      pathIn,
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), 'Обновить'),
      canSudo ? h('label', { class: 'check', title: 'Выполнять через sudo -n' }, rootCb, 'как root') : null),
    h('div', { class: 'toolbar' },
      h('div', { class: 'chips', style: { margin: 0 } }, places.map(([l, p]) => h('button', { class: 'chip', type: 'button', onclick: () => go(p) }, l))),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', type: 'button', onclick: () => newFolder() }, 'Новая папка'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => newFile() }, 'Новый файл'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => upInput.click() }, 'Загрузить'), upInput),
    crumbs, errBox,
    h('div', { class: 'toolbar', style: { marginBottom: '8px' } }, filterIn, h('span', { class: 'grow' }), count),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl files' },
      h('thead', null, h('tr', null, h('th', null, 'Имя'), h('th', { class: 'num' }, 'Размер'), h('th', null, 'Изменён'), h('th', null, 'Права'), h('th', null, 'Владелец'), h('th'))),
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
    tbody.replaceChildren(h('tr', null, h('td', { colspan: '6', class: 'empty' }, h('span', { class: 'spinner' }), NB + ' Загрузка…')));
    try {
      const d = await api(url('list', st.path));
      st.path = d.path;
      st.entries = d.entries;
      store.set('files:' + id, st.path);
      errBox.replaceChildren(d.truncated ? h('div', { class: 'alert warn', style: { marginBottom: '10px' } }, 'Файлов очень много — показана только часть.') : '');
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
    count.textContent = st.q ? `${list.length} из ${st.entries.length}` : `${st.entries.length} ${Fmt.plural(st.entries.length, 'объект', 'объекта', 'объектов')}`;
    if (!list.length) {
      tbody.replaceChildren(h('tr', null, h('td', { colspan: '6', class: 'empty' }, st.entries.length ? 'Ничего не найдено' : 'Папка пуста')));
      return;
    }
    tbody.replaceChildren(...list.map((e) => {
      const full = pathJoin(st.path, e.name);
      const dir = isDir(e);
      const more = h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': 'Ещё', title: 'Ещё' }, icon('dots'));
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        popMenu(more, [
          dir ? { label: 'Открыть', run: () => go(full) } : { label: 'Открыть в редакторе', run: () => openFile(full) },
          !dir && e.type !== 'd' ? { label: 'Скачать', run: () => download(full) } : null,
          { label: 'Копировать путь', run: () => copyText(full) },
          '-',
          { label: 'Переименовать', run: () => rename(e) },
          { label: 'Удалить', danger: true, run: () => remove(e) },
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
        overwrite = await confirmDialog({ title: `Заменить «${f.name}»?`, text: `В ${st.path} уже есть файл с таким именем.`, ok: 'Заменить', danger: true });
        if (!overwrite) continue;
      }
      toast(`Загрузка ${f.name} (${Fmt.bytes(f.size)})…`, 'warn');
      try {
        const res = await fetch('/api' + url('upload', target) + (overwrite ? '&overwrite=1' : ''), {
          method: 'POST', headers: { 'X-Panel-Token': TOKEN, 'Content-Type': 'application/octet-stream' }, body: f,
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'Ошибка ' + res.status);
        toast(`${f.name} загружен`);
      } catch (e) { toast(`Не удалось загрузить ${f.name}`, 'bad', e.message); }
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
    const name = await promptDialog({ title: 'Новая папка', label: `Имя папки в ${st.path}`, ok: 'Создать', validate: validName });
    if (name) op({ op: 'mkdir', path: pathJoin(st.path, name) }, 'Папка создана');
  }

  async function newFile() {
    const name = await promptDialog({ title: 'Новый файл', label: `Имя файла в ${st.path}`, ok: 'Создать', validate: validName });
    if (!name) return;
    if (st.entries.some((e) => e.name === name)) { toast('Такой файл уже есть', 'bad'); return; }
    fileEditor(page, { path: pathJoin(st.path, name), content: '', sha: '', isNew: true, root: st.root, onSaved: load });
  }

  async function rename(e) {
    const name = await promptDialog({ title: 'Переименовать', label: `Новое имя для «${e.name}»`, value: e.name, ok: 'Переименовать', validate: validName });
    if (!name || name === e.name) return;
    op({ op: 'rename', path: pathJoin(st.path, e.name), to: pathJoin(st.path, name) }, 'Переименовано');
  }

  async function remove(e) {
    const dir = e.type === 'd';
    const ok = await confirmDialog({
      title: `Удалить «${e.name}»?`, text: `${pathJoin(st.path, e.name)} — удаление нельзя отменить.`,
      warn: dir ? 'Папка будет удалена вместе со всем содержимым.' : null, ok: 'Удалить', danger: true,
    });
    if (ok) op({ op: 'delete', path: pathJoin(st.path, e.name) }, 'Удалено');
  }

  async function openFile(p, unit) {
    toast('Открываю ' + pathBase(p) + '…', 'warn');
    try {
      const d = await api(url('read', p));
      if (d.tooBig || d.binary) {
        const m = modal({
          title: pathBase(p),
          body: h('div', { class: 'form' }, h('div', { class: 'ink2' }, d.tooBig ? `Файл слишком большой для редактора (${Fmt.bytes(d.size)}, можно до 2 МБ).` : 'Это двоичный файл — его можно только скачать.')),
          foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Закрыть'), h('button', { class: 'btn primary', type: 'button', onclick: () => { download(p); m.close(); } }, 'Скачать')],
        });
        return;
      }
      fileEditor(page, Object.assign(d, { root: st.root, unit, onSaved: () => { if (pathDir(p) === st.path) load(); }, onDownload: () => download(p) }));
    } catch (e) {
      toast(`Не удалось открыть ${pathBase(p)}`, 'bad', e.message + (canSudo && !st.root && /доступ/.test(e.message) ? '\nВключите «как root».' : ''));
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
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, f.isNew ? 'Создать' : 'Сохранить');
  const restartBtn = f.unit ? h('button', { class: 'btn', type: 'button' }, `Сохранить и перезапустить ${f.unit.replace(/\.service$/, '')}`) : null;
  const undoBtn = h('button', { class: 'btn ghost left', type: 'button', hidden: true }, 'Вернуть как было');
  const dirty = () => ta.value !== saved;
  const meta = f.isNew ? 'новый файл' : [Fmt.bytes(f.size), fmtMode('f', f.mode), `${f.user}:${f.group}`, 'изменён ' + fileTime(f.mtime)].join(' · ');

  function upd() {
    const lines = ta.value.split('\n').length;
    stat.textContent = `${lines} ${Fmt.plural(lines, 'строка', 'строки', 'строк')}` + (dirty() ? ' · есть несохранённые изменения' : '');
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
    lead: h('span', null, h('span', { class: 'mono' }, f.path), ' · ', meta, f.root ? ' · как root' : ''),
    body: h('div', { class: 'editor-body' }, warnBox, ta, h('div', { class: 'editor-status' }, stat, h('span', { class: 'muted' }, '⌘S — сохранить'))),
    foot: [undoBtn, f.onDownload ? h('button', { class: 'btn ghost', type: 'button', onclick: () => f.onDownload() }, 'Скачать') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Закрыть'), restartBtn, saveBtn],
    beforeClose: () => {
      if (!dirty()) return true;
      confirmDialog({ title: 'Закрыть без сохранения?', text: 'Изменения в файле будут потеряны.', ok: 'Закрыть', danger: true }).then((ok) => { if (ok) m.close(true); });
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
        const ok = await confirmDialog({ title: 'В JSON есть ошибка', text: e.message, warn: 'Программа может не запуститься с таким файлом (если только она не допускает комментарии в JSON, как xray).', ok: 'Сохранить всё равно', danger: true });
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
      saveBtn.textContent = 'Сохранить';
      undoBtn.hidden = before === null;
      toast(`${name} сохранён`);
      if (f.onSaved) f.onSaved();
      if (restart && f.unit) {
        const ok = await serviceAction(page, f.unit, 'restart', 'Клиенты VPN на несколько секунд потеряют соединение.');
        if (ok) warnBox.replaceChildren(h('div', { class: 'alert good-alert' }, `Служба ${f.unit.replace(/\.service$/, '')} перезапущена. Проверьте журнал, что она запустилась без ошибок.`));
      }
    } catch (e) {
      warnBox.replaceChildren(h('div', { class: 'alert bad' }, 'Не сохранено: ' + e.message));
    }
    upd();
  }
  saveBtn.addEventListener('click', () => save(false));
  if (restartBtn) restartBtn.addEventListener('click', () => save(true));
  undoBtn.addEventListener('click', async () => {
    if (before === null) return;
    const ok = await confirmDialog({ title: 'Вернуть файл как было?', text: 'На сервер будет записано содержимое до вашего последнего сохранения.', ok: 'Вернуть' });
    if (!ok) return;
    try {
      const r = await write(before, sha);
      sha = r.sha;
      saved = before;
      ta.value = before;
      before = null;
      undoBtn.hidden = true;
      toast(`${name}: возвращено как было`);
      if (f.onSaved) f.onSaved();
    } catch (e) { warnBox.replaceChildren(h('div', { class: 'alert bad' }, 'Не получилось: ' + e.message)); }
    upd();
  });
}

/* ---------- вкладка «VPN» ---------- */
function vpnTab(page) {
  const id = page.id;
  const st = { data: null, timer: 0, busy: false, dead: false, open: new Set() };
  const k = { svc: kpiTile('VPN-службы'), conns: kpiTile('TCP-соединения клиентов'), ips: kpiTile('Клиентские IP'), wg: kpiTile('WireGuard / AmneziaWG') };
  const listEl = h('div', { class: 'vlist' });
  const stoppedEl = h('div');
  const errBox = h('div');
  const upd = h('span', { class: 'count' });
  const el = h('div', null,
    h('div', { class: 'grid kpis' }, Object.values(k).map((t) => t.el)),
    h('div', { class: 'toolbar' }, h('span', { class: 'ink2', style: { fontSize: '13px' } }, 'Службы VPN и прокси, найденные по названию'), h('span', { class: 'grow' }), upd,
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), 'Обновить')),
    errBox, listEl, stoppedEl);

  const short = (u) => u.replace(/\.service$/, '');
  const openLogs = (unit) => { page.logUnit = unit; location.hash = `#/s/${encodeURIComponent(id)}/logs`; };
  const openConfig = (path, unit) => { page.filePath = path; page.fileUnit = unit || ''; location.hash = `#/s/${encodeURIComponent(id)}/files`; };

  async function load() {
    if (st.busy || st.dead) return;
    st.busy = true;
    clearTimeout(st.timer);
    if (!st.data) listEl.replaceChildren(h('div', { class: 'card empty' }, h('span', { class: 'spinner' }), NB + ' Собираю сведения о VPN-службах…'));
    try {
      st.data = await api(`/servers/${encodeURIComponent(id)}/vpn`);
      errBox.replaceChildren(st.data.privileged ? '' : h('div', { class: 'alert warn', style: { marginBottom: '12px' } }, icon('warn'),
        h('div', null, 'Нет прав root или sudo без пароля — порты служб и пиры WireGuard могут быть видны не полностью.')));
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
    const extra = p.proto === 'tcp' && !local ? (p.conns ? ` · ${Fmt.int(p.conns)} ${Fmt.plural(p.conns, 'соединение', 'соединения', 'соединений')}${p.ips ? ` · ${p.ips} IP` : ''}` : ' · нет соединений') : local ? ' · только локально' : '';
    return h('span', { class: 'pchip' + (local ? ' dim' : ''), title: `${p.addr || '*'}:${p.port}` }, h('b', null, label), extra);
  }

  function wgBlock(w) {
    const showAll = st.open.has(w.name);
    const peers = showAll ? w.list : w.list.slice(0, 8);
    const now = Date.now();
    return h('div', { class: 'wg' },
      h('div', { class: 'wg-head' }, h('b', null, w.name), w.port ? h('span', { class: 'muted' }, `порт ${w.port}`) : null,
        h('span', null, `пиров ${w.peers}, активны ${w.active}`), h('span', { class: 'muted' }, `↓ ${Fmt.bytes(w.rx)} · ↑ ${Fmt.bytes(w.tx)}`)),
      w.list.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, 'Пир'), h('th', null, 'Адрес'), h('th', null, 'Разрешённые IP'), h('th', null, 'Рукопожатие'), h('th', { class: 'num' }, '↓ / ↑'))),
        h('tbody', null, peers.map((p) => {
          const age = p.handshake ? (now - p.handshake) / 1000 : null;
          return h('tr', null,
            h('td', { class: 'mono' }, p.key),
            h('td', { class: 'mono' }, p.endpoint || '—'),
            h('td', { class: 'mono' }, p.allowed || '—'),
            h('td', null, h('span', { class: 'st ' + (age != null && age < 180 ? 'good' : 'idle') }, h('span', { class: 'dot' }), age == null ? 'не было' : Fmt.dur(age) + ' назад')),
            h('td', { class: 'num' }, `${Fmt.bytes(p.rx)} / ${Fmt.bytes(p.tx)}`));
        })))) : null,
      w.list.length > 8 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { if (showAll) st.open.delete(w.name); else st.open.add(w.name); render(); } },
        showAll ? 'Свернуть' : `Показать всех (${w.list.length})`) : null);
  }

  function card(s) {
    const [cls, text] = serviceState(s);
    const ports = s.ports.filter((p) => !p.eph);
    const eph = s.ports.length - ports.length;
    const stats = [
      s.since ? ['Работает', Fmt.dur(s.since)] : null,
      s.mem ? ['Память', Fmt.bytes(s.mem)] : null,
      s.cpuSec ? ['Время CPU', Fmt.dur(s.cpuSec)] : null,
      ['Перезапусков', String(s.restarts || 0)],
      s.version ? ['Версия', s.version] : null,
      s.pid ? ['PID', String(s.pid)] : null,
    ].filter(Boolean);
    return h('div', { class: 'card vcard' },
      h('div', { class: 'vhead' },
        h('div', { class: 'vname' }, h('b', null, short(s.unit)), h('span', { class: 'st ' + cls }, h('span', { class: 'dot' }), text),
          s.restarts > 0 ? h('span', { class: 'badge warn', title: 'systemd перезапускал службу после сбоев' }, `перезапусков: ${s.restarts}`) : null),
        h('div', { class: 'vact' },
          s.config ? h('button', { class: 'btn sm', type: 'button', title: s.config, onclick: () => openConfig(s.config, s.unit) }, 'Конфиг') : null,
          h('button', { class: 'btn sm', type: 'button', onclick: () => openLogs(s.unit) }, 'Журнал'),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await serviceAction(page, s.unit, 'restart', 'Клиенты VPN на несколько секунд потеряют соединение.')) load(); } }, 'Перезапустить'))),
      s.description && s.description !== s.unit ? h('div', { class: 'vdesc' }, s.description) : null,
      h('div', { class: 'vstats' }, stats.map(([a, b]) => h('span', null, h('span', { class: 'muted' }, a + ' '), b))),
      ports.length || eph ? h('div', { class: 'pchips' }, ports.map(portChip), eph ? h('span', { class: 'muted', style: { fontSize: '12px', alignSelf: 'center' } }, `+ ${eph} исходящих UDP-сокетов`) : null) : null,
      s.config ? h('div', { class: 'vline' }, h('span', { class: 'muted' }, 'Конфиг '), h('span', { class: 'mono' }, s.config)) : null,
      s.exec ? h('div', { class: 'vline', title: s.exec }, h('span', { class: 'muted' }, 'Команда '), h('span', { class: 'mono' }, s.exec)) : null,
      (s.wg || []).map(wgBlock));
  }

  function render() {
    const d = st.data;
    const all = d.services || [];
    const running = all.filter((s) => s.active === 'active' || s.active === 'activating' || s.active === 'reloading');
    const stopped = all.filter((s) => !running.includes(s));
    const conns = all.reduce((a, s) => a + s.ports.reduce((b, p) => b + (p.conns || 0), 0), 0);
    const ips = all.reduce((a, s) => a + s.ports.reduce((b, p) => b + (p.ips || 0), 0), 0);
    const failed = all.filter((s) => s.active === 'failed');
    k.svc.set(String(running.length), ` из ${all.length}`, failed.length ? `с ошибкой: ${failed.map((s) => short(s.unit)).join(', ')}` : stopped.length ? `остановлены: ${stopped.map((s) => short(s.unit)).join(', ')}` : 'все работают', null);
    k.conns.set(Fmt.int(conns), '', 'установленные TCP-соединения на портах VPN', null);
    k.ips.set(Fmt.int(ips), '', 'разные адреса, по каждому порту отдельно', null);
    const wg = d.wg || [];
    const wgPeers = wg.reduce((a, w) => a + w.peers, 0), wgActive = wg.reduce((a, w) => a + w.active, 0);
    k.wg.set(wg.length ? `${wgActive}` : '—', wg.length ? ` из ${wgPeers}` : '', wg.length ? `активных пиров на ${wg.length} ${Fmt.plural(wg.length, 'интерфейсе', 'интерфейсах', 'интерфейсах')}` : 'интерфейсов не найдено', null);
    upd.textContent = 'обновлено ' + Fmt.clock(d.t, true);

    // интерфейсы WireGuard без своей службы (например, поднятые вручную)
    const own = new Set(all.flatMap((s) => (s.wg || []).map((w) => w.name)));
    const loose = wg.filter((w) => !own.has(w.name));

    if (!all.length && !loose.length) {
      listEl.replaceChildren(h('div', { class: 'card empty' }, h('b', null, 'VPN-службы не найдены'),
        'Панель ищет службы systemd с названиями xray, sing-box, hysteria, AmneziaWG, WireGuard, mtg, OpenVPN и других.'));
      stoppedEl.replaceChildren();
      return;
    }
    listEl.replaceChildren(...running.map(card), ...failed.map(card),
      loose.length ? h('div', { class: 'card vcard' }, h('div', { class: 'vhead' }, h('div', { class: 'vname' }, h('b', null, 'Интерфейсы WireGuard'))), loose.map(wgBlock)) : '');
    const idle = stopped.filter((s) => s.active !== 'failed');
    stoppedEl.replaceChildren(idle.length ? h('div', null,
      h('div', { class: 'section-title' }, `Остановлены (${idle.length})`),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('tbody', null, idle.map((s) => h('tr', null,
        h('td', { class: 'name-cell' }, h('b', null, short(s.unit)), h('div', { class: 'desc' }, s.description || NB)),
        h('td', null, h('span', { class: 'st idle' }, h('span', { class: 'dot' }), ENABLED_TEXT[s.enabled] ? `автозапуск ${ENABLED_TEXT[s.enabled]}` : 'остановлена')),
        h('td', { class: 'actions' },
          s.config ? h('button', { class: 'btn sm', type: 'button', onclick: () => openConfig(s.config) }, 'Конфиг') : null,
          h('button', { class: 'btn sm', type: 'button', onclick: () => openLogs(s.unit) }, 'Журнал'),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await serviceAction(page, s.unit, 'start')) load(); } }, 'Запустить')))))))) : '');
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
  const unitIn = h('input', { class: 'input', style: { width: '220px' }, placeholder: 'Все службы', list: dl.id, value: st.unit.replace(/\.service$/, '') });
  unitIn.addEventListener('change', () => { st.unit = unitIn.value.trim(); reload(); });
  const prioSel = h('select', { class: 'input', onchange: (e) => { st.prio = e.target.value; reload(); } },
    h('option', { value: '' }, 'Все уровни'), h('option', { value: '4' }, 'Предупреждения и выше'), h('option', { value: '3' }, 'Только ошибки'));
  const linesSel = h('select', { class: 'input', onchange: (e) => { st.lines = +e.target.value; reload(); } },
    [200, 300, 1000, 3000].map((n) => h('option', { value: String(n), selected: n === st.lines }, `${n} строк`)));
  const el = h('div', null,
    h('div', { class: 'toolbar' },
      unitIn, dl, prioSel, linesSel,
      h('input', { class: 'input', type: 'search', placeholder: 'Фильтр по тексту', style: { width: '200px' }, oninput: (e) => { st.q = e.target.value.toLowerCase(); render(); } }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { st.follow = e.target.checked; schedule(); } }), 'Следить'),
      h('span', { class: 'grow' }), count,
      h('button', { class: 'btn sm', type: 'button', onclick: reload }, icon('refresh'), 'Обновить')),
    errBox, box);

  const fillUnits = (list) => dl.replaceChildren(h('option', { value: 'kernel' }, 'Сообщения ядра'), ...list.map((s) => h('option', { value: s.unit.replace(/\.service$/, '') })));
  if (page.services) fillUnits(page.services);
  else api(`/servers/${encodeURIComponent(id)}/services`).then((d) => { page.services = d.services || []; fillUnits(page.services); }, () => {});

  function schedule() {
    clearTimeout(st.timer);
    if (st.follow && !st.dead) st.timer = setTimeout(() => load(true), 2500);
  }

  function reload() { st.entries = []; st.cursor = ''; box.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), NB + ' Загрузка журнала…')); load(false); }

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
    if (p <= 2) return h('span', { class: 'badge crit' }, 'крит.');
    if (p === 3) return h('span', { class: 'badge crit' }, 'ошибка');
    if (p === 4) return h('span', { class: 'badge warn' }, 'внимание');
    return h('span');
  }

  function render(scroll) {
    let list = st.entries;
    if (st.q) list = list.filter((e) => e.m.toLowerCase().includes(st.q) || (e.id || '').toLowerCase().includes(st.q));
    count.textContent = `${list.length} записей`;
    const frag = document.createDocumentFragment();
    for (const e of list) {
      if (st.plain) { frag.append(h('div', { class: 'log-plain' }, e.m)); continue; }
      frag.append(h('div', { class: 'log-line p' + e.p },
        h('span', { class: 'log-time', title: new Date(e.t).toLocaleString('ru-RU') }, Fmt.dateTime(e.t)),
        badge(e.p),
        h('span', { class: 'log-id', title: (e.u || '') + (e.pid ? ' · PID ' + e.pid : '') }, e.id || e.u || ''),
        h('span', { class: 'log-msg' }, e.m)));
    }
    box.replaceChildren(frag);
    if (!list.length) box.append(h('div', { class: 'empty' }, 'Записей нет'));
    if (scroll) box.scrollTop = box.scrollHeight;
  }

  reload();
  return { el, destroy() { st.dead = true; clearTimeout(st.timer); } };
}

/* ---------- вкладка «Сеть» ---------- */
function networkTab(page) {
  const id = page.id;
  const st = { timer: 0, dead: false, busy: false };
  const k = { rx: kpiTile('Входящий трафик'), tx: kpiTile('Исходящий трафик'), est: kpiTile('Установленные TCP'), peers: kpiTile('Уникальные адреса') };
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
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Входящие подключения'), h('div', { class: 'card-sub' }, 'по локальному порту'))), inEl),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Исходящие подключения'), h('div', { class: 'card-sub' }, 'по удалённому порту'))), outEl),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Активные адреса'), h('div', { class: 'card-sub' }, 'больше всего TCP-соединений'))), peersEl)),
    h('div', { class: 'grid two', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'Открытые порты'), h('div', { class: 'right' }, h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), 'Обновить'))),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Протокол'), h('th', null, 'Адрес'), h('th', { class: 'num' }, 'Порт'), h('th', null, 'Процесс'))), listenBody))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'Сетевые интерфейсы')),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Интерфейс'), h('th', { class: 'num' }, '↓'), h('th', { class: 'num' }, '↑'), h('th', { class: 'num' }, 'Всего ↓ / ↑'))), ifBody)))));

  function bars(target, list, fmtKey) {
    const max = Math.max(1, ...list.map((x) => x.count));
    target.replaceChildren(...list.map((x) => {
      const m = meter((x.count / max) * 100);
      m.el.classList.remove('warn', 'crit');
      return h('div', { class: 'lb' }, h('span', { class: 'lb-k' }, fmtKey(x.key)), h('span', { class: 'lb-v' }, Fmt.int(x.count)), m.el);
    }));
    if (!list.length) target.replaceChildren(h('div', { class: 'muted' }, 'нет соединений'));
  }

  function live(m) {
    if (!m) return;
    k.rx.set(Fmt.bits(m.netRx * 8), '', 'сейчас', null);
    k.tx.set(Fmt.bits(m.netTx * 8), '', 'сейчас', null);
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
      k.est.set(Fmt.int(d.established), '', `входящих ${Fmt.int(d.inbound)} · исходящих ${Fmt.int(d.outbound)}`, null);
      k.peers.set(Fmt.int(d.uniquePeers), '', 'IP-адресов с активными TCP', null);
      bars(inEl, d.localPorts || [], (p) => 'порт ' + p);
      bars(outEl, d.remotePorts || [], (p) => 'порт ' + p);
      bars(peersEl, d.peers || [], (p) => p);
      listenBody.replaceChildren(...(d.listen || []).map((l) => h('tr', null,
        h('td', null, l.proto), h('td', { class: 'mono' }, l.addr), h('td', { class: 'num' }, l.port),
        h('td', { class: 'ink2' }, (l.procs || []).join(', ') || '—'))));
      if (!(d.listen || []).length) listenBody.replaceChildren(h('tr', null, h('td', { colspan: '4', class: 'muted' }, 'нет данных (нужны права root или sudo)')));
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
    h('div', { class: 'toolbar' }, h('span', { class: 'grow' }), h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), 'Обновить')),
    errBox,
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Контейнер'), h('th', null, 'Состояние'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'Память'), h('th', null, 'Порты'), h('th'))), tbody)));

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
            h('button', { class: 'btn sm', type: 'button', onclick: () => logs(name) }, 'Логи'),
            h('button', { class: 'btn sm', type: 'button', onclick: () => act(name, 'restart') }, 'Перезапустить'),
            running ? h('button', { class: 'btn sm', type: 'button', onclick: () => act(name, 'stop') }, 'Остановить')
              : h('button', { class: 'btn sm', type: 'button', onclick: () => act(name, 'start') }, 'Запустить')));
      }));
      if (!(d.containers || []).length) tbody.replaceChildren(h('tr', null, h('td', { colspan: '6', class: 'empty' }, 'Контейнеров нет')));
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
    }
    st.busy = false;
    if (!st.dead) st.timer = setTimeout(load, 15000);
  }

  async function act(name, action) {
    if (action !== 'start') {
      const ok = await confirmDialog({ title: `${action === 'stop' ? 'Остановить' : 'Перезапустить'} контейнер «${name}»?`, ok: action === 'stop' ? 'Остановить' : 'Перезапустить', danger: action === 'stop' });
      if (!ok) return;
    }
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/docker/action`, { method: 'POST', body: { container: name, action } });
      r.ok ? toast(`Контейнер ${name}: готово`) : toast(`Контейнер ${name}: ошибка`, 'bad', r.error);
    } catch (e) { toast(e.message, 'bad'); }
    load();
  }

  async function logs(name) {
    const pre = h('pre', { class: 'pre' }, 'Загрузка…');
    const closeBtn = h('button', { class: 'btn', type: 'button' }, 'Закрыть');
    const md = modal({ title: `Логи контейнера ${name}`, lead: 'Последние 500 строк', body: pre, wide: true, foot: [closeBtn] });
    closeBtn.addEventListener('click', () => md.close());
    try {
      const d = await api(`/servers/${encodeURIComponent(id)}/docker/logs?container=${encodeURIComponent(name)}`);
      pre.textContent = d.output || '(пусто)';
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
  ['port', 'Порт'], ['listenaddress', 'Адреса'], ['permitrootlogin', 'Вход под root'], ['passwordauthentication', 'Вход по паролю'],
  ['kbdinteractiveauthentication', 'Интерактивный вход'], ['pubkeyauthentication', 'Вход по ключу'], ['permitemptypasswords', 'Пустые пароли'],
  ['maxauthtries', 'Попыток за подключение'], ['x11forwarding', 'X11 forwarding'], ['allowusers', 'Разрешённые пользователи'], ['allowgroups', 'Разрешённые группы'],
];
const SSHD_VAL = { yes: 'да', no: 'нет', 'prohibit-password': 'только по ключу', 'without-password': 'только по ключу', 'forced-commands-only': 'только заданные команды' };

function sshdRisk(k, v) {
  if (k === 'permitemptypasswords' && v === 'yes') return ['bad', 'опасно'];
  if (k === 'passwordauthentication' && v === 'yes') return ['warn', 'лучше выключить: подбор паролей'];
  if (k === 'kbdinteractiveauthentication' && v === 'yes') return ['warn', 'может принимать пароли'];
  if (k === 'permitrootlogin' && v === 'yes') return ['warn', 'root может входить по паролю'];
  return null;
}

function systemTab(page) {
  const id = page.id;
  const st = { d: null, busy: false, dead: false, job: '', jobT: 0, showAll: false };
  const errBox = h('div');
  const body = h('div', null, h('div', { class: 'card empty' }, h('span', { class: 'spinner' }), NB + ' Собираю сведения о системе…'));
  const jobBox = h('div');
  const el = h('div', null,
    h('div', { class: 'toolbar' }, h('span', { class: 'ink2', style: { fontSize: '13px' } }, 'Обновления пакетов, настройки SSH, попытки входа, fail2ban и ufw'), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), 'Обновить')),
    errBox, jobBox, body);

  async function load() {
    if (st.busy || st.dead) return;
    st.busy = true;
    try {
      st.d = await api(`/servers/${encodeURIComponent(id)}/system`);
      errBox.replaceChildren(st.d.privileged ? '' : h('div', { class: 'alert warn', style: { marginBottom: '12px' } }, icon('warn'),
        h('div', null, 'Нет прав root или sudo без пароля — часть сведений (sshd, fail2ban, журнал входов) недоступна, обновлять пакеты нельзя.')));
      render();
      if (st.d.job && !st.job) watchJob(st.d.job);
    } catch (e) {
      errBox.replaceChildren(h('div', { class: 'alert bad', style: { marginBottom: '12px' } }, e.message));
      body.replaceChildren();
    }
    st.busy = false;
  }

  const ago = (ms) => (ms ? Fmt.dur((Date.now() - ms) / 1000) + ' назад' : 'неизвестно');

  function updatesCard(d) {
    if (!d.apt) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Обновления'), h('div', { class: 'muted', style: { marginTop: '8px' } }, 'На сервере нет apt — обновления этой системы панель не показывает.'));
    const n = d.upgrades.length;
    const list = st.showAll ? d.upgrades : d.upgrades.slice(0, 12);
    const auto = d.autoUpgrade && d.unattended && d.unattended.startsWith('enabled');
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('div', { class: 'card-title' }, 'Обновления пакетов'),
          h('div', { class: 'card-sub' }, `список пакетов обновлён ${ago(d.lastUpdate)} · последняя установка ${ago(d.lastUpgrade)}`)),
        h('div', { class: 'vact' },
          h('button', { class: 'btn sm', type: 'button', disabled: !d.privileged || !!st.job, onclick: () => startJob('update') }, 'Проверить обновления'),
          h('button', { class: 'btn sm primary', type: 'button', disabled: !d.privileged || !!st.job || !n, onclick: () => startJob('upgrade') }, 'Установить обновления'))),
      h('div', { class: 'sys-kpis' },
        h('div', null, h('div', { class: 'kpi-value' }, String(n)), h('div', { class: 'kpi-sub' }, n ? Fmt.plural(n, 'пакет можно обновить', 'пакета можно обновить', 'пакетов можно обновить') : 'всё обновлено')),
        h('div', null, h('div', { class: 'kpi-value' + (d.security ? ' crit-ink' : '') }, String(d.security)), h('div', { class: 'kpi-sub' }, 'из них — исправления безопасности')),
        h('div', null, h('div', { class: 'kpi-value small' }, h('span', { class: 'st ' + (auto ? 'good' : 'warn') }, h('span', { class: 'dot' }), auto ? 'включены' : 'выключены')),
          h('div', { class: 'kpi-sub' }, 'автоматические обновления безопасности'))),
      d.reboot ? h('div', { class: 'alert warn', style: { alignItems: 'center' } }, icon('warn'),
        h('div', { style: { flex: 1 } }, 'Нужна перезагрузка, чтобы применились обновления' + (d.rebootPkgs && d.rebootPkgs.length ? ': ' + d.rebootPkgs.slice(0, 6).join(', ') + (d.rebootPkgs.length > 6 ? ` и ещё ${d.rebootPkgs.length - 6}` : '') : '') + '.'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => rebootDialog(page.srv) }, 'Перезагрузить…')) : null,
      n ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, h('th', null, 'Пакет'), h('th', null, 'Сейчас'), h('th', null, 'Новая версия'), h('th'))),
        h('tbody', null, list.map((p) => h('tr', null,
          h('td', null, h('b', null, p.name)), h('td', { class: 'mono muted' }, p.from), h('td', { class: 'mono' }, p.to),
          h('td', null, p.security ? h('span', { class: 'badge crit' }, 'безопасность') : null)))))) : null,
      n > 12 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.showAll = !st.showAll; render(); } }, st.showAll ? 'Свернуть' : `Показать все (${n})`) : null);
  }

  function sshCard(d) {
    const keys = SSHD_ROWS.filter(([k]) => d.sshd[k]);
    if (!keys.length) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'SSH-сервер'), h('div', { class: 'muted', style: { marginTop: '8px' } }, 'Настройки sshd прочитать не удалось (нужны права root).'));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'SSH-сервер'), h('div', { class: 'card-sub' }, 'действующие настройки (sshd -T)'))),
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
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Входы по SSH за 24 часа'),
        h('div', { class: 'card-sub' }, `неудачных попыток ${Fmt.int(d.authFail)} · успешных входов ${Fmt.int(d.authOk)}`))),
      d.authFail ? h('div', { class: 'grid two', style: { gap: '20px' } },
        h('div', null, h('div', { class: 'mini-title' }, 'Чаще всего с адресов'), d.authIps.map((x) => row(x, maxIP))),
        h('div', null, h('div', { class: 'mini-title' }, 'Пробовали пользователей'), d.authUsers.map((x) => row(x, maxU)))) : h('div', { class: 'muted' }, 'Неудачных попыток не было.'),
      d.accepted.length ? h('div', { style: { marginTop: '14px' } }, h('div', { class: 'mini-title' }, 'Успешные входы (последние)'),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl compact' }, h('tbody', null, d.accepted.map((a) => h('tr', null,
          h('td', null, h('b', null, a.user)), h('td', { class: 'mono' }, a.ip), h('td', { class: 'muted' }, a.method === 'publickey' ? 'по ключу' : a.method === 'password' ? 'по паролю' : a.method),
          h('td', { class: 'num muted' }, a.n > 1 ? `${a.n} раз` : ''),
          h('td', { class: 'muted nowrap' }, a.time ? 'последний ' + Fmt.dateTime(Date.parse(a.time), false) : ''))))))) : null);
  }

  function f2bCard(d) {
    if (!d.f2b) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'fail2ban'), h('div', { class: 'muted', style: { marginTop: '8px' } }, 'Не установлен. Он блокирует адреса, с которых подбирают пароли (apt install fail2ban).'));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'fail2ban'),
        h('div', { class: 'card-sub' }, h('span', { class: 'st ' + (d.f2bActive === 'active' ? 'good' : 'bad') }, h('span', { class: 'dot' }), d.f2bActive === 'active' ? 'работает' : (d.f2bActive || 'не запущен'))))),
      d.jails.length ? d.jails.map((j) => h('div', { class: 'jail' },
        h('div', { class: 'jail-head' }, h('b', null, j.name), h('span', { class: 'muted' }, `заблокировано сейчас ${j.banned} · всего ${j.totalBanned} · ошибок сейчас ${j.failed}`)),
        j.ips.length ? h('div', { class: 'pchips' }, j.ips.slice(0, 60).map((ip) => h('span', { class: 'pchip' }, h('span', { class: 'mono' }, ip),
          h('button', { class: 'linkbtn', type: 'button', title: 'Разблокировать', onclick: () => unban(j.name, ip) }, 'разбан'))),
        j.ips.length > 60 ? h('span', { class: 'muted', style: { fontSize: '12px' } }, `и ещё ${j.ips.length - 60}`) : null) : null)) : h('div', { class: 'muted' }, d.privileged ? 'Активных jail нет.' : 'Нужны права root.'));
  }

  function fwCard(d) {
    if (!d.ufw) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Файрвол ufw'), h('div', { class: 'muted', style: { marginTop: '8px' } }, 'ufw не установлен (правила nftables/iptables панель не разбирает).'));
    const on = d.ufwStatus === 'active';
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'card-title' }, 'Файрвол ufw'),
        h('div', { class: 'card-sub' }, h('span', { class: 'st ' + (on ? 'good' : 'idle') }, h('span', { class: 'dot' }), on ? 'включён' : d.ufwStatus === 'inactive' ? 'выключен' : (d.ufwStatus || 'нет данных'))))),
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
    const ok = await confirmDialog({ title: `Разблокировать ${ip}?`, text: `fail2ban, jail «${jail}».`, ok: 'Разблокировать' });
    if (!ok) return;
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/system/unban`, { method: 'POST', body: { jail, ip } });
      if (r.ok) toast(`${ip} разблокирован`); else toast('Не получилось', 'bad', r.error);
    } catch (e) { toast(e.message, 'bad'); }
    load();
  }

  async function startJob(action) {
    if (action === 'upgrade') {
      const vpn = (page.srv.units || []).filter((u) => u.vpn && u.active === 'active').length;
      const ok = await confirmDialog({
        title: `Установить обновления на ${page.srv.name}?`,
        text: 'apt-get update и apt-get upgrade. Конфигурационные файлы, которые вы меняли, сохранятся; удалять пакеты apt не будет. Задание работает на сервере само, его можно не ждать.',
        warn: vpn ? 'Обновление может перезапустить службы, в том числе VPN — клиенты на несколько секунд потеряют связь.' : null,
        ok: 'Установить',
      });
      if (!ok) return;
    }
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/system/apt`, { method: 'POST', body: { action } });
      if (r.already) toast('Обновление уже идёт — показываю его ход', 'warn');
      watchJob(r.unit);
    } catch (e) { toast('Не удалось запустить', 'bad', e.message); }
  }

  function watchJob(unit) {
    st.job = unit;
    if (st.d) render();
    const pre = h('pre', { class: 'pre job-log' }, '…');
    const head = h('div', { class: 'job-head' }, h('span', { class: 'spinner' }), h('b', null, unit.includes('apt') ? 'Обновление пакетов' : unit), h('span', { class: 'muted' }, 'идёт на сервере'));
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
          head.replaceChildren(h('span', { class: 'st ' + (ok ? 'good' : 'bad') }, h('span', { class: 'dot' }), ok ? 'Готово' : r.exit > 0 ? `Ошибка (код ${r.exit})` : 'Задание завершилось'),
            h('span', { class: 'grow' }), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => jobBox.replaceChildren() }, 'Скрыть'));
          st.job = '';
          toast(ok ? `${page.srv.name}: пакеты обновлены` : `${page.srv.name}: обновление завершилось с ошибкой`, ok ? 'good' : 'bad');
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
    sc.onerror = () => { xtermLoading = null; rej(new Error('не удалось загрузить ' + src)); };
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
  const closeBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => closeSession() }, 'Завершить сессию');
  const el = h('div', null,
    h('div', { class: 'toolbar' }, sessEl,
      h('button', { class: 'btn sm', type: 'button', onclick: () => newSession() }, '+ Новая сессия'),
      statusEl, h('span', { class: 'grow' }), closeBtn),
    host,
    h('div', { class: 'term-hint muted' }, 'Сессия продолжает работать, если уйти со вкладки, и закрывается через 15 минут без подключений. Копирование — выделите текст, вставка — ⌘V.'));

  function setStatus(text, cls) {
    statusEl.replaceChildren(cls ? h('span', { class: 'st ' + cls }, h('span', { class: 'dot' }), text) : text);
  }

  function renderSessions() {
    sessEl.replaceChildren(...st.sessions.map((x, i) => h('button', {
      type: 'button', class: x.id === st.sid ? 'on' : '', title: 'открыта ' + Fmt.dateTime(x.created, false),
      onclick: () => { if (x.id !== st.sid) attach(x.id); },
    }, `Сессия ${i + 1}` + (x.done ? ' · завершена' : ''))));
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
    setStatus('подключение…', 'warn');
    const es = new EventSource(`/api/term/${sid}/stream?token=${encodeURIComponent(TOKEN)}`);
    st.es = es;
    es.addEventListener('r', (e) => {
      st.term.reset();
      st.term.write(b64bytes(JSON.parse(e.data)));
      setStatus('подключено', 'good');
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
      setStatus('переподключение…', 'warn');
      if (es.readyState === EventSource.CLOSED) setTimeout(() => { if (!st.dead && st.sid === sid) refresh(); }, 2000);
    };
  }

  async function newSession() {
    ensureTerm();
    let cols = 100, rows = 30;
    try { const d = st.fit.proposeDimensions(); if (d && d.cols) { cols = d.cols; rows = d.rows; } } catch (e) { /* размер по умолчанию */ }
    setStatus('открываю сессию…', 'warn');
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
      const ok = await confirmDialog({ title: 'Завершить сессию терминала?', text: 'Запущенные в ней программы получат сигнал отбоя (SIGHUP).', ok: 'Завершить', danger: true });
      if (!ok) return;
    }
    try { await api(`/term/${st.sid}`, { method: 'DELETE' }); } catch (e) { /* уже закрыта */ }
    st.sessions = st.sessions.filter((s) => s.id !== st.sid);
    S.termSel.delete(id);
    st.sid = '';
    if (st.es) { st.es.close(); st.es = null; }
    const next = st.sessions.filter((s) => !s.done).pop();
    if (next) attach(next.id);
    else { renderSessions(); st.term.reset(); setStatus('нет открытых сессий'); }
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
    toast('Переподключаюсь…', 'warn');
  } catch (e) { toast(e.message, 'bad'); }
}

async function reloadConfig() {
  try {
    await api('/servers/reload', { method: 'POST', body: {} });
    toast('Список серверов обновлён из ~/.ssh/config');
  } catch (e) { toast(e.message, 'bad'); }
}

function rebootDialog(s) {
  const input = h('input', { class: 'input', placeholder: s.name, autocomplete: 'off', spellcheck: 'false' });
  const btn = h('button', { class: 'btn danger solid', type: 'button', disabled: true }, 'Перезагрузить');
  input.addEventListener('input', () => { btn.disabled = input.value.trim() !== s.name; });
  const m = modal({
    title: `Перезагрузить ${s.name}?`,
    body: h('div', { class: 'form' },
      h('div', { class: 'alert warn' }, icon('warn'), h('div', null, 'Все службы и подключения к серверу прервутся на 1–3 минуты. Если сервер не поднимется, понадобится консоль хостинга.')),
      h('label', { class: 'field' }, h('span', null, 'Для подтверждения введите название сервера: ', h('b', null, s.name)), input)),
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), btn],
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api(`/servers/${encodeURIComponent(s.id)}/reboot`, { method: 'POST', body: { confirm: input.value.trim() } });
      if (r.ok) { toast(`${s.name}: перезагрузка запущена`, 'warn'); m.close(); } else { toast('Перезагрузка не удалась', 'bad', r.error); btn.disabled = false; }
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
$('#btn-reload').addEventListener('click', reloadConfig);
window.addEventListener('hashchange', () => route());
window.addEventListener('resize', () => { for (const s of S.servers) updateSideRow(s); });

$('#main').replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), NB + ' Подключение к панели…')));
connect();

'use strict';
/* Палитра команд (⌘K / Ctrl+K) и горячие клавиши. Загружается до app.js,
   всё вызывается уже после загрузки страницы. */

const Palette = (() => {
  let dlg = null, input = null, listEl = null, items = [], shown = [], active = 0;

  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

  // Все пункты строятся при открытии: серверов и вкладок может быть много.
  function build() {
    const out = [];
    const r = parseRoute();
    const cur = r.view === 'server' ? S.by.get(r.id) : null;
    const tabsFor = (s) => TAB_DEFS.filter(([k]) => (k !== 'vpn' || !s.units || s.units.some((u) => u.vpn)) && (k !== 'vms' || (s.info && s.info.vm) || s.vms) && (k !== 'docker' || (s.info && s.info.docker)));
    const go = (hash) => () => { location.hash = hash; };
    const srvHash = (s, tab) => '#/s/' + encodeURIComponent(s.id) + (tab && tab !== 'overview' ? '/' + tab : '');

    if (cur) {
      for (const [k, label] of tabsFor(cur)) {
        if (k !== r.tab) out.push({ group: L('Этот сервер'), title: label, sub: cur.name, icon: 'chev', run: go(srvHash(cur, k)), boost: 30 });
      }
      for (const sc of S.scenarios.filter((x) => x.pinned)) {
        out.push({ group: L('Этот сервер'), title: L('Выполнить «{0}»', sc.name), sub: cur.name, icon: 'play', run: () => runScenario(sc, [cur.id]), boost: 20, kw: sc.script });
      }
      if (cur.status === 'offline') out.push({ group: L('Этот сервер'), title: L('Переподключить'), sub: cur.name, icon: 'refresh', run: () => reconnect(cur.id), boost: 40 });
    }
    const vis = S.servers.filter((s) => !s.hidden);
    for (const s of vis) {
      const st = srvState(s);
      out.push({ group: L('Серверы'), title: s.name, mono: true, sub: [s.group, LEVEL_TEXT[st.level], st.why[0]].filter(Boolean).join(' · '), level: st.level, run: go(srvHash(s)), kw: [s.host, s.group].join(' '), srv: s });
    }
    for (const a of document.querySelectorAll('.side-nav .nav-item')) {
      out.push({ group: L('Разделы'), title: a.querySelector('span').textContent, icon: 'chev', run: go(a.getAttribute('href')) });
    }
    for (const sc of S.scenarios) {
      out.push({ group: L('Команды'), title: sc.name, sub: sc.desc || sc.script.split('\n')[0], icon: 'play', run: () => runScenario(sc), kw: sc.script });
    }
    const theme = (v, label) => ({ group: L('Действия'), title: label, icon: 'gear', run: () => setTheme(v) });
    out.push(
      { group: L('Действия'), title: L('Добавить сервер'), icon: 'plus', run: () => addServerDialog() },
      { group: L('Действия'), title: L('Новая сохранённая команда'), icon: 'plus', run: () => scenarioDialog() },
      theme('dark', L('Тема: тёмная')), theme('light', L('Тема: светлая')), theme('', L('Тема: как в системе')),
      { group: L('Действия'), title: I18N.lang === 'ru' ? 'Language: English' : 'Язык: русский', icon: 'gear', run: () => setLang(I18N.lang === 'ru' ? 'en' : 'ru'), kw: 'язык language english русский' },
      { group: L('Действия'), title: L('Перечитать ~/.ssh/config'), icon: 'refresh', run: () => reloadConfig() },
      { group: L('Действия'), title: L('Горячие клавиши'), icon: 'info', run: () => shortcutsDialog(), kw: 'клавиши shortcuts keyboard помощь help' },
    );
    for (const it of out) it.hay = norm([it.title, it.sub, it.kw].filter(Boolean).join(' '));
    // «fi журнал»: вкладки серверов, подходящих под запрос, добавляются при поиске
    out.tabsOf = (s) => tabsFor(s).filter(([k]) => k !== 'overview').map(([k, label]) => {
      const it = { group: L('Вкладки'), title: `${s.name} › ${label}`, mono: true, level: srvState(s).level, run: go(srvHash(s, k)), boost: -5 };
      it.hay = norm(`${s.name} ${s.host || ''} ${label}`);
      return it;
    });
    return out;
  }

  function search(q) {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    if (!toks.length) return items.slice(0, 60);
    let pool = items;
    if (toks.length > 1) {
      const srv = items.filter((it) => it.srv && toks.some((x) => norm(it.srv.name + ' ' + (it.srv.host || '')).includes(x))).slice(0, 12);
      pool = items.concat(...srv.map((it) => items.tabsOf(it.srv)));
    }
    const res = [];
    for (const it of pool) {
      let score = it.boost || 0, ok = true;
      const title = norm(it.title);
      for (const x of toks) {
        const i = it.hay.indexOf(x);
        if (i < 0) { ok = false; break; }
        const ti = title.indexOf(x);
        score += ti === 0 ? 40 : ti > 0 && /[\s\-_.›]/.test(title[ti - 1]) ? 25 : ti > 0 ? 12 : 4;
      }
      if (ok) res.push([score - title.length / 40, it]);
    }
    res.sort((a, b) => b[0] - a[0]);
    return res.slice(0, 60).map((x) => x[1]);
  }

  function render() {
    shown = search(input.value);
    active = Math.min(active, Math.max(0, shown.length - 1));
    listEl.replaceChildren();
    if (!shown.length) {
      listEl.append(h('div', { class: 'pal-empty' }, L('Ничего не нашлось. Попробуйте имя сервера, раздел или действие.')));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    // без запроса — по группам в исходном порядке; при поиске — по убыванию совпадения, группа подписана справа
    const flat = input.value.trim() !== '';
    let last = null;
    shown.forEach((it, i) => {
      if (!flat && it.group !== last) { last = it.group; listEl.append(h('div', { class: 'pal-group', role: 'presentation' }, it.group)); }
      const el = h('div', { class: 'pal-item' + (i === active ? ' on' : ''), role: 'option', id: 'pal-o' + i, 'aria-selected': String(i === active) },
        it.level ? h('span', { class: 'dot pal-dot ' + ({ ok: 'online', warn: 'warn', down: 'offline', wait: 'connecting', off: 'off' })[it.level] }) : icon(it.icon || 'chev'),
        h('span', { class: 'pal-title' + (it.mono ? ' mono' : '') }, it.title),
        it.sub ? h('span', { class: 'pal-sub' }, it.sub) : null,
        flat ? h('span', { class: 'pal-kind' }, it.group) : null);
      el.addEventListener('click', () => choose(i));
      el.addEventListener('mousemove', () => { if (active !== i) { active = i; mark(); } });
      listEl.append(el);
    });
    input.setAttribute('aria-activedescendant', 'pal-o' + active);
  }

  function mark() {
    listEl.querySelectorAll('.pal-item').forEach((el, i) => { el.classList.toggle('on', i === active); el.setAttribute('aria-selected', String(i === active)); });
    input.setAttribute('aria-activedescendant', 'pal-o' + active);
    const el = listEl.querySelector('.pal-item.on');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const it = shown[i];
    if (!it) return;
    close();
    it.run();
  }

  function close() { if (dlg && dlg.open) dlg.close(); }

  function open(prefill) {
    if (dlg && dlg.open) return;
    if (!dlg) {
      input = h('input', { class: 'pal-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list',
        'aria-label': L('Сервер, вкладка или действие'), placeholder: L('Сервер, вкладка или действие — например «fi журнал»'), autocomplete: 'off', spellcheck: 'false' });
      listEl = h('div', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': L('Результаты') });
      dlg = h('dialog', { class: 'palette', 'aria-label': L('Палитра команд') },
        h('div', { class: 'pal-top' }, icon('search'), input, h('kbd', null, 'Esc')),
        listEl,
        h('div', { class: 'pal-foot' }, h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' ' + L('выбрать')), h('span', null, h('kbd', null, 'Enter'), ' ' + L('открыть')),
          h('span', { class: 'pal-help' }, h('kbd', null, '?'), ' ' + L('все клавиши'))));
      document.body.append(dlg);
      input.addEventListener('input', () => { active = 0; render(); });
      input.addEventListener('keydown', (e) => {
        const n = shown.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { active = (active + 1) % n; mark(); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { active = (active - 1 + n) % n; mark(); } }
        else if (e.key === 'Home' && n) { e.preventDefault(); active = 0; mark(); }
        else if (e.key === 'End' && n) { e.preventDefault(); active = n - 1; mark(); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
      });
      dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // щелчок по затемнению
    }
    items = build();
    input.value = prefill || '';
    active = 0;
    render();
    dlg.showModal();
    input.focus();
  }

  return { open, close, isOpen: () => !!(dlg && dlg.open) };
})();

function setTheme(v) {
  if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
  try { if (v) localStorage.setItem('sp.theme', v); else localStorage.removeItem('sp.theme'); } catch (e) { /* нет хранилища */ }
  themeChanged();
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

/* Переходы «g, затем буква» — по физическим клавишам, раскладка не важна. */
const GO_KEYS = { KeyS: ['#/', 'Все серверы'], KeyA: ['#/alerts', 'Оповещения'], KeyW: ['#/checks', 'Сайты и порты'], KeyC: ['#/commands', 'Команды'], KeyR: ['#/schedule', 'Расписание'], KeyN: ['#/notes', 'Заметки'], KeyM: ['#/manage', 'Управление'] };

function shortcutsDialog() {
  const row = (keys, text) => h('tr', null, h('td', { class: 'keys' }, keys.map((k) => (k === '+' || k === 'затем' ? h('span', { class: 'muted' }, ' ' + (k === '+' ? '+' : L('затем')) + ' ') : h('kbd', null, k)))), h('td', null, text));
  const m = modal({
    title: L('Горячие клавиши'),
    body: h('table', { class: 'keys-tbl' }, h('tbody', null,
      row([MOD_KEY, '+', 'K'], L('Палитра: сервер, вкладка, раздел, действие или сохранённая команда')),
      row(['/'], L('То же самое')),
      Object.entries(GO_KEYS).map(([code, [, label]]) => row(['G', 'затем', code.slice(3)], L(label))),
      row(['['], L('На странице сервера: предыдущая вкладка')),
      row([']'], L('На странице сервера: следующая вкладка')),
      row(['↑'], L('В таблице серверов: строка выше')),
      row(['↓'], L('В таблице серверов: строка ниже')),
      row(['?'], L('Этот список')),
      row(['Esc'], L('Закрыть окно или палитру')))),
    foot: [h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, L('Понятно'))],
  });
}

(function hotkeys() {
  let gAt = 0;
  const typing = (el) => el && el.closest && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest('.xterm'));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
      e.preventDefault();
      if (Palette.isOpen()) Palette.close(); else Palette.open();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('dialog[open], .backdrop')) return;
    if (e.key === '/') { e.preventDefault(); Palette.open(); return; }
    if (e.key === '?') { e.preventDefault(); shortcutsDialog(); return; }
    if (e.code === 'KeyG' && !e.shiftKey) { gAt = Date.now(); return; }
    if (gAt && Date.now() - gAt < 1500 && GO_KEYS[e.code]) { e.preventDefault(); gAt = 0; location.hash = GO_KEYS[e.code][0]; return; }
    gAt = 0;
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const r = parseRoute();
      const tabs = [...document.querySelectorAll('.tabs .tab')];
      if (r.view !== 'server' || !tabs.length) return;
      const i = tabs.findIndex((b) => b.classList.contains('active'));
      const next = tabs[(i + (e.code === 'BracketRight' ? 1 : tabs.length - 1)) % tabs.length];
      if (next) { e.preventDefault(); next.click(); }
    }
  });
})();

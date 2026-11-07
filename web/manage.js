'use strict';
/* Управление серверами: страница «Управление», мастер подключения,
   правка, удаление и выбор хостов из ~/.ssh/config.
   Загружается раньше app.js; функции app.js (h, api, modal…) вызываются
   только изнутри обработчиков, поэтому порядок не мешает. */

const OS_NAME = { darwin: 'macOS', windows: 'Windows', linux: 'Linux' };
const osName = () => OS_NAME[(S.setup || {}).os] || 'компьютера';

function srvAddr(s) {
  return (s.user ? s.user + '@' : '') + (s.host || '') + (s.port && s.port !== 22 ? ':' + s.port : '');
}

function srvSource(s) {
  if (s.source === 'ssh') return '~/.ssh/config';
  return s.panelKey ? 'панель, ключ панели' : 'панель';
}

function serverGroups() {
  return [...new Set(S.servers.map((s) => s.group).filter(Boolean))];
}

// [[группа, серверы]] с сохранением порядка; серверы без группы — первыми
function groupServers(list) {
  const m = new Map();
  for (const s of list) {
    const g = s.group || '';
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(s);
  }
  return [...m.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : 0));
}

async function refreshSetup() {
  try { S.setup = await api('/setup'); } catch (e) { return; }
  if (S.page && S.page.onSetup) S.page.onSetup();
}

function groupInput(value) {
  const id = 'sp-groups-' + Math.random().toString(36).slice(2, 8);
  const list = h('datalist', { id }, serverGroups().map((g) => h('option', { value: g })));
  const input = h('input', { class: 'input', value: value || '', placeholder: 'например, VPN или Сайты', maxlength: '40', list: id, autocomplete: 'off' });
  return { input, list };
}

function fingerprintBox(keys) {
  return h('div', { class: 'fp' },
    h('div', { class: 'fp-title' }, 'Отпечаток ключа сервера'),
    keys.map((k) => h('div', { class: 'fp-row' }, h('span', { class: 'fp-type' }, k.type.replace(/^ssh-|^ecdsa-sha2-/, '').toUpperCase()), h('code', null, k.fp))),
    h('div', { class: 'hint' }, 'По нему панель будет узнавать сервер и откажется подключаться, если ключ подменят. Сверить можно в консоли хостинга: ',
      h('code', null, 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')));
}

function codeLine(text) {
  const code = h('code', null, text);
  return h('div', { class: 'codeline' }, code,
    h('button', { class: 'btn sm icon-only', type: 'button', title: 'Скопировать', 'aria-label': 'Скопировать', onclick: () => copyText(code.textContent) }, icon('copy')));
}

async function loadKeys(create) {
  try { return await api('/keys' + (create ? '?create=1' : '')); } catch (e) { return []; }
}

function keyOptions(select, keys, current) {
  select.replaceChildren(h('option', { value: '' }, 'Ключи ssh по умолчанию'));
  for (const k of keys) select.append(h('option', { value: k.path }, k.panel ? 'Ключ панели' : k.path));
  if (current && ![...select.options].some((o) => o.value === current)) select.append(h('option', { value: current }, current));
  select.value = current || '';
}

/* ---------- мастер подключения ---------- */
async function addServerDialog() {
  const f = {
    host: h('input', { class: 'input', placeholder: '203.0.113.10, example.com или root@203.0.113.10:2222', autocomplete: 'off', spellcheck: 'false' }),
    user: h('input', { class: 'input', value: 'root', autocomplete: 'off', spellcheck: 'false' }),
    port: h('input', { class: 'input', type: 'number', value: '22', min: '1', max: '65535' }),
    name: h('input', { class: 'input', placeholder: 'например, Франкфурт', maxlength: '64' }),
  };
  const grp = groupInput('');
  const err = h('div');
  const next = h('button', { class: 'btn primary', type: 'button' }, 'Далее');
  const back = h('button', { class: 'btn', type: 'button', hidden: true }, 'Назад');
  const body = h('div');
  const step1 = h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', null, 'Адрес сервера'), f.host),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', null, 'Пользователь'), f.user),
      h('label', { class: 'field' }, h('span', null, 'Порт SSH'), f.port)),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', null, 'Название (необязательно)'), f.name),
      h('label', { class: 'field' }, h('span', null, 'Группа (необязательно)'), grp.input, grp.list)));
  body.append(step1, err);
  const m = modal({
    title: 'Подключить сервер',
    lead: 'Нужны адрес и пароль от хостинга или SSH-ключ. На сервер ничего не устанавливается.',
    body,
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), back, next],
  });
  setTimeout(() => f.host.focus(), 40);

  let probe = null;
  let auth = 'password';
  let step2 = null;
  let pass = null;
  let keySel = null;
  let keys = [];

  const busy = (text) => err.replaceChildren(h('div', { class: 'muted' }, h('span', { class: 'spinner' }), NB + text));
  const showErr = (msg, extra) => err.replaceChildren(h('div', { class: 'alert bad' }, h('div', { style: { flex: 1 } }, msg), extra || null));

  async function doProbe() {
    busy('Проверяю адрес…');
    next.disabled = true;
    try {
      probe = await api('/servers/probe', { method: 'POST', body: { host: f.host.value, port: +f.port.value || 22, user: f.user.value } });
      f.host.value = probe.host; f.port.value = String(probe.port); f.user.value = probe.user;
      err.replaceChildren();
      await showStep2();
    } catch (e) {
      showErr(e.message);
    } finally {
      next.disabled = false;
    }
  }

  async function showStep2() {
    keys = await loadKeys(false);
    pass = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false' });
    keySel = h('select', { class: 'input' });
    keyOptions(keySel, keys, keys.length ? keys[0].path : '');
    const pubCode = h('div');
    const updPub = () => {
      const k = keys.find((x) => x.path === keySel.value);
      pubCode.replaceChildren(k
        ? h('div', null, h('div', { class: 'hint' }, 'Если этого ключа ещё нет на сервере, выполните там (через консоль хостинга):'),
          codeLine(`mkdir -p ~/.ssh && echo '${k.pub}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`))
        : h('div', { class: 'hint' }, 'ssh возьмёт ключи из ~/.ssh, как при обычном подключении.'));
    };
    keySel.addEventListener('change', updPub);
    updPub();
    const passPane = h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, `Пароль пользователя ${probe.user}`), pass),
      h('div', { class: 'hint' }, 'Пароль не сохраняется. Панель войдёт с ним один раз, добавит на сервер свой ключ и дальше будет входить только по ключу.'));
    const keyPane = h('div', { class: 'form', hidden: true },
      h('label', { class: 'field' }, h('span', null, 'Ключ'), keySel), pubCode);
    const sw = seg([['password', 'По паролю'], ['key', 'По SSH-ключу']], auth, (v) => {
      auth = v;
      passPane.hidden = v !== 'password';
      keyPane.hidden = v !== 'key';
      (v === 'password' ? pass : keySel).focus();
    });
    step2 = h('div', { class: 'form' },
      h('div', { class: 'wiz-addr' }, h('span', { class: 'mono' }, `${probe.user}@${probe.host}${probe.port !== 22 ? ':' + probe.port : ''}`),
        h('span', { class: 'muted' }, 'отвечает по SSH')),
      probe.duplicate ? h('div', { class: 'alert warn' }, icon('warn'), h('div', null, `Этот адрес уже есть в панели: «${probe.duplicate}».`)) : null,
      fingerprintBox(probe.keys),
      h('div', { class: 'field' }, h('span', null, 'Как входить'), sw.el),
      passPane, keyPane);
    step1.hidden = true;
    body.insertBefore(step2, err);
    back.hidden = false;
    next.textContent = 'Подключить';
    setTimeout(() => (auth === 'password' ? pass : keySel).focus(), 40);
  }

  async function doAdd(force) {
    busy(auth === 'password' ? 'Вхожу по паролю и устанавливаю ключ панели…' : 'Подключаюсь…');
    next.disabled = true; back.disabled = true;
    try {
      const r = await api('/servers', {
        method: 'POST',
        body: {
          host: probe.host, port: probe.port, user: probe.user, probe: probe.probe,
          name: f.name.value, group: grp.input.value, auth,
          password: auth === 'password' ? pass.value : '', keyFile: auth === 'key' ? keySel.value : '', force,
        },
      });
      if (pass) pass.value = '';
      m.close();
      toast(`Сервер «${f.name.value.trim() || probe.host}» подключён`);
      refreshSetup();
      location.hash = '#/s/' + encodeURIComponent(r.id);
    } catch (e) {
      if (pass) { pass.value = ''; }
      showErr(e.message, e.data && e.data.canForce
        ? h('button', { class: 'btn sm', type: 'button', onclick: () => doAdd(true) }, 'Добавить всё равно') : null);
      if (e.data && /устарела|изменился/.test(e.message)) goBack();
    } finally {
      next.disabled = false; back.disabled = false;
    }
  }

  function goBack() {
    if (step2) step2.remove();
    step2 = null;
    step1.hidden = false;
    back.hidden = true;
    next.textContent = 'Далее';
    f.host.focus();
  }

  next.addEventListener('click', () => (step2 ? doAdd(false) : doProbe()));
  back.addEventListener('click', () => { err.replaceChildren(); goBack(); });
  m.box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !next.disabled) { e.preventDefault(); next.click(); }
  });
}

/* ---------- настройки сервера ---------- */
async function settingsDialog(s) {
  const manual = s.source === 'manual';
  const nameIn = h('input', { class: 'input', value: s.name, placeholder: s.alias || s.host, maxlength: '64' });
  const grp = groupInput(s.group);
  const mon = h('input', { type: 'checkbox', checked: s.monitor });
  const hid = h('input', { type: 'checkbox', checked: s.hidden });
  const mute = h('input', { type: 'checkbox', checked: !!s.mute });
  const c = manual ? {
    host: h('input', { class: 'input', value: s.host, autocomplete: 'off', spellcheck: 'false' }),
    user: h('input', { class: 'input', value: s.user || 'root', autocomplete: 'off', spellcheck: 'false' }),
    port: h('input', { class: 'input', type: 'number', value: String(s.port || 22), min: '1', max: '65535' }),
    key: h('select', { class: 'input' }),
  } : null;
  const fpBox = h('div');
  const err = h('div');
  const kv = (k, v) => (v ? [h('dt', null, k), h('dd', null, v)] : []);
  const conn = manual
    ? h('div', { class: 'form' },
      h('div', { class: 'form-sep' }, 'Подключение'),
      h('label', { class: 'field' }, h('span', null, 'Адрес'), c.host),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', null, 'Пользователь'), c.user),
        h('label', { class: 'field' }, h('span', null, 'Порт SSH'), c.port)),
      h('label', { class: 'field' }, h('span', null, 'Ключ'), c.key),
      fpBox)
    : h('div', { class: 'form' },
      h('div', { class: 'form-sep' }, 'Подключение'),
      h('div', { class: 'hint' }, `Параметры берутся из ~/.ssh/config (Host ${s.alias}). Чтобы их поменять, исправьте файл и нажмите «Обновить список» внизу боковой панели.`),
      h('dl', { class: 'kv' }, kv('Адрес', s.host), kv('Пользователь', s.user), kv('Порт', s.port ? String(s.port) : '')));
  const body = h('div', { class: 'form' },
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', null, 'Название в панели'), nameIn),
      h('label', { class: 'field' }, h('span', null, 'Группа'), grp.input, grp.list)),
    h('label', { class: 'check' }, mon, 'Собирать метрики постоянно (мониторинг)'),
    h('label', { class: 'check' }, hid, 'Скрыть из списка'),
    h('label', { class: 'check' }, mute, 'Не присылать оповещения об этом сервере'),
    conn,
    s.info ? h('dl', { class: 'kv' },
      kv('Права', s.info.uid === 0 ? 'root' : s.info.sudo ? 'sudo без пароля' : 'обычный пользователь — управление ограничено'),
      kv('IP-адреса', s.info.ips ? s.info.ips.join(', ') : ''),
      kv('Часовой пояс', s.info.tz)) : null,
    err);
  const save = h('button', { class: 'btn primary', type: 'button' }, 'Сохранить');
  const m = modal({
    title: 'Настройки сервера', body,
    foot: [h('button', { class: 'btn danger left', type: 'button', onclick: () => { m.close(); deleteServerDialog(s); } }, 'Удалить'),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), save],
  });
  let probe = null;
  if (manual) {
    const keys = await loadKeys(false);
    keyOptions(c.key, keys, s.panelKey ? 'panel' : s.keyFile || '');
    const reset = () => { probe = null; fpBox.replaceChildren(); };
    c.host.addEventListener('input', reset);
    c.port.addEventListener('input', reset);
  }

  save.addEventListener('click', async () => {
    const b = { name: nameIn.value.trim(), group: grp.input.value.trim(), monitor: mon.checked, hidden: hid.checked, mute: mute.checked };
    if (manual) {
      const host = c.host.value.trim();
      const port = +c.port.value || 22;
      const user = c.user.value.trim();
      const keyFile = c.key.value;
      const curKey = s.panelKey ? 'panel' : s.keyFile || '';
      const addrChanged = host !== s.host || port !== (s.port || 22);
      if (addrChanged || user !== (s.user || '') || keyFile !== curKey) Object.assign(b, { host, port, user, keyFile });
      if (addrChanged && !probe) {
        save.disabled = true;
        err.replaceChildren(h('div', { class: 'muted' }, h('span', { class: 'spinner' }), NB + 'Проверяю новый адрес…'));
        try {
          probe = await api('/servers/probe', { method: 'POST', body: { host, port, user } });
          c.host.value = probe.host; c.port.value = String(probe.port);
          fpBox.replaceChildren(fingerprintBox(probe.keys),
            h('div', { class: 'alert warn' }, icon('info'), h('div', null, 'Адрес изменился. Сверьте отпечаток и нажмите «Сохранить» ещё раз.')));
          err.replaceChildren();
        } catch (e) {
          err.replaceChildren(h('div', { class: 'alert bad' }, e.message));
        }
        save.disabled = false;
        return;
      }
      if (probe) { b.probe = probe.probe; b.host = probe.host; b.port = probe.port; }
    }
    save.disabled = true;
    try {
      await api(`/servers/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: b });
      m.close();
      toast('Настройки сохранены');
      if (hid.checked && parseRoute().view === 'server') location.hash = '#/';
    } catch (e) {
      err.replaceChildren(h('div', { class: 'alert bad' }, e.message));
      save.disabled = false;
    }
  });
}

/* ---------- удаление ---------- */
function deleteServerDialog(s) {
  const revoke = h('input', { type: 'checkbox', checked: true });
  const text = s.source === 'ssh'
    ? `Хост ${s.alias} останется в ~/.ssh/config, панель просто перестанет его показывать. Вернуть его можно в «Управлении» → «Из ~/.ssh/config».`
    : 'Сервер пропадёт из панели вместе с историей графиков. На самом сервере ничего не изменится.';
  const ok = h('button', { class: 'btn danger solid', type: 'button' }, 'Удалить');
  const m = modal({
    title: `Удалить «${s.name}» из панели?`,
    body: h('div', { class: 'form' }, h('div', { class: 'ink2' }, text),
      s.panelKey ? h('label', { class: 'check' }, revoke, 'Убрать ключ панели с сервера (из ~/.ssh/authorized_keys)') : null),
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), ok],
  });
  setTimeout(() => ok.focus(), 40);
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      const q = s.panelKey && revoke.checked ? '?revoke=1' : '';
      const r = await api(`/servers/${encodeURIComponent(s.id)}${q}`, { method: 'DELETE' });
      m.close();
      if (r.warning) toast(`«${s.name}» удалён из панели`, 'warn', r.warning);
      else toast(`«${s.name}» удалён из панели`);
      const rt = parseRoute();
      if (rt.view === 'server' && rt.id === s.id) location.hash = '#/manage';
      refreshSetup();
    } catch (e) {
      toast(e.message, 'bad');
      ok.disabled = false;
    }
  });
}

/* ---------- хосты из ~/.ssh/config ---------- */
async function sshImportDialog() {
  const box = h('div', { class: 'import-list' }, h('div', { class: 'muted' }, h('span', { class: 'spinner' }), NB + 'Читаю ~/.ssh/config…'));
  const save = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Сохранить');
  const all = h('button', { class: 'btn ghost sm left', type: 'button', hidden: true }, 'Отметить все');
  const m = modal({
    title: 'Серверы из ~/.ssh/config',
    lead: 'Отметьте, какие хосты показывать в панели. Сам файл панель не меняет.',
    body: box,
    foot: [all, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена'), save],
  });
  let d;
  try { d = await api('/ssh-hosts'); } catch (e) { box.replaceChildren(h('div', { class: 'alert bad' }, e.message)); return; }
  if (!d.hosts.length) {
    box.replaceChildren(h('div', { class: 'muted' }, 'В ~/.ssh/config нет хостов (строк Host …). Подключите сервер через «Добавить сервер».'));
    return;
  }
  const checks = d.hosts.map((x) => {
    const cb = h('input', { type: 'checkbox', checked: d.setup ? x.inPanel : true });
    box.append(h('label', { class: 'check imp' }, cb, h('b', null, x.alias),
      h('span', { class: 'muted mono' }, (x.user ? x.user + '@' : '') + x.host + (x.port && x.port !== 22 ? ':' + x.port : ''))));
    return [x.alias, cb];
  });
  box.firstChild.remove();
  all.hidden = false;
  all.addEventListener('click', () => {
    const on = !checks.every(([, cb]) => cb.checked);
    checks.forEach(([, cb]) => { cb.checked = on; });
    all.textContent = on ? 'Снять все' : 'Отметить все';
  });
  save.disabled = false;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api('/ssh-hosts', { method: 'PUT', body: { show: checks.filter(([, cb]) => cb.checked).map(([a]) => a) } });
      m.close();
      toast('Список серверов обновлён');
      refreshSetup();
    } catch (e) {
      toast(e.message, 'bad');
      save.disabled = false;
    }
  });
}

async function testServer(s, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Проверяю…';
  try {
    const r = await api(`/servers/${encodeURIComponent(s.id)}/test`, { method: 'POST', body: {} });
    if (r.ok) toast(`${s.name}: вход работает, ${r.ms} мс`);
    else toast(`${s.name}: не удалось войти`, 'bad', r.error);
  } catch (e) {
    toast(e.message, 'bad');
  }
  btn.disabled = false;
  btn.textContent = old;
}

/* ---------- страница «Управление» ---------- */
class ManagePage {
  constructor() {
    this.kind = 'manage';
    this.el = h('div', { class: 'page' });
    this.focusAfter = null;
    this.render();
  }

  onData() { this.render(); }
  onSetup() { this.render(); }
  destroy() {}

  onStatus(srv) {
    const r = this.rows && this.rows.get(srv.id);
    if (!r) return;
    r.dot.className = 'dot ' + srv.status;
    r.st.textContent = srv.hidden ? 'скрыт' : STATUS_TEXT[srv.status] || srv.status;
  }

  async move(id, dir) {
    const ids = S.servers.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.focusAfter = { id, dir };
    try { await api('/servers/order', { method: 'PUT', body: { ids } }); } catch (e) { toast(e.message, 'bad'); }
  }

  render() {
    const setup = S.setup || {};
    const list = S.servers;
    // список перерисовывается целиком (порядок, состояние ключа): запомним,
    // на какой кнопке был фокус, чтобы не терять его при каждом обновлении
    const act = document.activeElement;
    const keepLabel = act && this.el.contains(act) ? act.getAttribute('aria-label') : null;
    this.rows = new Map();
    const tbody = h('tbody');
    list.forEach((s, i) => {
      const dot = h('span', { class: 'dot ' + s.status });
      const st = h('span', { class: 'muted' }, s.hidden ? 'скрыт' : STATUS_TEXT[s.status] || s.status);
      const up = h('button', { class: 'btn ghost sm icon-only', type: 'button', title: 'Выше', 'aria-label': `${s.name}: выше`, disabled: i === 0, onclick: () => this.move(s.id, -1) }, icon('up'));
      const down = h('button', { class: 'btn ghost sm icon-only', type: 'button', title: 'Ниже', 'aria-label': `${s.name}: ниже`, disabled: i === list.length - 1, onclick: () => this.move(s.id, 1) }, icon('down'));
      tbody.append(h('tr', { class: s.hidden ? 'is-hidden' : '' },
        h('td', { class: 'mv' }, up, down),
        h('td', null, h('div', { class: 'mg-name' }, dot, h('a', { href: '#/s/' + encodeURIComponent(s.id) }, s.name),
          s.group ? h('span', { class: 'tag' }, s.group) : null)),
        h('td', { class: 'mono ink2' }, srvAddr(s)),
        h('td', { class: 'muted' }, srvSource(s)),
        h('td', null, st),
        h('td', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', onclick: (e) => testServer(s, e.currentTarget) }, 'Проверить'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => settingsDialog(s) }, 'Изменить'),
          h('button', { class: 'btn sm danger', type: 'button', onclick: () => deleteServerDialog(s) }, 'Удалить'))));
      this.rows.set(s.id, { dot, st, up, down });
    });

    const pub = setup.panelKey;
    const keyCard = h('div', { class: 'card pad' },
      h('div', { class: 'card-title' }, 'Ключ панели'),
      pub
        ? h('div', { class: 'form', style: { marginTop: '8px' } },
          h('div', { class: 'hint' }, 'Им панель входит на серверы, добавленные по паролю. Чтобы подключить сервер без пароля, добавьте этот ключ в ~/.ssh/authorized_keys на сервере.'),
          codeLine(pub))
        : h('div', { class: 'form', style: { marginTop: '8px' } },
          h('div', { class: 'hint' }, 'Ключ появится сам, когда вы подключите первый сервер по паролю. Можно создать его заранее, чтобы раздать на серверы вручную.'),
          h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: async () => { await loadKeys(true); refreshSetup(); } }, 'Создать ключ'))));
    const dataCard = h('div', { class: 'card pad' },
      h('div', { class: 'card-title' }, 'Где хранятся данные'),
      h('div', { class: 'form', style: { marginTop: '8px' } },
        h('div', { class: 'hint' }, 'Настройки, история графиков, ключ панели и токен Telegram-бота лежат только на этом компьютере:'),
        codeLine(setup.dataDir || '~/.server-panel')));

    this.el.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, 'Управление серверами'),
          h('div', { class: 'head-meta' }, h('span', null, 'Подключение, названия, группы, порядок в списке и удаление'))),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => sshImportDialog() }, 'Из ~/.ssh/config' + (setup.sshPending ? ` (${setup.sshPending})` : '')),
          h('button', { class: 'btn primary', type: 'button', onclick: () => addServerDialog() }, icon('plus'), 'Добавить сервер'))),
      list.length
        ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl manage' },
          h('thead', null, h('tr', null, h('th', null, h('span', { class: 'sr-only' }, 'Порядок')), h('th', null, 'Сервер'), h('th', null, 'Адрес'), h('th', null, 'Источник'), h('th', null, 'Состояние'), h('th', null, h('span', { class: 'sr-only' }, 'Действия')))),
          tbody))
        : h('div', { class: 'card empty' }, h('b', null, 'Серверов пока нет'), 'Нажмите «Добавить сервер» — понадобятся адрес и пароль от хостинга.'),
      h('div', { class: 'grid two', style: { marginTop: '16px' } }, keyCard, dataCard),
    );

    if (this.focusAfter) {
      const r = this.rows.get(this.focusAfter.id);
      const b = r && (this.focusAfter.dir < 0 ? r.up : r.down);
      const alt = r && (this.focusAfter.dir < 0 ? r.down : r.up);
      if (b && !b.disabled) b.focus(); else if (alt) alt.focus();
      this.focusAfter = null;
    } else if (keepLabel) {
      const b = [...this.el.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === keepLabel);
      if (b && !b.disabled) b.focus();
    }
  }
}

/* ---------- первый запуск ---------- */
function onboardingCard() {
  const setup = S.setup || {};
  const pending = !setup.sshSetup && setup.sshPending > 0;
  return h('div', { class: 'card onboard' },
    h('img', { class: 'onboard-mark', src: 'brand/mark.png', alt: '', width: '56', height: '27' }),
    h('h2', null, 'Подключите первый сервер'),
    h('p', { class: 'ink2' }, pending
      ? `В ~/.ssh/config найдено хостов: ${setup.sshPending}. Выберите, какие показывать, или подключите сервер по адресу и паролю.`
      : 'Понадобятся адрес сервера и пароль от хостинга (или SSH-ключ). На сервер ничего не устанавливается — панель работает по SSH.'),
    h('div', { class: 'onboard-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => addServerDialog() }, icon('plus'), 'Добавить сервер'),
      pending ? h('button', { class: 'btn', type: 'button', onclick: () => sshImportDialog() }, 'Выбрать из ~/.ssh/config') : null));
}

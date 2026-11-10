'use strict';
/* Характеристики сервера: процессор, видеокарты, память, накопители, платформа.
   Загружается до app.js; h, api, icon, store, NB берутся из app.js во время работы. */

const HW_ICONS = {
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 2.8V6M14.5 2.8V6M9.5 18v3.2M14.5 18v3.2M2.8 9.5H6M2.8 14.5H6M18 9.5h3.2M18 14.5h3.2"/>',
  gpu: '<path d="M3 4.5v15"/><path d="M3 7h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3"/><circle cx="10.5" cy="12" r="3"/><path d="M10.5 12h.01"/><path d="M16.5 10.2h1.8M16.5 13.8h1.8"/><path d="M7 17v2.5h8V17"/>',
  ram: '<rect x="2.5" y="6.5" width="19" height="9" rx="1.5"/><path d="M5.8 9.3h2.6v3.4H5.8zM10.7 9.3h2.6v3.4h-2.6zM15.6 9.3h2.6v3.4h-2.6z"/><path d="M5 15.5V18M7.7 15.5V18M10.4 15.5V18M14 15.5V18M16.7 15.5V18M19.2 15.5V18"/>',
  hdd: '<rect x="4.5" y="2.8" width="15" height="18.4" rx="2"/><circle cx="12" cy="10" r="4.3"/><path d="M12 10h.01"/><path d="M8.2 17.8l4.3-4.6"/><path d="M15.8 17.5h.01"/>',
  ssd: '<rect x="2.8" y="6" width="18.4" height="12" rx="2"/><path d="M6.3 10h6.4M6.3 13.8h4"/><path d="M17 12h.01"/>',
  nvme: '<path d="M2.8 9h16.4a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H2.8z"/><path d="M6 11.3h3.4v1.4H6zM11.4 11.3h3.4v1.4h-3.4z"/><path d="M18.2 9v6"/><circle cx="2.8" cy="12" r="1.2"/>',
  vdisk: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>',
  usb: '<rect x="7" y="2.8" width="10" height="7" rx="1"/><path d="M10 5.3h.01M14 5.3h.01"/><path d="M5.5 9.8h13v8.4a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3z"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="6" width="6" height="6" rx="1"/><path d="M15 6v6M17.7 6v6M6 15.3h12M6 18h7.5"/>',
  rack: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M6.5 7.5h.01M6.5 16.5h.01M10.5 7.5h7M10.5 16.5h7"/>',
  vm: '<path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z"/><path d="M4 7.2l8 4.4 8-4.4M12 11.6v9.6"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
};

function hwIcon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ico hw-ico' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = HW_ICONS[name] || '';
  return s;
}

const HW = {
  cache: new Map(), // id → { t, data }
  TTL: 10 * 60e3,
  async get(id, force) {
    const c = this.cache.get(id);
    if (!force && c && Date.now() - c.t < this.TTL) return c;
    const data = await api(`/servers/${encodeURIComponent(id)}/hardware`);
    const v = { t: Date.now(), data };
    this.cache.set(id, v);
    return v;
  },
};

/* ---------- подписи ---------- */

const VIRT_NAMES = {
  kvm: 'KVM', qemu: 'QEMU', vmware: 'VMware', microsoft: 'Hyper-V', oracle: 'VirtualBox', xen: 'Xen', bochs: 'Bochs',
  parallels: 'Parallels', amazon: 'AWS Nitro', apple: 'Apple', bhyve: 'bhyve', zvm: 'z/VM', powervm: 'PowerVM',
  lxc: 'LXC', 'lxc-libvirt': 'LXC', openvz: 'OpenVZ', docker: 'Docker', podman: 'Podman', 'systemd-nspawn': 'systemd-nspawn', wsl: 'WSL',
};
const CONTAINERS = new Set(['lxc', 'lxc-libvirt', 'openvz', 'docker', 'podman', 'systemd-nspawn', 'rkt', 'proot', 'pouch']);

function cpuName(s) {
  if (!s) return '';
  let n = s.replace(/\((R|TM|tm|r)\)/g, '').replace(/\s+@\s+[\d.]+\s*GHz/i, '').replace(/\s+\d+-Core Processor\b/i, '');
  if (/^Intel/.test(n)) n = n.replace(/\bCPU\b/, '');
  return n.replace(/\s+Processor$/i, '').replace(/\s+/g, ' ').trim();
}

function ghz(mhz) { return Fmt.num(mhz / 1000, mhz >= 10000 ? 1 : 2).replace(/,?0+$/, '') + NB + 'ГГц'; }

// BIOS пишет дату как ММ/ДД/ГГГГ
function biosDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || '');
  return m ? `${m[2]}.${m[1]}.${m[3]}` : s || '';
}

function memSpeed(s) { return (s || '').replace(/MT\/s/, 'МТ/с').replace(/MHz/, 'МГц'); }

function plural(n, a, b, c) { return `${n}${NB}${Fmt.plural(n, a, b, c)}`; }

/* ---------- температуры ---------- */

// пороги по умолчанию «горячо / перегрев», если датчик не сообщает свои
const T_DEF = { cpu: [85, 95], gpu: [85, 95], ram: [75, 85], hdd: [50, 60], ssd: [70, 80], nvme: [70, 80], disk: [55, 65], board: [70, 85], other: [80, 95] };
const CPU_LIKE = /cpu|peci|tsi|tctl|tdie|package|core/i;

function tLevel(t, key) {
  const [dh, dc] = T_DEF[key] || T_DEF[t.kind] || T_DEF.other;
  const hi = t.high || dh;
  const cr = t.crit && t.crit > hi ? t.crit : Math.max(dc, hi + 5);
  return t.c >= cr ? 'crit' : t.c >= hi ? 'warn' : '';
}

function tFmt(c) { return `${Math.round(c)}${NB}°C`; }

// главный датчик группы: Tdie → Tctl → edge (amdgpu) → Composite (NVMe) → Package → самый горячий
function tMain(list) {
  if (!list || !list.length) return null;
  for (const l of ['Tdie', 'Tctl', 'edge', 'Composite']) {
    const x = list.find((t) => t.label === l);
    if (x) return x;
  }
  const pkg = list.filter((t) => /^Package id/.test(t.label || ''));
  const pool = pkg.length ? pkg : list.filter((t) => !/^(junction|mem|hotspot|vram)$/i.test(t.label || ''));
  return (pool.length ? pool : list).reduce((a, t) => (t.c > a.c ? t : a));
}

function cpuTemps(T) {
  const own = T.filter((t) => t.kind === 'cpu');
  return own.length ? own : T.filter((t) => t.kind === 'board' && CPU_LIKE.test(t.label || ''));
}

// главная температура вида (для карточек на главной)
function tempMain(temps, kind) {
  const T = temps || [];
  return tMain(kind === 'cpu' ? cpuTemps(T) : T.filter((t) => t.kind === kind));
}

const BOARD_LABELS = {
  SYSTIN: 'Система', CPUTIN: 'Сокет процессора', PECI: 'Процессор (PECI)', 'PECI Agent 0': 'Процессор (PECI)',
  PCH_CHIP_TEMP: 'Чипсет', PCH_CPU_TEMP: 'Чипсет', PCH_CHIP_CPU_MAX_TEMP: 'Чипсет, максимум', PCH_MCH_TEMP: 'Северный мост',
  Motherboard: 'Плата', Chipset: 'Чипсет', VRM: 'VRM', 'CPU Socket': 'Сокет процессора', T_Sensor: 'Внешний датчик',
};

function sensorName(t) {
  const l = t.label || '';
  if (t.kind === 'other') {
    if (/^(iwlwifi|mt7|ath|rtw|brcm)/.test(t.chip)) return 'Wi-Fi';
    if (/^(r8169|igc|igb|ixgbe|i40e|ice|bnxt|mlx|e1000|tg3|atlantic|aq)/.test(t.chip)) return 'Сетевая карта' + (l ? ' · ' + l : '');
    if (/psu/.test(t.chip)) return 'Блок питания' + (l ? ' · ' + l : '');
    return t.chip + (l ? ' · ' + l : '');
  }
  if (t.chip === 'acpitz') return 'ACPI' + (l ? ' · ' + l : '');
  let m;
  if ((m = /^AUXTIN(\d+)$/.exec(l))) return 'Доп. датчик ' + m[1];
  // nct6683/nct6687 (MSI, Intel): процессор по шине SB-TSI/PECI, термисторы и диоды платы
  if (/^AMD TSI|^PECI|^Intel PECI/.test(l)) return 'Процессор (по данным платы)';
  if ((m = /^Thermistor (\d+)$/.exec(l))) return 'Термистор ' + m[1];
  if ((m = /^Diode (\d+)/.exec(l))) return 'Диод ' + m[1];
  if ((m = /^SMBus (\d+)$/.exec(l))) return 'Датчик SMBus ' + m[1];
  return BOARD_LABELS[l] || l || t.chip;
}

function tTitle(list) {
  return list.map((t) => `${t.label || t.chip}: ${Fmt.num(t.c, 1)}${NB}°C` + (t.high ? ` (порог ${Math.round(t.high)}${NB}°C)` : '')).join('\n');
}

function tLevelBadge(lvl) {
  if (!lvl) return null;
  return h('span', { class: 'hw-tlvl ' + lvl }, icon('warn'), lvl === 'crit' ? 'перегрев' : 'горячо');
}

// живое значение: «42 °C» и, если горячо, значок с подписью
function tValue(list, key) {
  const m = tMain(list);
  if (!m) return null;
  return [h('span', { class: 'hw-t' }, tFmt(m.c)), tLevelBadge(tLevel(m, key))];
}

/* ---------- плитки ---------- */

function hwTile(kind, title, ico, head, sub, rows, extra) {
  return h('div', { class: 'card hw-tile hw-' + kind },
    h('div', { class: 'hw-top' }, h('span', { class: 'hw-badge' }, hwIcon(ico)), h('span', { class: 'hw-label' }, title)),
    h('div', { class: 'hw-name', title: typeof head === 'string' ? head : null }, head),
    sub ? h('div', { class: 'hw-sub' }, sub) : null,
    extra || null,
    rows && rows.filter((r) => r && r[1]).length
      ? h('dl', { class: 'hw-dl' }, rows.filter((r) => r && r[1]).map(([k, v, t]) => [h('dt', null, k), h('dd', { title: t || (typeof v === 'string' ? v : null) }, v)]))
      : null);
}

// live(pick, key, opts) — место для живой температуры: pick(temps) → датчики
function cpuTile(hw, live) {
  const c = hw.cpu || {};
  const virt = hw.platform && hw.platform.virt;
  const parts = [];
  if (virt) parts.push(`${c.threads || 1}${NB}vCPU`);
  else {
    if (c.sockets > 1) parts.push(plural(c.sockets, 'процессор', 'процессора', 'процессоров'));
    if (c.cores) parts.push(plural(c.cores, 'ядро', 'ядра', 'ядер'));
    if (c.threads && c.threads !== c.cores) parts.push(plural(c.threads, 'поток', 'потока', 'потоков'));
  }
  if (c.maxMHz) parts.push('до ' + ghz(c.maxMHz));
  const base = /@\s+([\d.]+)\s*GHz/i.exec(c.model || '');
  if (!c.maxMHz && base) parts.push(base[1].replace('.', ',') + NB + 'ГГц');
  return hwTile('cpu', 'Процессор', 'cpu', cpuName(c.model) || 'Неизвестный процессор', parts.join(' · '), [
    ['Температура', live(cpuTemps, 'cpu')],
    ['Кэш L3', c.l3 ? Fmt.bytes(c.l3) : ''],
    ['Архитектура', c.arch],
    virt ? ['Гипервизор', c.hypervisor] : ['Виртуализация', c.virtExt],
  ]);
}

function gpuTemps(T, x, n) {
  const g = T.filter((t) => t.kind === 'gpu');
  const mine = x.slot ? g.filter((t) => t.dev && t.dev.toLowerCase().endsWith(x.slot.toLowerCase())) : [];
  return mine.length || n > 1 ? mine : g;
}

function gpuTile(hw, live) {
  const order = { gpu: 0, bmc: 1, virtual: 2 };
  const g = (hw.gpus || []).slice().sort((a, b) => order[a.kind] - order[b.kind]);
  const tag = (x) => (x.kind === 'virtual' ? h('span', { class: 'hw-tag' }, 'виртуальный') : x.kind === 'bmc' ? h('span', { class: 'hw-tag', title: 'Видеовыход контроллера удалённого управления (BMC)' }, 'BMC') : null);
  if (!g.length) {
    return hwTile('gpu', 'Видеокарта', 'gpu', h('span', { class: 'muted' }, 'Нет'), 'видеоадаптеры не найдены', null);
  }
  const meta = (x) => [x.chip ? 'чип ' + x.chip : '', x.vram ? Fmt.bytes(x.vram) : '', x.driver ? 'драйвер ' + x.driver : ''].filter(Boolean).join(' · ');
  if (g.length === 1) {
    const x = g[0];
    return hwTile('gpu', 'Видеокарта', 'gpu', h('span', { class: 'hw-name-in' }, x.name, tag(x)), null, [
      ['Температура', live((T) => gpuTemps(T, x, 1), 'gpu')],
      ['Чип', x.chip], ['Видеопамять', x.vram ? Fmt.bytes(x.vram) : ''], ['Драйвер', x.driver || 'не загружен'],
    ]);
  }
  // одинаковые карты — «2 × NVIDIA RTX 4090»
  const groups = [];
  for (const x of g) {
    const last = groups.find((y) => y.x.name === x.name && y.x.driver === x.driver);
    if (last) last.n++; else groups.push({ x, n: 1 });
  }
  const real = g.filter((x) => x.kind === 'gpu').length;
  return hwTile('gpu', 'Видеокарты', 'gpu', real ? plural(real, 'видеокарта', 'видеокарты', 'видеокарт') : plural(g.length, 'адаптер', 'адаптера', 'адаптеров'), null, null,
    h('ul', { class: 'hw-list' }, groups.map(({ x, n }) => h('li', null,
      h('div', { class: 'hw-li-name' }, h('span', { class: 'hw-trunc' }, n > 1 ? `${n}${NB}× ` : '', x.name, tag(x)), n === 1 ? live((T) => gpuTemps(T, x, g.length), 'gpu', { cls: 'hw-dt' }) : null),
      meta(x) ? h('div', { class: 'hw-li-sub' }, meta(x)) : null))));
}

function memTile(hw, live) {
  const m = hw.mem || {};
  const virt = hw.platform && hw.platform.virt;
  const mods = m.modules || [];
  const installed = mods.reduce((a, x) => a + x.size, 0);
  const types = [...new Set(mods.map((x) => x.type).filter(Boolean))];
  const speeds = [...new Set(mods.map((x) => memSpeed(x.speed)).filter(Boolean))];
  const head = h('span', null, Fmt.bytes(installed || m.total), types.length || speeds.length ? h('small', null, ' ' + [types.join('/'), speeds.join(', ')].filter(Boolean).join(' ')) : null);
  let sub = '';
  if (mods.length && !virt) {
    const sizes = [...new Set(mods.map((x) => x.size))];
    sub = sizes.length === 1 ? `${plural(mods.length, 'модуль', 'модуля', 'модулей')} по ${Fmt.bytes(sizes[0])}` : plural(mods.length, 'модуль', 'модуля', 'модулей');
    if (m.slots) sub += ` · заняты ${mods.length} из ${m.slots} слотов`;
  }
  const maker = (v) => (v || '').replace(/[,.]?\s+(Technology|Technologies|Corporation|Corp\.?|Inc\.?|Co\.?,?\s*Ltd\.?|Ltd\.?|GmbH)\.?$/i, '');
  const parts = [...new Set(mods.map((x) => [maker(x.maker), x.part].filter(Boolean).join(' ')).filter(Boolean))];
  let note = null;
  if (m.dmi === 'noroot') note = 'Модули памяти видны только под root или с sudo без пароля.';
  else if (m.dmi === 'missing') note = 'Чтобы увидеть модули памяти, установите dmidecode.';
  const ecc = m.ecc ? (m.ecc === 'None' ? 'нет' : `есть (${m.ecc})`) : '';
  return hwTile('ram', 'Оперативная память', 'ram', head, sub, [
    ['Температура', live((T) => T.filter((t) => t.kind === 'ram'), 'ram', virt ? null : {
      empty: 'нет датчика',
      emptyTitle: 'Ядро не видит датчиков температуры памяти. В модулях DDR5 они встроены и появляются сами; у DDR4 датчик есть не у всех модулей и подключается вручную (драйвер jc42).',
    })],
    virt ? null : ['Модули', parts.join('; ')],
    installed && Math.abs(installed - m.total) > 64 << 20 ? ['Доступно системе', Fmt.bytes(m.total, 1)] : null,
    virt ? null : ['Максимум', m.max ? Fmt.bytes(m.max) : ''],
    virt ? null : ['ECC', ecc],
    ['Swap', m.swap ? Fmt.bytes(m.swap) : 'нет'],
  ], note ? h('div', { class: 'hw-note' }, note) : null);
}

const DISK_KIND = { nvme: ['NVMe', 'nvme'], ssd: ['SSD', 'ssd'], hdd: ['HDD', 'hdd'], virtual: ['виртуальный', 'vdisk'], usb: ['USB', 'usb'] };

function diskMounts(d) {
  const ms = d.mounts || [];
  if (!ms.length) return h('span', { class: 'muted' }, 'не смонтирован');
  const main = ms.filter((x) => !/^\/boot(\/|$)|^\/efi$/.test(x));
  const show = main.length ? main : ms;
  const rest = ms.length - show.length;
  return h('span', { class: 'hw-mounts', title: ms.join('\n') }, show.slice(0, 3).map((x) => h('code', null, x)),
    show.length > 3 || rest ? h('span', { class: 'muted' }, ` +${show.length - Math.min(3, show.length) + rest}`) : null);
}

function diskTile(hw, live) {
  const ds = hw.disks || [];
  if (!ds.length) return hwTile('disk-tile', 'Накопители', 'hdd', h('span', { class: 'muted' }, 'Нет данных'), 'lsblk ничего не вернул', null);
  const total = ds.reduce((a, d) => a + d.size, 0);
  const kinds = [...new Set(ds.map((d) => (DISK_KIND[d.kind] || [d.kind])[0]))];
  const ico = ds.some((d) => d.kind === 'nvme') ? 'nvme' : ds.some((d) => d.kind === 'ssd') ? 'ssd' : ds.every((d) => d.kind === 'virtual') ? 'vdisk' : 'hdd';
  return hwTile('disk-tile', 'Накопители', ico, h('span', null, Fmt.bytes(total), h('small', null, ' ' + kinds.join(' + '))), plural(ds.length, 'накопитель', 'накопителя', 'накопителей'), null,
    h('ul', { class: 'hw-list' }, ds.map((d) => {
      const [kname, kico] = DISK_KIND[d.kind] || [d.kind, 'hdd'];
      return h('li', { class: 'hw-disk' },
        hwIcon(kico, 'hw-mini'),
        h('div', { class: 'hw-li-main' },
          h('div', { class: 'hw-li-name' }, h('span', { class: 'hw-trunc', title: d.model || d.name }, d.model || d.name),
            live((T) => T.filter((t) => t.kind === 'disk' && (t.dev === d.name || d.name.startsWith(t.dev + 'n'))), d.kind, { cls: 'hw-dt' }),
            h('b', null, Fmt.bytes(d.size))),
          h('div', { class: 'hw-li-sub' }, d.model ? `${kname} · ${d.name}` : kname, ' · ', diskMounts(d))));
    })));
}

// датчики платы и прочие (Wi-Fi, сетевые карты) — списком
function boardTemps(list, el) {
  const T = list.filter((t) => t.kind === 'board' || t.kind === 'other');
  el.hidden = !T.length;
  if (!T.length) return;
  const show = T.slice(0, 8);
  el.replaceChildren(h('div', { class: 'hw-cap' }, 'Датчики температуры'),
    h('dl', { class: 'hw-dl hw-tdl' }, show.map((t) => [
      h('dt', { title: `${t.chip}${t.label ? ' · ' + t.label : ''}` }, sensorName(t)),
      h('dd', { title: tTitle([t]) }, h('span', { class: 'hw-t' }, tFmt(t.c)), tLevelBadge(tLevel(t, t.kind)))])),
    T.length > show.length ? h('div', { class: 'hw-note', title: tTitle(T.slice(show.length)) }, `и ещё ${T.length - show.length}`) : '');
}

function platformTile(hw, live, act) {
  const p = hw.platform || {};
  if (p.virt) {
    const cont = CONTAINERS.has(p.virt);
    const vn = VIRT_NAMES[p.virt] || p.virt;
    return hwTile('plat', 'Платформа', cont ? 'rack' : 'vm', cont ? 'Контейнер' : 'Виртуальная машина', vn, [
      ['Поставщик', p.vendor && p.vendor !== p.product ? p.vendor : ''],
      ['Модель', p.product && p.product !== vn && !cont ? p.product : ''],
    ]);
  }
  let head;
  const rows = [];
  // у фирменных серверов (Dell PowerEdge, HPE ProLiant) модель важнее платы
  if (p.product && p.vendor && p.board && !p.board.includes(p.product)) {
    head = `${p.vendor} ${p.product}`;
    rows.push(['Плата', p.board]);
  } else {
    // «MSI MPG B550 GAMING PLUS (MS-7C56)» → код модели отдельной строкой
    head = (p.board || [p.vendor, p.product].filter(Boolean).join(' ') || 'Неизвестно').replace(/\s*\(([^)]+)\)$/, (all, code) => (code === p.product ? '' : all));
    if (p.product && !head.includes(p.product)) rows.push(['Модель', p.product]);
  }
  rows.push(['BIOS', [p.bios, p.biosDate ? 'от ' + biosDate(p.biosDate) : ''].filter(Boolean).join(' ')]);
  const server = /сервер|блейд/.test(p.chassis || '');
  const sens = hw.sensors || {};
  const tile = hwTile('plat', 'Платформа', server ? 'rack' : 'board', head, p.chassis ? p.chassis[0].toUpperCase() + p.chassis.slice(1) : '', rows);
  tile.append(live(null, 'board', { render: boardTemps }));
  if (sens.panel && sens.panel.length) {
    tile.append(h('div', { class: 'hw-note' }, `Драйверы датчиков включены панелью: ${sens.panel.join(', ')}.`,
      sens.root ? h('button', { class: 'linkbtn', type: 'button', onclick: () => act('disable') }, 'Отключить') : null));
  }
  return tile;
}

// полоса «включить датчики» — если в ядре есть драйверы для дисков или платы
function sensorsStrip(hw, act) {
  const s = hw.sensors || {};
  if ((hw.platform && hw.platform.virt) || !s.missing || !s.missing.length) return null;
  const what = [];
  if (s.missing.includes('drivetemp')) what.push('дисков');
  if (s.missing.some((m) => m !== 'drivetemp')) what.push('материнской платы');
  const btn = s.root ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => act('enable', btn) }, 'Включить датчики') : null;
  return h('div', { class: 'card hw-sens' },
    h('span', { class: 'hw-badge' }, icon('info')),
    h('div', { class: 'hw-sens-text' },
      h('div', null, `Температура ${what.join(' и ')} пока не видна`),
      h('div', { class: 'muted' }, s.root
        ? 'Нужные драйверы есть в ядре, но не загружены. Панель загрузит их и оставит те, что найдут датчики.'
        : 'Нужные драйверы есть в ядре, но не загружены. Включить их можно под root или с sudo без пароля.')),
    btn);
}

// короткая строка для свёрнутого вида
function hwSummary(hw) {
  const parts = [];
  if (hw.cpu && hw.cpu.model) parts.push(cpuName(hw.cpu.model).replace(/^(AMD|Intel)\s+/, ''));
  const mods = (hw.mem && hw.mem.modules) || [];
  const inst = mods.reduce((a, x) => a + x.size, 0) || (hw.mem && hw.mem.total);
  if (inst) parts.push(Fmt.bytes(inst) + ' RAM');
  const g = (hw.gpus || []).find((x) => x.kind === 'gpu');
  if (g) parts.push(g.name.replace(/^(NVIDIA|AMD|Intel)\s+/, ''));
  const ds = hw.disks || [];
  if (ds.length) parts.push(`${plural(ds.length, 'диск', 'диска', 'дисков')} · ${Fmt.bytes(ds.reduce((a, d) => a + d.size, 0))}`);
  return parts.join(' · ');
}

/* ---------- секция на вкладке «Обзор» ---------- */

function hardwareSection(id) {
  let open = store.get('hwOpen', true);
  let destroyed = false;
  let busy = false;
  let last = null;
  let slots = [];
  let lastT = null;
  const sub = h('span', { class: 'card-sub' });
  const body = h('div', { class: 'hw-grid' });
  const refresh = h('button', { class: 'btn sm icon-only', type: 'button', title: 'Собрать заново', 'aria-label': 'Собрать характеристики заново', onclick: () => load(true) }, icon('refresh'));
  const toggle = h('button', { class: 'btn sm hw-toggle', type: 'button', 'aria-expanded': String(open), onclick: () => setOpen(!open) }, hwIcon('chev'), h('span'));
  const el = h('section', { class: 'hw', 'aria-label': 'Характеристики сервера' },
    h('div', { class: 'hw-head' },
      h('button', { class: 'hw-title', type: 'button', onclick: () => setOpen(!open) }, 'Характеристики'), sub,
      h('div', { class: 'right' }, refresh, toggle)),
    body);

  function setOpen(v) {
    open = v;
    store.set('hwOpen', v);
    el.classList.toggle('closed', !v);
    toggle.setAttribute('aria-expanded', String(v));
    toggle.setAttribute('aria-label', v ? 'Свернуть характеристики' : 'Развернуть характеристики');
    toggle.lastChild.textContent = v ? 'Свернуть' : 'Развернуть';
    body.hidden = !v;
    renderSub();
  }

  function renderSub() {
    if (busy && !last) { sub.replaceChildren(h('span', { class: 'spinner' }), NB + ' собираю…'); return; }
    if (!last) return;
    const when = 'обновлено ' + Fmt.clock(last.t);
    sub.textContent = !open && last.data ? hwSummary(last.data) : busy ? 'обновляю…' : when;
    sub.title = when;
  }

  // место для живой температуры; обновляется из потока метрик (temps)
  function live(pick, key, opts) {
    opts = opts || {};
    const el = h('span', { class: 'hw-live' + (opts.cls ? ' ' + opts.cls : '') });
    if (opts.render) el.className = 'hw-tlist';
    el.hidden = true;
    slots.push({ el, pick, key, opts });
    return el;
  }

  function paint(T) {
    for (const s of slots) {
      if (s.opts.render) { s.opts.render(T, s.el); continue; }
      const list = s.pick(T);
      const v = tValue(list, s.key);
      const empty = !v && T && s.opts.empty;
      const show = !!v || !!empty;
      if (v) { s.el.replaceChildren(...v.filter(Boolean)); s.el.title = tTitle(list); }
      else if (empty) { s.el.replaceChildren(h('span', { class: 'muted' }, s.opts.empty)); s.el.title = s.opts.emptyTitle || ''; }
      s.el.hidden = !show;
      const dd = s.el.parentElement;
      if (dd && dd.tagName === 'DD') { dd.hidden = !show; if (dd.previousElementSibling) dd.previousElementSibling.hidden = !show; }
    }
  }

  async function act(action, btn) {
    const enable = action === 'enable';
    const ok = await confirmDialog(enable ? {
      title: 'Включить датчики температуры?',
      text: 'Панель загрузит драйверы из ядра сервера: drivetemp — температура SATA-дисков, и драйвер микросхемы мониторинга платы (nct6683, nct6775, it87 и др.). Оставит только те, что найдут свои датчики, и пропишет их в /etc/modules-load.d/method-panel-sensors.conf, чтобы они загружались после перезагрузки. Отключить можно здесь же.',
      ok: 'Включить',
    } : {
      title: 'Отключить драйверы датчиков?',
      text: 'Панель удалит /etc/modules-load.d/method-panel-sensors.conf и выгрузит драйверы, которые включила. Температуры дисков и платы пропадут.',
      ok: 'Отключить',
    });
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }), NB + 'Включаю…'); }
    try {
      const r = await api(`/servers/${encodeURIComponent(id)}/sensors`, { method: 'POST', body: { action } });
      if (!enable) toast('Драйверы датчиков отключены');
      else if (r.modules && r.modules.length) toast('Датчики включены: ' + r.modules.join(', '));
      else toast('Новых датчиков не нашлось', 'warn', 'Драйверы загрузились, но не нашли на этом сервере ни SATA-дисков с датчиком, ни знакомой микросхемы мониторинга платы.');
    } catch (e) {
      toast('Не получилось', 'bad', e.message);
    }
    if (!destroyed) load(true);
  }

  function render(v) {
    const hw = v.data;
    slots = [];
    body.replaceChildren(cpuTile(hw, live), gpuTile(hw, live), memTile(hw, live), diskTile(hw, live), platformTile(hw, live, act), sensorsStrip(hw, act) || '');
    if (lastT) paint(lastT);
  }

  async function load(force) {
    if (busy) return;
    busy = true;
    refresh.disabled = true;
    renderSub();
    if (!last) body.replaceChildren(...['cpu', 'gpu', 'ram', 'disk-tile', 'plat'].map((k) => h('div', { class: 'card hw-tile hw-skel hw-' + k }, h('span', { class: 'hw-badge' }), h('i'), h('i'))));
    try {
      const v = await HW.get(id, force);
      if (destroyed) return;
      last = v;
      render(v);
    } catch (e) {
      if (destroyed) return;
      if (!last) {
        body.replaceChildren(h('div', { class: 'card hw-err' }, icon('warn'), h('span', null, 'Не удалось собрать характеристики: ' + e.message),
          h('button', { class: 'btn sm', type: 'button', onclick: () => load(true) }, 'Повторить')));
      } else toast('Не удалось обновить характеристики', 'bad', e.message);
    } finally {
      busy = false;
      refresh.disabled = false;
      if (!destroyed) renderSub();
    }
  }

  setOpen(open);
  load(false);
  return {
    el,
    destroy() { destroyed = true; },
    reload() { if (!last) load(false); },
    temps(T) { lastT = T || []; paint(lastT); },
  };
}

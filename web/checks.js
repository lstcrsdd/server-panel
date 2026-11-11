'use strict';
/* Сайты и порты: проверки снаружи (checks.go). Загружается до app.js. */

const CHECK_PH = 'https://example.com, example.com:443 или tls://example.com:8443';

class ChecksPage {
  constructor() {
    this.kind = 'checks';
    this.checks = [];
    this.res = {};
    this.certDays = 14;
    this.edit = null; // id проверки, которую меняем в форме
    this.el = h('div', { class: 'page' });
    this.formEl = h('div');
    this.listEl = h('div', null, h('div', { class: 'card empty' }, h('span', { class: 'spinner' }), ' Загрузка…'));
    this.el.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-main' },
          h('h1', null, 'Сайты и порты'),
          h('div', { class: 'head-meta' }, h('span', null, 'Панель раз в минуту проверяет их с этого компьютера: отвечают ли и не истекает ли сертификат')))),
      this.formEl,
      h('div', { class: 'section-title' }, 'Проверки'),
      this.listEl,
      h('p', { class: 'muted chk-foot' }, 'Когда сообщать — правила «Сайт или порт не отвечает» и «Сертификат скоро истекает» на странице ',
        h('a', { href: '#/alerts' }, 'Оповещения'), '.'));
    this.renderForm();
    this.load();
    this.tick = setInterval(() => this.renderList(), 15e3);
  }

  async load() {
    try {
      const [d, al] = await Promise.all([api('/checks'), api('/alerts').catch(() => null)]);
      const cert = al && al.config && al.config.rules && al.config.rules.cert;
      if (cert && cert.days) this.certDays = cert.days;
      this.onChecks(d);
    } catch (e) {
      this.listEl.replaceChildren(h('div', { class: 'alert bad' }, e.message));
    }
  }

  onChecks(d) {
    this.checks = d.checks || [];
    this.res = d.results || {};
    this.renderList();
  }

  onData() {
    // список серверов в форме мог измениться
    if (this.srvSel && !this.srvSel.matches(':focus')) this.fillServers();
  }

  destroy() { clearInterval(this.tick); }

  fillServers() {
    const cur = this.srvSel.value;
    this.srvSel.replaceChildren(h('option', { value: '' }, 'не относится к серверу'),
      ...S.servers.filter((s) => !s.hidden || s.id === cur).map((s) => h('option', { value: s.id, selected: s.id === cur }, s.name)));
  }

  renderForm() {
    const c = this.edit ? this.checks.find((x) => x.id === this.edit) : null;
    const target = h('input', { class: 'input mono', placeholder: CHECK_PH, value: c ? c.target : '', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Адрес' });
    const name = h('input', { class: 'input', placeholder: 'например «Сайт магазина»', value: c ? c.name || '' : '', maxlength: '80', 'aria-label': 'Название' });
    this.srvSel = h('select', { class: 'input', 'aria-label': 'Сервер' });
    this.fillServers();
    this.srvSel.value = c ? c.server || '' : '';
    const err = h('div', { class: 'hint bad-ink', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, ...(c ? ['Сохранить'] : [icon('plus'), 'Добавить']));
    const form = h('form', { class: 'card chk-form', novalidate: true },
      h('div', { class: 'card-head' }, h('div', null,
        h('div', { class: 'card-title' }, c ? 'Изменить проверку' : 'Новая проверка'),
        h('div', { class: 'card-sub' }, 'Сайт — ответ по HTTP(S) и его сертификат; host:порт — открыт ли порт; tls://host:порт — сертификат на любом TLS-порте'))),
      h('div', { class: 'chk-fields' },
        h('label', { class: 'field chk-target' }, h('span', null, 'Адрес'), target),
        h('label', { class: 'field' }, h('span', null, 'Название ', h('span', { class: 'muted' }, '— необязательно')), name),
        h('label', { class: 'field' }, h('span', null, 'Сервер'), this.srvSel)),
      err,
      h('div', { class: 'chk-actions' }, submit,
        c ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { this.edit = null; this.renderForm(); } }, 'Отмена') : null));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      if (!target.value.trim()) { err.textContent = 'Укажите адрес'; err.hidden = false; target.focus(); return; }
      submit.disabled = true;
      const body = { target: target.value.trim(), name: name.value.trim(), server: this.srvSel.value };
      try {
        if (c) await api(`/checks/${encodeURIComponent(c.id)}`, { method: 'PUT', body });
        else await api('/checks', { method: 'POST', body });
        toast(c ? 'Проверка сохранена' : 'Проверка добавлена — первый результат через несколько секунд');
        this.edit = null;
        this.renderForm();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        submit.disabled = false;
      }
    });
    this.formEl.replaceChildren(form);
    if (c) target.focus();
  }

  renderList() {
    if (!this.checks.length) {
      this.listEl.replaceChildren(h('div', { class: 'card empty' },
        h('b', null, 'Проверок пока нет'),
        'Добавьте сайт или порт — например адрес панели VPN или порт, к которому подключаются клиенты'));
      return;
    }
    const rows = [...this.checks].sort((a, b) => this.rank(a) - this.rank(b) || this.label(a).localeCompare(this.label(b), 'ru'));
    this.listEl.replaceChildren(h('div', { class: 'card flush chk-list' }, rows.map((c) => this.row(c))));
  }

  label(c) { return c.name || c.target.replace(/^https:\/\//, '').replace(/\/$/, ''); }

  // сначала проблемы
  rank(c) {
    const r = this.res[c.id];
    if (c.off) return 3;
    if (!r) return 2;
    if (!r.ok || (r.cert && (r.cert.err || r.cert.days < this.certDays))) return 0;
    return 1;
  }

  row(c) {
    const r = this.res[c.id];
    const certBad = r && r.cert && (r.cert.err || r.cert.days < this.certDays);
    const state = c.off ? 'off' : !r ? 'connecting' : !r.ok ? 'offline' : certBad ? 'warn' : 'online';
    const sub = [h('span', { class: 'mono' }, c.target)];
    if (c.server) sub.push(h('span', { class: 'pchip' }, srvName(c.server)));

    // ответ
    let resp;
    if (c.off) resp = h('span', { class: 'muted' }, 'на паузе');
    else if (!r) resp = h('span', { class: 'muted' }, h('span', { class: 'spinner' }), NB + 'проверяю…');
    else if (!r.ok) {
      const long = Date.now() - r.since >= 60e3;
      resp = h('span', { class: 'bad-ink' }, r.err || 'не отвечает',
        long ? h('span', { class: 'muted' }, ' · уже ' + Fmt.dur((Date.now() - r.since) / 1000)) : null);
    } else {
      const bits = [];
      if (r.code) bits.push(String(r.code));
      if (r.ms != null) bits.push(r.ms + ' мс');
      resp = h('span', { title: r.code >= 400 ? `Сервер отвечает, но с кодом ${r.code}` : null, class: r.code >= 400 ? 'warn-ink' : null },
        bits.join(' · ') || 'порт открыт');
    }

    // сертификат
    let cert = null;
    if (r && r.cert) {
      const ce = r.cert, till = new Date(ce.notAfter).toLocaleDateString('ru-RU');
      const tip = `Действует до ${till}` + (ce.issuer ? `, выдан ${ce.issuer}` : '');
      if (ce.err) cert = h('span', { class: 'bad-ink', title: tip }, icon('warn'), 'сертификат: ' + ce.err);
      else if (ce.days < this.certDays) cert = h('span', { class: 'warn-ink', title: tip }, icon('warn'), 'сертификат истекает через ' + plural(ce.days, 'день', 'дня', 'дней'));
      else cert = h('span', { class: 'muted', title: tip }, 'сертификат ещё ' + plural(ce.days, 'день', 'дня', 'дней'));
    }

    const when = r && !c.off ? h('span', { class: 'muted chk-when', title: Fmt.dateTime(r.at) }, Date.now() - r.at < 60e3 ? 'только что' : Fmt.dur((Date.now() - r.at) / 1000) + ' назад') : null;

    const runBtn = h('button', { class: 'btn ghost sm icon-only', type: 'button', title: 'Проверить сейчас', 'aria-label': `Проверить ${this.label(c)} сейчас`, disabled: !!c.off }, icon('refresh'));
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.replaceChildren(h('span', { class: 'spinner' }));
      try {
        const d = await api(`/checks/${encodeURIComponent(c.id)}/run`, { method: 'POST' });
        if (d.result) { this.res[c.id] = d.result; this.renderList(); }
      } catch (e) {
        toast(e.message, 'bad');
        runBtn.disabled = false;
        runBtn.replaceChildren(icon('refresh'));
      }
    });
    const pauseBtn = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => this.patch(c, { off: !c.off }) }, c.off ? 'Включить' : 'Пауза');
    const editBtn = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { this.edit = c.id; this.renderForm(); this.formEl.scrollIntoView({ block: 'nearest' }); } }, 'Изменить');
    const delBtn = h('button', { class: 'btn ghost sm danger', type: 'button', onclick: () => this.remove(c) }, 'Удалить');

    return h('div', { class: 'chk-row' + (c.off ? ' dim' : '') },
      h('span', { class: 'dot ' + state }),
      h('div', { class: 'chk-main' },
        h('div', { class: 'chk-name' }, this.label(c)),
        h('div', { class: 'chk-sub' }, sub)),
      h('div', { class: 'chk-state' }, resp, cert, when),
      h('div', { class: 'chk-acts' }, runBtn, editBtn, pauseBtn, delBtn));
  }

  async patch(c, body) {
    try { await api(`/checks/${encodeURIComponent(c.id)}`, { method: 'PUT', body }); } catch (e) { toast(e.message, 'bad'); }
  }

  async remove(c) {
    const ok = await confirmDialog({ title: `Удалить проверку «${this.label(c)}»?`, text: 'Панель перестанет её проверять, а активное оповещение по ней снимется.', ok: 'Удалить', danger: true });
    if (!ok) return;
    try {
      await api(`/checks/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (this.edit === c.id) { this.edit = null; this.renderForm(); }
    } catch (e) { toast(e.message, 'bad'); }
  }
}

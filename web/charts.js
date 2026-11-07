'use strict';
/* Графики на canvas: временные ряды с перекрестием и подсказкой, спарклайны.
   Цвета берутся из CSS-переменных темы, поэтому светлая и тёмная темы
   рисуются своими ступенями палитры. */

const Theme = {
  cache: null,
  get() {
    if (this.cache) return this.cache;
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.cache = {
      surface: v('--surface'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'),
      grid: v('--grid'), axis: v('--axis'), font: v('--font'),
      s1: v('--s1'), s2: v('--s2'), s3: v('--s3'), s4: v('--s4'), accent: v('--accent'),
    };
    return this.cache;
  },
  reset() { this.cache = null; },
};

/* ---------- форматирование ---------- */
const Fmt = (() => {
  const n0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const n1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const n2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const NB = ' ';
  const scaled = (v, base, units, digits) => {
    let i = 0;
    let x = Math.abs(v || 0);
    while (x >= base && i < units.length - 1) { x /= base; i++; }
    const f = digits != null ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }) : (x < 10 && i > 0 ? n1 : n0);
    return f.format(x) + NB + units[i];
  };
  // подпись оси в единой единице, выбранной по верхнему делению шкалы
  const axisIn = (v, top, base, units) => {
    if (!v) return '0';
    let i = 0, div = 1;
    while (top / div >= base && i < units.length - 1) { div *= base; i++; }
    const x = v / div;
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: x < 10 && i > 0 ? 1 : 0 }).format(x) + NB + units[i];
  };
  return {
    axisBytes: (v, top) => axisIn(v, top, 1024, ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']),
    axisRate: (v, top) => axisIn(v, top, 1024, ['Б/с', 'КБ/с', 'МБ/с', 'ГБ/с']),
    axisBits: (v, top) => axisIn(v, top, 1000, ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с']),
    plural(n, one, few, many) {
      const a = Math.abs(n) % 100, b = a % 10;
      if (a > 10 && a < 20) return many;
      if (b === 1) return one;
      if (b >= 2 && b <= 4) return few;
      return many;
    },
    int: (v) => n0.format(v || 0),
    num: (v, d = 1) => (d === 0 ? n0 : d === 2 ? n2 : n1).format(v || 0),
    pct: (v) => n1.format(v || 0) + NB + '%',
    pct0: (v) => n0.format(v || 0) + NB + '%',
    bytes: (v, d) => scaled(v, 1024, ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'], d),
    rate: (v) => scaled(v, 1024, ['Б/с', 'КБ/с', 'МБ/с', 'ГБ/с'], null),
    bits: (bits) => scaled(bits, 1000, ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с', 'Тбит/с'], null),
    dur(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      if (d > 0) return `${d}${NB}д ${h}${NB}ч`;
      if (h > 0) return `${h}${NB}ч ${m}${NB}мин`;
      if (m > 0) return `${m}${NB}мин`;
      return `${sec}${NB}с`;
    },
    clock(ms, sec) {
      const d = new Date(ms);
      const p = (x) => String(x).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}` + (sec ? `:${p(d.getSeconds())}` : '');
    },
    date(ms) {
      const d = new Date(ms);
      const p = (x) => String(x).padStart(2, '0');
      return `${p(d.getDate())}.${p(d.getMonth() + 1)}`;
    },
    dateTime(ms, sec = true) {
      const t = Fmt.clock(ms, sec);
      if (new Date(ms).toDateString() === new Date().toDateString()) return t;
      return `${Fmt.date(ms)} ${t}`;
    },
  };
})();

/* ---------- шкалы ---------- */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

// base=1024 — шаги, кратные «круглым» КБ/МБ/ГБ; base=1000 — десятичные.
function niceTicks(max, count, base) {
  if (!(max > 0)) max = 1;
  let scale = 1;
  if (base) {
    const k = Math.max(0, Math.floor(Math.log(max) / Math.log(base)));
    scale = base ** k;
  }
  const step = niceStep(max / scale / count) * scale;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { ticks, top };
}

const DAY = 86400e3;
const X_STEPS = [10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, DAY, 2 * DAY, 7 * DAY];

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* ---------- график временного ряда ---------- */
class TimeChart {
  /**
   * opts.series: [{label, color:'s1', get:(p)=>number, kind:'area'|'line'}]
   * opts.stacked: полосы складываются (CPU)
   * opts.fmt: формат значения в подсказке, opts.axis: формат подписи оси
   * opts.max: (points, dataMax) => фиксированный верх шкалы или null
   * opts.base: 1024 | 1000 | null — какие шаги шкалы считать «круглыми»
   */
  constructor(opts) {
    this.o = Object.assign({ height: 190, stacked: false, fmt: (v) => Fmt.num(v), axis: null, total: null, minTop: 1 }, opts);
    if (!this.o.axis) this.o.axis = this.o.fmt;
    this.el = document.createElement('div');
    this.el.className = 'chart';
    this.canvas = document.createElement('canvas');
    this.canvas.style.height = this.o.height + 'px';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', opts.title || 'график');
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.empty = document.createElement('div');
    this.empty.className = 'chart-empty';
    this.empty.textContent = 'Данные собираются…';
    this.el.append(this.canvas, this.tip, this.empty);
    this.points = [];
    this.t0 = Date.now() - 900e3;
    this.t1 = Date.now();
    this.step = 2000;
    this.hoverX = null;
    this.raf = 0;
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.schedule();
    });
    this.canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.schedule(); });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.el);
  }

  legend() {
    const wrap = document.createElement('div');
    wrap.className = 'legend';
    if (this.o.series.length < 2) return wrap;
    const C = Theme.get();
    for (const s of this.o.series) {
      const item = document.createElement('span');
      const key = document.createElement('i');
      key.className = 'key ' + (s.kind === 'line' ? 'line' : 'rect');
      key.style.background = `var(--${s.color})`;
      item.append(key, document.createTextNode(s.label));
      wrap.append(item);
    }
    void C;
    return wrap;
  }

  set(points, t0, t1, step) {
    this.points = points || [];
    this.t0 = t0;
    this.t1 = t1;
    if (step) this.step = step;
    this.schedule();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  destroy() {
    this.ro.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  draw() {
    const o = this.o;
    const w = this.el.clientWidth;
    const H = o.height;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    const cv = this.canvas;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    const C = Theme.get();
    const pts = this.points.filter((p) => p.t >= this.t0 - this.step && p.t <= this.t1 + this.step);
    this.empty.hidden = pts.length > 1;

    const ser = o.series;
    const raw = pts.map((p) => ser.map((s) => Math.max(0, +s.get(p) || 0)));
    const vals = o.stacked
      ? raw.map((r) => { let acc = 0; return r.map((v) => (acc += v)); })
      : raw;
    let dataMax = 0;
    for (const r of vals) for (const v of r) if (v > dataMax) dataMax = v;
    let top = o.max ? o.max(pts, dataMax) : null;
    let ticks;
    if (top) {
      ({ ticks } = niceTicks(top, 4, o.base));
      ticks = ticks.filter((t) => t <= top * 1.0001);
    } else {
      ({ ticks, top } = niceTicks(Math.max(dataMax * 1.08, o.minTop), 4, o.base));
    }

    ctx.font = `11px ${C.font}`;
    let labelW = 0;
    const labels = ticks.map((t) => {
      const s = o.axis(t, top);
      labelW = Math.max(labelW, ctx.measureText(s).width);
      return s;
    });
    const padL = Math.ceil(labelW) + 12, padR = 10, padT = 10, padB = 24;
    const pw = w - padL - padR, ph = H - padT - padB;
    const span = Math.max(1, this.t1 - this.t0);
    const X = (t) => padL + ((t - this.t0) / span) * pw;
    const Y = (v) => padT + (1 - v / top) * ph;

    // сетка и ось Y
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks.forEach((t, i) => {
      const y = Math.round(Y(t)) + 0.5;
      ctx.strokeStyle = t === 0 ? C.axis : C.grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.fillText(labels[i], padL - 8, y);
    });

    // ось времени
    let xs = X_STEPS[X_STEPS.length - 1];
    for (const s of X_STEPS) if ((s / span) * pw >= 84) { xs = s; break; }
    const tzOff = new Date().getTimezoneOffset() * 60e3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.muted;
    for (let t = Math.ceil((this.t0 - tzOff) / xs) * xs + tzOff; t <= this.t1; t += xs) {
      const x = X(t);
      if (x < padL + 18 || x > w - padR - 18) continue;
      const d = new Date(t);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      ctx.fillText(xs >= DAY || (midnight && span > 30 * 3600e3) ? Fmt.date(t) : Fmt.clock(t, xs < 60e3), x, H - 6);
    }

    // данные: делим на отрезки по разрывам
    const gap = this.step * 3.5;
    const segs = [];
    let cur = [];
    for (let i = 0; i < pts.length; i++) {
      if (cur.length && pts[i].t - pts[cur[cur.length - 1]].t > gap) { segs.push(cur); cur = []; }
      cur.push(i);
    }
    if (cur.length) segs.push(cur);

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT - 3, pw, ph + 3);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const seg of segs) {
      if (seg.length < 2) continue;
      for (let si = ser.length - 1; si >= 0; si--) {
        const color = C[ser[si].color] || C.s1;
        // заливка
        ctx.beginPath();
        seg.forEach((i, k) => {
          const x = X(pts[i].t), y = Y(vals[i][si]);
          k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        for (let k = seg.length - 1; k >= 0; k--) {
          const i = seg[k];
          const base = o.stacked && si > 0 ? vals[i][si - 1] : 0;
          ctx.lineTo(X(pts[i].t), Y(base));
        }
        ctx.closePath();
        ctx.globalAlpha = o.stacked ? 0.26 : 0.10;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      for (let si = 0; si < ser.length; si++) {
        const color = C[ser[si].color] || C.s1;
        ctx.beginPath();
        seg.forEach((i, k) => {
          const x = X(pts[i].t), y = Y(vals[i][si]);
          k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = o.stacked ? 1.5 : 2;
        ctx.stroke();
      }
    }
    ctx.restore();

    // перекрестие и подсказка
    if (this.hoverX == null || pts.length === 0 || this.hoverX < padL - 4 || this.hoverX > w - padR + 4) {
      this.tip.hidden = true;
      return;
    }
    const tHover = this.t0 + ((this.hoverX - padL) / pw) * span;
    let idx = lowerBound(pts, tHover);
    if (idx >= pts.length) idx = pts.length - 1;
    if (idx > 0 && Math.abs(pts[idx - 1].t - tHover) < Math.abs(pts[idx].t - tHover)) idx--;
    const p = pts[idx];
    if (Math.abs(p.t - tHover) > Math.max(gap, span / 40)) { this.tip.hidden = true; return; }
    const x = Math.round(X(p.t)) + 0.5;
    ctx.strokeStyle = C.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + ph);
    ctx.stroke();
    for (let si = 0; si < ser.length; si++) {
      const y = Y(vals[idx][si]);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = C[ser[si].color] || C.s1;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.surface;
      ctx.stroke();
    }

    const tip = this.tip;
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tip-t';
    const avg = !!p.a;
    const per = this.step >= 1800e3 ? 'за 30 минут' : this.step >= 300e3 ? 'за 5 минут' : 'за минуту';
    head.textContent = (span > 20 * 3600e3 ? Fmt.dateTime(p.t, !avg) : Fmt.clock(p.t, !avg)) + (avg ? ` · среднее ${per}` : '');
    tip.append(head);
    const rows = ser.map((s, si) => [s, raw[idx][si]]);
    for (const [s, v] of (o.stacked ? rows.slice().reverse() : rows)) {
      tip.append(tipRow(`var(--${s.color})`, o.fmt(v, p), s.label));
    }
    if (o.total) {
      const tr = tipRow(null, o.fmt(o.total(p), p), o.totalLabel || 'Всего');
      tr.classList.add('total');
      tip.append(tr);
    }
    if (o.extra) for (const [label, value] of o.extra(p)) tip.append(tipRow(null, value, label));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = x + 14;
    if (left + tw > w) left = x - tw - 14;
    tip.style.left = Math.max(0, left) + 'px';
  }
}

function tipRow(color, value, label) {
  const r = document.createElement('div');
  r.className = 'tip-r';
  const k = document.createElement('i');
  k.className = 'key line';
  if (color) k.style.background = color; else k.style.visibility = 'hidden';
  const b = document.createElement('b');
  b.textContent = value;
  const s = document.createElement('span');
  s.textContent = label;
  r.append(k, b, s);
  return r;
}

/* ---------- спарклайн ---------- */
function drawSpark(canvas, values, opts = {}) {
  const w = canvas.clientWidth, H = canvas.clientHeight;
  if (!w || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, H);
  const C = Theme.get();
  const color = C[opts.color || 's1'];
  if (opts.baseline !== false) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H - 0.5);
    ctx.lineTo(w, H - 0.5);
    ctx.stroke();
  }
  if (values.length < 2) return;
  const n = opts.slots || values.length;
  const max = opts.max || Math.max(1, ...values) * 1.1;
  const X = (i) => w - (values.length - 1 - i) * (w / Math.max(1, n - 1));
  const Y = (v) => 2 + (1 - Math.min(v, max) / max) * (H - 4);
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineTo(X(values.length - 1), H);
  ctx.lineTo(X(0), H);
  ctx.closePath();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

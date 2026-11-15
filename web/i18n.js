'use strict';
/* Два языка интерфейса. Ключ перевода — русская строка: L('Все серверы').
   Перевода нет — показываем русскую. Язык меняется с перезагрузкой страницы,
   поэтому L() можно звать где угодно, в том числе в константах модулей.
   Словарь — lang-en.js (заполняет I18N.dict). */
const I18N = { lang: 'ru', locale: 'ru-RU', dict: {} };
(function () {
  let l = null;
  try { l = localStorage.getItem('sp.lang'); } catch (e) { /* хранилище недоступно */ }
  if (l !== 'ru' && l !== 'en') l = /^(ru|be|uk|kk)\b/i.test(navigator.language || 'ru') ? 'ru' : 'en';
  I18N.lang = l;
  I18N.locale = l === 'ru' ? 'ru-RU' : 'en-GB';
  document.documentElement.lang = l;
})();

// L('Нет связи {0}', '3 ч') — {0}, {1}… подставляются после перевода
// Имя L, а не t: в коде много локальных переменных t (время, задание, шаблон).
function L(s, ...args) {
  let r = I18N.lang === 'ru' ? s : (I18N.dict[s] || s);
  if (args.length) r = r.replace(/\{(\d)\}/g, (m, i) => (args[i] == null ? '' : args[i]));
  return r;
}

// формы числа: tn(5, 'сервер', 'сервера', 'серверов'); в словаре ключ 'сервер|сервера|серверов' → 'server|servers'
function tn(n, one, few, many) {
  if (I18N.lang !== 'ru') {
    const e = I18N.dict[`${one}|${few}|${many}`];
    if (e) { const f = e.split('|'); return Math.abs(n) === 1 ? f[0] : f[1] || f[0]; }
  }
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// Язык хранится в браузере; панели он сообщается, чтобы ошибки и оповещения шли на нём же.
function setLang(l) {
  try { localStorage.setItem('sp.lang', l); } catch (e) { /* хранилище недоступно */ }
  syncLang(l).then(() => location.reload());
}
function syncLang(l) {
  return api('/lang', { method: 'PUT', body: { lang: l } }).catch(() => {});
}

// статичная разметка: data-i18n — текст элемента, data-i18n-attr="title aria-label" — атрибуты
function i18nStatic(root) {
  if (I18N.lang === 'ru') return;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = L(el.textContent.trim());
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const a of el.getAttribute('data-i18n-attr').split(/\s+/)) if (el.hasAttribute(a)) el.setAttribute(a, L(el.getAttribute(a)));
  }
}

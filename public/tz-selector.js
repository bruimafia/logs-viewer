// Селектор часового пояса (пункт 6.4 плана улучшений).
//
// Позволяет инженеру выбрать, в каком TZ отображать временны́е метки логов:
//   • «Локальное»  — браузерный часовой пояс (поведение по умолчанию);
//   • «UTC»        — всегда UTC+00:00;
//   • фиксированные смещения ("+03:00", "-05:00" и т.д.) — удобно, когда
//     серверы работают в другом поясе, а инженер — в своём.
//
// Выбор хранится в localStorage['tz-mode'] и восстанавливается при перезагрузке.
// При изменении вызывается render(), чтобы список логов перерисовался.
//
// Публичный API модуля:
//   getTzOffsetMinutes()      → null | number
//   getTzLabel()              → string   (для отладки/тестов)
//   attachTzSelectorHandlers()

import { dom } from './state.js';
import { render } from './render.js';

// ====================== Константы ======================

const LS_KEY = 'tz-mode';

// Список опций: значение хранится как строка в <select>.
// 'local' — браузерный пояс; остальные — смещение в минутах (целое число).
const TZ_OPTIONS = [
  { value: 'local',  label: 'Локальное' },
  { value: '0',      label: 'UTC' },
  { value: '60',     label: 'UTC+01:00' },
  { value: '120',    label: 'UTC+02:00' },
  { value: '180',    label: 'UTC+03:00' },
  { value: '270',    label: 'UTC+04:30' },
  { value: '300',    label: 'UTC+05:00' },
  { value: '330',    label: 'UTC+05:30' },
  { value: '360',    label: 'UTC+06:00' },
  { value: '420',    label: 'UTC+07:00' },
  { value: '480',    label: 'UTC+08:00' },
  { value: '540',    label: 'UTC+09:00' },
  { value: '600',    label: 'UTC+10:00' },
  { value: '720',    label: 'UTC+12:00' },
  { value: '-60',    label: 'UTC−01:00' },
  { value: '-120',   label: 'UTC−02:00' },
  { value: '-180',   label: 'UTC−03:00' },
  { value: '-240',   label: 'UTC−04:00' },
  { value: '-300',   label: 'UTC−05:00' },
  { value: '-360',   label: 'UTC−06:00' },
  { value: '-420',   label: 'UTC−07:00' },
  { value: '-480',   label: 'UTC−08:00' },
];

// ====================== Внутреннее состояние ======================

// Текущее значение: 'local' | строка-число-минут.
// Восстанавливается из localStorage в attachTzSelectorHandlers().
let _current = 'local';

// ====================== Публичный API ======================

/**
 * Возвращает текущее смещение часового пояса в минутах:
 *   null  — браузерный локальный пояс (formatTime/formatTimeFull
 *           используют Date методы без явного смещения);
 *   число — фиксированное смещение, например 180 для UTC+03:00,
 *           -300 для UTC−05:00, 0 для UTC.
 *
 * @returns {null|number}
 */
export function getTzOffsetMinutes() {
  if (_current === 'local') return null;
  const n = parseInt(_current, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Человекочитаемый ярлык текущего пояса (для тестов и отладки).
 * @returns {string}
 */
export function getTzLabel() {
  const opt = TZ_OPTIONS.find(o => o.value === _current);
  return opt ? opt.label : 'Локальное';
}

// ====================== Инициализация ======================

/**
 * Наполняет <select id="tzSelector"> опциями, восстанавливает выбор из
 * localStorage и подвешивает обработчик изменения.
 * Вызывается один раз из app.js.
 */
export function attachTzSelectorHandlers() {
  const sel = dom.tzSelector;
  if (!sel) return;

  // Наполнить опциями (делаем это в JS, а не в HTML — TZ_OPTIONS
  // является единственным источником истины).
  sel.innerHTML = '';
  for (const opt of TZ_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    sel.appendChild(el);
  }

  // Восстановить сохранённое значение.
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && TZ_OPTIONS.some(o => o.value === saved)) {
      _current = saved;
    }
  } catch (e) { /* Safari Private — игнорируем */ }

  // Синхронизировать <select> с текущим значением.
  sel.value = _current;

  // Если сохранённое значение совпадает с браузерным поясом — пометить
  // опцию «Локальное», чтобы пользователь видел, какой именно пояс за ней.
  _updateLocalOptionLabel(sel);

  sel.addEventListener('change', () => {
    _current = sel.value;
    try { localStorage.setItem(LS_KEY, _current); } catch (e) {}
    render();
  });
}

// ====================== Внутренние утилиты ======================

/**
 * Дописывает к ярлыку опции «Локальное» текущее UTC-смещение браузера,
 * например «Локальное (UTC+03:00)». Это помогает инженеру понять,
 * чем «Локальное» отличается от конкретного пояса в списке.
 */
function _updateLocalOptionLabel(sel) {
  const localOpt = sel.querySelector('option[value="local"]');
  if (!localOpt) return;
  const offsetMin = -new Date().getTimezoneOffset(); // инвертируем знак
  const sign  = offsetMin >= 0 ? '+' : '−';
  const abs   = Math.abs(offsetMin);
  const hh    = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm    = String(abs % 60).padStart(2, '0');
  localOpt.textContent = `Локальное (UTC${sign}${hh}:${mm})`;
}

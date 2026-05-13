// Чистые утилиты — без DOM и без зависимости от мутируемого состояния.
// Это позволяет импортировать модуль из Node-тестов (node:test) и
// проверять логику парсинга/фильтрации/сортировки без браузера.

/**
 * Имена JSON-полей, в которых ищем идентификатор трассы / запроса.
 * Порядок имеет значение — первое непустое значение побеждает.
 * Покрывает наиболее частые конвенции: camelCase, snake_case,
 * trace / request / correlation.
 */
export const DEFAULT_TRACE_FIELDS = [
  'traceId',
  'trace_id',
  'requestId',
  'request_id',
  'correlationId',
  'correlation_id'
];

/**
 * Экранирует строку для безопасной вставки в HTML.
 * В браузере — через textContent/innerHTML; в Node возвращаем сырую строку
 * (тесты эту функцию не трогают, но импорт модуля не должен падать).
 */
export function escapeHtml(s) {
  if (typeof document === 'undefined') {
    return s == null ? '' : String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

/**
 * Возвращает HTML-строку, в которой все вхождения подстроки `query`
 * в `text` (без учёта регистра) обёрнуты в `<mark class="search-match">`.
 *
 * И «фоновый» текст, и сами совпадения экранируются через escapeHtml,
 * поэтому результат безопасен для вставки через innerHTML.
 *
 * Совпадения не пересекаются: после каждого матча курсор сдвигается
 * на длину иголки. При пустом `query` или пустой иголке функция
 * вырождается в обычный escapeHtml.
 *
 * @param {string} text
 * @param {string} query
 * @returns {string}
 */
export function highlightMatch(text, query) {
  const str = text == null ? '' : String(text);
  if (!query) return escapeHtml(str);
  const needle = String(query).toLowerCase();
  if (!needle) return escapeHtml(str);

  const haystack = str.toLowerCase();
  const parts = [];
  let i = 0;
  while (i <= str.length) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) {
      parts.push(escapeHtml(str.slice(i)));
      break;
    }
    if (idx > i) parts.push(escapeHtml(str.slice(i, idx)));
    parts.push(
      `<mark class="search-match">${escapeHtml(str.slice(idx, idx + needle.length))}</mark>`
    );
    i = idx + needle.length;
  }
  return parts.join('');
}

/**
 * Возвращает идентификатор трассы из JSON-объекта лог-записи или пустую
 * строку, если ни одного из распознаваемых полей нет. Чистая функция,
 * без DOM, без зависимостей.
 *
 * Логика:
 *  - перебираем `fields` в порядке передачи (по умолчанию — `DEFAULT_TRACE_FIELDS`);
 *  - берём первое значение, которое не `null`/`undefined` и не пустая строка;
 *  - числовые значения преобразуются в строку (некоторые трейсеры пишут int64).
 *
 * Не считается trace-полем: массив, объект, булево значение `false`.
 *
 * @param {Object} obj
 * @param {string[]} [fields=DEFAULT_TRACE_FIELDS]
 * @returns {string}
 */
export function getTraceId(obj, fields = DEFAULT_TRACE_FIELDS) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  for (const f of fields) {
    const v = obj[f];
    if (v == null) continue;
    if (typeof v === 'string') {
      if (v) return v;
    } else if (typeof v === 'number') {
      // Не пропускаем 0, но и не делаем String(NaN)
      if (Number.isFinite(v)) return String(v);
    }
    // Объекты/массивы/булевы значения пропускаем — это явно не трейс.
  }
  return '';
}

/**
 * Возвращает стабильный CSS-цвет (HSL) по строке traceId.
 * Один и тот же traceId всегда даёт один и тот же цвет —
 * это позволяет визуально связать записи одной трассы.
 *
 * Лёгкая 32-битная хэш-функция, тестируемо в Node.
 *
 * @param {string} traceId
 * @returns {string} например, 'hsl(217, 60%, 55%)'
 */
export function traceIdColor(traceId) {
  const s = String(traceId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

/**
 * Сокращает длинный traceId до короткого представления для бейджа.
 * UUID/sha-id обычно длинные — показываем первые 8 символов + …
 *
 * @param {string} traceId
 * @returns {string}
 */
export function shortTraceId(traceId) {
  const s = String(traceId || '');
  if (s.length <= 10) return s;
  return s.slice(0, 8) + '…';
}

/**
 * Форматирует unix-миллисекунды в локализованную строку даты-времени.
 * В тестах вызывается с известным TZ, поэтому возвращаемый формат стабилен.
 */
export function formatTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium', hour12: false });
}

/**
 * Форматирует количество байт в человекочитаемом виде.
 */
export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '0 B';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Парсит одну строку лога в формате JSON Lines.
 * Возвращает обогащённый объект или null, если строка некорректна.
 *
 * Поля:
 *   _timeMs      — миллисекунды (для сортировки/фильтра)
 *   _sourceName  — имя источника без расширения
 *   _serviceKey  — service из JSON или sourceName
 *   _traceId     — извлечённый traceId/requestId/correlationId (или '')
 */
export function parseLogLine(line, sourceName) {
  if (line == null) return null;
  line = String(line).trim();
  if (!line) return null;
  try {
    const o = JSON.parse(line);
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
    const time = o.time ? new Date(o.time).getTime() : 0;
    const service = o.service || sourceName || 'unknown';
    return {
      ...o,
      _timeMs: Number.isNaN(time) ? 0 : time,
      _sourceName: sourceName,
      _serviceKey: service,
      _traceId: getTraceId(o)
    };
  } catch (_) {
    return null;
  }
}

/**
 * Применяет фильтры (поиск, уровни, временной диапазон, видимость сервисов,
 * активный traceId) к массиву логов. Не модифицирует исходный массив.
 *
 * @param {Array} logs            — исходные логи
 * @param {Object} filters
 * @param {string} filters.search          — подстрока (lowercase сравнение)
 * @param {string[]} filters.activeLevels  — допустимые уровни в UPPER-CASE
 * @param {?number} filters.fromMs         — нижняя граница времени (null = без)
 * @param {?number} filters.toMs           — верхняя граница времени (null = без)
 * @param {Object} filters.serviceVisibility — serviceKey → bool
 * @param {?string} filters.traceFilter    — если задан, оставляем только записи с этим _traceId
 */
export function applyFilters(logs, filters) {
  const { search, activeLevels, fromMs, toMs, serviceVisibility, traceFilter } = filters;
  let list = logs;

  if (search) {
    const needle = search.toLowerCase();
    list = list.filter(e => {
      const msg = (e.msg || '').toLowerCase();
      if (msg.includes(needle)) return true;
      return JSON.stringify(e).toLowerCase().includes(needle);
    });
  }
  if (activeLevels && activeLevels.length) {
    list = list.filter(e => activeLevels.includes((e.level || '').toUpperCase()));
  }
  if (fromMs != null) list = list.filter(e => e._timeMs >= fromMs);
  if (toMs != null) list = list.filter(e => e._timeMs <= toMs);
  if (serviceVisibility) {
    list = list.filter(e => serviceVisibility[e._serviceKey] !== false);
  }
  if (traceFilter) {
    list = list.filter(e => e._traceId === traceFilter);
  }
  return list;
}

/**
 * Возвращает новый массив, отсортированный по выбранному режиму.
 * Не модифицирует исходный.
 *
 * Режим `'trace'`: записи с одним и тем же `_traceId` идут подряд
 * (внутри группы — по времени по возрастанию). Группы упорядочены по
 * времени самой ранней записи. Записи без `_traceId` образуют каждая
 * собственную «группу из одной» и встраиваются между трассами по
 * своему времени (как обычная time-asc-сортировка для одиночных записей).
 *
 * @param {Array} logs
 * @param {'time-asc'|'time-desc'|'service'|'level'|'trace'} sortMode
 */
export function sortLogs(logs, sortMode) {
  const list = [...logs];
  if (sortMode === 'time-desc') {
    list.sort((a, b) => b._timeMs - a._timeMs);
  } else if (sortMode === 'time-asc') {
    list.sort((a, b) => a._timeMs - b._timeMs);
  } else if (sortMode === 'service') {
    list.sort((a, b) => (a._serviceKey || '').localeCompare(b._serviceKey || '') || a._timeMs - b._timeMs);
  } else if (sortMode === 'level') {
    const order = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
    list.sort((a, b) => (order[a.level] ?? 4) - (order[b.level] ?? 4) || a._timeMs - b._timeMs);
  } else if (sortMode === 'trace') {
    // Каждой записи присваиваем bucketKey: traceId, либо уникальный
    // псевдо-ключ — чтобы записи без traceId не сливались в одну группу.
    const groupMinTime = new Map();
    const keyOf = new Map();
    let anonCounter = 0;
    for (const e of list) {
      const key = e._traceId ? `t:${e._traceId}` : `a:${anonCounter++}`;
      keyOf.set(e, key);
      const cur = groupMinTime.get(key);
      if (cur === undefined || e._timeMs < cur) groupMinTime.set(key, e._timeMs);
    }
    list.sort((a, b) => {
      const ka = keyOf.get(a);
      const kb = keyOf.get(b);
      if (ka === kb) return a._timeMs - b._timeMs;
      const ma = groupMinTime.get(ka);
      const mb = groupMinTime.get(kb);
      if (ma !== mb) return ma - mb;
      // tie-break стабильный: лексикографически по ключу
      return ka < kb ? -1 : 1;
    });
  }
  return list;
}

/**
 * Возвращает { fromMs, toMs } для пресета быстрого диапазона относительно
 * момента `nowMs`. Чистая функция — без DOM и без Date.now() внутри, чтобы
 * её можно было детерминированно тестировать.
 *
 * Поддерживаемые пресеты:
 *   '5m', '15m', '1h', '6h', '24h', '7d'  — последние N от now
 *   'today'      — от полуночи сегодня (локально) до now
 *   'yesterday'  — от полуночи вчера до полуночи сегодня (локально)
 *
 * Неизвестный пресет → { fromMs: null, toMs: null }.
 *
 * @param {string} preset
 * @param {number} [nowMs] — текущий момент в мс. Если опущен, берётся Date.now().
 * @returns {{fromMs: ?number, toMs: ?number}}
 */
export function getQuickRange(preset, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  switch (preset) {
    case '5m':  return { fromMs: now - 5 * minute,  toMs: now };
    case '15m': return { fromMs: now - 15 * minute, toMs: now };
    case '1h':  return { fromMs: now - hour,        toMs: now };
    case '6h':  return { fromMs: now - 6 * hour,    toMs: now };
    case '24h': return { fromMs: now - day,         toMs: now };
    case '7d':  return { fromMs: now - 7 * day,     toMs: now };
    case 'today': {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      return { fromMs: midnight.getTime(), toMs: now };
    }
    case 'yesterday': {
      const todayMidnight = new Date(now);
      todayMidnight.setHours(0, 0, 0, 0);
      const yesterdayMidnight = new Date(todayMidnight);
      yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
      return { fromMs: yesterdayMidnight.getTime(), toMs: todayMidnight.getTime() };
    }
    default:
      return { fromMs: null, toMs: null };
  }
}

/**
 * Форматирует unix-миллисекунды в строку формата YYYY-MM-DDTHH:MM:SS
 * в ЛОКАЛЬНОМ часовом поясе — именно такой формат принимает
 * <input type="datetime-local" step="1"> для записи в .value.
 *
 * Date#toISOString() не подходит: он возвращает UTC, из-за чего в полях
 * фильтра пользователь увидел бы смещённое время.
 *
 * Возвращает '' для null/undefined/NaN.
 *
 * @param {?number} ms
 * @returns {string}
 */
export function msToDatetimeLocalValue(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Возвращает многострочную человекочитаемую полную форму временной метки —
 * предназначена для атрибута `title` (нативный tooltip) на колонке с временем
 * в строке лога. Пункт 6.3 плана улучшений.
 *
 * Формат — 4 строки:
 *   понедельник, 15 января 2024 г.
 *   10:30:45.123 (UTC+03:00)
 *   ISO: 2024-01-15T07:30:45.123Z
 *   5 минут назад
 *
 * Если ms некорректен/нулевой — возвращает пустую строку. Это позволяет
 * вызывающему коду не выставлять `title` для записей без времени
 * (`formatTime` в этом случае рисует прочерк, подсказка не нужна).
 *
 * @param {?number} ms
 * @param {?number} [nowMs] — момент «сейчас» для относительного времени.
 *   В тестах фиксируется; в проде по умолчанию `Date.now()`.
 * @returns {string}
 */
export function formatTimeFull(ms, nowMs) {
  if (ms == null || !Number.isFinite(ms) || ms === 0) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';

  // День недели + полная дата на русском. Используем явные компоненты,
  // а не dateStyle: 'full' — так формат стабилен и не зависит от того,
  // как пользователь переопределил locale-настройки в ОС.
  const dateStr = d.toLocaleString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  // Время с миллисекундами и смещением TZ — собираем сами, чтобы не
  // зависеть от locale-форматов (которые могут вставлять U+202F / NBSP
  // и ломать копипасту из подсказки).
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const hh  = pad(d.getHours());
  const mm  = pad(d.getMinutes());
  const ss  = pad(d.getSeconds());
  const mss = pad(d.getMilliseconds(), 3);
  // getTimezoneOffset() возвращает минуты с обратным знаком:
  // для UTC+3 → -180. Поэтому инвертируем.
  const tzMin  = -d.getTimezoneOffset();
  const tzSign = tzMin >= 0 ? '+' : '-';
  const tzAbs  = Math.abs(tzMin);
  const tzStr  = `UTC${tzSign}${pad(Math.floor(tzAbs / 60))}:${pad(tzAbs % 60)}`;
  const timeStr = `${hh}:${mm}:${ss}.${mss} (${tzStr})`;

  const isoStr = d.toISOString();
  const rel    = formatRelativeTime(ms, nowMs);

  return rel
    ? `${dateStr}\n${timeStr}\nISO: ${isoStr}\n${rel}`
    : `${dateStr}\n${timeStr}\nISO: ${isoStr}`;
}

/**
 * Относительное время вида «5 минут назад», «через 2 часа», «только что».
 * Берёт первую подходящую единицу (секунды → минуты → часы → дни).
 * Поддерживает русское склонение по правилам Mod10/Mod100.
 *
 * Чистая функция: nowMs можно передать явно — это нужно для тестов
 * и чтобы во всех частях одного рендера подставлялся один и тот же «сейчас».
 *
 * @param {?number} ms
 * @param {?number} [nowMs] — если опущен, берётся `Date.now()`.
 * @returns {string} — пустая строка, если ms некорректен.
 */
export function formatRelativeTime(ms, nowMs) {
  if (ms == null || !Number.isFinite(ms) || ms === 0) return '';
  const now    = nowMs == null ? Date.now() : nowMs;
  const diff   = now - ms;             // положителен — в прошлом
  const abs    = Math.abs(diff);
  const future = diff < 0;

  // Порог «только что» — 5 секунд в обе стороны, чтобы подсказка не дёргалась
  // каждую секунду на свежеприехавших live-записях.
  if (abs < 5_000) return future ? 'через мгновение' : 'только что';

  const sec  = Math.round(abs / 1_000);
  const min  = Math.round(abs / 60_000);
  const hour = Math.round(abs / 3_600_000);
  const day  = Math.round(abs / 86_400_000);

  let amount, unit;
  if (sec  < 60) { amount = sec;  unit = pluralRu(sec,  'секунду', 'секунды', 'секунд'); }
  else if (min  < 60) { amount = min;  unit = pluralRu(min,  'минуту',  'минуты',  'минут');  }
  else if (hour < 24) { amount = hour; unit = pluralRu(hour, 'час',     'часа',    'часов');  }
  else                { amount = day;  unit = pluralRu(day,  'день',    'дня',     'дней');   }

  return future ? `через ${amount} ${unit}` : `${amount} ${unit} назад`;
}

/**
 * Русская плюрализация (one/few/many) для числительных:
 *   1 минута, 2 минуты, 5 минут, 21 минута, 22 минуты, 25 минут
 * Внутренний хелпер — не экспортируется.
 */
function pluralRu(n, one, few, many) {
  const mod10  = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

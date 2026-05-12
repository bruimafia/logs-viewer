// Чистые утилиты — без DOM и без зависимости от мутируемого состояния.
// Это позволяет импортировать модуль из Node-тестов (node:test) и
// проверять логику парсинга/фильтрации/сортировки без браузера.

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
      _serviceKey: service
    };
  } catch (_) {
    return null;
  }
}

/**
 * Применяет фильтры (поиск, уровни, временной диапазон, видимость сервисов)
 * к массиву логов. Не модифицирует исходный массив.
 *
 * @param {Array} logs            — исходные логи
 * @param {Object} filters
 * @param {string} filters.search          — подстрока (lowercase сравнение)
 * @param {string[]} filters.activeLevels  — допустимые уровни в UPPER-CASE
 * @param {?number} filters.fromMs         — нижняя граница времени (null = без)
 * @param {?number} filters.toMs           — верхняя граница времени (null = без)
 * @param {Object} filters.serviceVisibility — serviceKey → bool
 */
export function applyFilters(logs, filters) {
  const { search, activeLevels, fromMs, toMs, serviceVisibility } = filters;
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
  return list;
}

/**
 * Возвращает новый массив, отсортированный по выбранному режиму.
 * Не модифицирует исходный.
 *
 * @param {Array} logs
 * @param {'time-asc'|'time-desc'|'service'|'level'} sortMode
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
  }
  return list;
}

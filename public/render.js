// Отрисовка списка логов, чипов сервисов, индикаторов и общий update UI.
// Зависит от state (state.allLogs, state.fileNames, …) и DOM (dom.*).

import { state, dom, LIVE_BUFFER_CAP, LIVE_RENDER_DEBOUNCE_MS, JAEGER_URL_TEMPLATE } from './state.js';
import {
  escapeHtml,
  highlightMatch,
  highlightJson,
  formatTime,
  formatTimeFull,
  parseLogLine,
  applyFilters,
  sortLogs,
  traceIdColor,
  shortTraceId,
  serviceColor,
  buildJaegerUrl
} from './utils.js';
import { renderSparkline, getSparklineTimeBounds } from './sparkline.js';
import { getTzOffsetMinutes } from './tz-selector.js';
import {
  initVirtualList,
  setItems as vlistSetItems,
  getScrollAnchor,
  scrollToAnchor
} from './virtual-list.js';

// ====================== Чипы сервисов ======================

function syncServiceChipsVisibility() {
  if (!dom.servicesFilter) return;
  dom.servicesFilter.querySelectorAll('.service-chip').forEach(chip => {
    const label = chip.querySelector('.service-label');
    const service = label ? label.textContent : '';
    if (service) chip.classList.toggle('hidden', !state.serviceVisibility[service]);
  });
}

function areAllServicesVisible() {
  const services = Object.keys(state.fileNames);
  if (!services.length) return true;
  return services.every(s => state.serviceVisibility[s] !== false);
}

function updateServicesToggleAllButton() {
  if (!dom.servicesToggleAllBtn) return;
  const services = Object.keys(state.fileNames);
  const hasServices = services.length > 0;
  const allVisible = hasServices && areAllServicesVisible();
  dom.servicesToggleAllBtn.disabled = !hasServices;
  dom.servicesToggleAllBtn.classList.toggle('show-all', hasServices && !allVisible);
  const label = allVisible ? 'Скрыть все сервисы' : 'Отобразить все сервисы';
  dom.servicesToggleAllBtn.title = label;
  dom.servicesToggleAllBtn.setAttribute('aria-label', label);
}

export function toggleAllServicesVisibility() {
  const services = Object.keys(state.fileNames);
  if (!services.length) return;
  const showAll = !areAllServicesVisible();
  state.soloServiceFilter = null;
  services.forEach(s => {
    state.serviceVisibility[s] = showAll;
  });
  syncServiceChipsVisibility();
  updateServicesToggleAllButton();
  render();
}

export function attachServicesToggleAllHandler() {
  if (!dom.servicesToggleAllBtn) return;
  dom.servicesToggleAllBtn.addEventListener('click', toggleAllServicesVisibility);
}

/**
 * Соло-фильтр по сервису (клик по .log-service). null — снять фильтр, все сервисы включены.
 */
export function setSoloServiceFilter(serviceKey) {
  const key = (serviceKey && String(serviceKey).trim()) || null;
  state.soloServiceFilter = key;
  Object.keys(state.fileNames).forEach(s => {
    state.serviceVisibility[s] = key ? s === key : true;
  });
  syncServiceChipsVisibility();
  render();
}

/**
 * Соло-фильтр по уровню (клик по .log-level). null — снять фильтр, все уровни включены.
 */
export function setSoloLevelFilter(levelKey) {
  const key = (levelKey && String(levelKey).trim().toUpperCase()) || null;
  state.soloLevelFilter = key;
  dom.levelChecks.forEach(cb => {
    cb.checked = key ? cb.value === key : true;
  });
  render();
}

export function buildServiceChips() {
  dom.servicesFilter.innerHTML = '';
  Object.keys(state.fileNames).sort().forEach(service => {
    const chip = document.createElement('span');
    chip.className = 'service-chip' + (state.serviceVisibility[service] ? '' : ' hidden');
    // Цвет сервиса передаётся в CSS как переменная.
    // Это позволяет правилам styles.css использовать color-mix() и автоматически
    // подстраиваться под тёмную/светлую тему: фон — лёгкий тинт, граница и текст —
    // того же цветового тона, но плотнее.
    chip.style.setProperty('--service-color', serviceColor(service));
    chip.title = 'Клик: скрыть/показать логи этого сервиса';

    const labelEl = document.createElement('span');
    labelEl.className = 'service-label';
    labelEl.textContent = service;

    chip.appendChild(labelEl);

    chip.addEventListener('click', () => {
      state.soloServiceFilter = null;
      state.serviceVisibility[service] = !state.serviceVisibility[service];
      chip.classList.toggle('hidden', !state.serviceVisibility[service]);
      render();
    });
    dom.servicesFilter.appendChild(chip);
  });
  state.lastChipServicesKey = Object.keys(state.fileNames).sort().join('|');
}

// Пересобирает чипы только если множество сервисов изменилось.
// Нужно для live-режима: новые сервисы появляются по ходу стриминга
// и render() должен отрисовать для них чипы.
function maybeRebuildChips() {
  const currentKey = Object.keys(state.fileNames).sort().join('|');
  if (currentKey !== state.lastChipServicesKey) {
    buildServiceChips();
  }
}

// ====================== Сводные индикаторы ======================

export function updateOpenFilesLabel() {
  const countEl = dom.openFilesLabel.querySelector('.open-files-count');
  const n = state.openedFiles.length;
  if (n === 0) {
    if (countEl) countEl.textContent = '';
    dom.openFilesLabel.title = 'Файлы не выбраны';
    dom.openFilesLabel.setAttribute('aria-label', 'Файлы не выбраны');
    dom.openFilesLabel.classList.remove('has-files');
  } else {
    if (countEl) countEl.textContent = n;
    dom.openFilesLabel.title = state.openedFiles.join('\n');
    dom.openFilesLabel.setAttribute('aria-label', `Открыто файлов: ${n}`);
    dom.openFilesLabel.classList.add('has-files');
  }
}

export function updateLoadMoreVisibility() {
  if (state.paginatedFiles.size > 0) {
    dom.loadMoreWrap.classList.add('visible');
    const filesArr = Array.from(state.paginatedFiles.values());
    const totalLoaded = filesArr.reduce((acc, f) => acc + f.totalLoaded, 0);
    const filesText = filesArr.length === 1 ? '1 файл' : `${filesArr.length} файлов`;
  } else {
    dom.loadMoreWrap.classList.remove('visible');
  }
}

// stopLiveStream приходит из sse-client.js через late-binding:
// updateLiveIndicator вызывается оттуда же и из render.js до того, как
// sse-client успеет проинициализироваться. Поэтому связь сделана через
// функцию-регистратор.
let stopLiveStreamFn = null;
export function setStopLiveStreamHandler(fn) { stopLiveStreamFn = fn; }

export function updateLiveIndicator() {
  // Если все live-потоки закончились естественным образом,
  // но пауза была включена (или в буфере что-то осталось) — применяем
  // буфер и сбрасываем флаг. Иначе индикатор спрячется (size === 0)
  // и нажать «Возобновить» будет нечем — буфер останется висеть в памяти.
  if (state.liveStreams.size === 0 &&
      (state.liveStreamPaused || state.livePausedBuffer.length > 0)) {
    let totalAdded = 0;
    for (const item of state.livePausedBuffer) {
      totalAdded += addLinesToLogs(item.lines, item.displayName, item.serverHost).length;
    }
    state.livePausedBuffer = [];
    state.liveStreamPaused = false;
    if (totalAdded > 0) {
      trimAllLogsIfNeeded();
      scheduleRender();
    }
  }

  if (state.liveStreams.size > 0) {
    dom.liveIndicator.classList.add('active');
    dom.liveCount.textContent = state.liveStreams.size;

    // Класс .paused и текст кнопки «Пауза»/«Возобновить».
    const paused = state.liveStreamPaused;
    dom.liveIndicator.classList.toggle('paused', paused);
    if (dom.pauseLiveBtn) {
      if (paused) {
        const bufferedCount = state.livePausedBuffer
          .reduce((sum, item) => sum + item.lines.length, 0);
        dom.pauseLiveBtn.textContent = bufferedCount > 0
          ? `▶ Возобновить (+${bufferedCount})`
          : '▶ Возобновить';
        dom.pauseLiveBtn.classList.add('resume');
        dom.pauseLiveBtn.title = bufferedCount > 0
          ? `Возобновить отображение (${bufferedCount} строк в буфере)`
          : 'Возобновить отображение';
      } else {
        dom.pauseLiveBtn.textContent = 'Пауза';
        dom.pauseLiveBtn.classList.remove('resume');
        dom.pauseLiveBtn.title = 'Поставить на паузу — отображение приостановится, приём строк продолжится';
      }
    }

    dom.liveStreamsList.innerHTML = Array.from(state.liveStreams.values()).map(s => `
      <div class="live-stream-item">
        <span class="live-stream-name" title="${escapeHtml(s.displayName)}">${escapeHtml(s.displayName)}</span>
        <button class="live-stream-stop" data-key="${s.serverId}::${s.fileId}">Стоп</button>
      </div>
    `).join('');
    dom.liveStreamsList.querySelectorAll('.live-stream-stop').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (stopLiveStreamFn) stopLiveStreamFn(btn.dataset.key);
      });
    });
  } else {
    dom.liveIndicator.classList.remove('active');
    dom.liveIndicator.classList.remove('paused');
    dom.liveStreamsList.classList.remove('visible');
  }
}

// ====================== Баннер активной trace-трассы ======================

/**
 * Устанавливает активный фильтр по traceId. Передача '' / null / undefined снимает фильтр.
 * Вызывается изнутри (клик по бейджу) и из app.js (Clear-кнопка, очистка
 * при загрузке новых файлов).
 */
export function setTraceFilter(traceId) {
  const next = (traceId && String(traceId).trim()) || null;
  const hadFilter = !!state.currentTraceFilter;
  const willHaveFilter = !!next;

  // Перед включением фильтра запоминаем, какая запись была у верхнего края viewport.
  if (!hadFilter && willHaveFilter) {
    state.traceFilterScrollAnchor = getScrollAnchor();
  }

  state.currentTraceFilter = next;
  render({ restoreTraceScrollAnchor: hadFilter && !willHaveFilter });
}

function updateTraceFilterBanner() {
  const tf = state.currentTraceFilter;
  const jaegerEl = dom.traceFilterJaegerLink;
  if (!dom.traceFilterBanner) return;
  if (tf) {
    dom.traceFilterBanner.style.display = '';
    if (dom.traceFilterValue) {
      dom.traceFilterValue.textContent = tf;
      dom.traceFilterValue.style.color = traceIdColor(tf);
      dom.traceFilterValue.title = tf;
    }

    // IP сервера для Jaeger — берём из первой записи с этим traceId в загруженных логах.
    let serverHost = '';
    for (const e of state.allLogs) {
      if (e._traceId === tf && e._serverHost) {
        serverHost = String(e._serverHost).trim();
        break;
      }
    }
    if (!serverHost && typeof window !== 'undefined' && window.location?.hostname) {
      serverHost = window.location.hostname;
    }

    const jaegerUrl = buildJaegerUrl(JAEGER_URL_TEMPLATE, serverHost, tf);
    if (jaegerEl) {
      if (jaegerUrl) {
        jaegerEl.href = jaegerUrl;
        jaegerEl.title = `Открыть трассу в Jaeger UI: ${jaegerUrl}`;
        jaegerEl.removeAttribute('hidden');
        jaegerEl.setAttribute('aria-hidden', 'false');
      } else {
        jaegerEl.removeAttribute('href');
        jaegerEl.setAttribute('hidden', '');
        jaegerEl.setAttribute('aria-hidden', 'true');
      }
    }
  } else {
    dom.traceFilterBanner.style.display = 'none';
    if (jaegerEl) {
      jaegerEl.removeAttribute('href');
      jaegerEl.setAttribute('hidden', '');
      jaegerEl.setAttribute('aria-hidden', 'true');
    }
  }
}

export function updateUI() {
  buildServiceChips();
  updateOpenFilesLabel();
  dom.clearAllBtn.style.display = state.openedFiles.length ? 'inline-flex' : 'none';
  updateLoadMoreVisibility();
  render();
}

// ====================== Скользящее окно для live ======================

export function trimAllLogsIfNeeded() {
  // Срабатывает только при активных live-потоках, чтобы не терять историю.
  if (state.liveStreams.size === 0) return;
  if (state.allLogs.length <= LIVE_BUFFER_CAP) return;
  state.allLogs.sort((a, b) => a._timeMs - b._timeMs);
  state.allLogs.splice(0, state.allLogs.length - LIVE_BUFFER_CAP);
}

// ====================== Построение строки (для виртуального списка) ======================

/**
 * Строит DOM-элемент строки лога.
 * Чистая функция — всегда возвращает новый элемент на основе данных.
 *
 * @param {Object} entry - запись лога
 * @param {number} idx - индекс в отфильтрованном списке (не используется здесь, но может быть полезен)
 * @param {string} search - поисковая строка для подсветки
 * @param {number} tz - смещение часового пояса в минутах
 * @returns {HTMLElement}
 */
function buildRowElement(entry, idx, search, tz) {
  const row = document.createElement('div');
  row.className = `log-entry level-${(entry.level || 'INFO').toUpperCase()}`;
  if (entry._traceId) row.dataset.trace = entry._traceId;

  const extra = { ...entry };
  delete extra._timeMs;
  delete extra._sourceName;
  delete extra._serviceKey;
  delete extra._fileName;
  delete extra._traceId;
  delete extra._serverHost;
  delete extra.time;
  delete extra.level;
  delete extra.msg;
  delete extra.service;
  delete extra.source;
  const extraKeys = Object.keys(extra).filter(k => extra[k] !== undefined && extra[k] !== '');

  // Бейдж traceId — отдельная колонка сетки (.log-trace), чтобы сообщения
  // не сдвигались, когда у соседних строк traceId есть или нет.
  let traceCellHtml = '<span class="log-trace"></span>';
  if (entry._traceId) {
    const tid = entry._traceId;
    const color = traceIdColor(tid);
    const short = shortTraceId(tid);
    const isActive = state.currentTraceFilter === tid;
    traceCellHtml = `<span class="log-trace"><button type="button" class="log-trace-badge${isActive ? ' active' : ''}" ` +
      `data-trace="${escapeHtml(tid)}" ` +
      `style="--trace-color:${color}" ` +
      `title="${isActive ? 'Снять фильтр по трассе' : 'Показать только эту трассу'}: ${escapeHtml(tid)}">` +
      `${escapeHtml(short)}</button></span>`;
  }

  // Цвет и иконка сервиса. Переменная
  // --service-color используется правилами styles.css для фона/границы/
  // цвета текста. Иконка идёт отдельным span'ом — это упрощает CSS-таргетинг.
  const lvl = (entry.level || 'INFO').toUpperCase();
  const isLvlActive = state.soloLevelFilter === lvl;

  const svc      = entry._serviceKey || '';
  const svcColor = serviceColor(svc);
  const isSvcActive = state.soloServiceFilter === svc;

  // Полная временная метка идёт в нативный tooltip (`title`) — день недели,
  // время с миллисекундами, таймзона, ISO 8601, «N минут назад».
  // formatTimeFull возвращает '' для нулевого/невалидного времени —
  // тогда атрибут попадёт пустым, и браузер подсказку не покажет.
  const timeFullTitle = formatTimeFull(entry._timeMs, undefined, tz);

  // Пустой .log-extra-slot держит колонку доп. полей, чтобы msg не сдвигался.
  const extraCellHtml = extraKeys.length ? `
      <details class="log-extra">
        <summary class="log-extra-toggle" title="Дополнительные поля (${extraKeys.length})">
          <span class="log-extra-icon" aria-hidden="true"></span>
          <span class="log-extra-count">${extraKeys.length}</span>
          <span class="sr-only">Дополнительные поля</span>
        </summary>
        <div class="log-extra-panel">
          <pre>${highlightJson(JSON.stringify(extra, null, 2), search)}</pre>
        </div>
      </details>
    ` : '<span class="log-extra-slot"></span>';

  row.innerHTML = `
    <span class="log-time"${timeFullTitle ? ` title="${escapeHtml(timeFullTitle)}"` : ''}>${formatTime(entry._timeMs, tz)}</span>
    <button type="button" class="log-level level-${lvl}${isLvlActive ? ' active' : ''}" data-level="${escapeHtml(lvl)}" title="${isLvlActive ? 'Снять фильтр по уровню' : 'Показать только этот уровень'}: ${escapeHtml(lvl)}">${escapeHtml(lvl)}</button>
    <button type="button" class="log-service${isSvcActive ? ' active' : ''}" data-service="${escapeHtml(svc)}" style="--service-color:${svcColor}" title="${isSvcActive ? 'Снять фильтр по сервису' : 'Показать только этот сервис'}: ${escapeHtml(svc)}"><span class="service-label">${escapeHtml(svc)}</span></button>
    ${traceCellHtml}
    ${extraCellHtml}
    <span class="log-msg">${highlightMatch(entry.msg || '', search)}</span>
  `;
  return row;
}

// Контекст для rowRenderer (search и tz меняются при каждом вызове render)
let currentSearchCtx = '';
let currentTzCtx = 0;

function rowRenderer(entry, idx) {
  return buildRowElement(entry, idx, currentSearchCtx, currentTzCtx);
}

// ====================== Добавление контента ======================

/**
 * Парсит строки и добавляет их в state.allLogs.
 *
 * @param {string[]} lines        — исходные строки лога (JSONL)
 * @param {string}   displayName  — человекочитаемое имя источника
 * @param {?string}  serverHost   — IP/хост сервера, с которого пришёл лог.
 *   Сохраняется в entry._serverHost — используется для ссылки Jaeger в баннере
 *   фильтра по трассе (см. JAEGER_URL_TEMPLATE в state.js). Если хост неизвестен (локальные файлы
 *   из браузера, удалённый сервер без host) — используем window.location.hostname
 *   как разумный fallback (типичный случай — Jaeger развёрнут на той же машине,
 *   что и просмотрщик логов).
 *
 * @returns {Array} массив добавленных записей (если ничего не добавилось — пустой).
 *   Раньше возвращалось число; перешли на массив, чтобы вызывающая сторона
 *   (sse-client.js → error-alerts.js) могла отфильтровать ERROR без повторного
 *   парсинга. Все существующие проверки `if (added > 0)` остаются валидными,
 *   если поменять имя переменной — `if (newEntries.length > 0)`.
 */
export function addLinesToLogs(lines, displayName, serverHost) {
  const name = displayName.replace(/\.(log|json)$/i, '');
  const host = (serverHost && String(serverHost).trim())
    || (typeof window !== 'undefined' && window.location && window.location.hostname)
    || '';
  const added = [];
  for (const line of lines) {
    const entry = parseLogLine(line, name);
    if (entry) {
      entry._fileName = displayName;
      entry._serverHost = host;
      state.allLogs.push(entry);
      const s = entry._serviceKey;
      if (!state.fileNames[s]) state.fileNames[s] = new Set();
      state.fileNames[s].add(displayName);
      added.push(entry);
    }
  }
  Object.keys(state.fileNames).forEach(s => {
    if (state.serviceVisibility[s] === undefined) {
      state.serviceVisibility[s] = state.soloServiceFilter ? s === state.soloServiceFilter : true;
    }
  });
  return added;
}

// ====================== Фильтрация и рендер ======================

// Считывает текущие значения фильтров с DOM и вызывает чистые функции.
function filterLogs() {
  const { fromMs: sparkFrom, toMs: sparkTo } = getSparklineTimeBounds();
  const manualFrom = dom.timeFrom.value ? new Date(dom.timeFrom.value).getTime() : null;
  const manualTo = dom.timeTo.value ? new Date(dom.timeTo.value).getTime() : null;
  const filters = {
    search: dom.searchInput.value.trim(),
    activeLevels: state.soloLevelFilter
      ? [state.soloLevelFilter]
      : dom.levelChecks.filter(cb => cb.checked).map(cb => cb.value),
    fromMs: manualFrom != null ? Math.max(manualFrom, sparkFrom) : sparkFrom,
    toMs: manualTo != null ? Math.min(manualTo, sparkTo) : sparkTo,
    serviceVisibility: state.serviceVisibility,
    // Передаем traceFilter как есть, без преобразования пустой строки в null
    traceFilter: state.currentTraceFilter
  };
  return sortLogs(applyFilters(state.allLogs, filters), dom.sortBy.value);
}

function isNearBottom() {
  return (dom.logListWrap.scrollHeight - dom.logListWrap.scrollTop - dom.logListWrap.clientHeight) < 100;
}
function isNearTop() {
  return dom.logListWrap.scrollTop < 100;
}

function isNewestAtBottom() {
  const sort = dom.sortBy.value;
  return sort === 'time-asc' || sort === 'service' || sort === 'level' || sort === 'trace';
}

/** Прокрутка к «текущему моменту» — к новейшим записям с учётом сортировки. */
function scrollToLatest() {
  const toBottom = isNewestAtBottom();
  const apply = () => {
    dom.logListWrap.scrollTop = toBottom ? dom.logListWrap.scrollHeight : 0;
  };
  apply();
  // Повтор после rAF: виртуальный список пересчитывает высоты строк асинхронно.
  requestAnimationFrame(apply);
}

export function render(options = {}) {
  // Пересобираем чипы сервисов, если множество изменилось (важно для live-режима).
  maybeRebuildChips();
  updateServicesToggleAllButton();
  // Обновляем баннер активной трассы.
  updateTraceFilterBanner();
  // Обновляем мини-спарклайн. Дроссель через rAF — несколько
  // вызовов подряд при live-batch + render схлопнутся в один кадр.
  renderSparkline();

  // Считываем поисковую строку один раз — она используется и в фильтре,
  // и для подсветки совпадений в результатах.
  const search = dom.searchInput.value.trim();
  const list = filterLogs();
  const trace = state.currentTraceFilter;
  const soloSvc = state.soloServiceFilter;
  const soloLvl = state.soloLevelFilter;
  if (trace) {
    dom.statsEl.textContent = `Трасса ${shortTraceId(trace)}: ${list.length} из ${state.allLogs.length}`;
  } else if (soloSvc) {
    dom.statsEl.textContent = `Сервис ${soloSvc}: ${list.length} из ${state.allLogs.length}`;
  } else if (soloLvl) {
    dom.statsEl.textContent = `Уровень ${soloLvl}: ${list.length} из ${state.allLogs.length}`;
  } else {
    dom.statsEl.textContent = list.length === state.allLogs.length
      ? `Записей: ${state.allLogs.length}`
      : `Показано: ${list.length} из ${state.allLogs.length}`;
  }

  if (!state.allLogs.length) {
    dom.emptyState.style.display = 'block';
    dom.noResultsState.style.display = 'none';
    vlistSetItems([]);
    return;
  }
  dom.emptyState.style.display = 'none';
  dom.noResultsState.style.display = list.length ? 'none' : 'block';
  if (!list.length) {
    vlistSetItems([]);
    return;
  }

  // Запоминаем позицию скролла до перерисовки (для авто-скролла в live)
  const wasNearBottom = isNearBottom();
  const wasNearTop = isNearTop();

  // Обновляем контекст для rowRenderer
  currentSearchCtx = search;
  currentTzCtx = getTzOffsetMinutes();

  // Передаём список в виртуальный скролл
  vlistSetItems(list);

  // Возврат к прежней позиции после снятия trace-фильтра.
  if (options.restoreTraceScrollAnchor && state.traceFilterScrollAnchor) {
    scrollToAnchor(state.traceFilterScrollAnchor, list);
    state.traceFilterScrollAnchor = null;
  } else if (options.scrollToLatest) {
    state.userScrolledAway = false;
    scrollToLatest();
  } else if (state.liveStreams.size > 0 && !state.userScrolledAway) {
    // Авто-скролл в live-режиме
    if (isNewestAtBottom() && wasNearBottom) {
      dom.logListWrap.scrollTop = dom.logListWrap.scrollHeight;
    } else if (!isNewestAtBottom() && wasNearTop) {
      dom.logListWrap.scrollTop = 0;
    }
  }
}

export function scheduleRender() {
  if (state.renderTimeout) return;
  state.renderTimeout = setTimeout(() => {
    state.renderTimeout = null;
    render();
  }, LIVE_RENDER_DEBOUNCE_MS);
}

// Привязываем обработчик скролла к контейнеру (вызывается из app.js один раз)
export function attachScrollHandler() {
  dom.logListWrap.addEventListener('scroll', () => {
    // Любая ручная прокрутка отключает авто-скролл, пока пользователь не вернётся к краю.
    if (state.liveStreams.size === 0) return;
    const sort = dom.sortBy.value;
    const newestAtBottom = (sort === 'time-asc' || sort === 'service' || sort === 'level' || sort === 'trace');
    state.userScrolledAway = newestAtBottom ? !isNearBottom() : !isNearTop();
  });
}

// Инициализация виртуального списка (вызывается из app.js один раз)
export function initializeVirtualList() {
  initVirtualList({ rowRenderer });
}

// Делегирование клика по бейджу traceId и по сервису в строке. Список
// перерисовывается часто (live-режим), поэтому удобнее один обработчик на контейнер.
export function attachTraceBadgeHandler() {
  dom.logList.addEventListener('click', (e) => {
    const badge = e.target.closest && e.target.closest('.log-trace-badge');
    if (badge) {
      e.preventDefault();
      e.stopPropagation();
      const trace = badge.dataset.trace || '';
      // Повторный клик по уже активной трассе — снимает фильтр.
      if (state.currentTraceFilter === trace) {
        setTraceFilter(null);
      } else {
        setTraceFilter(trace);
      }
      return;
    }

    const lvlBtn = e.target.closest && e.target.closest('.log-level');
    if (lvlBtn) {
      e.preventDefault();
      e.stopPropagation();
      const level = lvlBtn.dataset.level || '';
      if (state.soloLevelFilter === level) {
        setSoloLevelFilter(null);
      } else {
        setSoloLevelFilter(level);
      }
      return;
    }

    const svcBtn = e.target.closest && e.target.closest('.log-service');
    if (!svcBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const service = svcBtn.dataset.service || '';
    if (state.soloServiceFilter === service) {
      setSoloServiceFilter(null);
    } else {
      setSoloServiceFilter(service);
    }
  });

  if (dom.traceFilterClear) {
    dom.traceFilterClear.addEventListener('click', () => setTraceFilter(null));
  }
}

// Отрисовка списка логов, чипов сервисов, индикаторов и общий update UI.
// Зависит от state (state.allLogs, state.fileNames, …) и DOM (dom.*).

import { state, dom, LIVE_BUFFER_CAP, LIVE_RENDER_DEBOUNCE_MS } from './state.js';
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
  serviceIcon
} from './utils.js';
import { renderSparkline } from './sparkline.js';

// ====================== Чипы сервисов ======================

export function buildServiceChips() {
  dom.servicesFilter.innerHTML = '';
  Object.keys(state.fileNames).sort().forEach(service => {
    const chip = document.createElement('span');
    chip.className = 'service-chip' + (state.serviceVisibility[service] ? '' : ' hidden');
    // Цвет сервиса передаётся в CSS как переменная (пункт 6.5 плана улучшений).
    // Это позволяет правилам styles.css использовать color-mix() и автоматически
    // подстраиваться под тёмную/светлую тему: фон — лёгкий тинт, граница и текст —
    // того же цветового тона, но плотнее.
    chip.style.setProperty('--service-color', serviceColor(service));
    chip.title = 'Клик: скрыть/показать логи этого сервиса';

    // Иконку и подпись делаем отдельными span'ами — это позволяет CSS управлять
    // их цветом независимо (например, гасить иконку на скрытом чипе сильнее, чем
    // текст). Иконка скрыта от скринридеров — это чисто визуальный маркер.
    const iconEl = document.createElement('span');
    iconEl.className = 'service-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = serviceIcon(service);

    const labelEl = document.createElement('span');
    labelEl.className = 'service-label';
    labelEl.textContent = service;

    chip.appendChild(iconEl);
    chip.appendChild(labelEl);

    chip.addEventListener('click', () => {
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
  if (state.openedFiles.length === 0) {
    dom.openFilesLabel.textContent = 'Файлы не выбраны';
    dom.openFilesLabel.title = '';
  } else {
    dom.openFilesLabel.textContent = state.openedFiles.join(', ');
    dom.openFilesLabel.title = state.openedFiles.join('\n');
  }
}

export function updateLoadMoreVisibility() {
  if (state.paginatedFiles.size > 0) {
    dom.loadMoreWrap.classList.add('visible');
    const filesArr = Array.from(state.paginatedFiles.values());
    const totalLoaded = filesArr.reduce((acc, f) => acc + f.totalLoaded, 0);
    const filesText = filesArr.length === 1 ? '1 файл' : `${filesArr.length} файлов`;
    dom.loadMoreInfo.textContent = `(загружено ${totalLoaded} строк из ${filesText})`;
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
  // Пункт 3.1: если все live-потоки закончились естественным образом,
  // но пауза была включена (или в буфере что-то осталось) — применяем
  // буфер и сбрасываем флаг. Иначе индикатор спрячется (size === 0)
  // и нажать «Возобновить» будет нечем — буфер останется висеть в памяти.
  if (state.liveStreams.size === 0 &&
      (state.liveStreamPaused || state.livePausedBuffer.length > 0)) {
    let totalAdded = 0;
    for (const item of state.livePausedBuffer) {
      totalAdded += addLinesToLogs(item.lines, item.displayName).length;
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

    // Пункт 3.1: класс .paused и текст кнопки «Пауза»/«Возобновить».
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
 * Устанавливает активный фильтр по traceId. Передача '' / null снимает фильтр.
 * Вызывается изнутри (клик по бейджу) и из app.js (Clear-кнопка, очистка
 * при загрузке новых файлов).
 */
export function setTraceFilter(traceId) {
  state.currentTraceFilter = traceId || null;
  render();
}

function updateTraceFilterBanner() {
  const tf = state.currentTraceFilter;
  if (!dom.traceFilterBanner) return;
  if (tf) {
    dom.traceFilterBanner.style.display = '';
    if (dom.traceFilterValue) {
      dom.traceFilterValue.textContent = tf;
      dom.traceFilterValue.style.color = traceIdColor(tf);
      dom.traceFilterValue.title = tf;
    }
  } else {
    dom.traceFilterBanner.style.display = 'none';
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

// ====================== Добавление контента ======================

/**
 * Парсит строки и добавляет их в state.allLogs.
 *
 * @returns {Array} массив добавленных записей (если ничего не добавилось — пустой).
 *   Раньше возвращалось число; перешли на массив, чтобы вызывающая сторона
 *   (sse-client.js → error-alerts.js) могла отфильтровать ERROR без повторного
 *   парсинга. Все существующие проверки `if (added > 0)` остаются валидными,
 *   если поменять имя переменной — `if (newEntries.length > 0)`.
 */
export function addLinesToLogs(lines, displayName) {
  const name = displayName.replace(/\.(log|json)$/i, '');
  const added = [];
  for (const line of lines) {
    const entry = parseLogLine(line, name);
    if (entry) {
      entry._fileName = displayName;
      state.allLogs.push(entry);
      const s = entry._serviceKey;
      if (!state.fileNames[s]) state.fileNames[s] = new Set();
      state.fileNames[s].add(displayName);
      added.push(entry);
    }
  }
  Object.keys(state.fileNames).forEach(s => {
    if (state.serviceVisibility[s] === undefined) state.serviceVisibility[s] = true;
  });
  return added;
}

// ====================== Фильтрация и рендер ======================

// Считывает текущие значения фильтров с DOM и вызывает чистые функции.
function filterLogs() {
  const filters = {
    search: dom.searchInput.value.trim(),
    activeLevels: dom.levelChecks.filter(cb => cb.checked).map(cb => cb.value),
    fromMs: dom.timeFrom.value ? new Date(dom.timeFrom.value).getTime() : null,
    toMs: dom.timeTo.value ? new Date(dom.timeTo.value).getTime() : null,
    serviceVisibility: state.serviceVisibility,
    traceFilter: state.currentTraceFilter || null
  };
  return sortLogs(applyFilters(state.allLogs, filters), dom.sortBy.value);
}

function isNearBottom() {
  return (dom.logListWrap.scrollHeight - dom.logListWrap.scrollTop - dom.logListWrap.clientHeight) < 100;
}
function isNearTop() {
  return dom.logListWrap.scrollTop < 100;
}

export function render() {
  // Пересобираем чипы сервисов, если множество изменилось (важно для live-режима).
  maybeRebuildChips();
  // Обновляем баннер активной трассы.
  updateTraceFilterBanner();
  // Обновляем мини-спарклайн (пункт 3.4). Дроссель через rAF — несколько
  // вызовов подряд при live-batch + render схлопнутся в один кадр.
  renderSparkline();

  // Считываем поисковую строку один раз — она используется и в фильтре,
  // и для подсветки совпадений в результатах.
  const search = dom.searchInput.value.trim();
  const list = filterLogs();
  const trace = state.currentTraceFilter;
  if (trace) {
    dom.statsEl.textContent = `Трасса ${shortTraceId(trace)}: ${list.length} из ${state.allLogs.length}`;
  } else {
    dom.statsEl.textContent = list.length === state.allLogs.length
      ? `Записей: ${state.allLogs.length}`
      : `Показано: ${list.length} из ${state.allLogs.length}`;
  }

  if (!state.allLogs.length) {
    dom.emptyState.style.display = 'block';
    dom.noResultsState.style.display = 'none';
    dom.logList.querySelectorAll('.log-entry').forEach(n => n.remove());
    return;
  }
  dom.emptyState.style.display = 'none';
  dom.noResultsState.style.display = list.length ? 'none' : 'block';
  if (!list.length) {
    dom.logList.querySelectorAll('.log-entry').forEach(n => n.remove());
    return;
  }

  // Запоминаем позицию скролла до перерисовки (для авто-скролла в live)
  const wasNearBottom = isNearBottom();
  const wasNearTop = isNearTop();

  const fragment = document.createDocumentFragment();
  list.forEach(entry => {
    const row = document.createElement('div');
    row.className = `log-entry level-${(entry.level || 'INFO').toUpperCase()}`;
    if (entry._traceId) row.dataset.trace = entry._traceId;

    const extra = { ...entry };
    delete extra._timeMs;
    delete extra._sourceName;
    delete extra._serviceKey;
    delete extra._fileName;
    delete extra._traceId;
    delete extra.time;
    delete extra.level;
    delete extra.msg;
    delete extra.service;
    delete extra.source;
    const extraKeys = Object.keys(extra).filter(k => extra[k] !== undefined && extra[k] !== '');

    // Бейдж traceId: кликабельный, окрашен стабильным цветом по хэшу.
    // Если уже идёт фильтрация по этой же трассе — у бейджа класс .active.
    let traceBadgeHtml = '';
    if (entry._traceId) {
      const tid = entry._traceId;
      const color = traceIdColor(tid);
      const short = shortTraceId(tid);
      const isActive = state.currentTraceFilter === tid;
      traceBadgeHtml = `<button type="button" class="log-trace-badge${isActive ? ' active' : ''}" ` +
        `data-trace="${escapeHtml(tid)}" ` +
        `style="--trace-color:${color}" ` +
        `title="${isActive ? 'Снять фильтр по трассе' : 'Показать только эту трассу'}: ${escapeHtml(tid)}">` +
        `${escapeHtml(short)}</button> `;
    }

    // Цвет и иконка сервиса (пункт 6.5 плана улучшений). Переменная
    // --service-color используется правилами styles.css для фона/границы/
    // цвета текста. Иконка идёт отдельным span'ом — это упрощает CSS-таргетинг.
    const svc      = entry._serviceKey || '';
    const svcColor = serviceColor(svc);
    const svcIcon  = serviceIcon(svc);

    // Полная временная метка идёт в нативный tooltip (`title`) — день недели,
    // время с миллисекундами, таймзона, ISO 8601, «N минут назад». Пункт 6.3.
    // formatTimeFull возвращает '' для нулевого/невалидного времени —
    // тогда атрибут попадёт пустым, и браузер подсказку не покажет.
    const timeFullTitle = formatTimeFull(entry._timeMs);
    row.innerHTML = `
      <span class="log-time"${timeFullTitle ? ` title="${escapeHtml(timeFullTitle)}"` : ''}>${formatTime(entry._timeMs)}</span>
      <span class="log-level level-${(entry.level || 'INFO').toUpperCase()}">${(entry.level || 'INFO').toUpperCase()}</span>
      <span class="log-service" style="--service-color:${svcColor}" title="Сервис: ${escapeHtml(svc)}"><span class="service-icon" aria-hidden="true">${escapeHtml(svcIcon)}</span><span class="service-label">${escapeHtml(svc)}</span></span>
      <span class="log-msg">${traceBadgeHtml}${highlightMatch(entry.msg || '', search)}</span>
      ${extraKeys.length ? `
        <div class="log-extra">
          <details>
            <summary>Доп. поля (${extraKeys.length})</summary>
            <pre>${highlightJson(JSON.stringify(extra, null, 2), search)}</pre>
          </details>
        </div>
      ` : ''}
    `;
    fragment.appendChild(row);
  });

  dom.logList.querySelectorAll('.log-entry').forEach(n => n.remove());
  dom.logList.appendChild(fragment);

  // Авто-скролл в live-режиме
  if (state.liveStreams.size > 0 && !state.userScrolledAway) {
    const sort = dom.sortBy.value;
    const newestAtBottom = (sort === 'time-asc' || sort === 'service' || sort === 'level' || sort === 'trace');
    if (newestAtBottom && wasNearBottom) {
      dom.logListWrap.scrollTop = dom.logListWrap.scrollHeight;
    } else if (!newestAtBottom && wasNearTop) {
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

// Делегирование клика по бейджу traceId. Список перерисовывается часто
// (live-режим), поэтому удобнее повесить один обработчик на контейнер.
export function attachTraceBadgeHandler() {
  dom.logList.addEventListener('click', (e) => {
    const badge = e.target.closest && e.target.closest('.log-trace-badge');
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    const trace = badge.dataset.trace || '';
    // Повторный клик по уже активной трассе — снимает фильтр.
    if (state.currentTraceFilter === trace) {
      setTraceFilter(null);
    } else {
      setTraceFilter(trace);
    }
  });

  if (dom.traceFilterClear) {
    dom.traceFilterClear.addEventListener('click', () => setTraceFilter(null));
  }
}

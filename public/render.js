// Отрисовка списка логов, чипов сервисов, индикаторов и общий update UI.
// Зависит от state (state.allLogs, state.fileNames, …) и DOM (dom.*).

import { state, dom, LIVE_BUFFER_CAP, LIVE_RENDER_DEBOUNCE_MS } from './state.js';
import { escapeHtml, highlightMatch, formatTime, parseLogLine, applyFilters, sortLogs } from './utils.js';

// ====================== Чипы сервисов ======================

export function buildServiceChips() {
  dom.servicesFilter.innerHTML = '';
  Object.keys(state.fileNames).sort().forEach(service => {
    const chip = document.createElement('span');
    chip.className = 'service-chip' + (state.serviceVisibility[service] ? '' : ' hidden');
    chip.textContent = service;
    chip.title = 'Клик: скрыть/показать логи этого сервиса';
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
  if (state.liveStreams.size > 0) {
    dom.liveIndicator.classList.add('active');
    dom.liveCount.textContent = state.liveStreams.size;
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
    dom.liveStreamsList.classList.remove('visible');
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

export function addLinesToLogs(lines, displayName) {
  const name = displayName.replace(/\.(log|json)$/i, '');
  let added = 0;
  for (const line of lines) {
    const entry = parseLogLine(line, name);
    if (entry) {
      entry._fileName = displayName;
      state.allLogs.push(entry);
      const s = entry._serviceKey;
      if (!state.fileNames[s]) state.fileNames[s] = new Set();
      state.fileNames[s].add(displayName);
      added++;
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
    serviceVisibility: state.serviceVisibility
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
  // Считываем поисковую строку один раз — она используется и в фильтре,
  // и для подсветки совпадений в результатах.
  const search = dom.searchInput.value.trim();
  const list = filterLogs();
  dom.statsEl.textContent = list.length === state.allLogs.length
    ? `Записей: ${state.allLogs.length}`
    : `Показано: ${list.length} из ${state.allLogs.length}`;

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
    const extra = { ...entry };
    delete extra._timeMs;
    delete extra._sourceName;
    delete extra._serviceKey;
    delete extra._fileName;
    delete extra.time;
    delete extra.level;
    delete extra.msg;
    delete extra.service;
    delete extra.source;
    const extraKeys = Object.keys(extra).filter(k => extra[k] !== undefined && extra[k] !== '');
    row.innerHTML = `
      <span class="log-time">${formatTime(entry._timeMs)}</span>
      <span class="log-level level-${(entry.level || 'INFO').toUpperCase()}">${(entry.level || 'INFO').toUpperCase()}</span>
      <span class="log-service">${escapeHtml(entry._serviceKey || '')}</span>
      <span class="log-msg">${highlightMatch(entry.msg || '', search)}</span>
      ${extraKeys.length ? `
        <div class="log-extra">
          <details>
            <summary>Доп. поля (${extraKeys.length})</summary>
            <pre>${highlightMatch(JSON.stringify(extra, null, 2), search)}</pre>
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
    const newestAtBottom = (sort === 'time-asc' || sort === 'service' || sort === 'level');
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
    const newestAtBottom = (sort === 'time-asc' || sort === 'service' || sort === 'level');
    state.userScrolledAway = newestAtBottom ? !isNearBottom() : !isNearTop();
  });
}

// SSE-парсер, режимы загрузки (Tail / Range / Live), баннер подключения
// live-потоков, прогресс-индикатор.

import { state, dom } from './state.js';
import { escapeHtml, formatBytes } from './utils.js';
import { addLinesToLogs, trimAllLogsIfNeeded, scheduleRender, updateUI, updateLiveIndicator, setStopLiveStreamHandler } from './render.js';
import { toast } from './toast.js';
import { handleNewLiveEntries } from './error-alerts.js';

// ====================== Парсер SSE ======================

export function createSSEParser(handlers) {
  let buffer = '';
  let currentEvent = null;
  let currentData = null;

  return {
    feed(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('event: ')) { currentEvent = line.substring(7); }
        else if (line.startsWith('data: ')) { currentData = line.substring(6); }
        else if (line === '') {
          if (currentEvent && currentData !== null) {
            try {
              const data = JSON.parse(currentData);
              if (handlers[currentEvent]) handlers[currentEvent](data);
            } catch (e) { console.error('SSE parse error:', e, currentData); }
          }
          currentEvent = null;
          currentData = null;
        }
      }
    }
  };
}

export async function streamSSE(url, body, handlers, abortSignal) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abortSignal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser(handlers);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
}

// ====================== Прогресс-индикатор ======================

export function createProgressContainer() {
  const c = document.createElement('div');
  c.className = 'stream-progress';
  c.innerHTML = `
    <div class="stream-file-name">Подготовка...</div>
    <div class="stream-progress-bar"><div class="stream-progress-fill" style="width: 0%"></div></div>
    <div class="stream-progress-text">
      <span class="progress-status">Подключение...</span>
      <span class="progress-bytes"></span>
    </div>
  `;
  const modalBody = dom.remoteModalBody;
  if (modalBody) modalBody.insertBefore(c, modalBody.firstChild);
  return c;
}

export function updateProgress(container, fileName, status, percent, indeterminate, bytesText) {
  const fileEl = container.querySelector('.stream-file-name');
  const fillEl = container.querySelector('.stream-progress-fill');
  const statusEl = container.querySelector('.progress-status');
  const bytesEl = container.querySelector('.progress-bytes');
  if (fileEl) fileEl.textContent = fileName;
  if (statusEl) statusEl.textContent = status;
  if (bytesEl) bytesEl.textContent = bytesText || '';
  if (fillEl) {
    if (indeterminate) { fillEl.classList.add('indeterminate'); fillEl.style.width = '30%'; }
    else { fillEl.classList.remove('indeterminate'); fillEl.style.width = `${percent || 0}%`; }
  }
}

/**
 * Читает опции серверного grep-фильтра из модалки (пункт 5.3).
 */
function getGrepOptions() {
  const patternEl = document.getElementById('remoteGrepPattern');
  const pattern = patternEl ? patternEl.value.trim() : '';
  if (!pattern) return {};
  const regexEl = document.getElementById('remoteGrepRegex');
  const caseEl = document.getElementById('remoteGrepCaseInsensitive');
  return { grepPattern: pattern, grepRegex: !!(regexEl && regexEl.checked), grepCaseInsensitive: !!(caseEl && caseEl.checked) };
}

/**
 * Читает фильтр по уровням из UI тулбара (пункт 5.2).
 * @returns {string[]} - Массив уровней для серверной фильтрации
 */
function getLevelFilter() {
  const levels = [];
  if (document.getElementById('levelError')?.checked) levels.push('ERROR');
  if (document.getElementById('levelWarn')?.checked) levels.push('WARN');
  if (document.getElementById('levelInfo')?.checked) levels.push('INFO');
  if (document.getElementById('levelDebug')?.checked) levels.push('DEBUG');
  return levels;
}

// ====================== Режим 1: Tail с пагинацией ======================

export async function loadTailMode(filesToLoad) {
  const linesNum = parseInt(document.getElementById('tailLines').value) || 1000;
  const grepOptions = getGrepOptions();
  const progressContainer = createProgressContainer();
  const isAppend = dom.appendModeCheckbox.checked;

  if (!isAppend) { stopAllLive(); resetAllLogs(); }

  let successCount = 0;
  let errorCount = 0;

  for (const fileInfo of filesToLoad) {
    const key = `${fileInfo.serverId}::${fileInfo.fileId}`;
    const displayName = `[${fileInfo.server.name}] ${fileInfo.file.name}`;
    const collectedLines = [];

    updateProgress(progressContainer, displayName, 'Загрузка хвоста...', null, true);

    try {
      await streamSSE('/api/tail-file', { serverId: fileInfo.serverId, fileId: fileInfo.fileId, lines: linesNum, offsetLines: 0, ...grepOptions }, {
        start: (data) => { updateProgress(progressContainer, displayName, `Чтение последних ${data.lines} строк...`, null, true); },
        lines: (data) => { for (const l of data.lines) collectedLines.push(l); updateProgress(progressContainer, displayName, `Получено строк: ${collectedLines.length}`, null, true); },
        error: (data) => { throw new Error(data.message); },
        complete: () => {}
      });

      if (!state.openedFiles.includes(displayName)) state.openedFiles.push(displayName);
      const added = addLinesToLogs(collectedLines, displayName);

      state.paginatedFiles.set(key, { serverId: fileInfo.serverId, fileId: fileInfo.fileId, displayName, server: fileInfo.server, file: fileInfo.file, currentOffset: linesNum, pageSize: linesNum, totalLoaded: added, grepOptions });
      successCount++;
    } catch (err) { console.error(`Ошибка загрузки ${displayName}:`, err); errorCount++; }
  }

  state.allLogs.sort((a, b) => a._timeMs - b._timeMs);
  updateUI();
  progressContainer.remove();

  if (errorCount > 0) { toast.error(`Загружено: ${successCount}, ошибок: ${errorCount}.\nПодробности в консоли.`, { title: 'Ошибка загрузки хвоста' }); }
}

export async function loadMorePages() {
  if (state.paginatedFiles.size === 0) return;
  dom.loadMoreBtn.disabled = true;
  const originalHtml = dom.loadMoreBtn.innerHTML;
  dom.loadMoreBtn.innerHTML = '<span class="loading-spinner"></span> Загрузка...';

  const filesArr = Array.from(state.paginatedFiles.values());
  let totalAdded = 0;
  let errors = [];

  for (const pf of filesArr) {
    try {
      const collectedLines = [];
      await streamSSE('/api/tail-file', { serverId: pf.serverId, fileId: pf.fileId, lines: pf.pageSize, offsetLines: pf.currentOffset, ...(pf.grepOptions || {}) }, {
        start: () => {},
        lines: (data) => { for (const l of data.lines) collectedLines.push(l); },
        error: (data) => { throw new Error(data.message); },
        complete: () => {}
      });
      const added = addLinesToLogs(collectedLines, pf.displayName);
      pf.currentOffset += pf.pageSize;
      pf.totalLoaded += added;
      totalAdded += added;
    } catch (err) { console.error(`Ошибка пагинации ${pf.displayName}:`, err); errors.push(`${pf.displayName}: ${err.message}`); }
  }

  state.allLogs.sort((a, b) => a._timeMs - b._timeMs);
  updateUI();
  dom.loadMoreBtn.innerHTML = originalHtml;
  dom.loadMoreBtn.disabled = false;

  if (errors.length > 0) { toast.error('Ошибки при загрузке:\n' + errors.join('\n'), { title: 'Не удалось подгрузить страницу' }); }
  else if (totalAdded === 0) { toast.info('Новых строк не получено — вероятно, достигнуто начало файла.', { title: 'Конец файла' }); }
}

// ====================== Режим 2: Диапазон дат ======================
// Пункт 5.2: Серверная фильтрация по уровню

export async function loadRangeMode(filesToLoad) {
  const dateFromEl = document.getElementById('remoteDateFrom');
  const dateToEl = document.getElementById('remoteDateTo');
  const dateRange = { dateFrom: dateFromEl?.value || null, dateTo: dateToEl?.value || null };
  const grepOptions = getGrepOptions();
  
  // Серверная фильтрация по уровню (пункт 5.2)
  const levels = getLevelFilter();

  const progressContainer = createProgressContainer();
  const isAppend = dom.appendModeCheckbox.checked;

  if (!isAppend) { stopAllLive(); resetAllLogs(); }

  let successCount = 0;
  let errorCount = 0;

  for (const fileInfo of filesToLoad) {
    const displayName = `[${fileInfo.server.name}] ${fileInfo.file.name}`;
    const collectedLines = [];
    let totalBytes = 0;
    let isGrepMode = false;

    try {
      await streamSSE('/api/stream-file', {
        serverId: fileInfo.serverId,
        fileId: fileInfo.fileId,
        dateFrom: dateRange.dateFrom,
        dateTo: dateRange.dateTo,
        levels: levels,  // Пункт 5.2: передаём уровни для серверной фильтрации
        ...grepOptions
      }, {
        start: (data) => {
          totalBytes = data.totalBytes || 0;
          isGrepMode = !!data.grepFilter;
          const filterInfo = data.levelFilter ? ' + фильтр по уровням' : '';
          if (isGrepMode) { updateProgress(progressContainer, displayName, `Серверный поиск${filterInfo}...`, null, true); }
          else { updateProgress(progressContainer, displayName, 'Загрузка...', 0, false, `0 / ${formatBytes(totalBytes)}`); }
        },
        progress: (data) => {
          if (isGrepMode) { updateProgress(progressContainer, displayName, 'Серверный поиск...', null, true, `Найдено: ${formatBytes(data.bytesLoaded || 0)}`); }
          else { updateProgress(progressContainer, displayName, 'Загрузка...', data.percent, false, `${formatBytes(data.bytesLoaded)} / ${formatBytes(data.totalBytes)}`); }
        },
        lines: (data) => { for (const l of data.lines) collectedLines.push(l); },
        error: (data) => { throw new Error(data.message); },
        complete: () => { updateProgress(progressContainer, displayName, 'Готово', 100, false); }
      });

      if (!state.openedFiles.includes(displayName)) state.openedFiles.push(displayName);
      addLinesToLogs(collectedLines, displayName);
      successCount++;
    } catch (err) { console.error(`Ошибка загрузки ${displayName}:`, err); errorCount++; }
  }

  state.allLogs.sort((a, b) => a._timeMs - b._timeMs);
  updateUI();
  progressContainer.remove();

  if (errorCount > 0) { toast.error(`Загружено: ${successCount}, ошибок: ${errorCount}.\nПодробности в консоли.`, { title: 'Ошибка загрузки диапазона' }); }
}

// ====================== Баннер подключения live-потоков ======================

const liveLoadingItems = new Map();
let liveLoadingHideTimer = null;

function updateLiveLoadingTitle() {
  const total = liveLoadingItems.size;
  if (total === 0) return;
  const pending = Array.from(liveLoadingItems.values()).filter(i => i.status !== 'success' && i.status !== 'error').length;
  if (pending > 0) {
    dom.liveLoadingTitle.textContent = total === 1 ? 'Подключение к live-потоку...' : `Подключение к live-потокам... (${total - pending} из ${total})`;
    dom.liveLoadingBanner.classList.remove('all-done');
  } else {
    dom.liveLoadingTitle.textContent = total === 1 ? 'Поток подключён' : `Все потоки подключены (${total})`;
    dom.liveLoadingBanner.classList.add('all-done');
  }
}

function addLiveLoadingItem(key, displayName) {
  const existing = liveLoadingItems.get(key);
  if (existing && existing.el) existing.el.remove();

  const el = document.createElement('div');
  el.className = 'live-loading-item';
  el.innerHTML = `<span class="loading-spinner"></span><span class="live-loading-check"></span><span class="live-loading-item-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span><span class="live-loading-item-status">Подключение к серверу...</span>`;
  dom.liveLoadingList.appendChild(el);
  liveLoadingItems.set(key, { displayName, status: 'connecting', el });

  dom.liveLoadingBanner.classList.add('visible');
  dom.liveLoadingBanner.classList.remove('all-done');
  updateLiveLoadingTitle();

  if (liveLoadingHideTimer) { clearTimeout(liveLoadingHideTimer); liveLoadingHideTimer = null; }
}

function setLiveLoadingItemStatus(key, status, statusText) {
  const item = liveLoadingItems.get(key);
  if (!item) return;
  item.status = status;
  item.el.classList.remove('success', 'error');
  if (status === 'success') item.el.classList.add('success');
  else if (status === 'error') item.el.classList.add('error');

  const checkEl = item.el.querySelector('.live-loading-check');
  if (checkEl) { checkEl.textContent = status === 'success' ? '✓' : status === 'error' ? '✗' : ''; }
  const statusEl = item.el.querySelector('.live-loading-item-status');
  if (statusEl) statusEl.textContent = statusText;

  updateLiveLoadingTitle();
  maybeScheduleLiveLoadingHide();
}

function removeLiveLoadingItem(key) {
  const item = liveLoadingItems.get(key);
  if (!item) return;
  if (item.el) item.el.remove();
  liveLoadingItems.delete(key);
  if (liveLoadingItems.size === 0) { dom.liveLoadingBanner.classList.remove('visible'); dom.liveLoadingBanner.classList.remove('all-done'); }
  else { updateLiveLoadingTitle(); }
}

function maybeScheduleLiveLoadingHide() {
  const allDone = liveLoadingItems.size > 0 && Array.from(liveLoadingItems.values()).every(i => i.status === 'success' || i.status === 'error');
  if (!allDone) return;
  if (liveLoadingHideTimer) return;
  liveLoadingHideTimer = setTimeout(() => {
    liveLoadingHideTimer = null;
    const stillAllDone = liveLoadingItems.size > 0 && Array.from(liveLoadingItems.values()).every(i => i.status === 'success' || i.status === 'error');
    if (stillAllDone) { dom.liveLoadingBanner.classList.remove('visible'); dom.liveLoadingBanner.classList.remove('all-done'); dom.liveLoadingList.innerHTML = ''; liveLoadingItems.clear(); }
  }, 1500);
}

export function clearAllLiveLoading() {
  if (liveLoadingHideTimer) { clearTimeout(liveLoadingHideTimer); liveLoadingHideTimer = null; }
  dom.liveLoadingBanner.classList.remove('visible');
  dom.liveLoadingBanner.classList.remove('all-done');
  dom.liveLoadingList.innerHTML = '';
  liveLoadingItems.clear();
}

// ====================== Режим 3: Live (tail -F) ======================

export async function startLiveMode(filesToLoad) {
  const initialLines = parseInt(document.getElementById('liveInitialLines').value) || 100;
  const isAppend = dom.appendModeCheckbox.checked;

  if (!isAppend) { stopAllLive(); clearAllLiveLoading(); resetAllLogs(); }

  state.userScrolledAway = false;

  const byServer = new Map();
  for (const fileInfo of filesToLoad) {
    const key = `${fileInfo.serverId}::${fileInfo.fileId}`;
    if (state.liveStreams.has(key)) continue;
    const displayName = `[${fileInfo.server.name}] ${fileInfo.file.name}`;
    if (!state.openedFiles.includes(displayName)) state.openedFiles.push(displayName);

    addLiveLoadingItem(key, displayName);

    let bucket = byServer.get(fileInfo.serverId);
    if (!bucket) { bucket = { server: fileInfo.server, files: [] }; byServer.set(fileInfo.serverId, bucket); }
    bucket.files.push({ fileId: fileInfo.fileId, displayName, key });
  }

  for (const [serverId, bucket] of byServer.entries()) {
    const abortController = new AbortController();
    const group = { serverId, abortController, fileKeys: new Set(bucket.files.map(f => f.key)), groupId: null };

    for (const f of bucket.files) {
      state.liveStreams.set(f.key, { displayName: f.displayName, serverId, fileId: f.fileId, group });
    }

    runLiveGroup(bucket.server, bucket.files, initialLines, group).catch(err => {
      if (err.name !== 'AbortError') console.error(`Live group error [${bucket.server.name}]:`, err);
    });
  }

  updateLiveIndicator();
  updateUI();
}

async function runLiveGroup(server, files, initialLines, group) {
  const fileState = new Map();
  for (const f of files) {
    fileState.set(f.fileId, { key: f.key, displayName: f.displayName, firstLinesReceived: false, hadError: false, ended: false });
  }

  try {
    await streamSSE('/api/tail-follow-multi', { serverId: server.id, files: files.map(f => ({ fileId: f.fileId, initialLines })) }, {
      start: (data) => { group.groupId = data.groupId; },
      'file-start': (data) => {
        const st = fileState.get(data.fileId);
        if (!st) return;
        console.log(`Live started: ${st.displayName}`);
        setLiveLoadingItemStatus(st.key, 'awaiting', initialLines > 0 ? `Чтение последних ${initialLines} строк...` : 'Ожидание новых записей...');
      },
      'file-lines': (data) => {
        const st = fileState.get(data.fileId);
        if (!st) return;

        const isInitialBatch = !st.firstLinesReceived;
        if (isInitialBatch) { st.firstLinesReceived = true; setLiveLoadingItemStatus(st.key, 'success', 'Подключено'); }

        if (state.liveStreamPaused) {
          state.livePausedBuffer.push({ lines: data.lines, displayName: st.displayName });
          updateLiveIndicator();
          return;
        }

        const newEntries = addLinesToLogs(data.lines, st.displayName);
        if (newEntries.length > 0) {
          trimAllLogsIfNeeded();
          scheduleRender();
          if (!isInitialBatch) { handleNewLiveEntries(newEntries); }
        }
      },
      'file-info': (data) => { const st = fileState.get(data.fileId); if (st) console.log(`[${st.displayName}] ${data.message}`); },
      'file-error': (data) => {
        const st = fileState.get(data.fileId);
        if (!st) return;
        st.hadError = true;
        console.error(`Live error [${st.displayName}]:`, data.message);
        setLiveLoadingItemStatus(st.key, 'error', `Ошибка: ${data.message}`);
      },
      'file-end': (data) => {
        const st = fileState.get(data.fileId);
        if (!st) return;
        st.ended = true;
        console.log(`Live ended: ${st.displayName}`);
        state.liveStreams.delete(st.key);
        updateLiveIndicator();
        if (!st.firstLinesReceived && !st.hadError) {
          const item = liveLoadingItems.get(st.key);
          if (item && item.status !== 'error') { setLiveLoadingItemStatus(st.key, 'error', 'Поток завершён без данных'); }
        }
      },
      'group-end': () => { console.log(`Live group ended: ${server.name}`); }
    }, group.abortController.signal);
  } catch (err) {
    if (err.name !== 'AbortError') {
      for (const [, st] of fileState) {
        if (!st.ended && !st.hadError) { setLiveLoadingItemStatus(st.key, 'error', `Ошибка: ${err.message}`); }
      }
      const errorCount = Array.from(fileState.values()).filter(s => !s.ended).length;
      if (errorCount > 0) { toast.error(err.message, { title: `Ошибка live-потоков [${server.name}]` }); }
    }
    throw err;
  } finally {
    for (const f of files) {
      if (state.liveStreams.has(f.key)) {
        const info = state.liveStreams.get(f.key);
        if (info && info.group === group) state.liveStreams.delete(f.key);
      }
    }
    updateLiveIndicator();
  }
}

export async function stopLiveStream(key) {
  const stream = state.liveStreams.get(key);
  if (!stream) return;
  const { group, fileId } = stream;

  state.liveStreams.delete(key);
  group.fileKeys.delete(key);
  updateLiveIndicator();

  const loadingItem = liveLoadingItems.get(key);
  if (loadingItem && loadingItem.status !== 'success') { removeLiveLoadingItem(key); }

  if (group.fileKeys.size === 0) { try { group.abortController.abort(); } catch (e) {} return; }
  if (group.groupId) {
    try {
      await fetch('/api/tail-follow-multi/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: group.groupId, fileId }) });
    } catch (e) { console.error('Не удалось остановить канал на сервере:', e); }
  }
}

export function stopAllLive() {
  for (const key of Array.from(state.liveStreams.keys())) {
    const item = liveLoadingItems.get(key);
    if (item && item.status !== 'success') { removeLiveLoadingItem(key); }
  }
  const groups = new Set();
  for (const stream of state.liveStreams.values()) { if (stream.group) groups.add(stream.group); }
  for (const group of groups) { try { group.abortController.abort(); } catch (e) {} }
  state.liveStreams.clear();
  state.liveStreamPaused = false;
  state.livePausedBuffer = [];
  updateLiveIndicator();
}

// ====================== Утилита очистки ======================

function resetAllLogs() {
  state.allLogs = [];
  state.fileNames = {};
  state.serviceVisibility = {};
  state.openedFiles = [];
  state.paginatedFiles.clear();
}

// ====================== Пауза / возобновление (пункт 3.1) ======================

export function pauseLiveStreams() {
  if (state.liveStreams.size === 0) return;
  if (state.liveStreamPaused) return;
  state.liveStreamPaused = true;
  updateLiveIndicator();
}

export function resumeLiveStreams() {
  if (!state.liveStreamPaused) return;
  state.liveStreamPaused = false;
  applyPausedBuffer();
  updateLiveIndicator();
}

function applyPausedBuffer() {
  if (state.livePausedBuffer.length === 0) return;
  let totalAdded = 0;
  for (const item of state.livePausedBuffer) { totalAdded += addLinesToLogs(item.lines, item.displayName).length; }
  state.livePausedBuffer = [];
  if (totalAdded > 0) { trimAllLogsIfNeeded(); scheduleRender(); }
}

// Регистрируем stopLiveStream в render.js
setStopLiveStreamHandler(stopLiveStream);
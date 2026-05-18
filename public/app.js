// Точка входа приложения.
// Импортирует все модули, навешивает обработчики событий и запускает
// первичный рендер. Сюда же вынесены:
//  • загрузка локальных файлов,
//  • переключение темы,
//  • навешивание глобальных обработчиков индикатора LIVE.

import { state, dom } from './state.js';
import { parseLogLine, getQuickRange, msToDatetimeLocalValue } from './utils.js';
import {
  render,
  updateUI,
  attachScrollHandler,
  attachTraceBadgeHandler,
  initializeVirtualList,
  setTraceFilter
} from './render.js';
import {
  stopAllLive,
  clearAllLiveLoading,
  loadMorePages,
  pauseLiveStreams,
  resumeLiveStreams
} from './sse-client.js';
import {
  openRemoteModal,
  closeRemoteModal,
  loadSelectedRemoteFiles
} from './remote-modal.js';
import { attachErrorAlertHandlers } from './error-alerts.js';
import { attachSparklineHandlers } from './sparkline.js';
import { attachTzSelectorHandlers } from './tz-selector.js';
import { invalidateHeights } from './virtual-list.js';

// ====================== Загрузка локальных файлов ======================

async function loadFiles(files) {
  const isAppendMode = dom.appendModeCheckbox.checked;
  if (!isAppendMode) {
    stopAllLive();
    state.allLogs = [];
    state.fileNames = {};
    state.serviceVisibility = {};
    state.openedFiles = [];
    state.paginatedFiles.clear();
    // При полной перезагрузке снимаем активный фильтр по трассе —
    // он почти наверняка относится к старому набору данных.
    state.currentTraceFilter = null;
  }

  for (const file of files) {
    if (isAppendMode && state.openedFiles.includes(file.name)) {
      console.log(`Файл "${file.name}" уже открыт, пропускаем`);
      continue;
    }
    const text = await file.text();
    const name = file.name.replace(/\.(log|json)$/i, '');
    state.openedFiles.push(file.name);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const entry = parseLogLine(line, name);
      if (entry) {
        entry._fileName = file.name;
        state.allLogs.push(entry);
        const s = entry._serviceKey;
        if (!state.fileNames[s]) state.fileNames[s] = new Set();
        state.fileNames[s].add(file.name);
      }
    }
  }
  state.allLogs.sort((a, b) => a._timeMs - b._timeMs);
  Object.keys(state.fileNames).forEach(s => {
    if (state.serviceVisibility[s] === undefined) state.serviceVisibility[s] = true;
  });
  updateUI();
}

// ====================== Обработчики DOM ======================

dom.fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  await loadFiles(files);
  dom.fileInput.value = '';
});

document.querySelector('.file-input-wrap .btn').addEventListener('click', () => dom.fileInput.click());

// Полная очистка: используется и кнопкой «Очистить все», и кнопкой «Стоп»
// в индикаторе LIVE — пользователь хочет, чтобы остановка потоков
// одновременно стирала все накопленные записи.
function clearAll() {
  stopAllLive();
  clearAllLiveLoading();
  state.allLogs = [];
  state.fileNames = {};
  state.serviceVisibility = {};
  state.openedFiles = [];
  state.paginatedFiles.clear();
  state.currentTraceFilter = null;
  updateUI();
}

dom.clearAllBtn.addEventListener('click', clearAll);

// Перерисовка при изменении фильтров
[dom.searchInput, dom.timeFrom, dom.timeTo, dom.sortBy].forEach(el => {
  el.addEventListener('input', render);
  el.addEventListener('change', render);
});
dom.levelChecks.forEach(cb => cb.addEventListener('change', render));

// Быстрые временные диапазоны: выбор пресета в выпадающем списке
// заполняет timeFrom/timeTo относительно текущего момента и
// перерисовывает список. Пустое значение опции (плейсхолдер) — это
// «не выбран», ничего не делаем.
if (dom.quickRangeSelect) {
  dom.quickRangeSelect.addEventListener('change', () => {
    const preset = dom.quickRangeSelect.value;
    if (!preset) return;
    const { fromMs, toMs } = getQuickRange(preset, Date.now());
    if (fromMs == null || toMs == null) return;
    dom.timeFrom.value = msToDatetimeLocalValue(fromMs);
    dom.timeTo.value   = msToDatetimeLocalValue(toMs);
    // Программная установка .value НЕ триггерит 'input'/'change' — рендерим вручную.
    render();
  });
}

// Кнопка очистки диапазона — сбрасывает оба datetime-поля и select.
if (dom.quickRangeClearBtn) {
  dom.quickRangeClearBtn.addEventListener('click', () => {
    dom.timeFrom.value = '';
    dom.timeTo.value = '';
    if (dom.quickRangeSelect) dom.quickRangeSelect.value = '';
    render();
  });
}

// Если пользователь правит даты руками — сбрасываем выбранный пресет
// в выпадающем списке (даты больше не соответствуют ни одному пресету).
[dom.timeFrom, dom.timeTo].forEach(el => {
  el.addEventListener('input', () => {
    if (dom.quickRangeSelect) dom.quickRangeSelect.value = '';
  });
});

// ====================== Модалка ======================

dom.openRemoteBtn.addEventListener('click', () => openRemoteModal());
dom.closeModalBtn.addEventListener('click', () => closeRemoteModal());
dom.cancelRemote.addEventListener('click', () => closeRemoteModal());
dom.remoteModal.addEventListener('click', (e) => {
  if (e.target === dom.remoteModal) closeRemoteModal();
});
dom.loadRemoteBtn.addEventListener('click', () => loadSelectedRemoteFiles());

// ====================== Индикатор LIVE ======================

dom.loadMoreBtn.addEventListener('click', () => loadMorePages());

dom.stopAllLiveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearAll();
});

// Пункт 3.1: пауза / возобновление live-потоков.
dom.pauseLiveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.liveStreamPaused) {
    resumeLiveStreams();
  } else {
    pauseLiveStreams();
  }
});

dom.liveIndicator.addEventListener('click', (e) => {
  // Игнорируем клики по кнопкам Стоп и Пауза — их обработчики
  // сами делают stopPropagation, но belt-and-suspenders.
  if (e.target.classList.contains('live-stop-btn')) return;
  if (e.target.classList.contains('live-pause-btn')) return;
  dom.liveStreamsList.classList.toggle('visible');
});
document.addEventListener('click', (e) => {
  if (!dom.liveIndicator.contains(e.target) && !dom.liveStreamsList.contains(e.target)) {
    dom.liveStreamsList.classList.remove('visible');
  }
});

attachScrollHandler();
// Инициализируем виртуальный список (один раз при старте)
initializeVirtualList();
// Делегирование клика по бейджам traceId + клик по «✕» в баннере фильтра.
attachTraceBadgeHandler();
attachErrorAlertHandlers();
attachSparklineHandlers();
attachTzSelectorHandlers();

// ====================== Переключение темы ======================

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('theme', theme); } catch (e) {}
  dom.themeToggleBtn.title = theme === 'dark'
    ? 'Переключить на светлую тему'
    : 'Переключить на тёмную тему';
}

dom.themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

// Компактный режим
//
// Состояние режима хранится в localStorage['compact-mode'] и продублировано
// в атрибуте data-compact="true" на <html>. Атрибут используется CSS —
// см. блок «Компактный режим отображения» в public/styles.css.
//
// Первичная установка атрибута происходит синхронным inline-скриптом в
// <head> — это исключает «прыжок» геометрии списка после первой
// перерисовки (та же логика, что и у data-theme).
 
/**
 * Применяет компактный режим: ставит/снимает data-compact на <html>,
 * сохраняет состояние в localStorage и подстраивает title чекбокса.
 *
 * @param {boolean} on
 */
function applyCompactMode(on) {
  if (on) {
    document.documentElement.setAttribute('data-compact', 'true');
  } else {
    document.documentElement.removeAttribute('data-compact');
  }
  try {
    localStorage.setItem('compact-mode', on ? '1' : '0');
  } catch (e) { /* localStorage может быть недоступен (Safari Private) */ }
 
  if (dom.compactModeCheckbox) {
    dom.compactModeCheckbox.title = on
      ? 'Выключить компактный режим (вернуть обычные строки)'
      : 'Уменьшить высоту строк, шрифт до 11 px, столбец сервиса — только иконка';
  }

  // Сбрасываем кэш высот при переключении компактного режима
  invalidateHeights();
}
 
if (dom.compactModeCheckbox) {
  // Начальное состояние чекбокса синхронизируем с тем, что inline-скрипт
  // в <head> уже выставил на <html>. Это однонаправленная синхронизация:
  // DOM-атрибут — источник правды на момент загрузки.
  const initiallyOn = document.documentElement.getAttribute('data-compact') === 'true';
  dom.compactModeCheckbox.checked = initiallyOn;
  applyCompactMode(initiallyOn);  // только для проставления title
 
  dom.compactModeCheckbox.addEventListener('change', (e) => {
    applyCompactMode(e.target.checked);
  });
}

// ====================== Старт ======================

render();

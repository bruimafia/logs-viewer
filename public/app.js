// Точка входа приложения.
// Импортирует все модули, навешивает обработчики событий и запускает
// первичный рендер. Сюда же вынесены:
//  • загрузка локальных файлов,
//  • переключение темы,
//  • навешивание глобальных обработчиков индикатора LIVE.

import { state, dom } from './state.js';
import { parseLogLine, getQuickRange, msToDatetimeLocalValue, escapeHtml } from './utils.js';
import {
  render,
  updateUI,
  attachScrollHandler,
  attachTraceBadgeHandler,
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
import { toastConfirm } from './toast.js';
import { attachErrorAlertHandlers } from './error-alerts.js';
import { attachSparklineHandlers } from './sparkline.js';
import { attachTzSelectorHandlers } from './tz-selector.js';

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

dom.clearAllBtn.addEventListener('click', () => {
  stopAllLive();
  clearAllLiveLoading();
  state.allLogs = [];
  state.fileNames = {};
  state.serviceVisibility = {};
  state.openedFiles = [];
  state.paginatedFiles.clear();
  state.currentTraceFilter = null;
  updateUI();
});

// Перерисовка при изменении фильтров
[dom.searchInput, dom.timeFrom, dom.timeTo, dom.sortBy].forEach(el => {
  el.addEventListener('input', render);
  el.addEventListener('change', render);
});
dom.levelChecks.forEach(cb => cb.addEventListener('change', render));

// Быстрые временные диапазоны: один клик заполняет timeFrom/timeTo
// относительно текущего момента и перерисовывает список.
dom.quickRangeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.range;
    if (preset === 'clear') {
      dom.timeFrom.value = '';
      dom.timeTo.value = '';
      dom.quickRangeButtons.forEach(b => b.classList.remove('active'));
    } else {
      const { fromMs, toMs } = getQuickRange(preset, Date.now());
      dom.timeFrom.value = msToDatetimeLocalValue(fromMs);
      dom.timeTo.value   = msToDatetimeLocalValue(toMs);
      dom.quickRangeButtons.forEach(b => b.classList.toggle('active', b === btn));
    }
    // Программная установка .value НЕ триггерит 'input'/'change' — рендерим вручную.
    render();
  });
});

// Если пользователь правит даты руками — снимаем подсветку выбранного пресета.
[dom.timeFrom, dom.timeTo].forEach(el => {
  el.addEventListener('input', () => {
    dom.quickRangeButtons.forEach(b => b.classList.remove('active'));
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

dom.stopAllLiveBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  // ... подтверждение и stopAllLive (не меняется)
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
// Делегирование клика по бейджам traceId + клик по «✕» в баннере фильтра.
attachTraceBadgeHandler();
attachScrollHandler();
attachTraceBadgeHandler();
attachErrorAlertHandlers();  // <-- добавили: пункты 3.2 и 3.3
attachSparklineHandlers();  // <-- пункт 3.4: мини-спарклайн со статистикой
attachTzSelectorHandlers();  // пункт 6.4: селектор часового пояса

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

// ====================== Компактный режим (пункт 6.7) ======================
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

// ====================== Кастомизация колонок (пункт 6.9) ======================

const DEFAULT_COLUMNS = ['time', 'level', 'service', 'msg'];
const STORAGE_KEY = 'log-viewer-columns';

// Загружаем сохранённые колонки из localStorage при старте.
function loadColumnSettings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        state.visibleColumns = parsed;
      }
    }
  } catch (e) { /* ignore */ }
}

// Сохраняем текущие колонки в localStorage.
function saveColumnSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.visibleColumns));
  } catch (e) { /* ignore */ }
}

// Стандартные колонки с читаемыми ярлыками.
const STANDARD_COLUMNS = [
  { key: 'time',    label: 'Время' },
  { key: 'level',   label: 'Уровень' },
  { key: 'service', label: 'Сервис' },
  { key: 'msg',     label: 'Сообщение' }
];

/**
 * Пересобирает список чекбоксов в дропдауне «Колонки».
 * Вызывается при открытии дропдауна и после добавления новых extra-полей.
 */
function updateColumnCustomizerList() {
  if (!dom.columnCustomizerList) return;

  // Собираем все доступные колонки: стандартные + discovered extra
  const extraFields = state.discoveredExtraFields || [];
  const allColumns = [
    ...STANDARD_COLUMNS,
    ...extraFields.map(key => ({ key, label: key }))
  ];

  dom.columnCustomizerList.innerHTML = allColumns.map(col => {
    const checked = state.visibleColumns.includes(col.key) ? 'checked' : '';
    return `
      <label class="column-check">
        <input type="checkbox" value="${escapeHtml(col.key)}" ${checked}>
        <span>${escapeHtml(col.label)}</span>
      </label>
    `;
  }).join('');

  // Обработчик на каждый чекбокс
  dom.columnCustomizerList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const colKey = cb.value;
      if (cb.checked) {
        if (!state.visibleColumns.includes(colKey)) {
          // Вставляем после стандартных колонок (time, level, service, msg),
          // чтобы extra-поля шли после основных
          const insertAfter = Math.max(
            STANDARD_COLUMNS.findIndex(c => c.key === colKey),
            0
          );
          const lastStandard = state.visibleColumns.findIndex(
            (k, i) => i >= insertAfter && STANDARD_COLUMNS.some(s => s.key === k)
          );
          if (lastStandard === -1) {
            state.visibleColumns.push(colKey);
          } else {
            state.visibleColumns.splice(lastStandard + 1, 0, colKey);
          }
        }
      } else {
        // Нельзя скрыть все колонки — хотя бы msg остаётся
        if (state.visibleColumns.length > 1) {
          state.visibleColumns = state.visibleColumns.filter(k => k !== colKey);
        } else {
          cb.checked = true; // реvert
          return;
        }
      }
      saveColumnSettings();
      render();
    });
  });
}

// Открытие/закрытие дропдауна
dom.columnCustomizerToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const hidden = dom.columnCustomizerDropdown.hidden;
  if (hidden) {
    updateColumnCustomizerList();
    dom.columnCustomizerDropdown.hidden = false;
    dom.columnCustomizerToggle.textContent = 'Колонки ▲';
  } else {
    dom.columnCustomizerDropdown.hidden = true;
    dom.columnCustomizerToggle.textContent = 'Колонки ▾';
  }
});

// Сброс к стандартным колонкам
if (dom.columnCustomizerReset) {
  dom.columnCustomizerReset.addEventListener('click', () => {
    state.visibleColumns = [...DEFAULT_COLUMNS];
    saveColumnSettings();
    updateColumnCustomizerList();
    render();
  });
}

// Закрытие по клику вне дропдауна
document.addEventListener('click', (e) => {
  if (!dom.columnCustomizerToggle.contains(e.target) &&
      !dom.columnCustomizerDropdown.contains(e.target)) {
    dom.columnCustomizerDropdown.hidden = true;
    if (dom.columnCustomizerToggle) dom.columnCustomizerToggle.textContent = 'Колонки ▾';
  }
});

// ====================== Старт ======================

loadColumnSettings();

render();

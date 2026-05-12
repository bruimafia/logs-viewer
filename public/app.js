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
  attachScrollHandler
} from './render.js';
import {
  stopAllLive,
  clearAllLiveLoading,
  loadMorePages
} from './sse-client.js';
import {
  openRemoteModal,
  closeRemoteModal,
  loadSelectedRemoteFiles
} from './remote-modal.js';

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

dom.stopAllLiveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (confirm(`Остановить все live-потоки (${state.liveStreams.size})?`)) {
    stopAllLive();
  }
});

dom.liveIndicator.addEventListener('click', (e) => {
  // Игнорируем клики по кнопке Стоп
  if (e.target.classList.contains('live-stop-btn')) return;
  dom.liveStreamsList.classList.toggle('visible');
});
document.addEventListener('click', (e) => {
  if (!dom.liveIndicator.contains(e.target) && !dom.liveStreamsList.contains(e.target)) {
    dom.liveStreamsList.classList.remove('visible');
  }
});

attachScrollHandler();

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

// ====================== Старт ======================

render();

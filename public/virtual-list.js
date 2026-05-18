// Виртуализация списка логов.
// Рендерит только видимое окно + буфер ±30 строк, остальное — спейсеры.
// Измеряет реальные высоты строк и запоминает раскрытое состояние <details>.

import { dom, VIRTUAL_BUFFER_ROWS, ROW_HEIGHT_ESTIMATE_DEFAULT, ROW_HEIGHT_ESTIMATE_COMPACT } from './state.js';

// ====================== Внутреннее состояние ======================

let items = [];                      // Текущий отфильтрованный массив записей
let heights = new WeakMap();         // Entry → измеренная высота строки
let openDetails = new WeakSet();     // Для каких Entry раскрыт <details>
let mountedRange = { start: -1, end: -1 };  // Текущее смонтированное окно

let topSpacer = null;
let bottomSpacer = null;
let rowRenderer = null;              // (entry, idx) => HTMLElement

let scrollRafPending = false;
let resizeObserver = null;

// ====================== Вспомогательные функции ======================

function estimateRowHeight() {
  return document.documentElement.getAttribute('data-compact') === 'true'
    ? ROW_HEIGHT_ESTIMATE_COMPACT
    : ROW_HEIGHT_ESTIMATE_DEFAULT;
}

function getHeight(entry) {
  return heights.get(entry) ?? estimateRowHeight();
}

// ====================== Публичный API ======================

/**
 * Единоразовая инициализация виртуального списка.
 * Создаёт спейсеры, подписывается на scroll/toggle/resize.
 *
 * @param {Object} config
 * @param {Function} config.rowRenderer - (entry, idx) => HTMLElement
 */
export function initVirtualList(config) {
  rowRenderer = config.rowRenderer;

  // Создаём спейсеры
  topSpacer = document.createElement('div');
  topSpacer.className = 'virtual-spacer';
  topSpacer.style.height = '0px';

  bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'virtual-spacer';
  bottomSpacer.style.height = '0px';

  dom.logList.appendChild(topSpacer);
  dom.logList.appendChild(bottomSpacer);

  // Обработчик скролла (rAF-throttled)
  dom.logListWrap.addEventListener('scroll', () => {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      renderWindow();
    });
  });

  // Обработчик toggle на <details> (capture, чтобы ловить до всплытия)
  dom.logList.addEventListener('toggle', (e) => {
    const detailsEl = e.target;
    if (!detailsEl || detailsEl.tagName !== 'DETAILS') return;

    const row = detailsEl.closest('.log-entry');
    if (!row) return;

    const idx = parseInt(row.dataset.idx, 10);
    if (isNaN(idx) || idx < 0 || idx >= items.length) return;

    const entry = items[idx];
    if (!entry) return;

    // Обновляем set
    if (detailsEl.open) {
      openDetails.add(entry);
    } else {
      openDetails.delete(entry);
    }

    // Ждём следующий кадр, чтобы details успел отрисоваться с новой высотой
    requestAnimationFrame(() => {
      const newHeight = row.offsetHeight;
      const oldHeight = heights.get(entry) ?? estimateRowHeight();
      heights.set(entry, newHeight);

      // Корректируем спейсеры (без полной перерисовки окна)
      const delta = newHeight - oldHeight;
      if (delta !== 0) {
        // Определяем, в какой спейсер уходит дельта
        // Если строка в смонтированном окне, то дельта вычитается из bottomSpacer
        const currentBottomHeight = parseFloat(bottomSpacer.style.height) || 0;
        bottomSpacer.style.height = `${Math.max(0, currentBottomHeight - delta)}px`;
      }
    });
  }, true);  // capture

  // ResizeObserver для отслеживания изменения ширины контейнера
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === dom.logListWrap) {
        // Ширина изменилась — высоты строк могут поменяться из-за переносов
        invalidateHeights();
        break;
      }
    }
  });
  resizeObserver.observe(dom.logListWrap);
}

/**
 * Устанавливает новый список записей и перерисовывает окно.
 * Не сбрасывает heights/openDetails — они per-entry, валидны.
 *
 * @param {Array} newItems - отфильтрованный и отсортированный массив записей
 */
export function setItems(newItems) {
  items = newItems;
  mountedRange = { start: -1, end: -1 };  // Сбрасываем окно
  renderWindow();
}

/**
 * Основная логика виртуализации: находит видимое окно + буфер,
 * монтирует строки, измеряет их высоту, обновляет спейсеры.
 */
export function renderWindow() {
  if (!rowRenderer) return;
  if (items.length === 0) {
    topSpacer.style.height = '0px';
    bottomSpacer.style.height = '0px';
    // Удаляем все строки между спейсерами
    while (topSpacer.nextSibling && topSpacer.nextSibling !== bottomSpacer) {
      topSpacer.nextSibling.remove();
    }
    mountedRange = { start: -1, end: -1 };
    return;
  }

  const scrollTop = dom.logListWrap.scrollTop;
  const clientHeight = dom.logListWrap.clientHeight;

  // Линейный проход: находим индексы строк, попадающих в видимость
  let accumulatedHeight = 0;
  let startIdx = 0;
  let endIdx = items.length - 1;

  // Находим startIdx: первая строка, чей низ >= scrollTop
  for (let i = 0; i < items.length; i++) {
    const h = getHeight(items[i]);
    if (accumulatedHeight + h >= scrollTop) {
      startIdx = i;
      break;
    }
    accumulatedHeight += h;
  }

  // Находим endIdx: последняя строка, чей верх < scrollTop + clientHeight
  let endHeight = accumulatedHeight;
  for (let i = startIdx; i < items.length; i++) {
    const h = getHeight(items[i]);
    endHeight += h;
    if (endHeight >= scrollTop + clientHeight) {
      endIdx = i;
      break;
    }
  }

  // Расширяем окно на буфер
  const bufferStart = Math.max(0, startIdx - VIRTUAL_BUFFER_ROWS);
  const bufferEnd = Math.min(items.length - 1, endIdx + VIRTUAL_BUFFER_ROWS);

  // Если окно не изменилось — ничего не делаем
  if (mountedRange.start === bufferStart && mountedRange.end === bufferEnd) {
    return;
  }

  mountedRange = { start: bufferStart, end: bufferEnd };

  // Считаем высоты спейсеров
  let topOffset = 0;
  for (let i = 0; i < bufferStart; i++) {
    topOffset += getHeight(items[i]);
  }

  let bottomOffset = 0;
  for (let i = bufferEnd + 1; i < items.length; i++) {
    bottomOffset += getHeight(items[i]);
  }

  topSpacer.style.height = `${topOffset}px`;
  bottomSpacer.style.height = `${bottomOffset}px`;

  // Удаляем все строки между спейсерами
  while (topSpacer.nextSibling && topSpacer.nextSibling !== bottomSpacer) {
    topSpacer.nextSibling.remove();
  }

  // Монтируем строки для окна [bufferStart, bufferEnd]
  const fragment = document.createDocumentFragment();
  for (let i = bufferStart; i <= bufferEnd; i++) {
    const entry = items[i];
    const row = rowRenderer(entry, i);
    row.dataset.idx = i;
    row.dataset.parity = (i % 2 === 0) ? 'even' : 'odd';

    // Восстанавливаем раскрытое состояние <details>
    if (openDetails.has(entry)) {
      const detailsEl = row.querySelector('details');
      if (detailsEl) {
        detailsEl.open = true;
      }
    }

    fragment.appendChild(row);
  }

  // Вставляем перед bottomSpacer
  dom.logList.insertBefore(fragment, bottomSpacer);

  // Измеряем высоты после рендера (в следующем кадре, чтобы layout завершился)
  requestAnimationFrame(() => {
    let spacerDelta = 0;
    const rows = dom.logList.querySelectorAll('.log-entry');

    rows.forEach((row) => {
      const idx = parseInt(row.dataset.idx, 10);
      if (isNaN(idx) || idx < 0 || idx >= items.length) return;

      const entry = items[idx];
      const measuredHeight = row.offsetHeight;
      const estimatedHeight = getHeight(entry);

      heights.set(entry, measuredHeight);
      spacerDelta += (measuredHeight - estimatedHeight);
    });

    // Корректируем спейсеры, если высоты уточнились
    if (spacerDelta !== 0) {
      const currentBottom = parseFloat(bottomSpacer.style.height) || 0;
      bottomSpacer.style.height = `${Math.max(0, currentBottom - spacerDelta)}px`;
    }
  });
}

/**
 * Сбрасывает кэш высот и перерисовывает окно.
 * Вызывается при изменении compact-режима или ширины контейнера.
 */
export function invalidateHeights() {
  heights = new WeakMap();
  renderWindow();
}

/**
 * Прокрутка в конец списка (для auto-scroll в live-режиме).
 */
export function scrollToBottom() {
  dom.logListWrap.scrollTop = dom.logListWrap.scrollHeight;
}

/**
 * Прокрутка в начало списка.
 */
export function scrollToTop() {
  dom.logListWrap.scrollTop = 0;
}

/**
 * Возвращает Set раскрытых details (для дебага).
 */
export function getOpenDetailsSet() {
  return openDetails;
}

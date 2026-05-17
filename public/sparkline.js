/**
 * Мини-спарклайн со статистикой по уровням логов.
 * Узкая полоса под тулбаром, показывающая гистограмму количества записей
 * в state.allLogs по уровням (ERROR / WARN / INFO / DEBUG), сгруппированных
 * по бинам времени в выбранном окне. Помогает увидеть всплеск — особенно
 * в live-режиме.
 */
/**
 * Особенности реализации:
 *   • Без зависимостей. Чистый <canvas> 2D, HiDPI-friendly: размер канваса
 *     в пикселях устройства считается по devicePixelRatio при каждом
 *     ресайзе, ctx масштабируется через setTransform.
 *   • Цвета берутся из CSS-переменных (getComputedStyle), поэтому смена
 *     темы (data-theme) не требует никакой пересборки палитры —
 *     MutationObserver на <html> перерисовывает спарклайн.
 *   • Источник данных — НЕ фильтрованный state.allLogs: цель спарклайна
 *     в том, чтобы дать общий обзор и подсветить, что прячут фильтры
 *     (типичный сценарий: «я скрыл DEBUG, но в логах сейчас всплеск
 *     DEBUG-сообщений — это нормально?»).
 *   • Клик по бину выставляет timeFrom/timeTo на границы бина (с малым
 *     запасом по краям) — удобный UX-зум, который автоматически
 *     заполняет существующие поля «С / До».
 *   • Дроссель через requestAnimationFrame: несколько вызовов
 *     renderSparkline() подряд (например, при live-batch + render)
 *     схлопываются в один кадр.
 *   • В live-режиме правый край окна — Date.now(), окно «едет» вправо
 *     с шагом 5 секунд через setInterval. Без этого пустота справа
 *     росла бы между приходом батчей.
 */

import { state, dom } from './state.js';
import { msToDatetimeLocalValue } from './utils.js';

// ===================== Константы =====================

// Размер окна по умолчанию (мс) — 30 минут. Полный перечень доступных
// значений задан в <select id="sparklineWindow"> в index.html.
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

// Ключи localStorage для сохранения пользовательских настроек
const LS_KEY_WINDOW    = 'sparkline:windowMs';
const LS_KEY_COLLAPSED = 'sparkline:collapsed';

// Целевое количество бинов на канвасе. Небольшое фиксированное значение
// обеспечивает широкие бары (легче попасть курсором) и стабильный внешний
// вид при ресайзе окна.
const BIN_COUNT = 60;

// Высота канваса в CSS-пикселях. Намеренно небольшая, чтобы не отнимать
// вертикальное место у основного списка логов.
const CANVAS_CSS_HEIGHT = 44;

// Порядок укладки уровней в стэке снизу-вверх. ERROR визуально сверху —
// самый «громкий» класс, его всплеск должен мгновенно бросаться в глаза.
const LEVELS_BOTTOM_UP = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

// Период автотика в live-режиме (мс). Окно сдвигается даже без новых записей.
const LIVE_TICK_MS = 5000;

// ===================== Внутреннее состояние модуля =====================

// Кешированный 2D-контекст канваса
let ctx = null;

// Палитра цветов из CSS-переменных. Пересчитывается при каждой отрисовке.
let palette = null;

// Токен запланированного requestAnimationFrame. null = рендер не ожидается.
let rafToken = null;

// Состояние последнего отрисованного кадра для тултипа и обработчика клика
let lastBins = null;
let lastWindowMs = DEFAULT_WINDOW_MS;

// ===================== Палитра / тема =====================

/**
 * Читает цвета из CSS-переменных документа.
 * Дефолтные значения соответствуют тёмной теме на случай, если CSS ещё не загрузился.
 * 
 * @returns {Object} Палитра с цветами для уровней и границ
 */
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  return {
    ERROR:  (cs.getPropertyValue('--error')  || '').trim() || '#f85149',
    WARN:   (cs.getPropertyValue('--warn')   || '').trim() || '#d29922',
    INFO:   (cs.getPropertyValue('--info')   || '').trim() || '#58a6ff',
    DEBUG:  (cs.getPropertyValue('--debug')  || '').trim() || '#8b949e',
    border: (cs.getPropertyValue('--border') || '').trim() || '#2d3548'
  };
}

// ===================== HiDPI-ресайз канваса =====================

/**
 * Приводит размеры канваса в соответствие с текущей шириной контейнера
 * и devicePixelRatio для поддержки HiDPI-дисплеев.
 * 
 * Перепривязываем .width/.height только при реальном изменении размеров,
 * чтобы избежать потери сглаживания и мигания при перерисовке.
 * 
 * @returns {Object|null} Объект с контекстом и CSS-размерами, или null
 */
function resizeCanvas() {
  const c = dom.sparklineCanvas;
  if (!c) return null;
  const rect = c.getBoundingClientRect();
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const cssW = Math.max(0, Math.floor(rect.width));
  const cssH = CANVAS_CSS_HEIGHT;
  if (cssW === 0) return null;

  if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
    c.width  = cssW * dpr;
    c.height = cssH * dpr;
    c.style.height = cssH + 'px';
  }
  const cx = c.getContext('2d');
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: cx, cssW, cssH };
}

// ===================== Биннинг по уровням =====================

/**
 * Распределяет логи по временным интервалам (бинам) с подсчётом по уровням.
 * Записи без времени (_timeMs === 0) пропускаются. Неизвестные уровни
 * приклеиваются к INFO.
 * 
 * @param {Array} logs - Массив записей логов (state.allLogs)
 * @param {number} windowMs - Длина временного окна в миллисекундах
 * @param {number} endMs - Правая граница окна (исключительно)
 * @returns {{bins: Array, max: number}} Массив бинов и максимальное количество
 */
function binByLevel(logs, windowMs, endMs) {
  const startMs = endMs - windowMs;
  const binMs = windowMs / BIN_COUNT;
  const bins = new Array(BIN_COUNT);
  for (let i = 0; i < BIN_COUNT; i++) {
    bins[i] = {
      t0: startMs + i * binMs,
      t1: startMs + (i + 1) * binMs,
      counts: { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 },
      total: 0
    };
  }
  let max = 0;
  for (const e of logs) {
    const t = e._timeMs;
    if (!t) continue;
    if (t < startMs || t >= endMs) continue;
    let idx = Math.floor((t - startMs) / binMs);
    // Страховка от пограничных случаев с плавающей точкой
    if (idx < 0) idx = 0;
    if (idx >= BIN_COUNT) idx = BIN_COUNT - 1;
    const lvl = (e.level || 'INFO').toUpperCase();
    const key = bins[idx].counts.hasOwnProperty(lvl) ? lvl : 'INFO';
    bins[idx].counts[key]++;
    bins[idx].total++;
    if (bins[idx].total > max) max = bins[idx].total;
  }
  return { bins, max };
}

// ===================== Отрисовка канваса =====================

/**
 * Отрисовывает бары спарклайна на канвасе.
 * 
 * @param {Array} bins - Массив бинов с данными
 * @param {number} max - Максимальное значение для масштабирования
 * @param {number} cssW - Ширина канваса в CSS-пикселях
 * @param {number} cssH - Высота канваса в CSS-пикселях
 */
function paint(bins, max, cssW, cssH) {
  const cx = ctx;
  cx.clearRect(0, 0, cssW, cssH);

  // Базовая линия снизу визуально «прижимает» бары
  cx.fillStyle = palette.border;
  cx.fillRect(0, cssH - 1, cssW, 1);

  if (max === 0) return;

  const barSlot = cssW / BIN_COUNT;
  const innerH = cssH - 2;

  for (let i = 0; i < BIN_COUNT; i++) {
    const bin = bins[i];
    if (bin.total === 0) continue;
    // Целочисленные границы предотвращают полупрозрачные артефакты между барами
    const xStart = Math.floor(i * barSlot);
    const xEnd   = Math.floor((i + 1) * barSlot);
    const w      = Math.max(1, xEnd - xStart - 1);

    let yBase = cssH - 1;
    for (const lvl of LEVELS_BOTTOM_UP) {
      const c = bin.counts[lvl];
      if (!c) continue;
      // Минимум 1px даже для одной записи, чтобы она была видна
      const h = Math.max(1, Math.round((c / max) * innerH));
      cx.fillStyle = palette[lvl];
      cx.fillRect(xStart, yBase - h, w, h);
      yBase -= h;
    }
  }
}

// ===================== Подпись оси X =====================

/**
 * Форматирует временную метку для подписи оси X.
 * Для окон ≥12 часов показывает дату и время, иначе только время.
 * 
 * @param {number} ms - Временная метка в миллисекундах
 * @returns {string} Отформатированная строка времени
 */
function formatAxisTime(ms) {
  const d = new Date(ms);
  if (lastWindowMs >= 12 * 3600 * 1000) {
    return d.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Обновляет подписи оси X: начало, середина и конец окна.
 * 
 * @param {number} startMs - Начало временного окна
 * @param {number} endMs - Конец временного окна
 */
function updateAxis(startMs, endMs) {
  if (!dom.sparklineAxis) return;
  const midMs = startMs + (endMs - startMs) / 2;
  dom.sparklineAxis.innerHTML =
    `<span>${formatAxisTime(startMs)}</span>` +
    `<span>${formatAxisTime(midMs)}</span>` +
    `<span>${formatAxisTime(endMs)}</span>`;
}

// ===================== Сводка справа в шапке =====================

/**
 * Обновляет сводку по уровням в шапке спарклайна.
 * Показывает количество записей каждого уровня и общее количество.
 * 
 * @param {Array} bins - Массив бинов с данными
 */
function updateStats(bins) {
  if (!dom.sparklineStats) return;
  let e = 0, w = 0, i = 0, d = 0;
  for (const b of bins) {
    e += b.counts.ERROR;
    w += b.counts.WARN;
    i += b.counts.INFO;
    d += b.counts.DEBUG;
  }
  const total = e + w + i + d;
  dom.sparklineStats.innerHTML =
    `<span class="sparkline-stat" title="ERROR в окне"><span class="sparkline-stat-dot" style="background:var(--error)"></span>${e}</span>` +
    `<span class="sparkline-stat" title="WARN в окне"><span class="sparkline-stat-dot" style="background:var(--warn)"></span>${w}</span>` +
    `<span class="sparkline-stat" title="INFO в окне"><span class="sparkline-stat-dot" style="background:var(--info)"></span>${i}</span>` +
    `<span class="sparkline-stat" title="DEBUG в окне"><span class="sparkline-stat-dot" style="background:var(--debug)"></span>${d}</span>` +
    `<span class="sparkline-stats-total" title="Всего записей в окне">/ ${total}</span>`;
}

// ===================== Главный публичный API =====================

/**
 * Запрашивает перерисовку спарклайна через requestAnimationFrame.
 * Безопасно вызывать многократно — реальная отрисовка максимум один раз за кадр.
 */
export function renderSparkline() {
  if (!dom.sparklineWrap) return;
  if (rafToken) return;
  rafToken = requestAnimationFrame(() => {
    rafToken = null;
    paintNow();
  });
}

/**
 * Выполняет немедленную отрисовку спарклайна.
 */
function paintNow() {
  if (!dom.sparklineWrap) return;

  // Скрываем полностью только если данных нет
  if (!state.allLogs.length) {
    dom.sparklineWrap.hidden = true;
    return;
  }
  dom.sparklineWrap.hidden = false;

  const collapsed = localStorage.getItem(LS_KEY_COLLAPSED) === '1';
  dom.sparklineWrap.classList.toggle('collapsed', collapsed);

  // В live-режиме окно «едет» вправо по текущему времени,
  // иначе привязано к времени самой свежей записи
  const windowMs = lastWindowMs;
  let endMs;
  if (state.liveStreams.size > 0) {
    endMs = Date.now();
  } else {
    let maxT = 0;
    for (const e of state.allLogs) if (e._timeMs > maxT) maxT = e._timeMs;
    endMs = maxT || Date.now();
  }
  const startMs = endMs - windowMs;

  // Биннинг нужен даже в свёрнутом состоянии для отображения итоговых цифр
  const { bins, max } = binByLevel(state.allLogs, windowMs, endMs);
  lastBins = bins;
  updateStats(bins);

  if (collapsed) {
    hideTooltip();
    return;
  }

  const sized = resizeCanvas();
  if (!sized) return;
  ctx = sized.ctx;
  palette = readPalette();

  paint(bins, max, sized.cssW, sized.cssH);
  updateAxis(startMs, endMs);
}

// ===================== Тултип =====================

/**
 * Определяет бин под курсором по горизонтальной координате.
 * 
 * @param {number} clientX - Координата X курсора
 * @returns {{idx: number, bin: Object}|null} Индекс и данные бина, или null
 */
function binAtClientX(clientX) {
  if (!lastBins) return null;
  const rect = dom.sparklineCanvas.getBoundingClientRect();
  const cssW = rect.width;
  if (cssW === 0) return null;
  const localX = clientX - rect.left;
  if (localX < 0 || localX > cssW) return null;
  const idx = Math.min(BIN_COUNT - 1, Math.max(0, Math.floor((localX / cssW) * BIN_COUNT)));
  return { idx, bin: lastBins[idx] };
}

/**
 * Показывает тултип с детальной информацией о бине.
 * 
 * @param {number} clientX - Координата X для позиционирования
 * @param {number} clientY - Координата Y для позиционирования
 * @param {Object} bin - Данные бина
 */
function showTooltip(clientX, clientY, bin) {
  const tt = dom.sparklineTooltip;
  if (!tt) return;
  const t0 = new Date(bin.t0);
  const t1 = new Date(bin.t1);
  const durSec = Math.round((bin.t1 - bin.t0) / 1000);
  const durLabel = durSec >= 60
    ? `${Math.round(durSec / 60)} мин`
    : `${durSec} с`;

  tt.innerHTML =
    `<div class="sparkline-tt-time">` +
      `${t0.toLocaleTimeString('ru-RU')} — ${t1.toLocaleTimeString('ru-RU')} ` +
      `<span class="sparkline-tt-dur">(${durLabel})</span>` +
    `</div>` +
    `<div class="sparkline-tt-row"><span class="sparkline-tt-dot" style="background:var(--error)"></span>ERROR<b>${bin.counts.ERROR}</b></div>` +
    `<div class="sparkline-tt-row"><span class="sparkline-tt-dot" style="background:var(--warn)"></span>WARN<b>${bin.counts.WARN}</b></div>` +
    `<div class="sparkline-tt-row"><span class="sparkline-tt-dot" style="background:var(--info)"></span>INFO<b>${bin.counts.INFO}</b></div>` +
    `<div class="sparkline-tt-row"><span class="sparkline-tt-dot" style="background:var(--debug)"></span>DEBUG<b>${bin.counts.DEBUG}</b></div>` +
    `<div class="sparkline-tt-total">Всего: <b>${bin.total}</b></div>` +
    (bin.total ? `<div class="sparkline-tt-hint">Клик — показать в списке</div>` : '');

  // Позиционируем относительно .sparkline-wrap с проверкой границ
  tt.style.display = 'block';
  const wrapRect = dom.sparklineWrap.getBoundingClientRect();
  const ttRect = tt.getBoundingClientRect();
  let left = clientX - wrapRect.left + 12;
  let top  = clientY - wrapRect.top  + 12;
  if (left + ttRect.width > wrapRect.width) {
    left = clientX - wrapRect.left - ttRect.width - 12;
  }
  if (left < 0) left = 4;
  tt.style.left = left + 'px';
  tt.style.top  = top  + 'px';
}

function hideTooltip() {
  if (dom.sparklineTooltip) dom.sparklineTooltip.style.display = 'none';
}

// ===================== Зум: клик по бину → timeFrom/timeTo =====================

/**
 * Устанавливает временной фильтр на границы выбранного бина.
 * Добавляет небольшой запас с каждой стороны для захвата граничных событий.
 * 
 * @param {Object} bin - Данные бина для зума
 */
function zoomToBin(bin) {
  if (!bin || bin.total === 0) return;
  const pad = (bin.t1 - bin.t0) * 0.5;
  const fromMs = Math.floor(bin.t0 - pad);
  const toMs   = Math.ceil(bin.t1 + pad);
  dom.timeFrom.value = msToDatetimeLocalValue(fromMs);
  dom.timeTo.value   = msToDatetimeLocalValue(toMs);
  // Программная установка .value не триггерит события — диспатчим вручную
  dom.timeFrom.dispatchEvent(new Event('input', { bubbles: true }));
  dom.timeTo.dispatchEvent(new Event('input', { bubbles: true }));
  // Сбрасываем выбранный пресет в выпадающем списке быстрых диапазонов —
  // даты после клика по бину не соответствуют ни одному из пресетов.
  if (dom.quickRangeSelect) {
    dom.quickRangeSelect.value = '';
  }
}

// ===================== Инициализация =====================

/**
 * Инициализирует обработчики событий для спарклайна.
 * Должна вызываться один раз из app.js после загрузки DOM.
 */
export function attachSparklineHandlers() {
  // Восстановление выбора окна из localStorage
  try {
    const saved = parseInt(localStorage.getItem(LS_KEY_WINDOW) || '', 10);
    if (Number.isFinite(saved) && saved > 0) lastWindowMs = saved;
  } catch (e) {}

  // Селектор временного окна
  if (dom.sparklineWindow) {
    const opt = Array.from(dom.sparklineWindow.options)
      .find(o => parseInt(o.value, 10) === lastWindowMs);
    if (opt) dom.sparklineWindow.value = opt.value;
    dom.sparklineWindow.addEventListener('change', () => {
      const ms = parseInt(dom.sparklineWindow.value, 10);
      if (Number.isFinite(ms) && ms > 0) {
        lastWindowMs = ms;
        try { localStorage.setItem(LS_KEY_WINDOW, String(ms)); } catch (e) {}
        renderSparkline();
      }
    });
  }

  // Кнопка «Свернуть / Развернуть»
  if (dom.sparklineToggle) {
    const setButtonState = (collapsed) => {
      dom.sparklineToggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      dom.sparklineToggle.setAttribute(
        'aria-label',
        collapsed ? 'Развернуть спарклайн' : 'Свернуть спарклайн'
      );
      dom.sparklineToggle.textContent = collapsed ? 'Развернуть' : 'Свернуть';
    };
    setButtonState(localStorage.getItem(LS_KEY_COLLAPSED) === '1');
    dom.sparklineToggle.addEventListener('click', () => {
      const currentlyCollapsed = localStorage.getItem(LS_KEY_COLLAPSED) === '1';
      const next = !currentlyCollapsed;
      try { localStorage.setItem(LS_KEY_COLLAPSED, next ? '1' : '0'); } catch (e) {}
      setButtonState(next);
      renderSparkline();
    });
  }

  // Канвас: тултип и клик
  if (dom.sparklineCanvas) {
    dom.sparklineCanvas.addEventListener('mousemove', (e) => {
      const hit = binAtClientX(e.clientX);
      if (!hit || !hit.bin) { hideTooltip(); return; }
      showTooltip(e.clientX, e.clientY, hit.bin);
    });
    dom.sparklineCanvas.addEventListener('mouseleave', hideTooltip);
    dom.sparklineCanvas.addEventListener('click', (e) => {
      const hit = binAtClientX(e.clientX);
      if (!hit || !hit.bin) return;
      zoomToBin(hit.bin);
      hideTooltip();
    });
  }

  // Ресайз окна
  window.addEventListener('resize', () => renderSparkline());

  // Автотик в live-режиме для сдвига окна
  setInterval(() => {
    if (state.liveStreams.size > 0 && !state.liveStreamPaused) {
      renderSparkline();
    }
  }, LIVE_TICK_MS);

  // Смена темы: перечитать палитру из CSS-переменных
  const themeObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === 'data-theme') {
        renderSparkline();
        return;
      }
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });
}

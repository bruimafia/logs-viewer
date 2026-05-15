// public/sparkline.js
//
// Мини-спарклайн со статистикой по уровням (пункт 3.4 плана улучшений).
// Узкая полоса под тулбаром, показывающая гистограмму количества записей
// в state.allLogs по уровням (ERROR / WARN / INFO / DEBUG), сгруппированных
// по бинам времени в выбранном окне. Помогает увидеть всплеск — особенно
// в live-режиме.
//
// Особенности реализации:
//   • Без зависимостей. Чистый <canvas> 2D, HiDPI-friendly: размер канваса
//     в пикселях устройства считается по devicePixelRatio при каждом
//     ресайзе, ctx масштабируется через setTransform.
//   • Цвета берутся из CSS-переменных (getComputedStyle), поэтому смена
//     темы (data-theme) не требует никакой пересборки палитры —
//     MutationObserver на <html> перерисовывает спарклайн.
//   • Источник данных — НЕ фильтрованный state.allLogs: цель спарклайна
//     в том, чтобы дать общий обзор и подсветить, что прячут фильтры
//     (типичный сценарий: «я скрыл DEBUG, но в логах сейчас всплеск
//     DEBUG-сообщений — это нормально?»). Уровневые фильтры применять
//     не нужно.
//   • Клик по бину выставляет timeFrom/timeTo на границы бина (с малым
//     запасом по краям) — удобный UX-зум, который автоматически
//     заполняет существующие поля «С / До».
//   • Дроссель через requestAnimationFrame: несколько вызовов
//     renderSparkline() подряд (например, при live-batch + render)
//     схлопываются в один кадр.
//   • В live-режиме правый край окна — Date.now(), окно «едет» вправо
//     с шагом 5 секунд через setInterval. Без этого пустота справа
//     росла бы между приходом батчей.
//
// Зависимости от других модулей: state (allLogs, liveStreams), dom
// (ссылки на новые HTML-элементы), msToDatetimeLocalValue из utils
// (для записи Date в значение datetime-local input'а).

import { state, dom } from './state.js';
import { msToDatetimeLocalValue } from './utils.js';

// ===================== Константы =====================

// Размер окна по умолчанию (мс) — 30 минут. Перечень доступных значений
// задан в <select id="sparklineWindow"> в index.html; здесь — только
// дефолт, который применится при первом запуске, пока пользователь
// не выбрал ничего сам.
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

// Ключи localStorage для запоминания пользовательских настроек.
const LS_KEY_WINDOW    = 'sparkline:windowMs';
const LS_KEY_COLLAPSED = 'sparkline:collapsed'; // '1' — свёрнут (видна только шапка), иначе развёрнут

// Целевое количество бинов на канвасе. Делается небольшим и фиксированным,
// чтобы бары были заметно широкими (по бару легче попасть курсором) и
// чтобы внешний вид не «прыгал» при ресайзе окна.
const BIN_COUNT = 60;

// Высота канваса в CSS-пикселях. Намеренно небольшая — пункт 3.4
// называет «узкий канвас», и мы не должны отъедать вертикальное место
// у основного списка логов.
const CANVAS_CSS_HEIGHT = 44;

// Порядок укладки уровней в стэке. Снизу-вверх: DEBUG → INFO → WARN → ERROR.
// ERROR оказывается визуально сверху — самый «громкий» класс,
// его всплеск должен мгновенно бросаться в глаза.
const LEVELS_BOTTOM_UP = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

// Период автотика в live-режиме (мс). Раз в столько секунд окно
// сдвигается, даже если новых записей не приходило.
const LIVE_TICK_MS = 5000;

// ===================== Внутреннее состояние модуля =====================

// Кешированный 2D-контекст. Перепривязывается при каждом resizeCanvas()
// (после setTransform), поэтому достаточно хранить ссылку.
let ctx = null;

// Палитра — пересчитывается из CSS-переменных при каждой отрисовке.
// Лёгкая операция (4–6 getPropertyValue), оптимизировать незачем.
let palette = null;

// Токен запланированного rAF. null — никакой кадр не ждёт, можно ставить.
let rafToken = null;

// Состояние последнего отрисованного кадра — нужно тултипу и обработчику
// клика, чтобы не пересчитывать биннинг при каждом mousemove.
let lastBins = null;            // массив { t0, t1, counts:{LEVEL:n}, total }
let lastWindowMs = DEFAULT_WINDOW_MS;

// ===================== Палитра / тема =====================

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  // Дефолтные значения — на случай, если CSS ещё не дозагрузился.
  // Соответствуют тёмной теме из styles.css.
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
 * Приводит .width/.height канваса в соответствие с текущей шириной
 * контейнера и devicePixelRatio. Возвращает контекст и CSS-размеры,
 * либо null, если канвас не вмонтирован.
 *
 * Перепривязываем .width/.height ТОЛЬКО при реальном изменении —
 * иначе всякий раз пропадало бы сглаживание и появлялось бы лёгкое
 * мигание при перерисовке внутри одного кадра.
 */
function resizeCanvas() {
  const c = dom.sparklineCanvas;
  if (!c) return null;
  const rect = c.getBoundingClientRect();
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const cssW = Math.max(0, Math.floor(rect.width));
  const cssH = CANVAS_CSS_HEIGHT;
  // Если контейнер ещё не растянулся (нулевая ширина) — не пытаемся
  // ничего рисовать, дождёмся следующего вызова.
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
 * Разносит логи по BIN_COUNT интервалам в окне [endMs - windowMs; endMs).
 * Возвращает массив бинов с раскладкой по уровням и максимальное
 * число записей в одном бине — оно станет вертикальным масштабом.
 *
 * Записи без времени (_timeMs === 0) пропускаем — их позиция на
 * временной оси неопределена. Уровни, которых нет в дефолтной четвёрке,
 * приклеиваются к INFO (логичнее всего — это «прочее»).
 *
 * @param {Array} logs       state.allLogs
 * @param {number} windowMs  длина окна в мс
 * @param {number} endMs     правая граница окна (исключительно)
 * @returns {{bins: Array, max: number}}
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
    // Численная пограничная страховка: при t === endMs - epsilon
    // idx может дать BIN_COUNT.
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

function paint(bins, max, cssW, cssH) {
  const cx = ctx;
  cx.clearRect(0, 0, cssW, cssH);

  // Тонкая базовая линия снизу — визуально «прижимает» бары и сглаживает
  // ощущение пустоты, когда логов мало.
  cx.fillStyle = palette.border;
  cx.fillRect(0, cssH - 1, cssW, 1);

  if (max === 0) return;

  const barSlot = cssW / BIN_COUNT;
  // На внутренний бар оставляем cssH - 2px: 1px нижняя линия + 1px воздух сверху.
  const innerH = cssH - 2;

  for (let i = 0; i < BIN_COUNT; i++) {
    const bin = bins[i];
    if (bin.total === 0) continue;
    // Целочисленные границы бара — без них при дробном barSlot между
    // соседними барами проступали бы полупрозрачные полоски.
    const xStart = Math.floor(i * barSlot);
    const xEnd   = Math.floor((i + 1) * barSlot);
    const w      = Math.max(1, xEnd - xStart - 1); // 1px зазор справа

    let yBase = cssH - 1; // рисуем снизу-вверх от нижней линии
    for (const lvl of LEVELS_BOTTOM_UP) {
      const c = bin.counts[lvl];
      if (!c) continue;
      // Высота сегмента пропорциональна доле в общем total; но даже 1
      // запись должна быть видна — поэтому минимум 1px.
      const h = Math.max(1, Math.round((c / max) * innerH));
      cx.fillStyle = palette[lvl];
      cx.fillRect(xStart, yBase - h, w, h);
      yBase -= h;
    }
  }
}

// ===================== Подпись оси X =====================

function formatAxisTime(ms) {
  const d = new Date(ms);
  // Для длинных окон (≥12 часов) дата важнее минут — даём день и часы.
  if (lastWindowMs >= 12 * 3600 * 1000) {
    return d.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function updateAxis(startMs, endMs) {
  if (!dom.sparklineAxis) return;
  const midMs = startMs + (endMs - startMs) / 2;
  dom.sparklineAxis.innerHTML =
    `<span>${formatAxisTime(startMs)}</span>` +
    `<span>${formatAxisTime(midMs)}</span>` +
    `<span>${formatAxisTime(endMs)}</span>`;
}

// ===================== Сводка справа в шапке =====================

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
  // Эмодзи-точки + цифра. Цвет точки через inline style — никакой
  // дополнительной таблицы стилей не нужно.
  dom.sparklineStats.innerHTML =
    `<span class="sparkline-stat" title="ERROR в окне"><span class="sparkline-stat-dot" style="background:var(--error)"></span>${e}</span>` +
    `<span class="sparkline-stat" title="WARN в окне"><span class="sparkline-stat-dot" style="background:var(--warn)"></span>${w}</span>` +
    `<span class="sparkline-stat" title="INFO в окне"><span class="sparkline-stat-dot" style="background:var(--info)"></span>${i}</span>` +
    `<span class="sparkline-stat" title="DEBUG в окне"><span class="sparkline-stat-dot" style="background:var(--debug)"></span>${d}</span>` +
    `<span class="sparkline-stats-total" title="Всего записей в окне">/ ${total}</span>`;
}

// ===================== Главный публичный API =====================

/**
 * Запрашивает перерисовку спарклайна. Безопасно вызывать многократно
 * подряд — реальная отрисовка случится максимум один раз за кадр.
 */
export function renderSparkline() {
  if (!dom.sparklineWrap) return;
  if (rafToken) return;
  rafToken = requestAnimationFrame(() => {
    rafToken = null;
    paintNow();
  });
}

function paintNow() {
  if (!dom.sparklineWrap) return;

  // Условие полного скрытия — только одно: данных нет. Кнопка «Свернуть»
  // НЕ должна прятать весь блок, иначе пользователь не сможет добраться
  // до неё, чтобы развернуть обратно. В свёрнутом состоянии остаётся
  // узкая шапка с цифрами и кнопкой «Развернуть».
  if (!state.allLogs.length) {
    dom.sparklineWrap.hidden = true;
    return;
  }
  dom.sparklineWrap.hidden = false;

  const collapsed = localStorage.getItem(LS_KEY_COLLAPSED) === '1';
  dom.sparklineWrap.classList.toggle('collapsed', collapsed);

  // Правый край окна:
  //   • в live-режиме — текущее время (окно «едет» вправо);
  //   • иначе — время самой свежей записи, чтобы при загруженном дампе
  //     не было пустоты «после конца файла».
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

  // Считаем бины ВСЕГДА — даже в свёрнутом состоянии, потому что в
  // шапке отображаются итоговые цифры по уровням. Сама раскладка
  // бинов нужна для updateStats; биннинг дёшев.
  const { bins, max } = binByLevel(state.allLogs, windowMs, endMs);
  lastBins = bins;
  updateStats(bins);

  if (collapsed) {
    // Канвас и ось не нужны — CSS их прячет по классу .collapsed.
    // Тултип, если он остался от прошлой сессии, тоже убираем.
    hideTooltip();
    return;
  }

  const sized = resizeCanvas();
  if (!sized) return; // канвас ещё не растянут — попробуем в следующем render()
  ctx = sized.ctx;
  palette = readPalette();

  paint(bins, max, sized.cssW, sized.cssH);
  updateAxis(startMs, endMs);
}

// ===================== Тултип =====================

/**
 * Определяет бин под курсором по clientX. Возвращает { idx, bin }
 * или null, если курсор вне канваса.
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

function showTooltip(clientX, clientY, bin) {
  const tt = dom.sparklineTooltip;
  if (!tt) return;
  const t0 = new Date(bin.t0);
  const t1 = new Date(bin.t1);
  // Длительность бина — для контекста («ах, это 30-секундный интервал»).
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

  // Тултип позиционируется относительно .sparkline-wrap (position: relative).
  // Сначала делаем display: block, чтобы получить реальные размеры,
  // затем корректируем left/top, чтобы не вылезти за края контейнера.
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

function zoomToBin(bin) {
  if (!bin || bin.total === 0) return;
  // Маленький запас (полбина) с каждой стороны, чтобы в фильтр попали
  // соседние записи — это удобно, если событие случилось ровно на
  // границе бина.
  const pad = (bin.t1 - bin.t0) * 0.5;
  const fromMs = Math.floor(bin.t0 - pad);
  const toMs   = Math.ceil(bin.t1 + pad);
  dom.timeFrom.value = msToDatetimeLocalValue(fromMs);
  dom.timeTo.value   = msToDatetimeLocalValue(toMs);
  // Программная установка .value НЕ триггерит input/change — диспатчим
  // вручную, чтобы render() и подсветка пресетов сработали.
  dom.timeFrom.dispatchEvent(new Event('input', { bubbles: true }));
  dom.timeTo.dispatchEvent(new Event('input', { bubbles: true }));
  // Снимаем подсветку у быстрых пресетов — у выбранного диапазона
  // нет соответствия среди «5 мин / 1 ч / ...».
  if (dom.quickRangeButtons) {
    dom.quickRangeButtons.forEach(b => b.classList.remove('active'));
  }
}

// ===================== Инициализация =====================

/**
 * Навешивает все обработчики событий. Должна вызываться один раз
 * из app.js после загрузки DOM (модули с type="module" грузятся с
 * defer-семантикой, так что DOM уже распарсен).
 */
export function attachSparklineHandlers() {
  // 1. Восстановить выбор окна из localStorage.
  try {
    const saved = parseInt(localStorage.getItem(LS_KEY_WINDOW) || '', 10);
    if (Number.isFinite(saved) && saved > 0) lastWindowMs = saved;
  } catch (e) { /* localStorage может быть недоступен (Safari Private) */ }

  // 2. Селектор окна.
  if (dom.sparklineWindow) {
    // Аккуратно выставляем текущее значение, только если оно есть в опциях —
    // иначе селектор откатится к первой опции при первом render() и собьёт
    // нашу `lastWindowMs`.
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

  // 3. Кнопка «Свернуть / Развернуть».
  //    Намеренно НЕ прячем всю секцию: пользователь должен иметь
  //    возможность развернуть её обратно, поэтому шапка с кнопкой
  //    остаётся видимой и в свёрнутом состоянии.
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

  // 4. Канвас: тултип и клик.
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

  // 5. Ресайз окна — канвас зависит от ширины контейнера.
  // Не дёргаем renderSparkline() напрямую: rAF-дроссель внутри.
  window.addEventListener('resize', () => renderSparkline());

  // 6. Тик в live-режиме: даже если новых записей не приходило,
  // окно «сейчас» должно сдвигаться, иначе справа будет расти
  // пустой хвост.
  setInterval(() => {
    if (state.liveStreams.size > 0 && !state.liveStreamPaused) {
      renderSparkline();
    }
  }, LIVE_TICK_MS);

  // 7. Смена темы: цвета палитры нужно перечитать из CSS-переменных.
  // MutationObserver на data-theme дешевле, чем подписка на событие
  // через CustomEvent — никакой синхронизации с app.js не требуется.
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

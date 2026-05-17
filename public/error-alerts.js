/**
 * Браузерные уведомления и звуковой сигнал на новые ERROR в live-режиме.
 *
 * Идея: в live-режиме легко пропустить важную ошибку — глаз отвлекается или
 * вкладка в фоне. Этот модуль умеет:
 *   • показать desktop-уведомление (Notification API) — даже если вкладка
 *     не в фокусе или свёрнута;
 *   • проиграть короткий двутональный «бип» (Web Audio API, без внешних
 *     аудио-файлов).
 *
 * Каждая фича включается своей галочкой в шапке (🔔 / 🔊). Выбор сохраняется
 * в localStorage и переживает перезагрузку страницы.
 *
 * Ключевые решения:
 *   • Срабатывает ТОЛЬКО когда есть активные live-потоки и пауза НЕ включена.
 *   • Не сигналим про первый батч строк — это исторический хвост.
 *     Алерты должны отражать «новые» события, а не историю.
 *   • Throttle: уведомления не чаще раза в 5 секунд, звук — в 2 секунды.
 *     Иначе шквал ошибок забьёт ОС-уведомлениями и устроит длинный бип.
 *   • Desktop-уведомления показываем только когда вкладка не видна
 *     (document.hidden). Если пользователь смотрит — он видит запись в списке.
 *   • AudioContext создаём лениво и в ответ на жест пользователя — иначе
 *     Chrome/Safari блокируют автозапуск звука.
 */

import { state, dom } from './state.js';
import { toast } from './toast.js';

// Настройки модуля
const STORAGE_KEY_NOTIFY = 'errorNotifyEnabled';
const STORAGE_KEY_SOUND  = 'errorSoundEnabled';

// Минимальный интервал между десктоп-уведомлениями (5 секунд)
const NOTIFY_THROTTLE_MS = 5000;

// Минимальный интервал между звуковыми сигналами (2 секунды)
const SOUND_THROTTLE_MS = 2000;

// Внутреннее состояние модуля
let notifyEnabled = false;
let soundEnabled  = false;
let lastNotifyMs  = 0;
let lastSoundMs   = 0;
let audioCtx      = null;

function loadSettings() {
  try {
    notifyEnabled = localStorage.getItem(STORAGE_KEY_NOTIFY) === '1';
    soundEnabled  = localStorage.getItem(STORAGE_KEY_SOUND)  === '1';
  } catch (e) {}
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY_NOTIFY, notifyEnabled ? '1' : '0');
    localStorage.setItem(STORAGE_KEY_SOUND,  soundEnabled  ? '1' : '0');
  } catch (e) {}
}

export function isNotifyEnabled() { return notifyEnabled; }
export function isSoundEnabled()  { return soundEnabled; }

/**
 * Включает/выключает desktop-уведомления. При включении запрашивает
 * разрешение у браузера.
 *
 * @param {boolean} enabled
 * @returns {Promise<boolean>} true, если режим успешно установлен
 */
export async function setNotifyEnabled(enabled) {
  if (!enabled) {
    notifyEnabled = false;
    saveSettings();
    return true;
  }

  if (!('Notification' in window)) {
    toast.warn('Этот браузер не поддерживает Notification API', {
      title: 'Уведомления недоступны'
    });
    return false;
  }

  // Если уже отказано — больше спросить не получится
  if (Notification.permission === 'denied') {
    toast.warn(
      'Уведомления заблокированы. Разрешите их вручную в настройках сайта в браузере.',
      { title: 'Нет разрешения на уведомления' }
    );
    return false;
  }

  if (Notification.permission === 'default') {
    let perm;
    try {
      perm = await Notification.requestPermission();
    } catch (e) {
      // Старый Safari возвращает callback-стиль
      perm = await new Promise(resolve => Notification.requestPermission(resolve));
    }
    if (perm !== 'granted') {
      toast.info('Уведомления остались выключенными', {
        title: 'Можно включить позже в настройках сайта'
      });
      return false;
    }
  }

  notifyEnabled = true;
  saveSettings();
  return true;
}

/**
 * Формирует заголовок и тело для desktop-уведомления.
 *
 * @param {Array<{level?:string, msg?:string, _serviceKey?:string, _fileName?:string}>} errors
 * @returns {{title: string, body: string}}
 */
export function formatErrorNotification(errors) {
  const count = errors.length;
  const first = errors[0] || {};
  const title = count > 1
    ? `Новые ERROR в логах: ${count}`
    : 'Новая ERROR-запись в логах';

  const parts = [];
  if (first._serviceKey) parts.push(`[${first._serviceKey}]`);
  if (first.msg) parts.push(String(first.msg));
  let body = parts.join(' ').trim() || 'Подробности — в окне просмотрщика логов.';

  // Обрезаем длинные body — Telegram/Slack/macOS обрезают на 200–400 символов
  if (body.length > 220) body = body.slice(0, 217) + '…';

  return { title, body };
}

function maybeShowNotification(errors) {
  if (!notifyEnabled) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  // На переднем плане desktop-уведомления только мешают
  if (!document.hidden) return;

  const now = Date.now();
  if (now - lastNotifyMs < NOTIFY_THROTTLE_MS) return;
  lastNotifyMs = now;

  const { title, body } = formatErrorNotification(errors);
  try {
    const notif = new Notification(title, {
      body,
      // tag + renotify: новые уведомления заменяют предыдущее, а не стекаются
      tag: 'log-viewer-error',
      renotify: true,
      silent: true
    });
    notif.onclick = () => {
      try { window.focus(); } catch (e) {}
      try { notif.close(); } catch (e) {}
    };
    // Автозакрытие через 7 секунд, чтобы не копились в Action Center
    setTimeout(() => { try { notif.close(); } catch (e) {} }, 7000);
  } catch (err) {
    // Service-worker-based notification может ругаться на http
    console.error('Не удалось показать уведомление:', err);
  }
}

// ====================== Web Audio: короткий «бип» ======================

function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    audioCtx = new AC();
  } catch (e) {
    return null;
  }
  return audioCtx;
}

/**
 * Проигрывает короткий двухтональный сигнал (880Hz → 660Hz).
 * 
 * @returns {Promise<void>} Promise, который резолвится когда звук начался
 */
export function playBeep() {
  const ctx = ensureAudioCtx();
  if (!ctx) return Promise.resolve();

  // Браузер может приостановить AudioContext, если не было жеста пользователя
  const ready = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
  return ready.then(() => {
    const now = ctx.currentTime;
    const tones = [
      { freq: 880, start: 0.00, dur: 0.09 },
      { freq: 660, start: 0.12, dur: 0.09 }
    ];
    for (const t of tones) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = t.freq;

      // ADSR-огибающая для плавного старта/стопа без щелчков.
      // exponentialRampTo требует значения > 0
      const startT = now + t.start;
      const peakT  = startT + 0.012;
      const endT   = startT + t.dur;
      gain.gain.setValueAtTime(0.0001, startT);
      gain.gain.exponentialRampToValueAtTime(0.18, peakT);
      gain.gain.exponentialRampToValueAtTime(0.0001, endT);

      osc.connect(gain).connect(ctx.destination);
      osc.start(startT);
      osc.stop(endT + 0.02);
    }
  }).catch(() => {});
}

/**
 * Включает/выключает звуковой сигнал. При включении сразу проигрывает
 * тестовый «бип».
 *
 * @param {boolean} enabled
 * @returns {Promise<boolean>} true, если настройка успешно применена
 */
export async function setSoundEnabled(enabled) {
  if (!enabled) {
    soundEnabled = false;
    saveSettings();
    return true;
  }

  const ctx = ensureAudioCtx();
  if (!ctx) {
    toast.warn('Этот браузер не поддерживает Web Audio API', {
      title: 'Звуковые сигналы недоступны'
    });
    return false;
  }

  // Это вызывается из обработчика клика — жест пользователя есть
  await playBeep();

  soundEnabled = true;
  saveSettings();
  return true;
}

function maybePlaySound() {
  if (!soundEnabled) return;
  const now = Date.now();
  if (now - lastSoundMs < SOUND_THROTTLE_MS) return;
  lastSoundMs = now;
  playBeep();
}

/**
 * Обрабатывает свежие записи, только что добавленные в state.allLogs.
 * Вызывается из sse-client.js на каждое событие file-lines (кроме первого батча).
 *
 * Делает что-то, только если:
 *   • активна хотя бы одна live-фича (уведомления или звук);
 *   • есть активные live-потоки;
 *   • live-режим НЕ на паузе;
 *   • среди новых записей есть хотя бы одна ERROR.
 *
 * @param {Array} newEntries — массив новых записей
 */
export function handleNewLiveEntries(newEntries) {
  if (!notifyEnabled && !soundEnabled) return;
  if (!newEntries || newEntries.length === 0) return;
  if (state.liveStreams.size === 0) return;
  if (state.liveStreamPaused) return;

  // Уровень нормализуем — в JSON могут писать 'Error', 'error', 'ERR'
  const errors = newEntries.filter(e => {
    const lvl = String(e.level || '').toUpperCase();
    return lvl === 'ERROR' || lvl === 'ERR' || lvl === 'FATAL' || lvl === 'CRITICAL';
  });
  if (errors.length === 0) return;

  // Сначала звук — он мгновенный
  maybePlaySound();
  maybeShowNotification(errors);
}

/**
 * Навешивает обработчики на чекбоксы уведомлений и звука,
 * и синхронизирует их состояние с сохранёнными настройками.
 * Вызывается из app.js один раз при старте.
 */
export function attachErrorAlertHandlers() {
  loadSettings();

  const notifyBox = dom.notifyOnErrorToggle || document.getElementById('notifyOnErrorToggle');
  const soundBox  = dom.soundOnErrorToggle  || document.getElementById('soundOnErrorToggle');

  if (notifyBox) {
    notifyBox.checked = notifyEnabled && hasGrantedNotificationPermission();
    syncNotifyTooltip(notifyBox);

    notifyBox.addEventListener('change', async (e) => {
      const want = e.target.checked;
      const ok = await setNotifyEnabled(want);
      if (!ok) e.target.checked = false;
      syncNotifyTooltip(notifyBox);
    });
  }

  if (soundBox) {
    soundBox.checked = soundEnabled;
    soundBox.title = 'Звуковой сигнал при появлении ERROR в live-режиме';
    soundBox.addEventListener('change', async (e) => {
      const want = e.target.checked;
      const ok = await setSoundEnabled(want);
      if (!ok) e.target.checked = false;
    });
  }
}

function hasGrantedNotificationPermission() {
  if (!('Notification' in window)) return false;
  return Notification.permission === 'granted';
}

function syncNotifyTooltip(box) {
  let title = 'Браузерные уведомления о новых ERROR в live-режиме';
  if (!('Notification' in window)) {
    title = 'Уведомления не поддерживаются в этом браузере';
    box.disabled = true;
  } else if (Notification.permission === 'denied') {
    title += ' (заблокированы в настройках сайта — измените их в браузере)';
  }
  box.title = title;
}

// Утилиты для тестов
export const __internal__ = {
  NOTIFY_THROTTLE_MS,
  SOUND_THROTTLE_MS,
  STORAGE_KEY_NOTIFY,
  STORAGE_KEY_SOUND
};

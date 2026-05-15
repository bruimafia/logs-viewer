// Браузерные уведомления и звуковой сигнал на новые ERROR в live-режиме
// (пункты 3.2 и 3.3 плана улучшений).
//
// Идея. В live-режиме легко пропустить важную ошибку: глаз отвлекается, или
// вкладка вообще в фоне. Этот модуль умеет:
//   • показать desktop-уведомление (Notification API) — даже если вкладка
//     не в фокусе или свёрнута;
//   • проиграть короткий двутональный «бип» (Web Audio API, без внешних
//     аудио-файлов) — звуковой сигнал, на который обращаешь внимание,
//     даже если в наушниках идёт музыка.
//
// Каждая фича включается своей галочкой в шапке (🔔 / 🔊). Выбор сохраняется
// в localStorage и переживает перезагрузку страницы.
//
// Дизайн-решения:
//   • Срабатывает ТОЛЬКО когда есть активные live-потоки и пауза НЕ включена
//     (пауза = «тише, я читаю»; алерты в этом режиме мешали бы).
//   • Не сигналим про первый батч строк — это исторический хвост (initial
//     lines, обычно 100 последних строк до подключения). Алерты должны
//     отражать «новые» события, а не историю. Решение принимает sse-client.js
//     (он знает, какая партия — первая), сюда приходят уже отфильтрованные.
//   • Throttle: уведомления не чаще раза в NOTIFY_THROTTLE_MS, звук — в
//     SOUND_THROTTLE_MS. Иначе шквал ошибок забьёт ОС-уведомлениями и
//     устроит длинный беспрерывный бип.
//   • Desktop-уведомления показываем только когда вкладка не видна
//     (document.hidden). Если пользователь и так смотрит — он видит запись
//     в списке, ещё одно «всплывающее окно» только раздражает. Звук
//     отыгрывается всегда (когда фича включена), он короткий и адресный.
//   • AudioContext создаём лениво и в ответ на жест пользователя
//     (клик по галочке) — иначе Chrome/Safari блокируют автозапуск звука.
//   • Самодостаточный модуль: импортируется и из sse-client.js, и из app.js,
//     но сам не зависит от render/sse — только от state (для проверки
//     live-флагов) и toast (для пользовательских сообщений).

import { state, dom } from './state.js';
import { toast } from './toast.js';

// ====================== Настройки ======================

const STORAGE_KEY_NOTIFY = 'errorNotifyEnabled';
const STORAGE_KEY_SOUND  = 'errorSoundEnabled';

// Минимальный интервал между десктоп-уведомлениями. 5 секунд — компромисс:
// не теряем редкие ошибки, не спамим если 200 ERROR прилетают за секунду.
const NOTIFY_THROTTLE_MS = 5000;

// Звук короткий (~200мс), но 2 секунды между «бипами» дают ушам отдохнуть
// и не превращают шквал ERROR в непрерывный гудок.
const SOUND_THROTTLE_MS = 2000;

// ====================== Состояние модуля ======================

let notifyEnabled = false;
let soundEnabled  = false;
let lastNotifyMs  = 0;
let lastSoundMs   = 0;
let audioCtx      = null;  // создаём лениво — см. ensureAudioCtx

function loadSettings() {
  try {
    notifyEnabled = localStorage.getItem(STORAGE_KEY_NOTIFY) === '1';
    soundEnabled  = localStorage.getItem(STORAGE_KEY_SOUND)  === '1';
  } catch (e) { /* приватный режим / quota — игнорируем */ }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY_NOTIFY, notifyEnabled ? '1' : '0');
    localStorage.setItem(STORAGE_KEY_SOUND,  soundEnabled  ? '1' : '0');
  } catch (e) {}
}

export function isNotifyEnabled() { return notifyEnabled; }
export function isSoundEnabled()  { return soundEnabled; }

// ====================== Notification API ======================

/**
 * Включает/выключает desktop-уведомления. При включении запрашивает
 * разрешение у браузера. Возвращает true, если режим действительно
 * стал требуемым (например, при отказе в разрешении вернёт false).
 *
 * @param {boolean} enabled
 * @returns {Promise<boolean>}
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

  // Если уже отказано — больше спросить не получится, говорим об этом честно.
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
      // Старый Safari возвращает callback-стиль; для совместимости
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
 * Вынесено в чистую функцию, чтобы можно было тестировать в Node.
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

  // Telegram/Slack/macOS обрезают длинные body на 200–400 символов; режем
  // сами, чтобы вместо хвоста сообщения не висели «…». 220 — точка ближе
  // к самой щадящей платформе.
  if (body.length > 220) body = body.slice(0, 217) + '…';

  return { title, body };
}

function maybeShowNotification(errors) {
  if (!notifyEnabled) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  // На переднем плане desktop-уведомления только мешают — пользователь
  // и так увидит запись в списке. Полезны именно когда вкладка в фоне.
  if (!document.hidden) return;

  const now = Date.now();
  if (now - lastNotifyMs < NOTIFY_THROTTLE_MS) return;
  lastNotifyMs = now;

  const { title, body } = formatErrorNotification(errors);
  try {
    const notif = new Notification(title, {
      body,
      // tag + renotify=true: новые уведомления заменяют предыдущее
      // вместо стека — окно ОС не превращается в простыню.
      tag: 'log-viewer-error',
      renotify: true,
      // Звук — отдельная опция; пусть ОС не дублирует наш «бип».
      silent: true
    });
    notif.onclick = () => {
      try { window.focus(); } catch (e) {}
      try { notif.close(); } catch (e) {}
    };
    // На некоторых ОС уведомления висят до клика — закрываем сами через
    // 7 секунд, чтобы не копились в Action Center.
    setTimeout(() => { try { notif.close(); } catch (e) {} }, 7000);
  } catch (err) {
    // Service-worker-based notification может ругаться, если страница
    // не serving с https. В chat'е это редкость, просто не падаем.
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
 * Проигрывает короткий двухтональный сигнал (880Hz → 660Hz). Возвращает
 * Promise, который резолвится, когда звук точно начался (или сразу,
 * если воспроизвести не удалось).
 */
export function playBeep() {
  const ctx = ensureAudioCtx();
  if (!ctx) return Promise.resolve();

  // Браузер может приостановить AudioContext, если не было жеста
  // пользователя. resume() безопасно вызывать в любом состоянии.
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

      // ADSR-огибающая, чтобы не было щелчка при старте/стопе.
      // exponentialRampTo требует значения > 0, поэтому стартуем с 0.0001.
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
  }).catch(() => { /* воспроизведение могло быть заблокировано — молча */ });
}

/**
 * Включает/выключает звуковой сигнал. При включении сразу проигрывает
 * тестовый «бип» (пользователь слышит, что фича теперь работает —
 * заодно убеждаемся, что AudioContext разрешён в этом контексте).
 *
 * Возвращает Promise<boolean> — успешно ли применили настройку.
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

  // Это вызывается из обработчика клика по галочке — жест пользователя
  // есть, AudioContext должен разрешить resume() и проигрывание.
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

// ====================== Точка интеграции с live-стримом ======================

/**
 * Обрабатывает свежие записи, только что добавленные в state.allLogs
 * через addLinesToLogs(). Вызывается из sse-client.js на каждое событие
 * file-lines (кроме первого батча — исторического хвоста).
 *
 * Делает что-то, только если:
 *   • активна хотя бы одна live-фича (уведомления или звук);
 *   • есть активные live-потоки;
 *   • live-режим НЕ на паузе;
 *   • среди новых записей есть хотя бы одна ERROR.
 *
 * @param {Array} newEntries — массив новых записей (с полями level, msg, _serviceKey, …)
 */
export function handleNewLiveEntries(newEntries) {
  if (!notifyEnabled && !soundEnabled) return;
  if (!newEntries || newEntries.length === 0) return;
  if (state.liveStreams.size === 0) return;
  if (state.liveStreamPaused) return;

  // Уровень нормализуем — в JSON могут писать 'Error', 'error', 'ERR' и т.п.
  // Считаем ошибкой что угодно, начинающееся с 'err' (включая 'ERROR', 'ERR').
  const errors = newEntries.filter(e => {
    const lvl = String(e.level || '').toUpperCase();
    return lvl === 'ERROR' || lvl === 'ERR' || lvl === 'FATAL' || lvl === 'CRITICAL';
  });
  if (errors.length === 0) return;

  // Сначала звук — он мгновенный; уведомление может дольше обрабатываться
  // системой и в этот момент мы хотим, чтобы пользователь УЖЕ услышал бип.
  maybePlaySound();
  maybeShowNotification(errors);
}

// ====================== UI: галочки 🔔 / 🔊 в шапке ======================

/**
 * Навешивает обработчики на чекбоксы #notifyOnErrorToggle и
 * #soundOnErrorToggle (если они присутствуют в разметке), и
 * синхронизирует их состояние с сохранёнными настройками.
 *
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

// ====================== Утилиты для тестов ======================
// Экспортируем константы — пригодятся, если кто-то захочет покрыть
// formatErrorNotification юнит-тестами или подменить throttle.
export const __internal__ = {
  NOTIFY_THROTTLE_MS,
  SOUND_THROTTLE_MS,
  STORAGE_KEY_NOTIFY,
  STORAGE_KEY_SOUND
};

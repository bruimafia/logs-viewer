// Toast-уведомления (пункт 6.1 плана улучшений).
//
// Заменяют нативные `alert()` / `confirm()`: неблокирующие, окрашены
// по уровню (error/warn/info/success), автоматически скрываются.
// Стек тостов отображается в правом нижнем углу.
//
// Контейнер `#toastContainer` обычно присутствует в разметке (см.
// index.html). Если его нет — он создаётся «на лету» при первом вызове,
// чтобы модуль был самодостаточным.
//
// Этот модуль не зависит от state/render/sse-client, поэтому может
// безопасно импортироваться откуда угодно.

const VALID_TYPES = new Set(['success', 'info', 'warn', 'error']);

// Дефолтные длительности подобраны по уровням: чем серьёзнее тип —
// тем дольше тост висит. duration: 0 — тост не скрывается автоматически.
const DEFAULT_DURATION = {
  success: 3500,
  info:    4000,
  warn:    5000,
  error:   6000
};

const ICONS = {
  success: '✓',
  info:    'ℹ',
  warn:    '⚠',
  error:   '✕'
};

function getContainer() {
  let el = document.getElementById('toastContainer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toastContainer';
    el.className = 'toast-container';
    document.body.appendChild(el);
  }
  return el;
}

function normalizeType(t) {
  return VALID_TYPES.has(t) ? t : 'info';
}

/**
 * Показать toast-уведомление.
 *
 * @param {('success'|'info'|'warn'|'error')} type
 * @param {string} message — основной текст (можно с переносами строк).
 * @param {object} [options]
 * @param {string} [options.title] — заголовок над сообщением.
 * @param {number} [options.duration] — мс до автоскрытия; 0 = не скрывать.
 * @returns {{ close: () => void, el: HTMLElement }}
 */
export function showToast(type, message, options = {}) {
  const t = normalizeType(type);
  const duration = options.duration != null ? options.duration : DEFAULT_DURATION[t];
  const container = getContainer();

  const el = document.createElement('div');
  el.className = `toast toast-${t}`;
  // Скринридерам сообщаем об ошибках/предупреждениях сразу (assertive),
  // об остальном — мягко (polite).
  const isAlerty = t === 'error' || t === 'warn';
  el.setAttribute('role', isAlerty ? 'alert' : 'status');
  el.setAttribute('aria-live', isAlerty ? 'assertive' : 'polite');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = ICONS[t];

  const content = document.createElement('div');
  content.className = 'toast-content';
  if (options.title) {
    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = String(options.title);
    content.appendChild(title);
  }
  const msg = document.createElement('div');
  msg.className = 'toast-message';
  msg.textContent = String(message ?? '');
  content.appendChild(msg);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Закрыть уведомление');
  closeBtn.textContent = '×';

  el.appendChild(icon);
  el.appendChild(content);
  el.appendChild(closeBtn);
  container.appendChild(el);

  let hideTimer = null;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    el.classList.add('toast-hide');
    el.addEventListener('animationend', () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, { once: true });
  }

  closeBtn.addEventListener('click', close);

  if (duration > 0) {
    hideTimer = setTimeout(close, duration);
    // Если пользователь навёл курсор — приостанавливаем автоскрытие,
    // пока он читает. На уход курсора — даём короткое доп. время.
    el.addEventListener('mouseenter', () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
    el.addEventListener('mouseleave', () => {
      if (!closed) hideTimer = setTimeout(close, 1500);
    });
  }

  return { close, el };
}

// Удобные обёртки для конкретных уровней.
export const toast = {
  success: (m, o) => showToast('success', m, o),
  info:    (m, o) => showToast('info',    m, o),
  warn:    (m, o) => showToast('warn',    m, o),
  error:   (m, o) => showToast('error',   m, o)
};

/**
 * Замена блокирующего `window.confirm()` в виде toast'а с двумя кнопками.
 * Возвращает Promise<boolean>: `true` — пользователь подтвердил,
 * `false` — отменил (включая закрытие крестиком или Esc).
 *
 * Не скрывается автоматически — ждёт явного ответа пользователя.
 *
 * @param {string} message
 * @param {object} [options]
 * @param {string} [options.title] — заголовок.
 * @param {('success'|'info'|'warn'|'error')} [options.type='warn']
 *   Цветовая гамма; по умолчанию warn, потому что confirm обычно
 *   вызывается перед потенциально нежелательным действием.
 * @param {string} [options.confirmText='Подтвердить']
 * @param {string} [options.cancelText='Отмена']
 * @param {boolean} [options.danger=false] — окрасить кнопку
 *   подтверждения красным (для деструктивных действий).
 * @returns {Promise<boolean>}
 */
export function toastConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const type = normalizeType(options.type || 'warn');
    const container = getContainer();

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-live', 'assertive');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ICONS[type];

    const content = document.createElement('div');
    content.className = 'toast-content';
    if (options.title) {
      const title = document.createElement('div');
      title.className = 'toast-title';
      title.textContent = String(options.title);
      content.appendChild(title);
    }
    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = String(message ?? '');
    content.appendChild(msg);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Закрыть уведомление');
    closeBtn.textContent = '×';

    const actions = document.createElement('div');
    actions.className = 'toast-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'toast-action-btn';
    cancelBtn.textContent = options.cancelText || 'Отмена';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'toast-action-btn ' + (options.danger ? 'danger' : 'primary');
    confirmBtn.textContent = options.confirmText || 'Подтвердить';
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(closeBtn);
    el.appendChild(actions);
    container.appendChild(el);

    let resolved = false;
    function finish(result) {
      if (resolved) return;
      resolved = true;
      document.removeEventListener('keydown', onKey, true);
      el.classList.add('toast-hide');
      el.addEventListener('animationend', () => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, { once: true });
      resolve(result);
    }

    closeBtn.addEventListener('click', () => finish(false));
    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));

    // Esc — отмена. Перехватываем на capture-фазе, чтобы сработать
    // даже если фокус не на самом тосте.
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    }
    document.addEventListener('keydown', onKey, true);

    // Фокус на кнопку подтверждения, чтобы Enter сразу её активировал.
    setTimeout(() => confirmBtn.focus(), 0);
  });
}

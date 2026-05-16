// Модальное окно «Удалённые файлы»: выбор сервера/файла, выбор режима
// загрузки, тест соединения. Управление конфигурацией серверов (7.1).
// Glob-паттерны и их превью (7.2). Загрузки делегируются sse-client.js.

import { state, dom } from './state.js';
import { escapeHtml } from './utils.js';
import { LIVE_BUFFER_CAP } from './state.js';
import { loadTailMode, loadRangeMode, startLiveMode } from './sse-client.js';
import { toast } from './toast.js';

// ====================== Состояние модального окна ======================

// Текущая активная вкладка: 'files' | 'servers'
let currentTab = 'files';

// Состояние редактора серверов: null | serverId | '__new__'
let editingServerId = null;

// Состояние редактора файлов: null | 'serverId::fileId' | 'serverId::__new__'
let editingFileKey = null;

// Хранит открытые (развёрнутые) серверы в настройках. Живёт дольше рендера.
const settingsExpandedServers = new Set();

// ====================== Открытие / закрытие ======================

export async function openRemoteModal() {
  state.selectedFiles.clear();
  dom.loadRemoteBtn.disabled = true;
  dom.remoteModal.classList.add('active');

  attachTabListeners();
  updateTabVisuals();
  await loadConfig();
}

export function closeRemoteModal() {
  dom.remoteModal.classList.remove('active');
}

// ====================== Вспомогательные функции ======================

async function loadConfig() {
  dom.remoteModalBody.innerHTML = `
    <div style="text-align: center; padding: 40px;">
      <div class="loading-spinner"></div>
      <p style="margin-top: 12px;">Загрузка конфигурации...</p>
    </div>
  `;
  try {
    const response = await fetch('/api/config');
    state.remoteConfig = await response.json();
    renderCurrentTab();
  } catch (err) {
    dom.remoteModalBody.innerHTML = `
      <div class="error-message">
        <p><strong>Ошибка загрузки конфигурации</strong></p>
        <p>${escapeHtml(err.message)}</p>
        <p style="margin-top: 12px;">Убедитесь, что сервер запущен: <code>npm start</code></p>
      </div>
    `;
  }
}

function renderCurrentTab() {
  if (currentTab === 'files') {
    renderFilesTab();
  } else {
    renderSettingsTab();
  }
}

function attachTabListeners() {
  // Пересоздаём кнопки, чтобы избежать накопления дублирующих обработчиков.
  document.querySelectorAll('#remoteModalTabs .modal-tab').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => switchTab(newBtn.dataset.tab));
  });
}

function updateTabVisuals() {
  document.querySelectorAll('#remoteModalTabs .modal-tab').forEach(btn => {
    const isActive = btn.dataset.tab === currentTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  // Кнопка загрузки доступна только на вкладке выбора файлов.
  dom.loadRemoteBtn.style.display = (currentTab === 'files') ? '' : 'none';
}

// ====================== Переключение вкладок ======================

function switchTab(tab) {
  if (tab === currentTab) return;
  currentTab = tab;
  editingServerId = null;
  editingFileKey = null;
  updateTabVisuals();
  renderCurrentTab();
}

// ====================== Вкладка «Выбрать файлы» ======================

function renderFilesTab() {
  const remoteConfig = state.remoteConfig;
  if (!remoteConfig || !remoteConfig.servers || remoteConfig.servers.length === 0) {
    dom.remoteModalBody.innerHTML = `
      <div class="no-servers">
        <p>Нет настроенных серверов.</p>
        <p>Перейдите на вкладку <strong>⚙ Серверы</strong>, чтобы добавить серверы и файлы.</p>
      </div>
    `;
    return;
  }

  let html = `
    <!-- Селектор режима -->
    <div class="load-mode-selector" id="loadModeSelector">
      <label class="load-mode-option" data-mode="tail">
        <input type="radio" name="loadMode" value="tail" checked>
        <span class="load-mode-option-icon">⇣</span>
        <span>Хвост</span>
      </label>
      <label class="load-mode-option" data-mode="range">
        <input type="radio" name="loadMode" value="range">
        <span class="load-mode-option-icon">⇋</span>
        <span>Диапазон дат</span>
      </label>
      <label class="load-mode-option" data-mode="live">
        <input type="radio" name="loadMode" value="live">
        <span class="load-mode-option-icon">●</span>
        <span>Live</span>
      </label>
    </div>

    <!-- Серверный поиск (пункт 5.3) — общее поле для режимов «Хвост» и «Диапазон» -->
    <div class="mode-config mode-config-shared" id="config-shared-grep">
      <span class="mode-config-label">Содержит (опционально) — серверный grep до загрузки</span>
      <div class="mode-config-row mode-config-row-grep">
        <input type="text" id="remoteGrepPattern"
               placeholder="напр.: ERROR, traceId=abc123, /timeout|deadline/"
               autocomplete="off"
               spellcheck="false">
        <label class="grep-flag-label" title="Использовать регулярное выражение (ERE: . * + ? ( ) | [ ] { } ^ $ \\)">
          <input type="checkbox" id="remoteGrepRegex">
          <span>.* regex</span>
        </label>
        <label class="grep-flag-label" title="Игнорировать регистр (-i)">
          <input type="checkbox" id="remoteGrepCaseInsensitive" checked>
          <span>Aa</span>
        </label>
      </div>
      <div class="mode-hint">
        Фильтрация выполняется на сервере (<code>grep</code>) ДО <code>tail</code>
        в режиме «Хвост» и вместо SFTP-чтения всего файла в режиме «Диапазон».
        Радикально ускоряет работу с большими файлами.
        В режиме «Хвост» это «последние N <em>совпавших</em> строк».
      </div>
    </div>

    <!-- Конфигурация: Хвост -->
    <div class="mode-config" id="config-tail">
      <span class="mode-config-label">Загрузить N последних строк (быстро, через tail)</span>
      <div class="mode-config-row">
        <label>Строк: <input type="number" id="tailLines" value="1000" min="10" max="100000" step="100"></label>
      </div>
      <div class="mode-hint">
        После загрузки в списке появится кнопка «↑ Загрузить ещё», которая подгрузит следующую страницу той же длины с каждого выбранного файла.
      </div>
    </div>

    <!-- Конфигурация: Диапазон дат -->
    <div class="mode-config" id="config-range" style="display:none;">
      <span class="mode-config-label">Период загрузки (оставьте пустым для загрузки всего файла)</span>
      <div class="mode-config-row">
        <label>От: <input type="datetime-local" id="remoteDateFrom" step="1"></label>
        <label>До: <input type="datetime-local" id="remoteDateTo" step="1"></label>
      </div>
      <div class="mode-config-row level-filter-remote">
        <span class="mode-config-label" style="margin-bottom: 4px;">Уровни (фильтрация на сервере, пункт 5.2):</span>
        <div class="remote-level-checks">
          <label class="remote-level-check"><input type="checkbox" id="remoteLevelError" value="ERROR" checked> ERROR</label>
          <label class="remote-level-check"><input type="checkbox" id="remoteLevelWarn" value="WARN" checked> WARN</label>
          <label class="remote-level-check"><input type="checkbox" id="remoteLevelInfo" value="INFO" checked> INFO</label>
          <label class="remote-level-check"><input type="checkbox" id="remoteLevelDebug" value="DEBUG" checked> DEBUG</label>
        </div>
      </div>
      <div class="mode-hint">
        Серверная фильтрация по уровню (<code>grep -E '"level":"(ERROR|WARN)"'</code>)
        выполняется ДО загрузки по SFTP — экономит трафик на больших файлах.
        Также работает с фильтром «Содержит» выше.
      </div>
    </div>

    <!-- Конфигурация: Live -->
    <div class="mode-config" id="config-live" style="display:none;">
      <span class="mode-config-label">Реальное время (tail -F): новые строки поступают мгновенно</span>
      <div class="mode-config-row">
        <label>Начальные строки: <input type="number" id="liveInitialLines" value="100" min="0" max="10000" step="10"></label>
      </div>
      <div class="mode-hint">
        Сначала будут показаны указанные начальные строки, затем новые записи будут появляться в реальном времени.
        Окно показа будет ограничено ${LIVE_BUFFER_CAP.toLocaleString('ru-RU')} записями (старые отбрасываются).
        После запуска модальное окно можно закрыть — потоки продолжат работать. Останавливайте их через индикатор LIVE в шапке.
      </div>
    </div>
  `;

  remoteConfig.servers.forEach(server => {
    html += `
      <div class="server-section" data-server-id="${server.id}">
        <div class="server-header" onclick="toggleServerFiles('${server.id}')">
          <div class="server-info">
            <span class="server-name">${escapeHtml(server.name)}</span>
            <span class="server-host">${escapeHtml(server.host)}:${server.port || 22}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="server-status pending" id="status-${server.id}">Проверка...</span>
            <button class="btn refresh-btn select-all-btn" onclick="event.stopPropagation(); toggleSelectAllServerFiles('${server.id}')" id="select-all-${server.id}" title="Выбрать/снять все файлы этого сервера">Выбрать все</button>
            <button class="btn refresh-btn" onclick="event.stopPropagation(); testServerConnection('${server.id}')" title="Проверить соединение">↻</button>
          </div>
        </div>
        <div class="server-files" id="files-${server.id}">
          ${server.files.map(file => {
            const key = `${server.id}::${file.id}`;
            const isLive = state.liveStreams.has(key);
            const isGlob = /[*?]/.test(file.remotePath);
            return `
            <div class="file-item ${isLive ? 'live-active' : ''}" onclick="toggleFileSelection('${server.id}', '${file.id}')" id="file-${server.id}-${file.id}">
              <input type="checkbox" class="file-checkbox" id="check-${server.id}-${file.id}" ${isLive ? 'disabled' : ''}>
              <div style="flex:1; min-width: 0;">
                <div class="file-name">
                  ${escapeHtml(file.name)}
                  ${isLive ? '<span class="file-live-badge">LIVE</span>' : ''}
                  ${isGlob ? '<span class="glob-badge" title="Glob-паттерн: сервер раскроет шаблон в реальные файлы при загрузке">glob</span>' : ''}
                </div>
                <div class="file-path">${escapeHtml(file.remotePath)}</div>
              </div>
            </div>
          `;
          }).join('')}
        </div>
      </div>
    `;
  });

  dom.remoteModalBody.innerHTML = html;

  remoteConfig.servers.forEach(server => updateSelectAllBtnState(server.id));

  document.querySelectorAll('#loadModeSelector .load-mode-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const mode = opt.dataset.mode;
      setLoadMode(mode);
    });
  });
  setLoadMode(state.currentLoadMode);

  remoteConfig.servers.forEach(server => testServerConnection(server.id));
}

function setLoadMode(mode) {
  state.currentLoadMode = mode;
  document.querySelectorAll('#loadModeSelector .load-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.mode === mode);
    const input = opt.querySelector('input');
    if (input) input.checked = (opt.dataset.mode === mode);
  });
  ['tail', 'range', 'live'].forEach(m => {
    const el = document.getElementById(`config-${m}`);
    if (el) el.style.display = (m === mode) ? '' : 'none';
  });
  const btnTexts = {
    tail: 'Загрузить хвост',
    range: 'Загрузить по диапазону',
    live: 'Запустить Live'
  };
  dom.loadRemoteBtn.textContent = btnTexts[mode];

  const sharedGrepEl = document.getElementById('config-shared-grep');
  if (sharedGrepEl) sharedGrepEl.style.display = (mode === 'live') ? 'none' : '';
}

// ====================== Вкладка «Серверы» ======================

function renderSettingsTab() {
  const servers = state.remoteConfig?.servers || [];

  let html = `<div class="settings-tab">`;

  if (servers.length === 0 && editingServerId !== '__new__') {
    html += `<p class="settings-empty">Нет настроенных серверов. Добавьте первый сервер ниже.</p>`;
  }

  servers.forEach(server => {
    if (editingServerId === server.id) {
      html += buildServerFormHtml(server);
    } else {
      html += buildServerCardHtml(server);
    }
  });

  if (editingServerId === '__new__') {
    html += buildServerFormHtml(null);
  } else {
    html += `
      <div class="settings-add-wrap">
        <button class="btn btn-success settings-add-btn" onclick="window.__rmAddServer()">+ Добавить сервер</button>
      </div>
    `;
  }

  html += `</div>`;
  dom.remoteModalBody.innerHTML = html;
}

function buildServerCardHtml(server) {
  const isExpanded = settingsExpandedServers.has(server.id);
  let filesHtml = '';

  if (isExpanded) {
    server.files.forEach(file => {
      if (editingFileKey === `${server.id}::${file.id}`) {
        filesHtml += buildFileFormHtml(server.id, file);
      } else {
        filesHtml += buildFileRowHtml(server.id, file);
      }
    });
    if (editingFileKey === `${server.id}::__new__`) {
      filesHtml += buildFileFormHtml(server.id, null);
    }
    if (editingFileKey !== `${server.id}::__new__`) {
      filesHtml += `
        <div class="settings-add-file-wrap">
          <button class="btn settings-add-file-btn" onclick="window.__rmAddFile('${server.id}')">+ Добавить файл</button>
        </div>
      `;
    }
  }

  return `
    <div class="settings-server-card" data-server-id="${server.id}">
      <div class="settings-server-row">
        <div class="settings-server-meta">
          <span class="settings-server-name">${escapeHtml(server.name)}</span>
          <span class="settings-server-addr">${escapeHtml(server.host)}:${server.port || 22}</span>
          <span class="settings-server-user">👤 ${escapeHtml(server.username || '')}</span>
        </div>
        <div class="settings-server-actions">
          <button class="btn" onclick="window.__rmEditServer('${server.id}')" title="Редактировать параметры сервера">✎ Редактировать</button>
          <button class="btn btn-danger" onclick="window.__rmDeleteServer('${server.id}')" title="Удалить сервер">✕</button>
        </div>
      </div>
      <div class="settings-files-section">
        <button class="settings-files-toggle" onclick="window.__rmToggleFiles('${server.id}')" aria-expanded="${isExpanded}">
          <span>Файлы (${server.files.length})</span>
          <span class="settings-files-arrow">${isExpanded ? '▲' : '▼'}</span>
        </button>
        ${isExpanded ? `<div class="settings-files-list">${filesHtml}</div>` : ''}
      </div>
    </div>
  `;
}

function buildServerFormHtml(server) {
  const isNew = !server;
  const sid = isNew ? '__new__' : server.id;
  const vals = {
    name: isNew ? '' : escapeHtml(server.name),
    host: isNew ? '' : escapeHtml(server.host),
    port: isNew ? '22' : (server.port || 22),
    username: isNew ? '' : escapeHtml(server.username || ''),
    password: isNew ? '' : '••••••••'
  };

  return `
    <div class="settings-server-form" data-server-id="${sid}">
      <div class="settings-form-title">${isNew ? 'Добавить сервер' : 'Редактировать сервер'}</div>
      <div class="settings-form-grid">
        <div class="settings-form-group">
          <label class="settings-form-label" for="sform-name-${sid}">Название *</label>
          <input class="settings-form-input" type="text" id="sform-name-${sid}"
                 value="${vals.name}" placeholder="Production" autocomplete="off">
        </div>
        <div class="settings-form-group">
          <label class="settings-form-label" for="sform-host-${sid}">Хост *</label>
          <input class="settings-form-input" type="text" id="sform-host-${sid}"
                 value="${vals.host}" placeholder="192.168.1.1" autocomplete="off">
        </div>
        <div class="settings-form-group settings-form-group-small">
          <label class="settings-form-label" for="sform-port-${sid}">Порт</label>
          <input class="settings-form-input" type="number" id="sform-port-${sid}"
                 value="${vals.port}" min="1" max="65535">
        </div>
        <div class="settings-form-group">
          <label class="settings-form-label" for="sform-user-${sid}">Пользователь *</label>
          <input class="settings-form-input" type="text" id="sform-user-${sid}"
                 value="${vals.username}" placeholder="ubuntu" autocomplete="off">
        </div>
        <div class="settings-form-group settings-form-group-full">
          <label class="settings-form-label" for="sform-pass-${sid}">Пароль${isNew ? ' *' : ''}</label>
          <div class="settings-password-wrap">
            <input class="settings-form-input" type="password" id="sform-pass-${sid}"
                   value="${vals.password}"
                   placeholder="${isNew ? 'Введите пароль' : 'Оставьте без изменений'}">
            <button class="settings-password-toggle" type="button"
                    onclick="window.__rmTogglePass('sform-pass-${sid}')"
                    title="Показать / скрыть пароль" aria-label="Показать пароль">👁</button>
          </div>
        </div>
      </div>
      <div class="settings-form-actions">
        <button class="btn" type="button" onclick="window.__rmTestConnForm('${sid}')">Проверить соединение</button>
        <span class="settings-conn-status" id="sform-conn-${sid}"></span>
        <div style="flex:1;"></div>
        <button class="btn" type="button" onclick="window.__rmCancelServer()">Отмена</button>
        <button class="btn btn-primary" type="button" onclick="window.__rmSaveServer('${sid}')">Сохранить</button>
      </div>
    </div>
  `;
}

function buildFileRowHtml(serverId, file) {
  const isGlob = /[*?]/.test(file.remotePath);
  return `
    <div class="settings-file-row">
      <div class="settings-file-info">
        <span class="settings-file-name">${escapeHtml(file.name)}</span>
        <span class="settings-file-path">${escapeHtml(file.remotePath)}</span>
        ${isGlob ? `<span class="glob-badge" title="Glob-паттерн: раскрывается сервером при загрузке">glob</span>` : ''}
      </div>
      <div class="settings-file-actions">
        <button class="btn btn-xs" onclick="window.__rmEditFile('${serverId}', '${file.id}')" title="Редактировать">✎</button>
        <button class="btn btn-xs btn-danger" onclick="window.__rmDeleteFile('${serverId}', '${file.id}')" title="Удалить">✕</button>
      </div>
    </div>
  `;
}

function buildFileFormHtml(serverId, file) {
  const isNew = !file;
  const fid = isNew ? '__new__' : file.id;
  // В ID элементов заменяем :: на __, чтобы избежать проблем с querySelector.
  const escapedKey = `${serverId}__${fid}`;

  return `
    <div class="settings-file-form">
      <div class="settings-form-title settings-form-title-sm">${isNew ? 'Добавить файл' : 'Редактировать файл'}</div>
      <div class="settings-file-form-grid">
        <div class="settings-form-group">
          <label class="settings-form-label" for="fform-name-${escapedKey}">Название *</label>
          <input class="settings-form-input" type="text" id="fform-name-${escapedKey}"
                 value="${isNew ? '' : escapeHtml(file.name)}" placeholder="app.log" autocomplete="off">
        </div>
        <div class="settings-form-group">
          <label class="settings-form-label" for="fform-path-${escapedKey}">Путь на сервере *</label>
          <div class="settings-file-path-wrap">
            <input class="settings-form-input" type="text" id="fform-path-${escapedKey}"
                   value="${isNew ? '' : escapeHtml(file.remotePath)}"
                   placeholder="/var/log/app/*.log" autocomplete="off" spellcheck="false">
            <button class="btn btn-xs" type="button"
                    onclick="window.__rmGlobPreview('${serverId}', '${escapedKey}')"
                    title="Просмотреть файлы, соответствующие паттерну">Просмотр</button>
          </div>
          <div class="settings-form-hint">Поддерживаются glob-паттерны: <code>/var/log/*.log</code>, <code>/logs/app-?.log</code></div>
          <div class="glob-preview-list" id="glob-preview-${escapedKey}"></div>
        </div>
      </div>
      <div class="settings-form-actions">
        <div style="flex:1;"></div>
        <button class="btn" type="button" onclick="window.__rmCancelFile()">Отмена</button>
        <button class="btn btn-primary" type="button" onclick="window.__rmSaveFile('${serverId}', '${fid}')">Сохранить</button>
      </div>
    </div>
  `;
}

// ====================== Обработчики настроек серверов ======================

async function settingsSaveServer(sid) {
  const isNew = sid === '__new__';

  const nameEl  = document.getElementById(`sform-name-${sid}`);
  const hostEl  = document.getElementById(`sform-host-${sid}`);
  const portEl  = document.getElementById(`sform-port-${sid}`);
  const userEl  = document.getElementById(`sform-user-${sid}`);
  const passEl  = document.getElementById(`sform-pass-${sid}`);

  [nameEl, hostEl, portEl, userEl, passEl].forEach(el => el?.classList.remove('input-error'));

  const name     = nameEl?.value.trim() || '';
  const host     = hostEl?.value.trim() || '';
  const port     = parseInt(portEl?.value) || 22;
  const username = userEl?.value.trim() || '';
  const password = passEl?.value || '';

  let hasError = false;
  if (!name)     { nameEl?.classList.add('input-error'); hasError = true; }
  if (!host)     { hostEl?.classList.add('input-error'); hasError = true; }
  if (!username) { userEl?.classList.add('input-error'); hasError = true; }
  if (isNew && !password) { passEl?.classList.add('input-error'); hasError = true; }
  if (port < 1 || port > 65535) { portEl?.classList.add('input-error'); hasError = true; }
  if (hasError) {
    toast.error('Заполните обязательные поля', { title: 'Ошибка валидации' });
    return;
  }

  const servers = [...(state.remoteConfig?.servers || [])];

  if (isNew) {
    servers.push({
      id: 'server-' + Date.now(),
      name, host, port, username, password,
      files: []
    });
  } else {
    const idx = servers.findIndex(s => s.id === sid);
    if (idx === -1) { toast.error('Сервер не найден'); return; }
    servers[idx] = { ...servers[idx], name, host, port, username, password };
  }

  await saveConfigToServer({ servers }, isNew ? 'Сервер добавлен' : 'Сервер обновлён');
  editingServerId = null;
}

async function settingsDeleteServer(sid) {
  const server = state.remoteConfig?.servers?.find(s => s.id === sid);
  if (!server) return;
  if (!confirm(`Удалить сервер «${server.name}»?\nФайлы на сервере не будут затронуты — удаляется только запись в конфигурации.`)) return;

  const servers = (state.remoteConfig?.servers || []).filter(s => s.id !== sid);
  settingsExpandedServers.delete(sid);
  await saveConfigToServer({ servers }, 'Сервер удалён', /*refetch=*/false);
  editingServerId = null;
  state.remoteConfig = { ...state.remoteConfig, servers };
  renderSettingsTab();
}

async function settingsSaveFile(serverId, fid) {
  const isNew = fid === '__new__';
  const escapedKey = `${serverId}__${fid}`;

  const nameEl = document.getElementById(`fform-name-${escapedKey}`);
  const pathEl = document.getElementById(`fform-path-${escapedKey}`);

  [nameEl, pathEl].forEach(el => el?.classList.remove('input-error'));

  const name       = nameEl?.value.trim() || '';
  const remotePath = pathEl?.value.trim() || '';

  let hasError = false;
  if (!name)       { nameEl?.classList.add('input-error'); hasError = true; }
  if (!remotePath) { pathEl?.classList.add('input-error'); hasError = true; }
  if (hasError) {
    toast.error('Заполните обязательные поля', { title: 'Ошибка валидации' });
    return;
  }

  const servers = (state.remoteConfig?.servers || []).map(s => {
    if (s.id !== serverId) return s;
    const files = [...(s.files || [])];
    if (isNew) {
      files.push({ id: 'file-' + Date.now(), name, remotePath });
    } else {
      const fi = files.findIndex(f => f.id === fid);
      if (fi !== -1) files[fi] = { ...files[fi], name, remotePath };
    }
    return { ...s, files };
  });

  settingsExpandedServers.add(serverId);
  await saveConfigToServer({ servers }, isNew ? 'Файл добавлен' : 'Файл обновлён', /*refetch=*/false);
  editingFileKey = null;
  state.remoteConfig = { ...state.remoteConfig, servers };
  renderSettingsTab();
}

async function settingsDeleteFile(serverId, fileId) {
  const server = state.remoteConfig?.servers?.find(s => s.id === serverId);
  const file = server?.files?.find(f => f.id === fileId);
  if (!file) return;
  if (!confirm(`Удалить файл «${file.name}»?`)) return;

  const servers = (state.remoteConfig?.servers || []).map(s => {
    if (s.id !== serverId) return s;
    return { ...s, files: s.files.filter(f => f.id !== fileId) };
  });

  settingsExpandedServers.add(serverId);
  await saveConfigToServer({ servers }, 'Файл удалён', /*refetch=*/false);
  editingFileKey = null;
  state.remoteConfig = { ...state.remoteConfig, servers };
  renderSettingsTab();
}

/**
 * Сохраняет конфиг через POST /api/config.
 * refetch=true → заново получает конфиг с сервера (для актуальных масок паролей).
 * refetch=false → обновляет state.remoteConfig из переданного объекта.
 */
async function saveConfigToServer(config, successMsg, refetch = true) {
  try {
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const result = await resp.json();
    if (!result.success) throw new Error(result.error || 'Ошибка сохранения');
    toast.success(successMsg);
    if (refetch) {
      await loadConfig();
    }
  } catch (err) {
    toast.error(err.message, { title: 'Ошибка сохранения' });
    throw err;
  }
}

// ====================== Glob-превью ======================

async function settingsGlobPreview(serverId, escapedKey) {
  const pathEl    = document.getElementById(`fform-path-${escapedKey}`);
  const previewEl = document.getElementById(`glob-preview-${escapedKey}`);
  const pattern   = pathEl?.value.trim();
  if (!pattern || !previewEl) return;

  if (!/[*?]/.test(pattern)) {
    previewEl.innerHTML = `<span class="glob-preview-info">Паттерн не содержит символов подстановки (* или ?)</span>`;
    return;
  }

  previewEl.innerHTML = `<span class="glob-preview-info"><span class="loading-spinner" style="width:12px;height:12px;border-width:2px;"></span> Поиск файлов...</span>`;

  try {
    const resp = await fetch('/api/expand-glob', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId, pattern })
    });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);

    if (!result.files.length) {
      previewEl.innerHTML = `<span class="glob-preview-info">Файлов не найдено</span>`;
    } else {
      previewEl.innerHTML = `
        <div class="glob-preview-header">Найдено: ${result.files.length} файл(а/ов)</div>
        ${result.files.map(f => `<div class="glob-preview-file">📄 ${escapeHtml(f)}</div>`).join('')}
      `;
    }
  } catch (err) {
    previewEl.innerHTML = `<span class="glob-preview-error">Ошибка: ${escapeHtml(err.message)}</span>`;
  }
}

// ====================== Тест соединения из формы ======================

async function settingsTestConnForm(sid) {
  const statusEl = document.getElementById(`sform-conn-${sid}`);
  if (!statusEl) return;

  const hostEl = document.getElementById(`sform-host-${sid}`);
  const portEl = document.getElementById(`sform-port-${sid}`);
  const userEl = document.getElementById(`sform-user-${sid}`);
  const passEl = document.getElementById(`sform-pass-${sid}`);

  const host     = hostEl?.value.trim();
  const port     = parseInt(portEl?.value) || 22;
  const username = userEl?.value.trim();
  const password = passEl?.value;

  if (!host || !username) {
    statusEl.className = 'settings-conn-status error';
    statusEl.textContent = 'Заполните хост и пользователя';
    return;
  }

  statusEl.className = 'settings-conn-status pending';
  statusEl.textContent = 'Проверяю...';

  try {
    let endpoint, body;
    if (password === '••••••••' && sid !== '__new__') {
      // Пароль не изменялся — тестируем по serverId
      endpoint = '/api/test-connection-by-id';
      body = { serverId: sid };
    } else {
      endpoint = '/api/test-connection';
      body = { host, port, username, password };
    }
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await resp.json();
    if (result.success) {
      statusEl.className = 'settings-conn-status connected';
      statusEl.textContent = '✓ Подключено';
    } else {
      statusEl.className = 'settings-conn-status error';
      statusEl.textContent = '✕ ' + (result.message || 'Ошибка');
      statusEl.title = result.message || '';
    }
  } catch (err) {
    statusEl.className = 'settings-conn-status error';
    statusEl.textContent = '✕ ' + err.message;
  }
}

// ====================== window-биндинги (inline onclick в settings-tab) ======================

window.__rmAddServer = () => {
  editingServerId = '__new__';
  editingFileKey  = null;
  renderSettingsTab();
};
window.__rmEditServer = (sid) => {
  editingServerId = sid;
  editingFileKey  = null;
  renderSettingsTab();
};
window.__rmCancelServer = () => {
  editingServerId = null;
  renderSettingsTab();
};
window.__rmSaveServer   = (sid) => settingsSaveServer(sid).catch(() => {});
window.__rmDeleteServer = (sid) => settingsDeleteServer(sid);

window.__rmToggleFiles = (serverId) => {
  if (settingsExpandedServers.has(serverId)) {
    settingsExpandedServers.delete(serverId);
  } else {
    settingsExpandedServers.add(serverId);
  }
  renderSettingsTab();
};

window.__rmAddFile = (serverId) => {
  editingServerId = null;
  editingFileKey  = `${serverId}::__new__`;
  settingsExpandedServers.add(serverId);
  renderSettingsTab();
};
window.__rmEditFile = (serverId, fileId) => {
  editingServerId = null;
  editingFileKey  = `${serverId}::${fileId}`;
  settingsExpandedServers.add(serverId);
  renderSettingsTab();
};
window.__rmCancelFile = () => {
  editingFileKey = null;
  renderSettingsTab();
};
window.__rmSaveFile   = (serverId, fid) => settingsSaveFile(serverId, fid).catch(() => {});
window.__rmDeleteFile = (serverId, fileId) => settingsDeleteFile(serverId, fileId);

window.__rmTogglePass = (inputId) => {
  const el = document.getElementById(inputId);
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
};
window.__rmTestConnForm = (sid) => settingsTestConnForm(sid);
window.__rmGlobPreview  = (serverId, escapedKey) => settingsGlobPreview(serverId, escapedKey);

// ====================== Глобальные функции для файловой вкладки (inline onclick) ======================
// Шаблон рендерится через innerHTML, поэтому onclick-атрибуты видят только globals.

function toggleServerFiles(serverId) {
  const filesEl = document.getElementById(`files-${serverId}`);
  if (filesEl) {
    filesEl.style.display = filesEl.style.display === 'none' ? 'block' : 'none';
  }
}

function toggleFileSelection(serverId, fileId) {
  const key     = `${serverId}::${fileId}`;
  const fileEl  = document.getElementById(`file-${serverId}-${fileId}`);
  const checkEl = document.getElementById(`check-${serverId}-${fileId}`);
  if (state.liveStreams.has(key)) return;

  if (state.selectedFiles.has(key)) {
    state.selectedFiles.delete(key);
    fileEl?.classList.remove('selected');
    if (checkEl) checkEl.checked = false;
  } else {
    state.selectedFiles.add(key);
    fileEl?.classList.add('selected');
    if (checkEl) checkEl.checked = true;
  }
  dom.loadRemoteBtn.disabled = state.selectedFiles.size === 0;
  updateSelectAllBtnState(serverId);
}

function updateSelectAllBtnState(serverId) {
  const btn = document.getElementById(`select-all-${serverId}`);
  if (!btn || !state.remoteConfig) return;
  const server = state.remoteConfig.servers.find(s => s.id === serverId);
  if (!server) return;
  const selectable = server.files.filter(f => !state.liveStreams.has(`${serverId}::${f.id}`));
  if (selectable.length === 0) {
    btn.textContent = 'Выбрать все';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const allSelected = selectable.every(f => state.selectedFiles.has(`${serverId}::${f.id}`));
  btn.textContent = allSelected ? 'Снять все' : 'Выбрать все';
}

function toggleSelectAllServerFiles(serverId) {
  if (!state.remoteConfig) return;
  const server = state.remoteConfig.servers.find(s => s.id === serverId);
  if (!server) return;
  const selectable = server.files.filter(f => !state.liveStreams.has(`${serverId}::${f.id}`));
  if (selectable.length === 0) return;

  const allSelected = selectable.every(f => state.selectedFiles.has(`${serverId}::${f.id}`));

  selectable.forEach(file => {
    const key     = `${serverId}::${file.id}`;
    const fileEl  = document.getElementById(`file-${serverId}-${file.id}`);
    const checkEl = document.getElementById(`check-${serverId}-${file.id}`);
    if (allSelected) {
      state.selectedFiles.delete(key);
      if (fileEl)  fileEl.classList.remove('selected');
      if (checkEl) checkEl.checked = false;
    } else {
      state.selectedFiles.add(key);
      if (fileEl)  fileEl.classList.add('selected');
      if (checkEl) checkEl.checked = true;
    }
  });

  dom.loadRemoteBtn.disabled = state.selectedFiles.size === 0;
  updateSelectAllBtnState(serverId);
}

async function testServerConnection(serverId) {
  const statusEl = document.getElementById(`status-${serverId}`);
  if (!statusEl) return;
  statusEl.className = 'server-status pending';
  statusEl.textContent = 'Проверка...';
  try {
    const response = await fetch('/api/test-connection-by-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId })
    });
    const result = await response.json();
    if (result.success) {
      statusEl.className = 'server-status connected';
      statusEl.textContent = 'Подключено';
      statusEl.title = '';
    } else {
      statusEl.className = 'server-status error';
      statusEl.textContent = 'Ошибка';
      statusEl.title = result.message;
    }
  } catch (err) {
    statusEl.className = 'server-status error';
    statusEl.textContent = 'Ошибка';
    statusEl.title = err.message;
  }
}

window.toggleServerFiles          = toggleServerFiles;
window.toggleFileSelection        = toggleFileSelection;
window.toggleSelectAllServerFiles = toggleSelectAllServerFiles;
window.testServerConnection       = testServerConnection;

// ====================== Запуск загрузки выбранных файлов ======================

export async function loadSelectedRemoteFiles() {
  if (state.selectedFiles.size === 0) return;
  const filesToLoad = Array.from(state.selectedFiles).map(key => {
    const [serverId, fileId] = key.split('::');
    const server = state.remoteConfig.servers.find(s => s.id === serverId);
    const file   = server ? server.files.find(f => f.id === fileId) : null;
    return { serverId, fileId, server, file };
  }).filter(f => f.server && f.file);

  dom.loadRemoteBtn.disabled = true;
  const originalText = dom.loadRemoteBtn.textContent;
  dom.loadRemoteBtn.innerHTML = '<span class="loading-spinner"></span> Загрузка...';

  try {
    if (state.currentLoadMode === 'tail') {
      await loadTailMode(filesToLoad);
      closeRemoteModal();
    } else if (state.currentLoadMode === 'range') {
      await loadRangeMode(filesToLoad);
      closeRemoteModal();
    } else if (state.currentLoadMode === 'live') {
      await startLiveMode(filesToLoad);
      closeRemoteModal();
    }
  } catch (err) {
    toast.error(err.message, { title: 'Ошибка загрузки' });
  } finally {
    dom.loadRemoteBtn.disabled = state.selectedFiles.size === 0;
    dom.loadRemoteBtn.textContent = originalText;
  }
}

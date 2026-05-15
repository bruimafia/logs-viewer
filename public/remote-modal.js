// Модальное окно «Удалённые файлы»: выбор сервера/файла, выбор режима
// загрузки, тест соединения. Сами загрузки делегируются sse-client.js.

import { state, dom } from './state.js';
import { escapeHtml } from './utils.js';
import { LIVE_BUFFER_CAP } from './state.js';
import { loadTailMode, loadRangeMode, startLiveMode } from './sse-client.js';
import { toast } from './toast.js';

// ====================== Открытие / закрытие ======================

export async function openRemoteModal() {
  state.selectedFiles.clear();
  dom.loadRemoteBtn.disabled = true;
  dom.remoteModal.classList.add('active');

  dom.remoteModalBody.innerHTML = `
    <div style="text-align: center; padding: 40px;">
      <div class="loading-spinner"></div>
      <p style="margin-top: 12px;">Загрузка конфигурации...</p>
    </div>
  `;

  try {
    const response = await fetch('/api/config');
    state.remoteConfig = await response.json();
    renderRemoteConfig();
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

export function closeRemoteModal() {
  dom.remoteModal.classList.remove('active');
}

// ====================== Рендеринг конфигурации ======================

function renderRemoteConfig() {
  const remoteConfig = state.remoteConfig;
  if (!remoteConfig || !remoteConfig.servers || remoteConfig.servers.length === 0) {
    dom.remoteModalBody.innerHTML = `
      <div class="no-servers">
        <p>Нет настроенных серверов.</p>
        <p>Отредактируйте файл <code>remote-config.json</code> для добавления серверов.</p>
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
            return `
            <div class="file-item ${isLive ? 'live-active' : ''}" onclick="toggleFileSelection('${server.id}', '${file.id}')" id="file-${server.id}-${file.id}">
              <input type="checkbox" class="file-checkbox" id="check-${server.id}-${file.id}" ${isLive ? 'disabled' : ''}>
              <div style="flex:1; min-width: 0;">
                <div class="file-name">${escapeHtml(file.name)} ${isLive ? '<span class="file-live-badge">LIVE</span>' : ''}</div>
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

  // Серверный grep (пункт 5.3) применим только к Tail и Range.
  // В Live прячем поле, чтобы пользователь не подумал, что оно тут работает.
  const sharedGrepEl = document.getElementById('config-shared-grep');
  if (sharedGrepEl) sharedGrepEl.style.display = (mode === 'live') ? 'none' : '';
}

// ====================== Глобальные функции для inline-обработчиков ======================
// Шаблон рендерится через innerHTML, поэтому onclick='...' видит только globals.
// Закидываем нужные функции в window.

function toggleServerFiles(serverId) {
  const filesEl = document.getElementById(`files-${serverId}`);
  if (filesEl) {
    filesEl.style.display = filesEl.style.display === 'none' ? 'block' : 'none';
  }
}

function toggleFileSelection(serverId, fileId) {
  const key = `${serverId}::${fileId}`;
  const fileEl = document.getElementById(`file-${serverId}-${fileId}`);
  const checkEl = document.getElementById(`check-${serverId}-${fileId}`);
  if (state.liveStreams.has(key)) return;

  if (state.selectedFiles.has(key)) {
    state.selectedFiles.delete(key);
    fileEl.classList.remove('selected');
    checkEl.checked = false;
  } else {
    state.selectedFiles.add(key);
    fileEl.classList.add('selected');
    checkEl.checked = true;
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
    const key = `${serverId}::${file.id}`;
    const fileEl = document.getElementById(`file-${serverId}-${file.id}`);
    const checkEl = document.getElementById(`check-${serverId}-${file.id}`);
    if (allSelected) {
      state.selectedFiles.delete(key);
      if (fileEl) fileEl.classList.remove('selected');
      if (checkEl) checkEl.checked = false;
    } else {
      state.selectedFiles.add(key);
      if (fileEl) fileEl.classList.add('selected');
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

window.toggleServerFiles = toggleServerFiles;
window.toggleFileSelection = toggleFileSelection;
window.toggleSelectAllServerFiles = toggleSelectAllServerFiles;
window.testServerConnection = testServerConnection;

// ====================== Запуск загрузки выбранных файлов ======================

export async function loadSelectedRemoteFiles() {
  if (state.selectedFiles.size === 0) return;
  const filesToLoad = Array.from(state.selectedFiles).map(key => {
    const [serverId, fileId] = key.split('::');
    const server = state.remoteConfig.servers.find(s => s.id === serverId);
    const file = server ? server.files.find(f => f.id === fileId) : null;
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

const express = require('express');
const cors = require('cors');
const SftpClient = require('ssh2-sftp-client');
const { Client: SshClient } = require('ssh2');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

// Разрешаем CORS для локальной разработки
app.use(cors());
app.use(express.json());

// Раздача статических файлов
app.use(express.static(__dirname));

// Путь к конфигурационному файлу
const configPath = path.join(__dirname, 'remote-config.json');

// ====================== Утилиты ======================

function getConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('Ошибка чтения конфигурации:', err.message);
  }
  return { servers: [] };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Ошибка сохранения конфигурации:', err.message);
    return false;
  }
}

// Безопасное экранирование для shell (одинарные кавычки)
function shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Строит prefix-команду grep'а для серверного поиска (пункт 5.3 плана улучшений).
 * Возвращает строку вида `grep -a -F -i -e 'pattern'` или null, если pattern пуст.
 */
function buildGrepPrefix(pattern, options = {}) {
  if (!pattern || typeof pattern !== 'string') return null;
  const flags = ['-a'];
  flags.push(options.regex ? '-E' : '-F');
  if (options.caseInsensitive) flags.push('-i');
  return `grep ${flags.join(' ')} -e ${shellEscape(pattern)}`;
}

/**
 * Разбирает grep-опции из тела HTTP-запроса.
 */
function parseGrepFilter(body) {
  const pattern = typeof body?.grepPattern === 'string' ? body.grepPattern.trim() : '';
  if (!pattern) return { prefix: null, hasFilter: false };
  return {
    prefix: buildGrepPrefix(pattern, {
      regex: !!body.grepRegex,
      caseInsensitive: !!body.grepCaseInsensitive
    }),
    hasFilter: true
  };
}

/**
 * Строит grep-команду для фильтрации по уровням логирования (пункт 5.2).
 * @param {string[]} levels - Массив уровней ['ERROR', 'WARN', 'INFO', 'DEBUG']
 * @returns {string|null} - Строка grep-паттерна или null
 */
function buildLevelGrep(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const patterns = levels.map(level => `"level":"${level}"`).join('|');
  return `grep -a -E -e ${shellEscape(patterns)}`;
}

/**
 * Разбирает фильтр по уровням из тела запроса (пункт 5.2).
 */
function parseLevelFilter(body) {
  const levels = body?.levels;
  if (!levels || !Array.isArray(levels) || levels.length === 0) return null;
  return buildLevelGrep(levels);
}

/**
 * Объединяет несколько grep-команд в одну через pipe.
 */
function combineGrepCommands(grep1, grep2) {
  if (!grep1 && !grep2) return null;
  if (!grep1) return grep2;
  if (!grep2) return grep1;
  return `${grep1} | ${grep2}`;
}

// ====================== Пул SSH-соединений ======================

const MAX_CHANNELS_PER_CLIENT = 8;
const IDLE_CLOSE_TIMEOUT_MS = 5000;

function credKey(server) {
  return `${server.host}:${server.port || 22}:${server.username}:${server.password || ''}`;
}

class PooledSshClient {
  constructor(server) {
    this.server = server;
    this.client = new SshClient();
    this.channels = 0;
    this.broken = false;
    this.idleTimer = null;
    this.readyPromise = this._connect();
    this.readyPromise.catch(() => {});
  }

  _connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        console.log(`[ssh-pool] подключено к ${this.server.name} (${this.server.host})`);
        resolve();
      };
      const onError = (err) => {
        this.broken = true;
        if (settled) return;
        settled = true;
        try { this.client.end(); } catch (e) {}
        reject(err);
      };
      this.client.once('ready', onReady);
      this.client.on('error', (err) => {
        this.broken = true;
        if (!settled) onError(err);
        else console.error(`[ssh-pool] ошибка соединения с ${this.server.name}: ${err.message}`);
      });
      this.client.on('close', () => { this.broken = true; });
      try {
        this.client.connect({
          host: this.server.host,
          port: this.server.port || 22,
          username: this.server.username,
          password: this.server.password,
          readyTimeout: 20000,
          keepaliveInterval: 15000
        });
      } catch (err) { onError(err); }
    });
  }

  destroy() {
    this.broken = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try { this.client.end(); } catch (e) {}
  }
}

class SshConnectionPool {
  constructor(server) {
    this.server = server;
    this.credKey = credKey(server);
    this.clients = [];
  }

  updateServer(server) {
    const newKey = credKey(server);
    if (newKey !== this.credKey) {
      console.log(`[ssh-pool] креды для ${server.name} изменились — сбрасываю пул`);
      this.destroyAll();
      this.credKey = newKey;
    }
    this.server = server;
  }

  destroyAll() {
    for (const pc of this.clients) pc.destroy();
    this.clients = [];
  }

  _reserveSlot() {
    this.clients = this.clients.filter(pc => !pc.broken);
    let pc = this.clients.find(c => c.channels < MAX_CHANNELS_PER_CLIENT);
    if (!pc) { pc = new PooledSshClient(this.server); this.clients.push(pc); }
    pc.channels++;
    if (pc.idleTimer) { clearTimeout(pc.idleTimer); pc.idleTimer = null; }
    return pc;
  }

  _releaseSlot(pc) {
    pc.channels = Math.max(0, pc.channels - 1);
    if (pc.broken) {
      this.clients = this.clients.filter(c => c !== pc);
      try { pc.client.end(); } catch (e) {}
      return;
    }
    if (pc.channels === 0) {
      pc.idleTimer = setTimeout(() => {
        this.clients = this.clients.filter(c => c !== pc);
        console.log(`[ssh-pool] закрываю простаивающее соединение с ${this.server.name}`);
        pc.destroy();
      }, IDLE_CLOSE_TIMEOUT_MS);
    }
  }

  async exec(cmd) {
    const pc = this._reserveSlot();
    try {
      await pc.readyPromise;
    } catch (err) {
      this._releaseSlot(pc);
      throw err;
    }
    if (pc.broken) {
      this._releaseSlot(pc);
      throw new Error('SSH-соединение разорвано');
    }

    return new Promise((resolve, reject) => {
      pc.client.exec(cmd, (err, stream) => {
        if (err) { this._releaseSlot(pc); reject(err); return; }
        let released = false;
        const release = () => { if (released) return; released = true; this._releaseSlot(pc); };
        stream.once('close', release);
        stream.once('error', release);
        resolve(stream);
      });
    });
  }
}

const sshPools = new Map();

function getSshPool(server) {
  let pool = sshPools.get(server.id);
  if (!pool) { pool = new SshConnectionPool(server); sshPools.set(server.id, pool); }
  else { pool.updateServer(server); }
  return pool;
}

function destroyAllPools() {
  for (const pool of sshPools.values()) pool.destroyAll();
  sshPools.clear();
}

function pruneRemovedPools() {
  const config = getConfig();
  const liveIds = new Set(config.servers.map(s => s.id));
  for (const [id, pool] of sshPools.entries()) {
    if (!liveIds.has(id)) {
      console.log(`[ssh-pool] сервер ${id} удалён из конфига — закрываю пул`);
      pool.destroyAll();
      sshPools.delete(id);
    }
  }
}

process.on('SIGTERM', () => { console.log('\nПолучен SIGTERM, закрываю SSH-соединения...'); destroyAllPools(); process.exit(0); });
process.on('SIGINT', () => { console.log('\nПолучен SIGINT, закрываю SSH-соединения...'); destroyAllPools(); process.exit(0); });

// SSE: безопасная отправка события
function makeSseSender(res) {
  return (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };
}

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  try { res.write(': open\n\n'); } catch (e) {}
}

function getLogTimeMs(line) {
  try {
    const trimmed = line.trim();
    if (!trimmed) return 0;
    const o = JSON.parse(trimmed);
    return o.time ? new Date(o.time).getTime() : 0;
  } catch { return 0; }
}

function tryParseJson(line) {
  try { return JSON.parse(line.trim()); } catch { return null; }
}

function findServerAndFile(serverId, fileId) {
  const config = getConfig();
  const server = config.servers.find(s => s.id === serverId);
  if (!server) return { error: 'Сервер не найден' };
  const file = server.files.find(f => f.id === fileId);
  if (!file) return { error: 'Файл не найден' };
  return { server, file };
}

// ====================== API: конфигурация ======================

app.get('/api/config', (req, res) => {
  const config = getConfig();
  const safeConfig = { servers: config.servers.map(server => ({ ...server, password: server.password ? '••••••••' : '' })) };
  res.json(safeConfig);
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  const currentConfig = getConfig();
  newConfig.servers.forEach((server, index) => {
    if (server.password === '••••••••' && currentConfig.servers[index]) {
      server.password = currentConfig.servers[index].password;
    }
  });
  if (saveConfig(newConfig)) res.json({ success: true });
  else res.status(500).json({ error: 'Ошибка сохранения конфигурации' });
});

app.get('/api/reload-config', (req, res) => {
  const config = getConfig();
  pruneRemovedPools();
  res.json({ success: true, serversCount: config.servers.length });
});

// ====================== API: проверка соединения ======================

app.post('/api/test-connection-by-id', async (req, res) => {
  const { serverId } = req.body;
  const config = getConfig();
  const server = config.servers.find(s => s.id === serverId);
  if (!server) return res.json({ success: false, message: 'Сервер не найден' });
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: server.host, port: server.port || 22, username: server.username, password: server.password, readyTimeout: 15000 });
    await sftp.end();
    res.json({ success: true, message: 'Соединение успешно' });
  } catch (err) {
    try { await sftp.end(); } catch (e) {}
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/test-connection', async (req, res) => {
  const { host, port, username, password } = req.body;
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host, port: port || 22, username, password, readyTimeout: 15000 });
    await sftp.end();
    res.json({ success: true, message: 'Соединение успешно' });
  } catch (err) {
    try { await sftp.end(); } catch (e) {}
    res.json({ success: false, message: err.message });
  }
});

// ====================== API: загрузка целиком (с фильтром по дате и уровню) ======================
// Пункт 5.2: Серверная фильтрация для режима «диапазон дат»

async function streamFileViaGrep({ res, sendEvent, server, file, grepPrefix, levelGrep, fromMs, toMs }) {
  const hasDateFilter = fromMs != null || toMs != null;
  const filePath = shellEscape(file.remotePath);
  const combinedGrep = combineGrepCommands(grepPrefix, levelGrep);
  const hasLevelFilter = !!levelGrep;
  const cmd = combinedGrep ? `${combinedGrep} ${filePath}` : `cat ${filePath}`;

  let stream;
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; if (stream) try { stream.close(); } catch (e) {} };

  try {
    sendEvent('start', {
      fileName: path.basename(file.remotePath),
      filePath: file.remotePath,
      serverName: server.name,
      totalBytes: 0,
      grepFilter: true,
      levelFilter: hasLevelFilter
    });

    const pool = getSshPool(server);
    stream = await pool.exec(cmd);

    let buffer = '';
    let lineCount = 0;
    let bytesLoaded = 0;
    let stderrAcc = '';

    stream.on('data', (chunk) => {
      bytesLoaded += chunk.length;
      buffer += chunk.toString('utf-8');
      const parts = buffer.split('\n');
      buffer = parts.pop();
      if (parts.length > 0) {
        const toSend = hasDateFilter ? parts.filter(line => {
          const t = getLogTimeMs(line);
          if (fromMs != null && t < fromMs) return false;
          if (toMs != null && t > toMs) return false;
          return true;
        }) : parts;
        if (toSend.length > 0) { lineCount += toSend.length; sendEvent('lines', { lines: toSend }); }
        sendEvent('progress', { bytesLoaded });
      }
    });

    stream.stderr.on('data', (chunk) => { stderrAcc += chunk.toString('utf-8'); });

    stream.on('close', (code) => {
      if (buffer.length > 0) {
        let toSend = [buffer];
        if (hasDateFilter) {
          const t = getLogTimeMs(buffer);
          const inRange = (fromMs == null || t >= fromMs) && (toMs == null || t <= toMs);
          toSend = inRange ? [buffer] : [];
        }
        if (toSend.length > 0) { lineCount += toSend.length; sendEvent('lines', { lines: toSend }); }
      }
      const stderrText = stderrAcc.trim();
      const isError = stderrText && code !== 1;
      if (isError) { sendEvent('error', { message: stderrText || `Exit code ${code}` }); }
      else { sendEvent('complete', { totalLines: lineCount, bytesLoaded }); }
      cleanup();
      res.end();
    });

    stream.on('error', (err) => { sendEvent('error', { message: err.message }); cleanup(); res.end(); });
    res.on('close', cleanup);

  } catch (err) {
    sendEvent('error', { message: err.message });
    cleanup();
    res.end();
  }
}

app.post('/api/stream-file', async (req, res) => {
  const { serverId, fileId, dateFrom, dateTo } = req.body;
  const fromMs = dateFrom ? new Date(dateFrom).getTime() : null;
  const toMs = dateTo ? new Date(dateTo).getTime() : null;
  const hasDateFilter = fromMs != null || toMs != null;

  const found = findServerAndFile(serverId, fileId);
  if (found.error) return res.status(404).json({ error: found.error });
  const { server, file } = found;

  // Серверный grep (пункт 5.3)
  const { prefix: grepPrefix, hasFilter: hasGrep } = parseGrepFilter(req.body);
  
  // Серверная фильтрация по уровню (пункт 5.2)
  const levelGrep = parseLevelFilter(req.body);
  const hasLevelFilter = !!levelGrep;
  const useGrepMode = hasGrep || hasLevelFilter;

  setSseHeaders(res);
  const sendEvent = makeSseSender(res);

  if (useGrepMode) {
    return streamFileViaGrep({ res, sendEvent, server, file, grepPrefix, levelGrep, fromMs, toMs });
  }

  // --- SFTP-ветка ---
  const sftp = new SftpClient();
  let totalBytes = 0;
  let processedBytes = 0;
  const CHUNK_SIZE = 64 * 1024;

  try {
    await sftp.connect({ host: server.host, port: server.port || 22, username: server.username, password: server.password, readyTimeout: 20000 });
    const stat = await sftp.stat(file.remotePath);
    totalBytes = stat.size;

    sendEvent('start', { fileName: path.basename(file.remotePath), filePath: file.remotePath, serverName: server.name, totalBytes });

    const stream = await sftp.createReadStream(file.remotePath, { highWaterMark: CHUNK_SIZE });
    let buffer = '';

    stream.on('data', (chunk) => {
      processedBytes += chunk.length;
      buffer += chunk.toString('utf-8');

      sendEvent('progress', { bytesLoaded: processedBytes, totalBytes, percent: Math.round((processedBytes / totalBytes) * 100) });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      if (lines.length > 0) {
        const toSend = hasDateFilter ? lines.filter(line => {
          const t = getLogTimeMs(line);
          if (fromMs != null && t < fromMs) return false;
          if (toMs != null && t > toMs) return false;
          return true;
        }) : lines;
        if (toSend.length > 0) sendEvent('lines', { lines: toSend });
      }
    });

    stream.on('end', () => {
      if (buffer.length > 0) {
        let toSend = [buffer];
        if (hasDateFilter) {
          const t = getLogTimeMs(buffer);
          const inRange = (fromMs == null || t >= fromMs) && (toMs == null || t <= toMs);
          toSend = inRange ? [buffer] : [];
        }
        if (toSend.length > 0) sendEvent('lines', { lines: toSend });
      }
      sendEvent('complete', { bytesLoaded: processedBytes, totalBytes });
      try { sftp.end(); } catch (e) {}
      res.end();
    });

    stream.on('error', (err) => { sendEvent('error', { message: err.message }); try { sftp.end(); } catch (e) {} res.end(); });
    res.on('close', async () => { try { stream.destroy(); } catch (e) {} try { await sftp.end(); } catch (e) {} });

  } catch (err) {
    sendEvent('error', { message: err.message });
    try { await sftp.end(); } catch (e) {}
    res.end();
  }
});

// ====================== API: tail с пагинацией ======================

app.post('/api/tail-file', async (req, res) => {
  const { serverId, fileId, lines, offsetLines } = req.body;
  const linesNum = Math.max(1, Math.min(100000, parseInt(lines) || 1000));
  const offsetNum = Math.max(0, parseInt(offsetLines) || 0);

  const found = findServerAndFile(serverId, fileId);
  if (found.error) return res.status(404).json({ error: found.error });
  const { server, file } = found;

  const { prefix: grepPrefix, hasFilter: hasGrep } = parseGrepFilter(req.body);
  setSseHeaders(res);
  const sendEvent = makeSseSender(res);

  let stream;
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; if (stream) try { stream.close(); } catch (e) {} };

  try {
    const filePath = shellEscape(file.remotePath);
    const totalLines = linesNum + offsetNum;

    let cmd;
    if (grepPrefix) {
      cmd = offsetNum === 0 ? `${grepPrefix} ${filePath} | tail -n ${linesNum}` : `${grepPrefix} ${filePath} | tail -n ${totalLines} | head -n ${linesNum}`;
    } else {
      cmd = offsetNum === 0 ? `tail -n ${linesNum} ${filePath}` : `tail -n ${totalLines} ${filePath} | head -n ${linesNum}`;
    }

    sendEvent('start', { fileName: path.basename(file.remotePath), filePath: file.remotePath, serverName: server.name, lines: linesNum, offsetLines: offsetNum, mode: 'tail', grepFilter: hasGrep });

    const pool = getSshPool(server);
    stream = await pool.exec(cmd);

    let buffer = '';
    let lineCount = 0;
    let stderrAcc = '';

    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const parts = buffer.split('\n');
      buffer = parts.pop();
      if (parts.length > 0) { lineCount += parts.length; sendEvent('lines', { lines: parts }); }
    });

    stream.stderr.on('data', (chunk) => { stderrAcc += chunk.toString('utf-8'); });

    stream.on('close', (code) => {
      if (buffer.length > 0) { lineCount += 1; sendEvent('lines', { lines: [buffer] }); }
      const stderrText = stderrAcc.trim();
      const isError = stderrText && (code !== 0 || hasGrep);
      if (isError) { sendEvent('error', { message: stderrText || `Exit code ${code}` }); }
      else { sendEvent('complete', { totalLines: lineCount, exitCode: code }); }
      cleanup();
      res.end();
    });

    stream.on('error', (err) => { sendEvent('error', { message: err.message }); cleanup(); res.end(); });
    res.on('close', cleanup);

  } catch (err) {
    sendEvent('error', { message: err.message });
    cleanup();
    res.end();
  }
});

// ====================== API: live-стриминг (tail -F) ======================

app.post('/api/tail-follow', async (req, res) => {
  const { serverId, fileId, initialLines } = req.body;
  const initialNum = Math.max(0, Math.min(10000, parseInt(initialLines) || 100));

  const found = findServerAndFile(serverId, fileId);
  if (found.error) return res.status(404).json({ error: found.error });
  const { server, file } = found;

  setSseHeaders(res);
  const sendEvent = makeSseSender(res);

  let stream;
  let cleaned = false;

  const keepAlive = setInterval(() => { if (res.writableEnded || res.destroyed) return; try { res.write(': keepalive\n\n'); } catch (e) {} }, 25000);

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepAlive);
    if (stream) { try { stream.signal('TERM'); } catch (e) {} try { stream.close(); } catch (e) {} }
  };

  try {
    const filePath = shellEscape(file.remotePath);
    const cmd = `tail -n ${initialNum} -F ${filePath}`;

    sendEvent('start', { fileName: path.basename(file.remotePath), filePath: file.remotePath, serverName: server.name, mode: 'live', initialLines: initialNum });

    const pool = getSshPool(server);
    stream = await pool.exec(cmd);

    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const parts = buffer.split('\n');
      buffer = parts.pop();
      if (parts.length > 0) sendEvent('lines', { lines: parts });
    });

    stream.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8').trim();
      const lower = text.toLowerCase();
      const isFatal = lower.includes('no such file') || lower.includes('permission denied') || lower.includes('cannot open');
      if (isFatal) sendEvent('error', { message: text });
      else if (text) sendEvent('info', { message: text });
    });

    stream.on('close', (code) => {
      if (buffer.length > 0) sendEvent('lines', { lines: [buffer] });
      sendEvent('end', { exitCode: code });
      cleanup();
      try { res.end(); } catch (e) {}
    });

    stream.on('error', (err) => { sendEvent('error', { message: err.message }); cleanup(); try { res.end(); } catch (e) {} });
    res.on('close', cleanup);

  } catch (err) {
    sendEvent('error', { message: err.message });
    cleanup();
    try { res.end(); } catch (e) {}
  }
});

// ====================== API: мультиплексный live-стриминг ======================

const liveGroups = new Map();
let liveGroupCounter = 0;

function newGroupId() { return `g${Date.now()}_${++liveGroupCounter}`; }

app.post('/api/tail-follow-multi', async (req, res) => {
  const { serverId, files } = req.body || {};
  if (!serverId || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Требуется serverId и непустой массив files' });
  }

  const config = getConfig();
  const server = config.servers.find(s => s.id === serverId);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  setSseHeaders(res);
  const sendEvent = makeSseSender(res);

  const groupId = newGroupId();
  const group = { streams: new Map(), sendEvent, serverId };
  liveGroups.set(groupId, group);

  const keepAlive = setInterval(() => { if (res.writableEnded || res.destroyed) return; try { res.write(': keepalive\n\n'); } catch (e) {} }, 25000);

  let closed = false;
  const closeAll = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    for (const stream of group.streams.values()) { try { stream.signal('TERM'); } catch (e) {} try { stream.close(); } catch (e) {} }
    group.streams.clear();
    liveGroups.delete(groupId);
    try { res.end(); } catch (e) {}
  };

  const closeFile = (fileId) => {
    const stream = group.streams.get(fileId);
    if (!stream) return false;
    group.streams.delete(fileId);
    try { stream.signal('TERM'); } catch (e) {} try { stream.close(); } catch (e) {}
    if (group.streams.size === 0) { sendEvent('group-end', {}); closeAll(); }
    return true;
  };
  group.closeFile = closeFile;

  sendEvent('start', { groupId });

  const pool = getSshPool(server);

  for (const fileSpec of files) {
    const file = server.files.find(f => f.id === fileSpec.fileId);
    if (!file) { sendEvent('file-error', { fileId: fileSpec.fileId, message: 'Файл не найден в конфиге' }); sendEvent('file-end', { fileId: fileSpec.fileId, exitCode: -1 }); continue; }
    const initialNum = Math.max(0, Math.min(10000, parseInt(fileSpec.initialLines) || 100));
    const fileId = fileSpec.fileId;

    (async () => {
      const filePath = shellEscape(file.remotePath);
      const cmd = `tail -n ${initialNum} -F ${filePath}`;
      let stream;
      try { stream = await pool.exec(cmd); } catch (err) { sendEvent('file-error', { fileId, message: err.message }); sendEvent('file-end', { fileId, exitCode: -1 }); return; }

      if (closed) { try { stream.close(); } catch (e) {} return; }

      group.streams.set(fileId, stream);

      sendEvent('file-start', { fileId, fileName: path.basename(file.remotePath), filePath: file.remotePath, serverName: server.name, mode: 'live', initialLines: initialNum });

      let buffer = '';

      stream.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const parts = buffer.split('\n');
        buffer = parts.pop();
        if (parts.length > 0) sendEvent('file-lines', { fileId, lines: parts });
      });

      stream.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf-8').trim();
        if (!text) return;
        const lower = text.toLowerCase();
        const isFatal = lower.includes('no such file') || lower.includes('permission denied') || lower.includes('cannot open');
        if (isFatal) sendEvent('file-error', { fileId, message: text });
        else sendEvent('file-info', { fileId, message: text });
      });

      stream.on('close', (code) => {
        if (buffer.length > 0) sendEvent('file-lines', { fileId, lines: [buffer] });
        sendEvent('file-end', { fileId, exitCode: code });
        group.streams.delete(fileId);
        if (group.streams.size === 0 && !closed) {
          setTimeout(() => { if (group.streams.size === 0 && !closed) { sendEvent('group-end', {}); closeAll(); } }, 100);
        }
      });

      stream.on('error', (err) => { sendEvent('file-error', { fileId, message: err.message }); });
    })().catch(err => { console.error(`[multi-live] непойманная ошибка для fileId=${fileId}:`, err); sendEvent('file-error', { fileId, message: String(err.message || err) }); });
  }

  res.on('close', closeAll);
});

app.post('/api/tail-follow-multi/stop', (req, res) => {
  const { groupId, fileId } = req.body || {};
  const group = liveGroups.get(groupId);
  if (!group) return res.json({ success: false, message: 'Группа не найдена (возможно, уже закрыта)' });
  if (fileId) { const ok = group.closeFile(fileId); return res.json({ success: ok }); }
  for (const fid of Array.from(group.streams.keys())) group.closeFile(fid);
  return res.json({ success: true });
});

// ====================== Запуск сервера ======================

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Просмотрщик логов запущен`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`========================================\n`);
  console.log(`Конфигурационный файл: ${configPath}`);
  console.log(`Для редактирования удаленных серверов откройте remote-config.json\n`);
});
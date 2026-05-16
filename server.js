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
 *
 *   options.regex            — true → -E (ERE: . * + ? ( ) | [ ] { } ^ $ \),
 *                              false → -F (fixed string, литерал — безопасно по умолчанию)
 *   options.caseInsensitive  — true → -i (игнорировать регистр)
 *
 * Флаг `-a` (treat binary as text) включён всегда — иначе на логах с NUL-байтами
 * grep печатает "Binary file ... matches" вместо строк.
 *
 * Pattern экранируется через shellEscape. Ключ `-e` критичен: без него pattern,
 * начинающийся с `-` (например, `-v`), будет проинтерпретирован как флаг grep.
 */
function buildGrepPrefix(pattern, options = {}) {
  if (!pattern || typeof pattern !== 'string') return null;
  const flags = ['-a'];
  flags.push(options.regex ? '-E' : '-F');
  if (options.caseInsensitive) flags.push('-i');
  return `grep ${flags.join(' ')} -e ${shellEscape(pattern)}`;
}

/**
 * Разбирает logLevels из тела HTTP-запроса (пункт 5.2).
 * Принимает body.logLevels — массив строк уровней ['ERROR','WARN'].
 * Возвращает { prefix, hasFilter }:
 *   prefix    — готовая часть grep-команды, либо null
 *   hasFilter — true, если задан непустой массив
 *
 *   options.regex            — true → -E, false → -F
 *   options.caseInsensitive  — true → -i
 */
function buildLogLevelsPrefix(levels, options = {}) {
  if (!Array.isArray(levels) || levels.length === 0) return { prefix: null, hasFilter: false };
  // Экранируем каждый уровень отдельно — вдруг имя содержит спецсимволы.
  const escaped = levels.map(l => shellEscape(String(l).trim())).join('|');
  const flags = ['-a', options.regex ? '-E' : '-F'];
  if (options.caseInsensitive) flags.push('-i');
  // Каждый уровень может встретиться в формате "level":"ERROR" или "level":"ERROR",
  // используем ERE с группировкой для надёжности.
  const pattern = `"level":"(${escaped})"`;
  return {
    prefix: `grep ${flags.join(' ')} -e ${shellEscape(pattern)}`,
    hasFilter: true
  };
}

/**
 * Разбирает grep-опции из тела HTTP-запроса. Принимает:
 *   body.grepPattern         (string)  — паттерн поиска
 *   body.grepRegex           (boolean) — использовать ERE вместо литерала
 *   body.grepCaseInsensitive (boolean) — игнорировать регистр
 *
 * Возвращает { prefix, hasFilter }:
 *   prefix    — готовая строка для подстановки в команду, либо null
 *   hasFilter — true, если задан непустой паттерн
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

// ====================== Пул SSH-соединений ======================
// Live-стриминг и tail запускают exec-команды по SSH. Чтобы не упираться
// в лимиты sshd (MaxStartups, MaxSessions) при параллельных потоках,
// держим один SSH-клиент на сервер и мультиплексируем exec-каналы поверх
// него. Если каналов на одном соединении становится много — открывается
// дополнительный клиент. Соединение само закрывается после периода простоя.

// sshd по умолчанию: MaxSessions=10. Оставляем небольшой запас.
const MAX_CHANNELS_PER_CLIENT = 8;
// Через сколько мс простоя (нет активных каналов) закрывать соединение.
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
    // Подавляем unhandled rejection — ждать readyPromise могут позже.
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
        // Любая ошибка — клиент непригоден для дальнейшего использования.
        this.broken = true;
        if (!settled) onError(err);
        else console.error(`[ssh-pool] ошибка соединения с ${this.server.name}: ${err.message}`);
      });
      this.client.on('close', () => {
        this.broken = true;
      });
      try {
        this.client.connect({
          host: this.server.host,
          port: this.server.port || 22,
          username: this.server.username,
          password: this.server.password,
          readyTimeout: 20000,
          keepaliveInterval: 15000
        });
      } catch (err) {
        onError(err);
      }
    });
  }

  destroy() {
    this.broken = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try { this.client.end(); } catch (e) {}
  }
}

class SshConnectionPool {
  constructor(server) {
    this.server = server;
    this.credKey = credKey(server);
    this.clients = []; // PooledSshClient[]
  }

  // Если креды поменялись через /api/config — старые соединения непригодны.
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

  // Синхронно резервируем слот в каком-нибудь клиенте: либо в существующем
  // здоровом с запасом по каналам, либо в новом. Делать это синхронно
  // важно: иначе 10 одновременных запросов решили бы открыть 10 клиентов.
  _reserveSlot() {
    // Выкидываем сломанные.
    this.clients = this.clients.filter(pc => !pc.broken);

    let pc = this.clients.find(c => c.channels < MAX_CHANNELS_PER_CLIENT);
    if (!pc) {
      pc = new PooledSshClient(this.server);
      this.clients.push(pc);
    }
    pc.channels++;
    if (pc.idleTimer) {
      clearTimeout(pc.idleTimer);
      pc.idleTimer = null;
    }
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

  // Возвращает exec-канал (Channel из ssh2). Пул сам отслеживает закрытие
  // канала и освобождает слот; вызывающему коду НЕ нужно закрывать SSH-клиент.
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
        if (err) {
          this._releaseSlot(pc);
          reject(err);
          return;
        }
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this._releaseSlot(pc);
        };
        stream.once('close', release);
        stream.once('error', release);
        resolve(stream);
      });
    });
  }
}

const sshPools = new Map(); // serverId -> SshConnectionPool

function getSshPool(server) {
  let pool = sshPools.get(server.id);
  if (!pool) {
    pool = new SshConnectionPool(server);
    sshPools.set(server.id, pool);
  } else {
    pool.updateServer(server);
  }
  return pool;
}

function destroyAllPools() {
  for (const pool of sshPools.values()) pool.destroyAll();
  sshPools.clear();
}

// Закрываем пулы для серверов, исчезнувших из конфига.
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

// Корректное закрытие при остановке процесса.
function gracefulShutdown(signal) {
  console.log(`\nПолучен ${signal}, закрываю SSH-соединения...`);
  destroyAllPools();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// SSE: безопасная отправка события
function makeSseSender(res) {
  return (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
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
  } catch {
    return 0;
  }
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
  const safeConfig = {
    servers: config.servers.map(server => ({
      ...server,
      password: server.password ? '••••••••' : ''
    }))
  };
  res.json(safeConfig);
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  const currentConfig = getConfig();
  // Сопоставляем по serverId, а не по индексу — это безопасно при добавлении/удалении серверов.
  const currentServerMap = new Map(currentConfig.servers.map(s => [s.id, s]));
  newConfig.servers.forEach(server => {
    if (server.password === '••••••••') {
      const currentServer = currentServerMap.get(server.id);
      if (currentServer) server.password = currentServer.password;
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

  // Для локального сервера SSH не нужен — просто сообщаем об успехе.
  if (isLocalServer(server)) return res.json({ success: true, message: 'Локальный сервер' });

  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: server.host,
      port: server.port || 22,
      username: server.username,
      password: server.password,
      readyTimeout: 15000
    });
    await sftp.end();
    res.json({ success: true, message: 'Соединение успешно' });
  } catch (err) {
    try { await sftp.end(); } catch (e) {}
    res.json({ success: false, message: err.message });
  }
});

// ====================== API: раскрытие glob-паттернов (пункт 7.2) ======================

/**
 * Раскрывает glob-паттерн в список реальных файлов через SSH exec.
 * Использует bash для надёжного раскрытия wildcards: * ? [].
 * Возвращает пустой массив при ошибке или если файлов не найдено.
 */
async function expandGlobPattern(server, pattern) {
  const pool = getSshPool(server);
  // ls -1d выводит каждый файл на отдельной строке; 2>/dev/null подавляет ошибку «не найдено».
  const cmd = `bash -c 'ls -1d ${shellEscape(pattern)} 2>/dev/null | sort'`;
  return new Promise((resolve) => {
    pool.exec(cmd).then(stream => {
      let output = '';
      stream.on('data', chunk => { output += chunk.toString('utf-8'); });
      stream.stderr?.on('data', () => {});
      stream.on('close', () => {
        const files = output.split('\n').map(f => f.trim()).filter(f => f.length > 0);
        resolve(files);
      });
      stream.on('error', () => resolve([]));
    }).catch(() => resolve([]));
  });
}

app.post('/api/expand-glob', async (req, res) => {
  const { serverId, pattern } = req.body;
  if (!pattern) return res.json({ files: [], isGlob: false });

  const hasWildcard = /[*?]/.test(pattern);
  if (!hasWildcard) return res.json({ files: [pattern], isGlob: false });

  const config = getConfig();
  const server = config.servers.find(s => s.id === serverId);
  if (!server) return res.status(400).json({ error: 'Сервер не найден' });

  // Локальный сервер: раскрываем паттерн через Node.js fs без SSH.
  if (isLocalServer(server)) {
    const files = expandGlobLocal(pattern);
    return res.json({ files, isGlob: true, pattern });
  }

  try {
    const files = await expandGlobPattern(server, pattern);
    res.json({ files, isGlob: true, pattern });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================== Локальные файлы (без SSH) ======================

/** true, если сервер обращается к файлам на той же машине, где запущен Node. */
function isLocalServer(server) {
  return server.type === 'local';
}

/**
 * Раскрывает glob-паттерн для локальных файлов без внешних зависимостей.
 * Поддерживает * (любые символы кроме разделителя) и ? (один символ).
 * Нечувствительность к регистру включается на Windows автоматически.
 */
function patternSegmentToRegex(seg) {
  const esc = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const src = '^' + esc.replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]') + '$';
  return new RegExp(src, process.platform === 'win32' ? 'i' : '');
}

function matchGlobSegmentsLocal(base, segments) {
  if (segments.length === 0) {
    try { return fs.statSync(base).isFile() ? [base] : []; } catch { return []; }
  }
  const [current, ...rest] = segments;
  const isLast = rest.length === 0;
  const regex = patternSegmentToRegex(current);
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const results = [];
  for (const entry of entries) {
    if (!regex.test(entry.name)) continue;
    const full = path.join(base, entry.name);
    if (isLast) { if (entry.isFile()) results.push(full); }
    else        { if (entry.isDirectory()) results.push(...matchGlobSegmentsLocal(full, rest)); }
  }
  return results;
}

function expandGlobLocal(pattern) {
  const normed = path.normalize(pattern);
  const segs   = normed.split(path.sep);
  let fixedSegs = [], globSegs = [], inGlob = false;
  for (const seg of segs) {
    if (!inGlob && !seg.includes('*') && !seg.includes('?')) fixedSegs.push(seg);
    else { inGlob = true; globSegs.push(seg); }
  }
  if (globSegs.length === 0) {
    try { return fs.statSync(normed).isFile() ? [normed] : []; } catch { return []; }
  }
  const base = fixedSegs.join(path.sep) || path.sep;
  return matchGlobSegmentsLocal(base, globSegs).sort();
}

/**
 * Строит фильтр строк по grepPattern/grepRegex/grepCaseInsensitive для локальных файлов.
 * Возвращает null, если паттерн не задан.
 */
function makeLocalLineFilter(body) {
  const pattern = typeof body?.grepPattern === 'string' ? body.grepPattern.trim() : '';
  if (!pattern) return null;
  if (body.grepRegex) {
    try {
      const re = new RegExp(pattern, body.grepCaseInsensitive ? 'i' : '');
      return line => re.test(line);
    } catch { return null; }
  }
  const search = body.grepCaseInsensitive ? pattern.toLowerCase() : pattern;
  return line => (body.grepCaseInsensitive ? line.toLowerCase() : line).includes(search);
}

/**
 * Читает последние n строк файла через Node.js ReadStream.
 * Применяет необязательный фильтр к каждой строке.
 */
function readLastNLinesLocal(filePath, n, filter = null) {
  return new Promise((resolve) => {
    const lines = [];
    let buf = '';
    const stream = fs.createReadStream(filePath, { highWaterMark: 65536 });
    stream.on('data', chunk => {
      buf += chunk.toString('utf-8');
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts) { if (!filter || filter(line)) lines.push(line); }
    });
    stream.on('end',   () => { if (buf && (!filter || filter(buf))) lines.push(buf); resolve(lines.slice(-n)); });
    stream.on('error', () => resolve([]));
  });
}

// ====================== Локальный stream-file ======================

async function streamFileLocal({ res, sendEvent, server, file, body, fromMs, toMs }) {
  const filePath = file.remotePath;
  const hasDateFilter = fromMs != null || toMs != null;
  const lineFilter   = makeLocalLineFilter(body);
  const levelFilter  = Array.isArray(body?.logLevels) && body.logLevels.length > 0
    ? body.logLevels.map(l => l.toUpperCase()) : null;

  let totalBytes = 0;
  try { totalBytes = fs.statSync(filePath).size; }
  catch (err) { sendEvent('error', { message: `Файл не найден: ${err.message}` }); return res.end(); }

  sendEvent('start', {
    fileName: path.basename(filePath), filePath,
    serverName: server.name, totalBytes, local: true
  });

  const shouldKeep = (line) => {
    if (!line.trim()) return false;
    if (lineFilter && !lineFilter(line)) return false;
    if (levelFilter) {
      try { const lv = JSON.parse(line)?.level; if (lv && !levelFilter.includes(lv.toUpperCase())) return false; }
      catch {}
    }
    if (hasDateFilter) {
      const t = getLogTimeMs(line);
      if (fromMs != null && t < fromMs) return false;
      if (toMs != null && t > toMs)    return false;
    }
    return true;
  };

  let processedBytes = 0;
  let buf = '';
  const readStream = fs.createReadStream(filePath, { highWaterMark: 65536 });

  readStream.on('data', chunk => {
    processedBytes += chunk.length;
    buf += chunk.toString('utf-8');
    const parts = buf.split('\n');
    buf = parts.pop();
    sendEvent('progress', {
      bytesLoaded: processedBytes, totalBytes,
      percent: totalBytes > 0 ? Math.round((processedBytes / totalBytes) * 100) : 0
    });
    if (parts.length > 0) {
      const toSend = parts.filter(shouldKeep);
      if (toSend.length > 0) sendEvent('lines', { lines: toSend });
    }
  });
  readStream.on('end', () => {
    if (buf.trim() && shouldKeep(buf)) sendEvent('lines', { lines: [buf] });
    sendEvent('complete', { bytesLoaded: processedBytes, totalBytes });
    res.end();
  });
  readStream.on('error', err => { sendEvent('error', { message: err.message }); res.end(); });
  res.on('close', () => { try { readStream.destroy(); } catch {} });
}

// ====================== Локальный tail-file ======================

async function tailFileLocal({ res, sendEvent, server, file, linesNum, offsetNum, body }) {
  const filePath   = file.remotePath;
  const lineFilter = makeLocalLineFilter(body);

  sendEvent('start', {
    fileName: path.basename(filePath), filePath,
    serverName: server.name, lines: linesNum, offsetLines: offsetNum,
    mode: 'tail', local: true
  });
  try {
    const total     = linesNum + offsetNum;
    // readLastNLinesLocal возвращает строки от старых к новым.
    // slice(0, linesNum) = «старшая» половина окна — аналог tail -n total | head -n linesNum.
    const allLines  = await readLastNLinesLocal(filePath, total, lineFilter);
    const pageLines = allLines.slice(0, linesNum);
    if (pageLines.length > 0) sendEvent('lines', { lines: pageLines });
    sendEvent('complete', { totalLines: pageLines.length, exitCode: 0 });
  } catch (err) {
    sendEvent('error', { message: err.message });
  }
  res.end();
}

// ====================== Локальный tail-follow (live polling) ======================

async function tailFollowLocalSse({ res, sendEvent, file, server, initialNum, keepAlive }) {
  const filePath = file.remotePath;
  let stopped = false;
  let intervalId = null;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(keepAlive);
    if (intervalId) clearInterval(intervalId);
    try { res.end(); } catch {}
  };
  res.on('close', cleanup);

  sendEvent('start', {
    fileName: path.basename(filePath), filePath,
    serverName: server.name, mode: 'live', initialLines: initialNum, local: true
  });

  try {
    const initLines = await readLastNLinesLocal(filePath, initialNum);
    if (!stopped && initLines.length > 0) sendEvent('lines', { lines: initLines });
  } catch (err) {
    sendEvent('error', { message: err.message });
    return cleanup();
  }

  let currentSize = 0;
  try { currentSize = fs.statSync(filePath).size; }
  catch (err) { sendEvent('error', { message: err.message }); return cleanup(); }

  let trailingBuf = '';
  intervalId = setInterval(() => {
    if (stopped) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > currentSize) {
        const newBytes = stat.size - currentSize;
        const chunk = Buffer.alloc(newBytes);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, chunk, 0, newBytes, currentSize);
        fs.closeSync(fd);
        currentSize = stat.size;
        trailingBuf += chunk.toString('utf-8');
        const parts = trailingBuf.split('\n');
        trailingBuf = parts.pop();
        if (parts.length > 0 && !stopped) sendEvent('lines', { lines: parts });
      } else if (stat.size < currentSize) {
        currentSize = stat.size;
        trailingBuf = '';
        sendEvent('info', { message: 'Файл ротирован' });
      }
    } catch { /* временная ошибка — повторим в следующем цикле */ }
  }, 250);
}

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

// ====================== API: загрузка целиком (с фильтром по дате) ======================
// Используется для режима "По диапазону дат"

/**
 * Реализация Range-режима при включённом серверном grep (пункт 5.3):
 * вместо потокового SFTP-чтения всего файла запускаем `grep ... file`
 * через SSH exec. По сети передаются только совпавшие строки —
 * радикальное ускорение на больших файлах.
 *
 * Прогресс по байтам источника недоступен (grep уже отфильтровал),
 * поэтому прогресс-бар индетерминантный; всё, что мы передаём, —
 * объём УЖЕ-совпавших байт.
 *
 * Фильтр по дате остаётся построчным (так же, как в SFTP-ветке) —
 * date-фильтр JSON-aware, grep его подменить не может.
 */
async function streamFileViaGrep({ res, sendEvent, server, file, grepPrefix, fromMs, toMs }) {
  const hasDateFilter = fromMs != null || toMs != null;
  const filePath = shellEscape(file.remotePath);
  const cmd = `${grepPrefix} ${filePath}`;

  let stream;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (stream) try { stream.close(); } catch (e) {}
  };

  try {
    sendEvent('start', {
      fileName: path.basename(file.remotePath),
      filePath: file.remotePath,
      serverName: server.name,
      totalBytes: 0,        // неизвестно — клиент покажет индетерминантный прогресс
      grepFilter: true
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
        const toSend = hasDateFilter
          ? parts.filter(line => {
              const t = getLogTimeMs(line);
              if (fromMs != null && t < fromMs) return false;
              if (toMs != null && t > toMs) return false;
              return true;
            })
          : parts;
        if (toSend.length > 0) {
          lineCount += toSend.length;
          sendEvent('lines', { lines: toSend });
        }
        // Прогресс по «найденным» байтам — без totalBytes,
        // клиент должен показать это как indeterminate.
        sendEvent('progress', { bytesLoaded });
      }
    });

    stream.stderr.on('data', (chunk) => {
      stderrAcc += chunk.toString('utf-8');
    });

    stream.on('close', (code) => {
      if (buffer.length > 0) {
        let toSend = [buffer];
        if (hasDateFilter) {
          const t = getLogTimeMs(buffer);
          const inRange = (fromMs == null || t >= fromMs) && (toMs == null || t <= toMs);
          toSend = inRange ? [buffer] : [];
        }
        if (toSend.length > 0) {
          lineCount += toSend.length;
          sendEvent('lines', { lines: toSend });
        }
      }
      const stderrText = stderrAcc.trim();
      // grep exit 1 = «нет совпадений», это НЕ ошибка (отдадим complete с 0 строк).
      // grep exit 2 (или произвольный со stderr) = ошибка.
      const isError = stderrText && code !== 1;
      if (isError) {
        sendEvent('error', { message: stderrText || `Exit code ${code}` });
      } else {
        sendEvent('complete', { totalLines: lineCount, bytesLoaded });
      }
      cleanup();
      res.end();
    });

    stream.on('error', (err) => {
      sendEvent('error', { message: err.message });
      cleanup();
      res.end();
    });

    res.on('close', cleanup);

  } catch (err) {
    sendEvent('error', { message: err.message });
    cleanup();
    res.end();
  }
}

/**
 * Реализация Range-режима при фильтре по уровням (пункт 5.2).
 * Через SSH exec делаем grep по уровням, затем применяем фильтр по дате
 * (date-фильтр JSON-aware, grep его подменить не может).
 *
 * Фильтрация по уровню происходит на сервере через `grep -E`,
 * что позволяет не тащить миллионы строк INFO по сети.
 *
 * Прогресс-бар индетерминантный (grep уже отфильтровал), передаём
 * объём уже-найденных байт.
 */
async function streamFileViaLevelFilter({ res, sendEvent, server, file, logLevels, fromMs, toMs }) {
  const hasDateFilter = fromMs != null || toMs != null;

  const { prefix, hasFilter } = buildLogLevelsPrefix(logLevels, { regex: true, caseInsensitive: false });
  if (!hasFilter) {
    // Уровни не заданы — отдаём пустой результат.
    sendEvent('start', {
      fileName: path.basename(file.remotePath),
      filePath: file.remotePath,
      serverName: server.name,
      totalBytes: 0,
      levelFilter: true
    });
    sendEvent('complete', { totalLines: 0, bytesLoaded: 0 });
    return res.end();
  }

  const filePath = shellEscape(file.remotePath);
  const cmd = `${prefix} ${filePath}`;

  let stream;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (stream) try { stream.close(); } catch (e) {}
  };

  try {
    sendEvent('start', {
      fileName: path.basename(file.remotePath),
      filePath: file.remotePath,
      serverName: server.name,
      totalBytes: 0,
      levelFilter: true
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
        const toSend = hasDateFilter
          ? parts.filter(line => {
              const t = getLogTimeMs(line);
              if (fromMs != null && t < fromMs) return false;
              if (toMs != null && t > toMs) return false;
              return true;
            })
          : parts;
        if (toSend.length > 0) {
          lineCount += toSend.length;
          sendEvent('lines', { lines: toSend });
        }
        sendEvent('progress', { bytesLoaded });
      }
    });

    stream.stderr.on('data', (chunk) => {
      stderrAcc += chunk.toString('utf-8');
    });

    stream.on('close', (code) => {
      if (buffer.length > 0) {
        let toSend = [buffer];
        if (hasDateFilter) {
          const t = getLogTimeMs(buffer);
          const inRange = (fromMs == null || t >= fromMs) && (toMs == null || t <= toMs);
          toSend = inRange ? [buffer] : [];
        }
        if (toSend.length > 0) {
          lineCount += toSend.length;
          sendEvent('lines', { lines: toSend });
        }
      }
      const stderrText = stderrAcc.trim();
      const isError = stderrText && code !== 1;
      if (isError) {
        sendEvent('error', { message: stderrText || `Exit code ${code}` });
      } else {
        sendEvent('complete', { totalLines: lineCount, bytesLoaded });
      }
      cleanup();
      res.end();
    });

    stream.on('error', (err) => {
      sendEvent('error', { message: err.message });
      cleanup();
      res.end();
    });

    res.on('close', cleanup);

  } catch (err) {
    sendEvent('error', { message: err.message });
    cleanup();
    res.end();
  }
}

app.post('/api/stream-file', async (req, res) => {
  const { serverId, fileId, dateFrom, dateTo, logLevels } = req.body;
  const fromMs = dateFrom ? new Date(dateFrom).getTime() : null;
  const toMs = dateTo ? new Date(dateTo).getTime() : null;
  const hasDateFilter = fromMs != null || toMs != null;
  const hasLevelFilter = Array.isArray(logLevels) && logLevels.length > 0;

  const found = findServerAndFile(serverId, fileId);
  if (found.error) return res.status(404).json({ error: found.error });
  const { server, file } = found;

  // Серверный grep (пункт 5.3): при заполненном поле «Содержит» уходим
  // в отдельный путь через SSH exec — это даёт реальную экономию трафика
  // на больших файлах, т.к. SFTP стянул бы файл целиком, а grep отдаёт
  // только совпадения.
  const { prefix: grepPrefix, hasFilter: hasGrep } = parseGrepFilter(req.body);

  setSseHeaders(res);
  const sendEvent = makeSseSender(res);

  // Локальный сервер: все варианты фильтрации реализованы в Node.js, без SSH/SFTP.
  if (isLocalServer(server)) {
    return streamFileLocal({ res, sendEvent, server, file, body: req.body, fromMs, toMs });
  }

  if (hasGrep) {
    return streamFileViaGrep({ res, sendEvent, server, file, grepPrefix, fromMs, toMs });
  }

  // --- SFTP-ветка: при фильтре по уровню переключаемся на SSH exec-grep ---
  if (hasLevelFilter) {
    return streamFileViaLevelFilter({ res, sendEvent, server, file, logLevels, fromMs, toMs });
  }

  // --- Старая ветка через SFTP, без изменений ---

  const sftp = new SftpClient();
  let totalBytes = 0;
  let processedBytes = 0;
  const CHUNK_SIZE = 64 * 1024;

  try {
    await sftp.connect({
      host: server.host,
      port: server.port || 22,
      username: server.username,
      password: server.password,
      readyTimeout: 20000
    });

    const stat = await sftp.stat(file.remotePath);
    totalBytes = stat.size;

    sendEvent('start', {
      fileName: path.basename(file.remotePath),
      filePath: file.remotePath,
      serverName: server.name,
      totalBytes
    });

    const stream = await sftp.createReadStream(file.remotePath, { highWaterMark: CHUNK_SIZE });
    let buffer = '';

    stream.on('data', (chunk) => {
      processedBytes += chunk.length;
      buffer += chunk.toString('utf-8');

      sendEvent('progress', {
        bytesLoaded: processedBytes,
        totalBytes,
        percent: Math.round((processedBytes / totalBytes) * 100)
      });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      if (lines.length > 0) {
        const toSend = hasDateFilter
          ? lines.filter(line => {
              const t = getLogTimeMs(line);
              if (fromMs != null && t < fromMs) return false;
              if (toMs != null && t > toMs) return false;
              return true;
            })
          : lines;
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

    stream.on('error', (err) => {
      sendEvent('error', { message: err.message });
      try { sftp.end(); } catch (e) {}
      res.end();
    });

    res.on('close', async () => {
      try { stream.destroy(); } catch (e) {}
      try { await sftp.end(); } catch (e) {}
    });

  } catch (err) {
    sendEvent('error', { message: err.message });
    try { await sftp.end(); } catch (e) {}
    res.end();
  }
});

// ====================== API: tail с пагинацией ======================
// Эффективная загрузка последних N строк через SSH exec.
// offsetLines позволяет загружать "более старые" страницы (для подгрузки вверх).

app.post('/api/tail-file', async (req, res) => {
  const { serverId, fileId, lines, offsetLines } = req.body;
  const linesNum = Math.max(1, Math.min(100000, parseInt(lines) || 1000));
  const offsetNum = Math.max(0, parseInt(offsetLines) || 0);

  const found = findServerAndFile(serverId, fileId);
  if (found.error) return res.status(404).json({ error: found.error });
  const { server, file } = found;

  // Серверный grep (пункт 5.3): опциональный пре-фильтр перед tail.
  const { prefix: grepPrefix, hasFilter: hasGrep } = parseGrepFilter(req.body);

  setSseHeaders(res);
  const sendEvent = makeSseSender(res);

  // Локальный сервер: читаем через Node.js без SSH.
  if (isLocalServer(server)) {
    return tailFileLocal({ res, sendEvent, server, file, linesNum, offsetNum, body: req.body });
  }

  let stream;
  let cleaned = false;

  // SSH-клиент общий через пул, поэтому закрываем только канал.
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (stream) try { stream.close(); } catch (e) {}
  };

  try {
    const filePath = shellEscape(file.remotePath);
    const totalLines = linesNum + offsetNum;

    // С grep'ом семантика «последние N СОВПАВШИХ строк» — сначала фильтруем
    // ВЕСЬ файл, потом берём хвост. Без grep'а — старая команда.
    // tail берёт последние totalLines строк, head обрезает первые linesNum:
    // получаем "окно" размером linesNum, начинающееся с offset от конца файла.
    let cmd;
    if (grepPrefix) {
      cmd = offsetNum === 0
        ? `${grepPrefix} ${filePath} | tail -n ${linesNum}`
        : `${grepPrefix} ${filePath} | tail -n ${totalLines} | head -n ${linesNum}`;
    } else {
      cmd = offsetNum === 0
        ? `tail -n ${linesNum} ${filePath}`
        : `tail -n ${totalLines} ${filePath} | head -n ${linesNum}`;
    }

    sendEvent('start', {
      fileName: path.basename(file.remotePath),
      filePath: file.remotePath,
      serverName: server.name,
      lines: linesNum,
      offsetLines: offsetNum,
      mode: 'tail',
      grepFilter: hasGrep
    });

    const pool = getSshPool(server);
    stream = await pool.exec(cmd);

    let buffer = '';
    let lineCount = 0;
    let stderrAcc = '';

    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const parts = buffer.split('\n');
      buffer = parts.pop();
      if (parts.length > 0) {
        lineCount += parts.length;
        sendEvent('lines', { lines: parts });
      }
    });

    stream.stderr.on('data', (chunk) => {
      stderrAcc += chunk.toString('utf-8');
    });

    stream.on('close', (code) => {
      if (buffer.length > 0) {
        lineCount += 1;
        sendEvent('lines', { lines: [buffer] });
      }
      const stderrText = stderrAcc.trim();
      // ТОНКОСТЬ grep-режима:
      // В пайпе `grep ... | tail -n N` итоговый exit code = exit code tail,
      // который почти всегда 0, ДАЖЕ если grep упал с "Invalid regular
      // expression" или "No such file". Без специальной обработки клиент
      // увидит "complete" с 0 строк и не поймёт, что произошло.
      // Поэтому: в grep-режиме непустой stderr трактуем как ошибку
      // независимо от exit code. В обычном tail-режиме оставляем старое
      // поведение (code !== 0 && stderr).
      const isError = stderrText && (code !== 0 || hasGrep);
      if (isError) {
        sendEvent('error', { message: stderrText || `Exit code ${code}` });
      } else {
        sendEvent('complete', { totalLines: lineCount, exitCode: code });
      }
      cleanup();
      res.end();
    });

    stream.on('error', (err) => {
      sendEvent('error', { message: err.message });
      cleanup();
      res.end();
    });

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

  // Пинг каждые 25с для поддержания соединения через прокси.
  const keepAlive = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(': keepalive\n\n'); } catch (e) {}
  }, 25000);

  // Локальный сервер: polling через fs вместо SSH tail -F.
  if (isLocalServer(server)) {
    return tailFollowLocalSse({ res, sendEvent, file, server, initialNum, keepAlive });
  }

  // SSH-клиент общий через пул, поэтому закрываем только канал —
  // отправляем remote-процессу tail сигнал TERM и закрываем канал.
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepAlive);
    if (stream) {
      try { stream.signal('TERM'); } catch (e) {}
      try { stream.close(); } catch (e) {}
    }
  };

  try {
    const filePath = shellEscape(file.remotePath);
    // -F: переоткрывает файл при ротации, ждёт если файла ещё нет.
    const cmd = `tail -n ${initialNum} -F ${filePath}`;

    sendEvent('start', {
      fileName: path.basename(file.remotePath),
      filePath: file.remotePath,
      serverName: server.name,
      mode: 'live',
      initialLines: initialNum
    });

    const pool = getSshPool(server);
    stream = await pool.exec(cmd);

    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const parts = buffer.split('\n');
      buffer = parts.pop();
      if (parts.length > 0) {
        sendEvent('lines', { lines: parts });
      }
    });

    stream.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8').trim();
      const lower = text.toLowerCase();
      // tail -F пишет в stderr сообщения о ротации — это не ошибки.
      const isFatal = lower.includes('no such file')
        || lower.includes('permission denied')
        || lower.includes('cannot open');
      if (isFatal) sendEvent('error', { message: text });
      else if (text) sendEvent('info', { message: text });
    });

    stream.on('close', (code) => {
      if (buffer.length > 0) sendEvent('lines', { lines: [buffer] });
      sendEvent('end', { exitCode: code });
      cleanup();
      try { res.end(); } catch (e) {}
    });

    stream.on('error', (err) => {
      sendEvent('error', { message: err.message });
      cleanup();
      try { res.end(); } catch (e) {}
    });

    res.on('close', cleanup);

  } catch (err) {
    sendEvent('error', { message: err.message });
    cleanup();
    try { res.end(); } catch (e) {}
  }
});

// ====================== API: мультиплексный live-стриминг ======================
// Несколько файлов одного сервера передаются через ОДНО SSE-соединение.
// Это обходит лимит браузера в 6 одновременных HTTP/1.1 соединений на origin
// (sse-стримы long-lived, заполняют весь пул сокетов и блокируют остальные fetch'и).
//
// Формат запроса:
//   { serverId, files: [{ fileId, initialLines }, ...] }
// События SSE (в каждом, кроме control, есть fileId):
//   start            — { groupId } (один раз, в начале)
//   file-start       — { fileId, fileName, filePath, serverName, initialLines }
//   file-lines       — { fileId, lines: [...] }
//   file-info        — { fileId, message }
//   file-error       — { fileId, message }
//   file-end         — { fileId, exitCode }
//   group-end        — {} (когда все каналы закрыты)
//
// Остановка отдельного файла: POST /api/tail-follow-multi/stop { groupId, fileId }
// Остановка всей группы: abort fetch на клиенте (res.on('close')).

const liveGroups = new Map(); // groupId -> { streams: Map<fileId, stream>, sendEvent, serverId }
let liveGroupCounter = 0;

function newGroupId() {
  return `g${Date.now()}_${++liveGroupCounter}`;
}

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
  // closers: Map<fileId, () => void> — унифицированный способ остановить один поток
  // (SSH-stream.signal('TERM') или clearInterval для локального polling).
  const group = { closers: new Map(), sendEvent, serverId };
  liveGroups.set(groupId, group);

  // Пинг каждые 25с для поддержания соединения через прокси.
  const keepAlive = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(': keepalive\n\n'); } catch (e) {}
  }, 25000);

  let closed = false;
  const closeAll = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    for (const closer of group.closers.values()) { try { closer(); } catch {} }
    group.closers.clear();
    liveGroups.delete(groupId);
    try { res.end(); } catch (e) {}
  };

  // Закрытие отдельного потока по fileId. Если был последний — закрываем всё.
  const closeFile = (fileId) => {
    const closer = group.closers.get(fileId);
    if (!closer) return false;
    group.closers.delete(fileId);
    try { closer(); } catch {}
    if (group.closers.size === 0) {
      sendEvent('group-end', {});
      closeAll();
    }
    return true;
  };
  group.closeFile = closeFile;

  sendEvent('start', { groupId });

  const pool = isLocalServer(server) ? null : getSshPool(server);

  // Стартуем все потоки параллельно. Ошибки одного файла не должны валить группу.
  for (const fileSpec of files) {
    const file = server.files.find(f => f.id === fileSpec.fileId);
    if (!file) {
      sendEvent('file-error', { fileId: fileSpec.fileId, message: 'Файл не найден в конфиге' });
      sendEvent('file-end', { fileId: fileSpec.fileId, exitCode: -1 });
      continue;
    }
    const initialNum = Math.max(0, Math.min(10000, parseInt(fileSpec.initialLines) || 100));
    const fileId = fileSpec.fileId;

    if (isLocalServer(server)) {
      // ---- Ветка локального файла (polling через fs) ----
      (async () => {
        const filePath = file.remotePath;
        let stopped = false;
        let intervalId = null;

        // Регистрируем closer сразу, чтобы closeAll/closeFile могли остановить.
        const registerCloser = () => group.closers.set(fileId, () => {
          stopped = true;
          if (intervalId) clearInterval(intervalId);
        });
        registerCloser();

        sendEvent('file-start', {
          fileId,
          fileName: path.basename(filePath),
          filePath,
          serverName: server.name,
          mode: 'live',
          initialLines: initialNum,
          local: true
        });

        const initLines = await readLastNLinesLocal(filePath, initialNum).catch(() => []);
        if (!stopped && initLines.length > 0) sendEvent('file-lines', { fileId, lines: initLines });

        if (stopped) return;

        let currentSize = 0;
        try { currentSize = fs.statSync(filePath).size; } catch {}
        let trailingBuf = '';

        intervalId = setInterval(() => {
          if (stopped) return;
          try {
            const stat = fs.statSync(filePath);
            if (stat.size > currentSize) {
              const newBytes = stat.size - currentSize;
              const chunk = Buffer.alloc(newBytes);
              const fd = fs.openSync(filePath, 'r');
              fs.readSync(fd, chunk, 0, newBytes, currentSize);
              fs.closeSync(fd);
              currentSize = stat.size;
              trailingBuf += chunk.toString('utf-8');
              const parts = trailingBuf.split('\n');
              trailingBuf = parts.pop();
              if (parts.length > 0 && !stopped) sendEvent('file-lines', { fileId, lines: parts });
            } else if (stat.size < currentSize) {
              currentSize = stat.size;
              trailingBuf = '';
            }
          } catch {}
        }, 250);

        // Обновляем closer, теперь включая intervalId.
        registerCloser();
      })().catch(err => {
        console.error(`[multi-live-local] ошибка fileId=${fileId}:`, err);
        sendEvent('file-error', { fileId, message: String(err.message || err) });
      });
      continue;
    }

    // ---- SSH-ветка ----
    (async () => {
      const filePath = shellEscape(file.remotePath);
      const cmd = `tail -n ${initialNum} -F ${filePath}`;
      let stream;
      try {
        stream = await pool.exec(cmd);
      } catch (err) {
        sendEvent('file-error', { fileId, message: err.message });
        sendEvent('file-end', { fileId, exitCode: -1 });
        return;
      }

      if (closed) {
        try { stream.close(); } catch (e) {}
        return;
      }

      group.closers.set(fileId, () => {
        try { stream.signal('TERM'); } catch {}
        try { stream.close(); } catch {}
      });

      sendEvent('file-start', {
        fileId,
        fileName: path.basename(file.remotePath),
        filePath: file.remotePath,
        serverName: server.name,
        mode: 'live',
        initialLines: initialNum
      });

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
        const isFatal = lower.includes('no such file')
          || lower.includes('permission denied')
          || lower.includes('cannot open');
        if (isFatal) sendEvent('file-error', { fileId, message: text });
        else sendEvent('file-info', { fileId, message: text });
      });

      stream.on('close', (code) => {
        if (buffer.length > 0) sendEvent('file-lines', { fileId, lines: [buffer] });
        sendEvent('file-end', { fileId, exitCode: code });
        group.closers.delete(fileId);
        if (group.closers.size === 0 && !closed) {
          setTimeout(() => {
            if (group.closers.size === 0 && !closed) {
              sendEvent('group-end', {});
              closeAll();
            }
          }, 100);
        }
      });

      stream.on('error', (err) => {
        sendEvent('file-error', { fileId, message: err.message });
      });
    })().catch(err => {
      console.error(`[multi-live] непойманная ошибка для fileId=${fileId}:`, err);
      sendEvent('file-error', { fileId, message: String(err.message || err) });
    });
  }

  res.on('close', closeAll);
});

// Управляющий эндпоинт: остановить отдельный файл в группе или всю группу.
app.post('/api/tail-follow-multi/stop', (req, res) => {
  const { groupId, fileId } = req.body || {};
  const group = liveGroups.get(groupId);
  if (!group) return res.json({ success: false, message: 'Группа не найдена (возможно, уже закрыта)' });

  if (fileId) {
    const ok = group.closeFile(fileId);
    return res.json({ success: ok });
  }
  // без fileId — закрываем всю группу
  for (const fid of Array.from(group.closers.keys())) group.closeFile(fid);
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

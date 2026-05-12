// Smoke-тесты HTTP-сервера. Поднимаем server.js на случайном порту,
// бьём по эндпоинтам и проверяем базовое поведение. Без mock-SSH
// (это отдельный шаг — см. README, раздел «Тестирование»).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// server.js хардкодит PORT=5000. Чтобы тесты не упирались в занятый порт
// и не толкались с реально запущенным dev-сервером, копируем server.js
// во временный файл и переписываем PORT на свободный (8001).
const TEST_PORT = 8001;
let serverProcess;
let tempServerPath;

before(async () => {
  const original = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf-8');
  const patched = original.replace(/const\s+PORT\s*=\s*\d+\s*;/, `const PORT = ${TEST_PORT};`);
  tempServerPath = path.join(projectRoot, '.server.test.js');
  fs.writeFileSync(tempServerPath, patched, 'utf-8');

  serverProcess = spawn('node', [tempServerPath], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Ждём, пока сервер сообщит о готовности
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Сервер не стартовал за 10с')), 10000);
    serverProcess.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`http://localhost:${TEST_PORT}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr.on('data', (chunk) => {
      // не падаем на stderr — там могут быть предупреждения; просто логируем
      process.stderr.write(`[server stderr] ${chunk}`);
    });
    serverProcess.on('error', reject);
  });

  // Маленький дополнительный буфер на установление listen()
  await delay(100);
});

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await new Promise(resolve => serverProcess.once('exit', resolve));
  }
  if (tempServerPath) {
    try { fs.unlinkSync(tempServerPath); } catch (e) {}
  }
});

async function get(pathname) {
  const res = await fetch(`http://localhost:${TEST_PORT}${pathname}`);
  return res;
}

async function postJson(pathname, body) {
  const res = await fetch(`http://localhost:${TEST_PORT}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res;
}

// ====================== Статика ======================

test('GET / отдаёт index.html', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /<title>Просмотр логов<\/title>/);
  // Должен ссылаться на новые модули
  assert.match(text, /\/public\/styles\.css/);
  assert.match(text, /\/public\/app\.js/);
});

test('GET /public/styles.css отдаётся как CSS', async () => {
  const res = await get('/public/styles.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /css/);
  const text = await res.text();
  assert.match(text, /:root/);
});

test('GET /public/utils.js отдаётся как JS', async () => {
  const res = await get('/public/utils.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  const text = await res.text();
  assert.match(text, /export function parseLogLine/);
});

test('GET несуществующего файла → 404', async () => {
  const res = await get('/no-such-thing.txt');
  assert.equal(res.status, 404);
});

// ====================== /api/config ======================

test('GET /api/config возвращает JSON со списком серверов', async () => {
  const res = await get('/api/config');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.servers));
});

test('GET /api/config маскирует пароли', async () => {
  const res = await get('/api/config');
  const body = await res.json();
  for (const server of body.servers) {
    // Если пароль есть — он маскирован; если нет — пустая строка
    if (server.password) {
      assert.equal(server.password, '••••••••', `пароль для ${server.name} должен быть замаскирован`);
    }
  }
});

test('GET /api/reload-config возвращает success', async () => {
  const res = await get('/api/reload-config');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.serversCount, 'number');
});

// ====================== Валидация ввода ======================

test('POST /api/test-connection-by-id с несуществующим id → success:false', async () => {
  const res = await postJson('/api/test-connection-by-id', { serverId: 'nonexistent-server-xyz' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.match(body.message, /не найден/i);
});

test('POST /api/tail-follow-multi без serverId → 400', async () => {
  const res = await postJson('/api/tail-follow-multi', { files: [] });
  assert.equal(res.status, 400);
});

test('POST /api/tail-follow-multi с пустым массивом files → 400', async () => {
  const res = await postJson('/api/tail-follow-multi', { serverId: 'x', files: [] });
  assert.equal(res.status, 400);
});

test('POST /api/tail-follow-multi с неизвестным serverId → 404', async () => {
  const res = await postJson('/api/tail-follow-multi', {
    serverId: 'no-such-server',
    files: [{ fileId: 'x', initialLines: 10 }]
  });
  assert.equal(res.status, 404);
});

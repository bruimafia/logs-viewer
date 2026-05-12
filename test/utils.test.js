// Unit-тесты чистых функций из public/utils.js.
// Запуск: npm test (node --test ниже Node 18 не поддерживается).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLogLine,
  applyFilters,
  sortLogs,
  formatBytes,
  escapeHtml,
  highlightMatch
} from '../public/utils.js';

// ====================== parseLogLine ======================

test('parseLogLine: корректная JSON-строка парсится и обогащается метаданными', () => {
  const entry = parseLogLine(
    '{"time":"2024-01-15T10:30:00.000Z","level":"INFO","msg":"hello","service":"db"}',
    'fallback'
  );
  assert.ok(entry);
  assert.equal(entry.level, 'INFO');
  assert.equal(entry.msg, 'hello');
  assert.equal(entry._serviceKey, 'db');
  assert.equal(entry._sourceName, 'fallback');
  assert.equal(entry._timeMs, Date.parse('2024-01-15T10:30:00.000Z'));
});

test('parseLogLine: пустая строка → null', () => {
  assert.equal(parseLogLine('', 'src'), null);
  assert.equal(parseLogLine('   ', 'src'), null);
  assert.equal(parseLogLine(null, 'src'), null);
});

test('parseLogLine: невалидный JSON → null', () => {
  assert.equal(parseLogLine('not json', 'src'), null);
  assert.equal(parseLogLine('{broken', 'src'), null);
});

test('parseLogLine: массив или строка JSON (не объект) → null', () => {
  // applyFilters работает с .level/.msg/._serviceKey, а на массивах их нет.
  assert.equal(parseLogLine('[1,2,3]', 'src'), null);
  assert.equal(parseLogLine('"just a string"', 'src'), null);
});

test('parseLogLine: service из JSON приоритетнее sourceName', () => {
  const entry = parseLogLine('{"service":"order","msg":"x"}', 'fallback');
  assert.equal(entry._serviceKey, 'order');
});

test('parseLogLine: при отсутствии service берётся sourceName', () => {
  const entry = parseLogLine('{"msg":"x"}', 'app');
  assert.equal(entry._serviceKey, 'app');
});

test('parseLogLine: при отсутствии и service, и sourceName — "unknown"', () => {
  const entry = parseLogLine('{"msg":"x"}', '');
  assert.equal(entry._serviceKey, 'unknown');
});

test('parseLogLine: без поля time — _timeMs=0', () => {
  const entry = parseLogLine('{"msg":"x"}', 'app');
  assert.equal(entry._timeMs, 0);
});

test('parseLogLine: с невалидным time — _timeMs=0 (а не NaN)', () => {
  const entry = parseLogLine('{"time":"бред","msg":"x"}', 'app');
  assert.equal(entry._timeMs, 0);
});

// ====================== applyFilters ======================

const makeLogs = () => [
  { _timeMs: 100, _serviceKey: 'a', level: 'INFO',  msg: 'hello world' },
  { _timeMs: 200, _serviceKey: 'a', level: 'ERROR', msg: 'oops' },
  { _timeMs: 300, _serviceKey: 'b', level: 'WARN',  msg: 'careful' },
  { _timeMs: 400, _serviceKey: 'c', level: 'DEBUG', msg: 'verbose hello' }
];

test('applyFilters: пустые фильтры → исходный массив', () => {
  const logs = makeLogs();
  const result = applyFilters(logs, {
    search: '',
    activeLevels: [],
    fromMs: null,
    toMs: null,
    serviceVisibility: null
  });
  assert.equal(result.length, 4);
});

test('applyFilters: search по msg регистронезависимо', () => {
  const result = applyFilters(makeLogs(), {
    search: 'HELLO',
    activeLevels: [],
    fromMs: null,
    toMs: null,
    serviceVisibility: null
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(e => e.msg), ['hello world', 'verbose hello']);
});

test('applyFilters: search по дополнительным полям (через JSON.stringify)', () => {
  const logs = [
    { _timeMs: 1, _serviceKey: 'a', level: 'INFO', msg: 'm1', traceId: 'abc-123' },
    { _timeMs: 2, _serviceKey: 'b', level: 'INFO', msg: 'm2', traceId: 'def-456' }
  ];
  const result = applyFilters(logs, {
    search: 'abc',
    activeLevels: [],
    fromMs: null,
    toMs: null,
    serviceVisibility: null
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].traceId, 'abc-123');
});

test('applyFilters: фильтр по уровням', () => {
  const result = applyFilters(makeLogs(), {
    search: '',
    activeLevels: ['ERROR', 'WARN'],
    fromMs: null,
    toMs: null,
    serviceVisibility: null
  });
  assert.deepEqual(result.map(e => e.level), ['ERROR', 'WARN']);
});

test('applyFilters: фильтр по временному диапазону (обе границы включаются)', () => {
  const result = applyFilters(makeLogs(), {
    search: '',
    activeLevels: [],
    fromMs: 200,
    toMs: 300,
    serviceVisibility: null
  });
  assert.deepEqual(result.map(e => e._timeMs), [200, 300]);
});

test('applyFilters: serviceVisibility — false скрывает сервис, отсутствующий ключ оставляет', () => {
  const result = applyFilters(makeLogs(), {
    search: '',
    activeLevels: [],
    fromMs: null,
    toMs: null,
    serviceVisibility: { a: true, b: false /* c отсутствует — значит видим */ }
  });
  assert.deepEqual(result.map(e => e._serviceKey), ['a', 'a', 'c']);
});

test('applyFilters: исходный массив не мутирован', () => {
  const logs = makeLogs();
  const before = [...logs];
  applyFilters(logs, { search: 'hello', activeLevels: ['INFO'], fromMs: null, toMs: null, serviceVisibility: null });
  assert.deepEqual(logs, before);
});

// ====================== sortLogs ======================

test('sortLogs: time-asc возрастает', () => {
  const logs = [
    { _timeMs: 300 }, { _timeMs: 100 }, { _timeMs: 200 }
  ];
  const result = sortLogs(logs, 'time-asc');
  assert.deepEqual(result.map(e => e._timeMs), [100, 200, 300]);
});

test('sortLogs: time-desc убывает', () => {
  const logs = [
    { _timeMs: 100 }, { _timeMs: 300 }, { _timeMs: 200 }
  ];
  const result = sortLogs(logs, 'time-desc');
  assert.deepEqual(result.map(e => e._timeMs), [300, 200, 100]);
});

test('sortLogs: по сервису, потом по времени', () => {
  const logs = [
    { _timeMs: 200, _serviceKey: 'b' },
    { _timeMs: 100, _serviceKey: 'a' },
    { _timeMs: 150, _serviceKey: 'a' }
  ];
  const result = sortLogs(logs, 'service');
  assert.deepEqual(result.map(e => `${e._serviceKey}/${e._timeMs}`), ['a/100', 'a/150', 'b/200']);
});

test('sortLogs: по уровню — порядок ERROR<WARN<INFO<DEBUG<остальное', () => {
  const logs = [
    { _timeMs: 1, level: 'INFO' },
    { _timeMs: 2, level: 'ERROR' },
    { _timeMs: 3, level: 'DEBUG' },
    { _timeMs: 4, level: 'WARN' },
    { _timeMs: 5, level: 'TRACE' }   // неизвестный — в конце
  ];
  const result = sortLogs(logs, 'level');
  assert.deepEqual(result.map(e => e.level), ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']);
});

test('sortLogs: исходный массив не мутирован', () => {
  const logs = [{ _timeMs: 200 }, { _timeMs: 100 }];
  const before = [...logs];
  sortLogs(logs, 'time-asc');
  assert.deepEqual(logs, before);
});

// ====================== formatBytes ======================

test('formatBytes: 0 → "0 B"', () => {
  assert.equal(formatBytes(0), '0 B');
});

test('formatBytes: null/undefined → "0 B"', () => {
  assert.equal(formatBytes(null), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
});

test('formatBytes: KB / MB / GB', () => {
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1024 * 1024), '1 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1 GB');
});

test('formatBytes: дробная часть округляется до десятой', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
});

// ====================== escapeHtml ======================

test('escapeHtml (Node-ветка): экранирует основные спецсимволы', () => {
  // В Node нет document — модуль использует ручную замену.
  assert.equal(escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('escapeHtml: null/undefined → пустая строка', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

// ====================== highlightMatch ======================

test('highlightMatch: пустой query — возвращает экранированный текст без mark', () => {
  assert.equal(highlightMatch('hello <b>', ''), 'hello &lt;b&gt;');
  assert.equal(highlightMatch('hello <b>', null), 'hello &lt;b&gt;');
  assert.equal(highlightMatch('hello <b>', undefined), 'hello &lt;b&gt;');
});

test('highlightMatch: null/undefined text — пустая строка', () => {
  assert.equal(highlightMatch(null, 'x'), '');
  assert.equal(highlightMatch(undefined, 'x'), '');
});

test('highlightMatch: пустой text', () => {
  assert.equal(highlightMatch('', 'abc'), '');
});

test('highlightMatch: простое совпадение оборачивается в <mark>', () => {
  assert.equal(
    highlightMatch('hello world', 'world'),
    'hello <mark class="search-match">world</mark>'
  );
});

test('highlightMatch: совпадение в начале строки', () => {
  assert.equal(
    highlightMatch('world hello', 'world'),
    '<mark class="search-match">world</mark> hello'
  );
});

test('highlightMatch: регистронезависимое, регистр исходного текста сохраняется', () => {
  assert.equal(
    highlightMatch('Hello WORLD', 'world'),
    'Hello <mark class="search-match">WORLD</mark>'
  );
});

test('highlightMatch: несколько совпадений подсвечиваются все', () => {
  assert.equal(
    highlightMatch('foo bar foo', 'foo'),
    '<mark class="search-match">foo</mark> bar <mark class="search-match">foo</mark>'
  );
});

test('highlightMatch: HTML экранируется и снаружи, и внутри mark', () => {
  assert.equal(
    highlightMatch('<script>alert(x)</script>', 'alert'),
    '&lt;script&gt;<mark class="search-match">alert</mark>(x)&lt;/script&gt;'
  );
});

test('highlightMatch: спецсимволы regex в query трактуются как литералы', () => {
  // Точка не должна совпадать с «X» (как было бы при некорректном использовании RegExp).
  assert.equal(
    highlightMatch('aXb a.b', '.'),
    'aXb a<mark class="search-match">.</mark>b'
  );
});

test('highlightMatch: совпадений нет — возвращает только escapeHtml(text)', () => {
  assert.equal(
    highlightMatch('hello <world>', 'xyz'),
    'hello &lt;world&gt;'
  );
});

test('highlightMatch: непересекающиеся совпадения, шаг = длине иголки', () => {
  // "aaaa" с поиском "aa" → ровно два совпадения, не четыре
  assert.equal(
    highlightMatch('aaaa', 'aa'),
    '<mark class="search-match">aa</mark><mark class="search-match">aa</mark>'
  );
});

test('highlightMatch: query длиннее текста — совпадений нет', () => {
  assert.equal(highlightMatch('hi', 'hello'), 'hi');
});

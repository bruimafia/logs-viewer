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
  highlightMatch,
  getQuickRange,
  msToDatetimeLocalValue,
  getTraceId,
  traceIdColor,
  shortTraceId,
  DEFAULT_TRACE_FIELDS,
  formatTimeFull,
  formatRelativeTime
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

test('parseLogLine: _traceId извлекается из traceId', () => {
  const e = parseLogLine('{"msg":"x","traceId":"abc"}', 'app');
  assert.equal(e._traceId, 'abc');
});

test('parseLogLine: _traceId извлекается из request_id (snake_case)', () => {
  const e = parseLogLine('{"msg":"x","request_id":"r1"}', 'app');
  assert.equal(e._traceId, 'r1');
});

test('parseLogLine: _traceId — пустая строка при отсутствии trace-полей', () => {
  const e = parseLogLine('{"msg":"x"}', 'app');
  assert.equal(e._traceId, '');
});

// ====================== getTraceId ======================

test('getTraceId: DEFAULT_TRACE_FIELDS включает все основные варианты', () => {
  assert.deepEqual(DEFAULT_TRACE_FIELDS, [
    'traceId', 'trace_id', 'requestId', 'request_id', 'correlationId', 'correlation_id'
  ]);
});

test('getTraceId: traceId имеет наивысший приоритет', () => {
  assert.equal(
    getTraceId({ traceId: 'a', trace_id: 'b', requestId: 'c', request_id: 'd' }),
    'a'
  );
});

test('getTraceId: trace_id, если traceId отсутствует', () => {
  assert.equal(getTraceId({ trace_id: 'b' }), 'b');
});

test('getTraceId: requestId / request_id распознаются', () => {
  assert.equal(getTraceId({ requestId: 'r' }), 'r');
  assert.equal(getTraceId({ request_id: 'r' }), 'r');
});

test('getTraceId: correlationId / correlation_id распознаются', () => {
  assert.equal(getTraceId({ correlationId: 'k' }), 'k');
  assert.equal(getTraceId({ correlation_id: 'k' }), 'k');
});

test('getTraceId: число конвертируется в строку', () => {
  assert.equal(getTraceId({ traceId: 12345 }), '12345');
  assert.equal(getTraceId({ traceId: 0 }), '0');
});

test('getTraceId: NaN/Infinity пропускаются', () => {
  assert.equal(getTraceId({ traceId: NaN, requestId: 'r' }), 'r');
  assert.equal(getTraceId({ traceId: Infinity, requestId: 'r' }), 'r');
});

test('getTraceId: пустые/нулевые значения пропускаются — берём следующий вариант', () => {
  assert.equal(getTraceId({ traceId: '', requestId: 'r' }), 'r');
  assert.equal(getTraceId({ traceId: null, trace_id: undefined, requestId: 'r' }), 'r');
});

test('getTraceId: массивы/объекты/булевы значения не считаются trace-полем', () => {
  assert.equal(getTraceId({ traceId: [1, 2], requestId: 'r' }), 'r');
  assert.equal(getTraceId({ traceId: {}, requestId: 'r' }), 'r');
  assert.equal(getTraceId({ traceId: true, requestId: 'r' }), 'r');
});

test('getTraceId: ни одного распознанного поля — пустая строка', () => {
  assert.equal(getTraceId({ msg: 'x' }), '');
});

test('getTraceId: null/undefined/массив на входе — пустая строка', () => {
  assert.equal(getTraceId(null), '');
  assert.equal(getTraceId(undefined), '');
  assert.equal(getTraceId([1, 2, 3]), '');
});

test('getTraceId: настраиваемый список полей', () => {
  assert.equal(getTraceId({ xId: 'v' }, ['xId']), 'v');
  // Если в кастомный список не входит traceId — он игнорируется.
  assert.equal(getTraceId({ traceId: 'def', xId: 'v' }, ['xId']), 'v');
});

// ====================== traceIdColor / shortTraceId ======================

test('traceIdColor: возвращает hsl-строку с hue в диапазоне 0..359', () => {
  for (const tid of ['abc', '550e8400-e29b-41d4-a716-446655440000', '0', 'X', 'long-trace-id-1']) {
    const c = traceIdColor(tid);
    assert.match(c, /^hsl\(\d+, 60%, 55%\)$/);
    const hue = Number(c.match(/^hsl\((\d+)/)[1]);
    assert.ok(hue >= 0 && hue < 360, `hue ${hue} вне диапазона`);
  }
});

test('traceIdColor: детерминирован — один traceId всегда даёт один цвет', () => {
  assert.equal(traceIdColor('foo'), traceIdColor('foo'));
  assert.equal(traceIdColor('abc-123'), traceIdColor('abc-123'));
});

test('traceIdColor: разные traceId обычно дают разный hue (выборочная проверка)', () => {
  const a = traceIdColor('abc-001');
  const b = traceIdColor('xyz-999');
  assert.notEqual(a, b);
});

test('shortTraceId: короткие строки возвращаются как есть', () => {
  assert.equal(shortTraceId('abc'), 'abc');
  assert.equal(shortTraceId('1234567890'), '1234567890'); // ровно 10 символов
});

test('shortTraceId: длинные строки обрезаются до 8 символов + …', () => {
  assert.equal(shortTraceId('550e8400-e29b-41d4-a716-446655440000'), '550e8400…');
});

test('shortTraceId: пустые значения', () => {
  assert.equal(shortTraceId(''), '');
  assert.equal(shortTraceId(null), '');
  assert.equal(shortTraceId(undefined), '');
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

test('applyFilters: traceFilter оставляет только записи с заданным _traceId', () => {
  const logs = [
    { _timeMs: 1, _serviceKey: 's', level: 'INFO', msg: 'a', _traceId: 'X' },
    { _timeMs: 2, _serviceKey: 's', level: 'INFO', msg: 'b', _traceId: 'Y' },
    { _timeMs: 3, _serviceKey: 's', level: 'INFO', msg: 'c', _traceId: 'X' },
    { _timeMs: 4, _serviceKey: 's', level: 'INFO', msg: 'd', _traceId: ''  }
  ];
  const result = applyFilters(logs, {
    search: '', activeLevels: [], fromMs: null, toMs: null,
    serviceVisibility: null, traceFilter: 'X'
  });
  assert.deepEqual(result.map(e => e.msg), ['a', 'c']);
});

test('applyFilters: traceFilter=null/undefined/"" — фильтр отключён', () => {
  const logs = [
    { _timeMs: 1, _serviceKey: 's', level: 'INFO', msg: 'a', _traceId: 'X' },
    { _timeMs: 2, _serviceKey: 's', level: 'INFO', msg: 'b', _traceId: ''  }
  ];
  for (const tf of [null, undefined, '']) {
    const result = applyFilters(logs, {
      search: '', activeLevels: [], fromMs: null, toMs: null,
      serviceVisibility: null, traceFilter: tf
    });
    assert.equal(result.length, 2, `traceFilter=${String(tf)}`);
  }
});

test('applyFilters: traceFilter комбинируется с остальными фильтрами', () => {
  const logs = [
    { _timeMs: 1, _serviceKey: 'a', level: 'INFO',  msg: 'hi', _traceId: 'X' },
    { _timeMs: 2, _serviceKey: 'a', level: 'ERROR', msg: 'oops', _traceId: 'X' },
    { _timeMs: 3, _serviceKey: 'b', level: 'ERROR', msg: 'oops', _traceId: 'X' },
    { _timeMs: 4, _serviceKey: 'a', level: 'ERROR', msg: 'oops', _traceId: 'Y' }
  ];
  const result = applyFilters(logs, {
    search: '',
    activeLevels: ['ERROR'],
    fromMs: null, toMs: null,
    serviceVisibility: { a: true, b: false },
    traceFilter: 'X'
  });
  // Должна остаться только запись с traceId=X, уровнем ERROR и сервисом a
  assert.equal(result.length, 1);
  assert.equal(result[0]._timeMs, 2);
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
  assert.deepEqual(
    result.map(e => `${e._serviceKey}/${e._timeMs}`),
    ['a/100', 'a/150', 'b/200']
  );
});

test('sortLogs: по уровню — ERROR/WARN/INFO/DEBUG, неизвестные в конце', () => {
  const logs = [
    { _timeMs: 1, level: 'INFO' },
    { _timeMs: 2, level: 'ERROR' },
    { _timeMs: 3, level: 'DEBUG' },
    { _timeMs: 4, level: 'WARN' },
    { _timeMs: 5, level: 'TRACE' /* неизвестный */ }
  ];
  const result = sortLogs(logs, 'level');
  assert.deepEqual(result.map(e => e.level), ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']);
});

test('sortLogs: режим trace группирует записи по traceId, между группами — по minTime', () => {
  const logs = [
    { _timeMs: 100, _traceId: 'X', _serviceKey: 's' },
    { _timeMs: 200, _traceId: '',  _serviceKey: 's' },
    { _timeMs: 50,  _traceId: 'Y', _serviceKey: 's' },
    { _timeMs: 300, _traceId: 'X', _serviceKey: 's' },
    { _timeMs: 150, _traceId: '',  _serviceKey: 's' }
  ];
  const result = sortLogs(logs, 'trace');
  // Y(50) → X-100 → X-300 (группа X цельная) → anon-150 → anon-200
  assert.deepEqual(
    result.map(e => `${e._traceId || '-'}/${e._timeMs}`),
    ['Y/50', 'X/100', 'X/300', '-/150', '-/200']
  );
});

test('sortLogs: режим trace без traceId — фактически time-asc для одиночных', () => {
  const logs = [
    { _timeMs: 300, _traceId: '' },
    { _timeMs: 100, _traceId: '' },
    { _timeMs: 200, _traceId: '' }
  ];
  const result = sortLogs(logs, 'trace');
  assert.deepEqual(result.map(e => e._timeMs), [100, 200, 300]);
});

test('sortLogs: режим trace — группа сохраняет внутренний порядок по времени', () => {
  // Одна большая трасса с пересекающимися по времени записями
  const logs = [
    { _timeMs: 500, _traceId: 'T' },
    { _timeMs: 100, _traceId: 'T' },
    { _timeMs: 300, _traceId: 'T' },
    { _timeMs: 200, _traceId: 'T' }
  ];
  const result = sortLogs(logs, 'trace');
  assert.deepEqual(result.map(e => e._timeMs), [100, 200, 300, 500]);
});

test('sortLogs: режим trace — исходный массив не мутируется', () => {
  const logs = [
    { _timeMs: 2, _traceId: 'B' },
    { _timeMs: 1, _traceId: 'A' }
  ];
  const before = logs.map(e => ({ ...e }));
  sortLogs(logs, 'trace');
  assert.deepEqual(logs, before);
});

// ====================== formatBytes ======================

test('formatBytes: 0/null/undefined → "0 B"', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(null), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
});

test('formatBytes: байты, килобайты, мегабайты', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1 GB');
});

// ====================== escapeHtml ======================

test('escapeHtml: спецсимволы HTML экранируются', () => {
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

// ====================== getQuickRange ======================

test('getQuickRange: 5m — fromMs = now - 5 минут, toMs = now', () => {
  const now = 1_700_000_000_000;
  const r = getQuickRange('5m', now);
  assert.equal(r.toMs, now);
  assert.equal(r.fromMs, now - 5 * 60_000);
});

test('getQuickRange: 15m / 1h / 6h / 24h / 7d — корректные смещения', () => {
  const now = 1_700_000_000_000;
  assert.equal(getQuickRange('15m', now).fromMs, now - 15 * 60_000);
  assert.equal(getQuickRange('1h',  now).fromMs, now - 60 * 60_000);
  assert.equal(getQuickRange('6h',  now).fromMs, now - 6 * 60 * 60_000);
  assert.equal(getQuickRange('24h', now).fromMs, now - 24 * 60 * 60_000);
  assert.equal(getQuickRange('7d',  now).fromMs, now - 7 * 24 * 60 * 60_000);
  for (const p of ['15m', '1h', '6h', '24h', '7d']) {
    assert.equal(getQuickRange(p, now).toMs, now);
  }
});

test('getQuickRange: today — fromMs = локальная полночь, toMs = now', () => {
  const now = Date.now();
  const r = getQuickRange('today', now);
  const expected = new Date(now);
  expected.setHours(0, 0, 0, 0);
  assert.equal(r.fromMs, expected.getTime());
  assert.equal(r.toMs, now);
  assert.ok(r.fromMs <= r.toMs);
});

test('getQuickRange: yesterday — диапазон от полуночи вчера до полуночи сегодня', () => {
  const now = Date.now();
  const r = getQuickRange('yesterday', now);
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  const yesterdayMidnight = new Date(todayMidnight);
  yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
  assert.equal(r.fromMs, yesterdayMidnight.getTime());
  assert.equal(r.toMs,   todayMidnight.getTime());
  // На границе DST разница может быть 23 или 25 часов — допускаем
  const diffHours = (r.toMs - r.fromMs) / 3_600_000;
  assert.ok(diffHours >= 23 && diffHours <= 25, `ожидали ~24ч, получили ${diffHours}`);
});

test('getQuickRange: неизвестный пресет → { fromMs: null, toMs: null }', () => {
  const r = getQuickRange('xxx', Date.now());
  assert.equal(r.fromMs, null);
  assert.equal(r.toMs, null);
});

test('getQuickRange: без nowMs использует Date.now()', () => {
  const before = Date.now();
  const r = getQuickRange('1h');
  const after = Date.now();
  assert.ok(r.toMs >= before && r.toMs <= after);
  assert.equal(r.toMs - r.fromMs, 60 * 60_000);
});

// ====================== msToDatetimeLocalValue ======================

test('msToDatetimeLocalValue: форматирует мс в YYYY-MM-DDTHH:MM:SS (локально)', () => {
  const d = new Date(2024, 0, 15, 10, 30, 45);
  assert.equal(msToDatetimeLocalValue(d.getTime()), '2024-01-15T10:30:45');
});

test('msToDatetimeLocalValue: одноцифровые компоненты заполняются нулями', () => {
  const d = new Date(2024, 4, 3, 7, 5, 9);
  assert.equal(msToDatetimeLocalValue(d.getTime()), '2024-05-03T07:05:09');
});

test('msToDatetimeLocalValue: null/undefined/NaN → ""', () => {
  assert.equal(msToDatetimeLocalValue(null), '');
  assert.equal(msToDatetimeLocalValue(undefined), '');
  assert.equal(msToDatetimeLocalValue(NaN), '');
});

test('msToDatetimeLocalValue: round-trip через datetime-local', () => {
  const original = '2024-07-08T13:45:22';
  const ms = new Date(original).getTime();
  assert.equal(msToDatetimeLocalValue(ms), original);
});

// ====================== formatRelativeTime ======================
// Чистая функция: nowMs передаётся явно, чтобы тесты не зависели от Date.now().

test('formatRelativeTime: совсем недавно → "только что"', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now,         now), 'только что');
  assert.equal(formatRelativeTime(now - 3_000, now), 'только что');
});

test('formatRelativeTime: будущее в пределах нескольких секунд → "через мгновение"', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now + 2_000, now), 'через мгновение');
});

test('formatRelativeTime: секунды — русское склонение one/few/many', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now - 21_000, now), '21 секунду назад');
  assert.equal(formatRelativeTime(now - 23_000, now), '23 секунды назад');
  assert.equal(formatRelativeTime(now - 25_000, now), '25 секунд назад');
  // Граница 11 — особый случай (mod10=1, но mod100=11 → many)
  assert.equal(formatRelativeTime(now - 11_000, now), '11 секунд назад');
});

test('formatRelativeTime: минуты в прошлом', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now -      60_000, now), '1 минуту назад');
  assert.equal(formatRelativeTime(now -  5 * 60_000, now), '5 минут назад');
  assert.equal(formatRelativeTime(now - 22 * 60_000, now), '22 минуты назад');
});

test('formatRelativeTime: часы в прошлом', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now -      3_600_000, now), '1 час назад');
  assert.equal(formatRelativeTime(now -  2 * 3_600_000, now), '2 часа назад');
  assert.equal(formatRelativeTime(now -  5 * 3_600_000, now), '5 часов назад');
});

test('formatRelativeTime: дни в прошлом', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now -      86_400_000, now), '1 день назад');
  assert.equal(formatRelativeTime(now -  3 * 86_400_000, now), '3 дня назад');
  assert.equal(formatRelativeTime(now -  7 * 86_400_000, now), '7 дней назад');
});

test('formatRelativeTime: будущее за порогом — "через N единиц"', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now + 10 * 60_000,    now), 'через 10 минут');
  assert.equal(formatRelativeTime(now +  2 * 3_600_000, now), 'через 2 часа');
});

test('formatRelativeTime: null/undefined/0/NaN → ""', () => {
  assert.equal(formatRelativeTime(null,      Date.now()), '');
  assert.equal(formatRelativeTime(undefined, Date.now()), '');
  assert.equal(formatRelativeTime(0,         Date.now()), '');
  assert.equal(formatRelativeTime(NaN,       Date.now()), '');
});

// ====================== formatTimeFull ======================

test('formatTimeFull: null/0/NaN → "" (title не выставится в DOM)', () => {
  assert.equal(formatTimeFull(null),      '');
  assert.equal(formatTimeFull(undefined), '');
  assert.equal(formatTimeFull(0),         '');
  assert.equal(formatTimeFull(NaN),       '');
});

test('formatTimeFull: содержит ISO с миллисекундами', () => {
  const iso = '2024-01-15T07:30:45.123Z';
  const ms  = Date.parse(iso);
  // now == ms, чтобы относительная часть была фиксирована («только что»)
  const full = formatTimeFull(ms, ms);
  assert.ok(full.includes(`ISO: ${iso}`), `ISO-строки нет в:\n${full}`);
});

test('formatTimeFull: включает относительное время', () => {
  const ms  = Date.parse('2024-01-15T07:30:45.123Z');
  const now = ms + 10 * 60_000;
  const full = formatTimeFull(ms, now);
  assert.ok(full.includes('10 минут назад'), `relative-строки нет в:\n${full}`);
});

test('formatTimeFull: 4 строки — дата / время+TZ / ISO / relative', () => {
  const ms = Date.parse('2024-01-15T07:30:45.123Z');
  const lines = formatTimeFull(ms, ms + 60_000).split('\n');
  assert.equal(lines.length, 4, `ожидали 4 строки, получили:\n${lines.join('\n')}`);
  assert.match(lines[1], /UTC[+-]\d{2}:\d{2}/);  // вторая строка — время с TZ
  assert.ok(lines[2].startsWith('ISO: '));       // третья — ISO
});

test('formatTimeFull: время в формате HH:MM:SS.mmm с миллисекундами и TZ', () => {
  const ms   = Date.parse('2024-01-15T07:30:45.123Z');
  const full = formatTimeFull(ms, ms);
  assert.match(full, /\d{2}:\d{2}:\d{2}\.\d{3} \(UTC[+-]\d{2}:\d{2}\)/);
});

test('formatTimeFull: при пропуске relative (граничный случай "только что") всё ещё 4 строки', () => {
  // now == ms даёт "только что" — это валидная непустая relative-часть,
  // т.е. 4 строки гарантированы для любого корректного ms.
  const ms = Date.parse('2024-06-01T00:00:00.000Z');
  assert.equal(formatTimeFull(ms, ms).split('\n').length, 4);
});

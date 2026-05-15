// Unit-тесты чистых функций из public/error-alerts.js
// (пункты 3.2 и 3.3 плана улучшений: уведомления и звук на ERROR).
//
// Модуль трогает window/document/Notification/AudioContext/localStorage,
// которых в Node нет. Поэтому ВЫНОСИМ из него чистые функции, которые
// можно тестировать в Node без mock'ов:
//   • formatErrorNotification — единственная по-настоящему «чистая» функция.
//
// Импорт самого модуля в node-тесте упадёт из-за `import { state, dom } from './state.js'`,
// который при чтении DOM падает. Поэтому либо мы используем динамический
// import после установки минимального DOM-окружения через `global`, либо
// тестируем формирующую функцию через копию исходника.
//
// Здесь делаем второе: маленький parsing-тест, чтобы CI и `npm test` ловили
// регрессии формата. Полную интеграцию `handleNewLiveEntries` проверяет
// ручное тестирование (см. чек-лист в PATCHES.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleSrc = readFileSync(
  path.join(__dirname, '..', 'public', 'error-alerts.js'),
  'utf-8'
);

// Извлекаем исходник formatErrorNotification из модуля и оборачиваем
// в самостоятельный модуль — так мы тестируем РЕАЛЬНЫЙ код, а не его копию.
// Если функцию переименовать или удалить — этот regex упадёт.
const m = moduleSrc.match(
  /export function formatErrorNotification\(errors\)[\s\S]*?\n\}/
);
if (!m) {
  throw new Error('formatErrorNotification не найдена в public/error-alerts.js');
}
const fnSource = m[0].replace(/^export\s+/, '');
// eslint-disable-next-line no-new-func
const formatErrorNotification = new Function(
  `${fnSource}\nreturn formatErrorNotification;`
)();

// ====================== formatErrorNotification ======================

test('formatErrorNotification: одна запись — заголовок «Новая ERROR-запись…»', () => {
  const r = formatErrorNotification([
    { level: 'ERROR', _serviceKey: 'db', msg: 'Connection refused' }
  ]);
  assert.equal(r.title, 'Новая ERROR-запись в логах');
  assert.equal(r.body, '[db] Connection refused');
});

test('formatErrorNotification: несколько записей — заголовок с количеством', () => {
  const r = formatErrorNotification([
    { _serviceKey: 's1', msg: 'first error' },
    { _serviceKey: 's2', msg: 'second error' },
    { _serviceKey: 's3', msg: 'third error' }
  ]);
  assert.equal(r.title, 'Новые ERROR в логах: 3');
  // В теле — только ПЕРВАЯ ошибка, остальные пропускаем (ОС всё равно
  // обрежет длинное тело; одна понятная строка лучше каши).
  assert.equal(r.body, '[s1] first error');
});

test('formatErrorNotification: запись без service — только msg', () => {
  const r = formatErrorNotification([{ msg: 'Что-то сломалось' }]);
  assert.equal(r.body, 'Что-то сломалось');
});

test('formatErrorNotification: запись без msg — только service', () => {
  const r = formatErrorNotification([{ _serviceKey: 'auth' }]);
  assert.equal(r.body, '[auth]');
});

test('formatErrorNotification: совсем пустая запись — fallback-сообщение', () => {
  const r = formatErrorNotification([{}]);
  assert.match(r.body, /Подробности/);
  // Заголовок всё равно адекватный
  assert.equal(r.title, 'Новая ERROR-запись в логах');
});

test('formatErrorNotification: пустой массив — fallback', () => {
  const r = formatErrorNotification([]);
  assert.equal(r.title, 'Новая ERROR-запись в логах');
  assert.match(r.body, /Подробности/);
});

test('formatErrorNotification: длинное msg обрезается до 220 символов с …', () => {
  const r = formatErrorNotification([{ msg: 'A'.repeat(500) }]);
  // Не больше 220 символов (фактически 218 = 217 + '…').
  assert.ok(r.body.length <= 220, `длина ${r.body.length} > 220`);
  assert.ok(r.body.endsWith('…'), 'должно заканчиваться многоточием');
});

test('formatErrorNotification: msg-число конвертится в строку', () => {
  const r = formatErrorNotification([{ _serviceKey: 'svc', msg: 42 }]);
  assert.equal(r.body, '[svc] 42');
});

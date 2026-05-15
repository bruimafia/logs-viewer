// Общее изменяемое состояние, DOM-ссылки и константы.
// Используется во всех остальных модулях.
//
// state — объект, чтобы импортирующие модули видели актуальные значения
// после реассайнов (`state.allLogs = []` будет виден везде, в отличие от
// `export let allLogs`, где импортёр не может переприсвоить).

export const LIVE_BUFFER_CAP = 50000;        // Максимум записей при активных live-потоках
export const LIVE_RENDER_DEBOUNCE_MS = 200;  // Дебаунс live-рендера

export const state = {
  allLogs: [],
  fileNames: {},                // serviceKey → Set<fileName>
  serviceVisibility: {},        // serviceKey → bool
  openedFiles: [],              // Список имён открытых файлов
  remoteConfig: null,
  selectedFiles: new Set(),

  // Режим загрузки в модалке
  currentLoadMode: 'tail',

  // Состояние пагинации для tail-режима:
  // key "serverId::fileId" → { serverId, fileId, displayName, currentOffset, pageSize, server, file, totalLoaded }
  paginatedFiles: new Map(),

  // Активные live-потоки:
  // key "serverId::fileId" → { displayName, serverId, fileId, group }
  liveStreams: new Map(),

  // Глобальный флаг паузы live-потоков (пункт 3.1). При true входящие
  // строки не пушатся в allLogs, а копятся в livePausedBuffer.
  // SSE-соединение и серверные `tail -F` процессы остаются живыми.
  liveStreamPaused: false,

  // Буфер строк, накопленных во время паузы. Применяется через
  // addLinesToLogs при resume; очищается при stopAllLive.
  // Элементы: { lines: string[], displayName: string }
  livePausedBuffer: [],

  // Дебаунс live-рендера
  renderTimeout: null,
  // Флаг — пользователь прокрутил список и не хочет авто-скролла
  userScrolledAway: false,
  // Хэш текущего набора сервисов — чтобы не пересобирать чипы лишний раз
  lastChipServicesKey: '',

  // Активный фильтр по traceId / requestId.
  // null или пустая строка — фильтр выключен. Строка — показываем только записи
  // с e._traceId === currentTraceFilter. Устанавливается кликом по бейджу
  // трассы в любой записи, снимается крестиком в баннере или при «Очистить все».
  currentTraceFilter: null
};

// DOM-ссылки. Модуль грузится через <script type="module">, который
// исполняется с defer-семантикой — DOM к этому моменту уже распарсен.
export const dom = {
  fileInput: document.getElementById('fileInput'),
  openFilesLabel: document.getElementById('openFilesLabel'),
  statsEl: document.getElementById('stats'),
  logListWrap: document.getElementById('logListWrap'),
  logList: document.getElementById('logList'),
  emptyState: document.getElementById('emptyState'),
  noResultsState: document.getElementById('noResultsState'),
  searchInput: document.getElementById('search'),
  levelChecks: ['levelError', 'levelWarn', 'levelInfo', 'levelDebug'].map(id => document.getElementById(id)),
  timeFrom: document.getElementById('timeFrom'),
  timeTo: document.getElementById('timeTo'),
  quickRangeButtons: document.querySelectorAll('.quick-range-btn'),
  sortBy: document.getElementById('sortBy'),
  servicesFilter: document.getElementById('servicesFilter'),
  appendModeCheckbox: document.getElementById('appendMode'),
  compactModeCheckbox: document.getElementById('compactMode'),
  clearAllBtn: document.getElementById('clearAllBtn'),
  openRemoteBtn: document.getElementById('openRemoteBtn'),
  remoteModal: document.getElementById('remoteModal'),
  closeModalBtn: document.getElementById('closeModal'),
  cancelRemote: document.getElementById('cancelRemote'),
  loadRemoteBtn: document.getElementById('loadRemoteBtn'),
  remoteModalBody: document.getElementById('remoteModalBody'),
  liveIndicator: document.getElementById('liveIndicator'),
  liveCount: document.getElementById('liveCount'),
  stopAllLiveBtn: document.getElementById('stopAllLiveBtn'),
  pauseLiveBtn: document.getElementById('pauseLiveBtn'),
  liveStreamsList: document.getElementById('liveStreamsList'),
  loadMoreWrap: document.getElementById('loadMoreWrap'),
  loadMoreBtn: document.getElementById('loadMoreBtn'),
  loadMoreInfo: document.getElementById('loadMoreInfo'),
  liveLoadingBanner: document.getElementById('liveLoadingBanner'),
  liveLoadingList: document.getElementById('liveLoadingList'),
  liveLoadingTitle: document.getElementById('liveLoadingTitle'),
  themeToggleBtn: document.getElementById('themeToggle'),

  // Галочки 🔔 / 🔊 для пунктов 3.2 и 3.3 (см. public/error-alerts.js).
  notifyOnErrorToggle: document.getElementById('notifyOnErrorToggle'),
  soundOnErrorToggle:  document.getElementById('soundOnErrorToggle'),

  // Баннер активного фильтра по traceId
  traceFilterBanner: document.getElementById('traceFilterBanner'),
  traceFilterValue: document.getElementById('traceFilterValue'),
  traceFilterClear: document.getElementById('traceFilterClear'),

  // Мини-спарклайн со статистикой (пункт 3.4). См. public/sparkline.js.
  sparklineWrap:    document.getElementById('sparklineWrap'),
  sparklineCanvas:  document.getElementById('sparklineCanvas'),
  sparklineAxis:    document.getElementById('sparklineAxis'),
  sparklineStats:   document.getElementById('sparklineStats'),
  sparklineWindow:  document.getElementById('sparklineWindow'),
  sparklineToggle:  document.getElementById('sparklineToggle'),
  sparklineTooltip: document.getElementById('sparklineTooltip'),

  // Контейнер toast-уведомлений (пункт 6.1)
  toastContainer: document.getElementById('toastContainer')
};

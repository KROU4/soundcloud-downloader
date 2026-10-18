// Background: Chromium service worker or Firefox event page (same file).
//  - Chromium: the engine lives in an offscreen document (needs DOM for blob URLs);
//    this worker routes commands to it and provides downloads/cookies/storage.
//  - Firefox: the background page has a DOM, so the engine runs right here.
import { BLOB_TYPE, SC_TAB_PATTERNS, call, ext, onMessage } from './lib/browser.js';
import { SETTINGS_KEY } from './lib/settings.js';

const IS_SERVICE_WORKER = typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope;

// ------------------------------------------------------------ platform services

/**
 * SoundCloud session token (the site keeps it in the `oauth_token` cookie). Without
 * it the API serves only 30-second previews of many label tracks, so every Firefox
 * privacy mode has to be covered: first-party isolation makes a plain get() throw,
 * and containers keep cookies in their own stores.
 */
async function getToken() {
  const query = { url: 'https://soundcloud.com/', name: 'oauth_token' };
  for (const extra of [{}, { firstPartyDomain: 'soundcloud.com' }]) {
    try {
      const cookie = await ext.cookies.get({ ...query, ...extra });
      if (cookie?.value) return cookie.value;
    } catch {
      // try the next variant
    }
  }
  try {
    const stores = ext.cookies.getAllCookieStores ? await ext.cookies.getAllCookieStores() : [{ id: undefined }];
    for (const store of stores) {
      const all = await ext.cookies.getAll({ domain: 'soundcloud.com', name: 'oauth_token', storeId: store.id, firstPartyDomain: null });
      const found = all.find((c) => c.value);
      if (found) return found.value;
    }
  } catch {
    // Chromium rejects firstPartyDomain; the plain get() above already covered it
  }
  return null;
}

async function getSettings() {
  return (await ext.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
}

async function cacheGet(key) {
  return (await ext.storage.local.get(`cache:${key}`))[`cache:${key}`];
}

async function cacheSet(key, value) {
  await ext.storage.local.set({ [`cache:${key}`]: value });
}

const DOWNLOAD_TIMEOUT = 5 * 60 * 1000;
const ERASED = 'Загрузка удалена из списка браузера';
const pendingDownloads = new Map();

function finishDownload(id, error, filename) {
  const p = pendingDownloads.get(id);
  if (!p) return;
  pendingDownloads.delete(id);
  clearTimeout(p.timer);
  if (error) p.reject(error);
  else p.resolve(filename);
}

function settleDownload(id, item) {
  if (!pendingDownloads.has(id)) return;
  if (!item) finishDownload(id, new Error(ERASED));
  else if (item.state === 'complete') finishDownload(id, null, item.filename || '');
  else if (item.state === 'interrupted') finishDownload(id, new Error(`Сохранение прервано: ${item.error || 'неизвестная ошибка'}`));
  else if (item.danger && item.danger !== 'safe' && item.danger !== 'accepted') {
    finishDownload(id, new Error('Браузер пометил файл как опасный: подтвердите его в списке загрузок'));
  }
}

ext.downloads.onChanged.addListener((delta) => {
  if (!pendingDownloads.has(delta.id) || !(delta.state || delta.danger || delta.error)) return;
  ext.downloads.search({ id: delta.id }).then(([item]) => settleDownload(delta.id, item));
});

ext.downloads.onErased.addListener((id) => finishDownload(id, new Error(ERASED)));

/** Starts a download and resolves with the final path once it is complete. */
async function download(url, filename, { overwrite = false } = {}) {
  const id = await ext.downloads.download({ url, filename, conflictAction: overwrite ? 'overwrite' : 'uniquify', saveAs: false });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finishDownload(id, new Error('Браузер не сохранил файл за 5 минут')), DOWNLOAD_TIMEOUT);
    pendingDownloads.set(id, { resolve, reject, timer });
  });
  // Small blobs can finish before onChanged fires for us.
  ext.downloads.search({ id }).then(([item]) => settleDownload(id, item));
  return done;
}

/** Lets the offscreen document find its download after a service worker restart. */
async function findDownload(url) {
  const [item] = await ext.downloads.search({ url });
  return item ? { state: item.state, filename: item.filename, error: item.error || null } : null;
}

let lastBadge = '';
async function broadcast(state) {
  const msg = { to: 'ui', type: 'state', state };
  ext.runtime.sendMessage(msg).catch(() => {});
  try {
    for (const tab of await ext.tabs.query({ url: SC_TAB_PATTERNS })) ext.tabs.sendMessage(tab.id, msg).catch(() => {});
  } catch {
    // no tabs permission for this pattern — popup still gets updates
  }
  const left = state.jobs.flatMap((j) => j.items).filter((i) => i.status === 'queued' || i.status === 'downloading').length;
  const resolving = state.jobs.some((j) => j.status === 'resolving');
  const text = left ? String(left) : resolving ? '…' : '';
  if (text !== lastBadge) {
    lastBadge = text;
    ext.action.setBadgeText({ text });
    ext.action.setBadgeBackgroundColor({ color: '#ff5500' });
  }
}

// --------------------------------------------------------------- engine access

let enginePromise = null;
let creatingOffscreen = null;

/** Check-and-create in one shared promise, so parallel callers never race. */
function ensureOffscreen() {
  creatingOffscreen ??= (async () => {
    const existing = ext.runtime.getContexts ? await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [];
    if (existing.length) return;
    try {
      await ext.offscreen.createDocument({
        url: 'engine/host.html',
        reasons: ['BLOBS'],
        justification: 'Сборка аудиофайла с обложкой и тегами перед сохранением',
      });
    } catch (e) {
      if (!/single offscreen document/i.test(e?.message || '')) throw e;
    }
  })().finally(() => {
    creatingOffscreen = null;
  });
  return creatingOffscreen;
}

if (!IS_SERVICE_WORKER) {
  enginePromise = import('./engine/engine.js').then(
    ({ Engine }) =>
      new Engine({
        getSettings,
        getToken,
        cacheGet,
        cacheSet,
        broadcast,
        // Firefox suspends idle event pages; a storage write fires storage.onChanged,
        // which counts as activity and keeps long playlists going.
        keepAlive: () => ext.storage.local.set({ keepAlive: Date.now() }),
        async saveFile(bytes, filename, opts) {
          const url = URL.createObjectURL(new Blob(Array.isArray(bytes) ? bytes : [bytes], { type: BLOB_TYPE }));
          try {
            return await download(url, filename, opts);
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        },
      }),
  );
  ext.storage.onChanged.addListener(() => {});
}

async function engineCall(cmd) {
  if (!IS_SERVICE_WORKER) return (await enginePromise).handle(cmd);
  await ensureOffscreen();
  return call({ ...cmd, to: 'offscreen' }, { retries: 20 });
}

// ------------------------------------------------------------------ messaging

// Popup, options and content scripts talk to the engine through here.
onMessage(
  (msg) => msg.to === 'engine',
  (msg) => engineCall(msg),
);

// Requests coming from the offscreen document (Chromium only).
onMessage(
  (msg) => msg.to === 'background',
  async (msg) => {
    switch (msg.op) {
      case 'download':
        return download(msg.url, msg.filename, { overwrite: !!msg.overwrite });
      case 'findDownload':
        return findDownload(msg.url);
      case 'getToken':
        return getToken();
      case 'getSettings':
        return getSettings();
      case 'cacheGet':
        return cacheGet(msg.key);
      case 'cacheSet':
        return cacheSet(msg.key, msg.value);
      case 'broadcast':
        return broadcast(msg.state);
      case 'keepAlive':
        return true;
      default:
        throw new Error(`Неизвестная операция ${msg.op}`);
    }
  },
);

// --------------------------------------------------------------- context menu

const MENU_LINK = 'scdl-link';
const MENU_PAGE = 'scdl-page';

ext.runtime.onInstalled.addListener(() => {
  ext.contextMenus.removeAll().then(() => {
    ext.contextMenus.create({ id: MENU_LINK, title: 'Скачать с SoundCloud', contexts: ['link'], targetUrlPatterns: SC_TAB_PATTERNS });
    ext.contextMenus.create({ id: MENU_PAGE, title: 'Скачать эту страницу SoundCloud', contexts: ['page'], documentUrlPatterns: SC_TAB_PATTERNS });
  });
});

ext.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  if (url) engineCall({ cmd: 'enqueue', url }).catch((e) => console.error('[scdl]', e));
});

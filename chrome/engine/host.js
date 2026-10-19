// Chromium offscreen document: hosts the engine. Only chrome.runtime is available
// here, so storage, cookies, tabs and downloads are requested from the service worker.
// (Not in an "offscreen/" folder: some Chromium builds refuse to serve that path.)
import { Engine } from './engine.js';
import { BLOB_TYPE, call, onMessage } from '../lib/browser.js';

const bg = (op, extra = {}) => call({ to: 'background', op, ...extra });

async function waitForDownload(url, originalError) {
  for (let i = 0; i < 120; i++) {
    const d = await bg('findDownload', { url }).catch(() => null);
    if (d?.state === 'complete') return d.filename;
    if (d?.state === 'interrupted') throw new Error(`Сохранение прервано: ${d.error || 'неизвестная ошибка'}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw originalError;
}

const engine = new Engine({
  getSettings: () => bg('getSettings'),
  getToken: () => bg('getToken'),
  pageCall: (tabId, pageOp, args, opts) => bg('pageCall', { tabId, pageOp, args, opts }),
  pickTab: (preferred = null) => bg('pickTab', { preferred }),
  navigate: (tabId, url) => bg('navigate', { tabId, url }),
  cacheGet: (key) => bg('cacheGet', { key }),
  cacheSet: (key, value) => bg('cacheSet', { key, value }),
  broadcast: (state) => bg('broadcast', { state }).catch(() => {}),
  // A message wakes the service worker and resets its idle timer.
  keepAlive: () => bg('keepAlive').catch(() => {}),
  async saveFile(bytes, filename, { overwrite = false } = {}) {
    const url = URL.createObjectURL(new Blob(Array.isArray(bytes) ? bytes : [bytes], { type: BLOB_TYPE }));
    try {
      return await bg('download', { url, filename, overwrite });
    } catch (e) {
      // The service worker restarted while the browser was writing the file: its
      // reply is lost, but the download goes on. Find it by its unique blob URL.
      if (!/message channel|port closed|не ответило/i.test(e.message)) throw e;
      return await waitForDownload(url, e);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
});

onMessage(
  (msg) => msg.to === 'offscreen',
  (msg) => engine.handle(msg),
);

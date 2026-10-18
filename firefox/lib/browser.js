// One API object for both browsers: Firefox exposes promise-based `browser`,
// Chromium MV3 returns promises from `chrome`.
export const ext = globalThis.browser ?? globalThis.chrome;

/**
 * Registers a message handler for messages matching `filter`. Uses sendResponse
 * (supported everywhere) instead of returning a promise (Firefox-only until recently).
 */
export function onMessage(filter, handler) {
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !filter(msg, sender)) return false;
    Promise.resolve()
      .then(() => handler(msg, sender))
      .then(
        (result) => sendResponse({ ok: true, result }),
        (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
      );
    return true;
  });
}

/** Sends a message and unwraps the { ok, result | error } envelope. */
export async function call(msg, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await ext.runtime.sendMessage(msg);
      if (!res) throw new Error('Расширение не ответило');
      if (!res.ok) throw new Error(res.error);
      return res.result;
    } catch (e) {
      const notReady = /Receiving end does not exist|Could not establish connection/i.test(e?.message || '');
      if (!notReady || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export const SC_TAB_PATTERNS = ['*://soundcloud.com/*', '*://*.soundcloud.com/*'];

/**
 * Type for blobs handed to downloads.download. A real media type makes Chromium
 * "fix" the extension (.m3u8 → .m3u, sometimes .opus → .ogg); octet-stream keeps
 * the file name exactly as we built it.
 */
export const BLOB_TYPE = 'application/octet-stream';

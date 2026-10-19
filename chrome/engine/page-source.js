// Track data and stream links taken from an open soundcloud.com tab: the fallback
// source. content/page-hook.js watches what the site's own player loads and starts
// playback through the site's play buttons when a track is needed.
import { DRM_REASON, cleanUrl, isEncrypted } from './sc-api.js';
import { isScPageUrl } from '../lib/hosts.js';

const PAGE_RESERVED = /^\/(you|search|charts|settings|stations|feed|upload|messages|notifications|pages)(\/|$)/;

export function isSoundCloudPage(url) {
  try {
    const u = new URL(url);
    return /^(m\.|www\.)?soundcloud\.com$/.test(u.hostname) && u.pathname.length > 1 && !PAGE_RESERVED.test(u.pathname);
  } catch {
    return false;
  }
}

const samePath = (a, b) => {
  try {
    const p = (u) => decodeURIComponent(new URL(u).pathname).replace(/\/+$/, '').toLowerCase();
    return p(a) === p(b);
  } catch {
    return false;
  }
};

const DRM = DRM_REASON;
const PREVIEW = 'Плеер получил только 30-секундное превью: полная версия доступна подписчикам Go+ (или войдите на soundcloud.com)';

/** Reason a track cannot be saved in full, judged from the data the site already has; null if it looks fine. */
export function trackProblem(track) {
  const tcs = track?.media?.transcodings;
  if (!tcs) return null; // not loaded yet: the player will tell
  if (!tcs.length) return 'У трека нет доступных потоков (заблокирован в регионе или удалён)';
  const full = tcs.filter((t) => !t.snipped);
  if (full.length && full.every(isEncrypted)) return DRM;
  if (!full.length) return PREVIEW;
  return null;
}

/** "aac_160k" → "AAC 160 kbps". */
export function qualityLabel(grab) {
  const preset = grab.preset || grab.url.match(/\/((?:aac|mp3|opus|abr)_[a-z0-9]+)\//i)?.[1] || '';
  const codec = /opus/i.test(preset) || /opus/.test(grab.mime || '') ? 'Opus' : /mp3|mpeg/i.test(preset) || /audio\/mpeg/.test(grab.mime || '') ? 'MP3' : 'AAC';
  const kbps = preset.match(/(\d+)k/)?.[1];
  return kbps ? `${codec} ${kbps} kbps` : codec;
}

const LEASED = Symbol('leased');
const LOGIN = 'SoundCloud просит войти: без входа плеер не воспроизводит треки. Войдите на soundcloud.com и повторите';
const TAB_GONE = /No tab with id|Invalid tab|tab was closed|Вкладка SoundCloud закрыта/i;
// Where the site's player streams from: a link elsewhere did not come from the player.
const STREAM_HOST = /(^|\.)(sndcdn\.com|soundcloud\.cloud)$/;

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class PageSource {
  /**
   * @param {{ pageCall: (tabId:number, op:string, args?:object, opts?:{reload?:boolean}) => Promise<any>,
   *           pickTab: (preferred?:number|null) => Promise<number>,
   *           navigate: (tabId:number, url:string) => Promise<void> }} platform
   */
  constructor(platform) {
    this.platform = platform;
    /** tabId → tail of the queue of page operations (one at a time per tab). */
    this.locks = new Map();
    /** tabId → { jobId, done, release }: a playlist/profile job keeps its page in the tab. */
    this.leases = new Map();
  }

  /** One operation at a time drives a tab's player (and possibly navigates it). */
  withTab(tabId, fn) {
    const prev = this.locks.get(tabId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(tabId, tail);
    tail.then(() => this.locks.get(tabId) === tail && this.locks.delete(tabId));
    return run;
  }

  /** Waits until no other job holds the job's tab for its playlist or profile page. */
  async waitLease(job, signal) {
    for (;;) {
      const lease = this.leases.get(job.tabId);
      if (!lease || lease.jobId === job.id) return;
      await abortable(lease.done, signal);
      job.tabId = await this.platform.pickTab(job.tabId);
    }
  }

  async claim(job, signal) {
    job.tabId = await this.platform.pickTab(job.tabId);
    await this.waitLease(job, signal);
    if (this.leases.get(job.tabId)?.jobId === job.id) return;
    let release;
    const done = new Promise((r) => (release = r));
    this.leases.set(job.tabId, { jobId: job.id, done, release });
  }

  /**
   * Runs a navigating page operation once no other job holds the tab for its list.
   * The lease is checked again inside the tab lock: one may have been taken meanwhile.
   */
  async navigateWhenFree(job, signal, fn) {
    for (;;) {
      await this.waitLease(job, signal);
      const res = await this.withTab(job.tabId, () => {
        const lease = this.leases.get(job.tabId);
        return lease && lease.jobId !== job.id ? LEASED : fn();
      });
      if (res !== LEASED) return res;
    }
  }

  /** Called when a job stops: other jobs may navigate its tab again. */
  release(job) {
    for (const [tabId, lease] of this.leases) {
      if (lease.jobId !== job.id) continue;
      this.leases.delete(tabId);
      lease.release();
    }
  }

  async call(job, op, args, opts) {
    // Look-only callers (the popup) use exactly the tab they name: never open one.
    if (opts?.reload !== false) job.tabId = await this.platform.pickTab(job.tabId);
    try {
      return await this.platform.pageCall(job.tabId, op, args, opts);
    } catch (e) {
      if (!TAB_GONE.test(e.message) || opts?.reload === false) throw e;
      // The user closed the tab: continue in another SoundCloud tab.
      job.tabId = await this.platform.pickTab(null);
      await this.platform.navigate(job.tabId, job.pageUrl || job.url);
      return this.platform.pageCall(job.tabId, op, args, opts);
    }
  }

  async navigate(job, url) {
    job.tabId = await this.platform.pickTab(job.tabId);
    try {
      await this.platform.navigate(job.tabId, url);
    } catch (e) {
      if (!TAB_GONE.test(e.message)) throw e;
      job.tabId = await this.platform.pickTab(null);
      await this.platform.navigate(job.tabId, url);
    }
  }

  async currentPath(job) {
    return (await this.call(job, 'ping'))?.path || '';
  }

  /** What the page knows about a URL; null if it is not on this page. `reload: false` never touches the tab. */
  peek(job, url, opts) {
    return this.call(job, 'resolve', { url }, opts);
  }

  /**
   * Track, playlist or profile behind a URL. Navigates the tab there if the page
   * does not have the data yet; for collections loads the whole list by scrolling.
   */
  async resolve(job, url, { signal } = {}) {
    job.tabId = await this.platform.pickTab(job.tabId);
    let res = await this.withTab(job.tabId, () => this.peek(job, url));
    if (!res?.data) {
      res = await this.navigateWhenFree(job, signal, async () => {
        await this.navigate(job, url);
        return this.peek(job, url);
      });
    }
    signal?.throwIfAborted();
    if (!res?.data) throw new Error('Страница SoundCloud не отдала данные: откройте ссылку в браузере и проверьте, что она открывается');
    if (res.kind === 'track') return res;

    // Collections need their own page: its list holds the play buttons. The job
    // keeps that page in the tab until it ends, so other jobs do not navigate away.
    // A private playlist opens only by its secret link (/s-…), which the data may lack.
    const secret = /^\/[^/]+\/sets\/[^/]+\/s-[^/]+$/.test(new URL(url).pathname);
    const pageUrl = res.kind === 'user' ? `${cleanUrl(res.data.permalink_url || url)}/tracks` : secret ? cleanUrl(url) : res.data.permalink_url || url;
    // The page's data is not trusted: only a soundcloud.com page may become the job's page.
    if (!isScPageUrl(pageUrl)) throw new Error('Страница вернула недопустимую ссылку');
    job.pageUrl = pageUrl;
    await this.claim(job, signal);
    return this.withTab(job.tabId, async () => {
      const here = await this.currentPath(job);
      if (!samePath(`https://soundcloud.com${here}`, pageUrl)) await this.navigate(job, pageUrl);
      signal?.throwIfAborted();
      await this.call(job, 'loadAll', { expected: res.data.track_count || res.data.tracks?.length || 0 });
      signal?.throwIfAborted();
      const full = await this.peek(job, pageUrl);
      return full?.data ? full : res;
    });
  }

  /**
   * Signed stream link for a track, obtained by the site's player. `fresh` makes
   * the player fetch a new one (the previous link expired).
   */
  async grab(job, track, { index = null, fresh = false, signal } = {}) {
    // Without a login every track would wait for the player in vain: fail them at once.
    if (job.blocker) throw new Error(job.blocker);
    job.tabId = await this.platform.pickTab(job.tabId);
    const args = { id: track.id, permalink: track.permalink_url, index, collection: job.pageUrl || null, fresh };
    let res = await this.withTab(job.tabId, () => {
      signal?.throwIfAborted();
      return this.call(job, 'grab', args);
    });
    if (res?.error === 'not-found') {
      // The track's play button is not on the current page: open the job's page,
      // once no other job needs the tab for its own list.
      res = await this.navigateWhenFree(job, signal, async () => {
        signal?.throwIfAborted();
        // A private track opens only by its secret link (the job's own URL).
        const own = /\/s-[^/]+$/.test(new URL(job.url).pathname) ? job.url : null;
        await this.navigate(job, job.pageUrl || own || track.permalink_url || job.url);
        if (job.pageUrl) await this.call(job, 'loadAll', { expected: job.items?.length || 0 });
        signal?.throwIfAborted();
        let again = await this.call(job, 'grab', args);
        if (again?.error === 'not-found' && job.pageUrl && track.permalink_url) {
          await this.navigate(job, track.permalink_url);
          again = await this.call(job, 'grab', args);
          // Back to the list for the remaining tracks.
          await this.navigate(job, job.pageUrl);
        }
        return again;
      });
    }
    if (res?.error === 'login') {
      job.blocker = LOGIN;
      throw new Error(LOGIN);
    }
    if (res?.error === 'not-found') throw new Error('Не нашёл на странице кнопку воспроизведения этого трека');
    if (res?.error === 'stale-in-player') {
      throw new Error('Ссылка плеера на этот трек устарела, а он сейчас загружен в плеер: переключите трек или обновите страницу SoundCloud и повторите');
    }
    if (res?.error === 'timeout') {
      throw new Error(
        res.loggedIn === false
          ? 'Плеер SoundCloud не начал загрузку трека. Похоже, нужен вход: войдите на soundcloud.com и повторите'
          : 'Плеер SoundCloud не начал загрузку трека. Проверьте, что трек играет на сайте, и повторите',
      );
    }
    if (!res?.url) throw new Error('Плеер SoundCloud не выдал ссылку на поток');
    let host = '';
    try {
      host = new URL(res.url).hostname;
    } catch {
      // checked below
    }
    if (!STREAM_HOST.test(host) || res.trackId !== track.id) throw new Error('Страница вернула ссылку не на поток этого трека');
    if (res.preview) throw new Error(PREVIEW);
    if (/encrypted/.test(res.protocol || '')) throw new Error(DRM);
    return res;
  }
}

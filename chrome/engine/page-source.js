// Track data and stream links taken from an open soundcloud.com tab. The extension
// does not call SoundCloud's API: content/page-hook.js watches what the site's own
// player loads and starts playback through the site's play buttons when needed.

const PAGE_RESERVED = /^\/(you|search|charts|settings|stations|feed|upload|messages|notifications|pages)(\/|$)/;

/** Removes tracking/query noise and normalizes mobile links. */
export function cleanUrl(input) {
  const u = new URL(String(input).trim());
  if (u.hostname === 'm.soundcloud.com' || u.hostname === 'www.soundcloud.com') u.hostname = 'soundcloud.com';
  if (u.hostname === 'soundcloud.com') {
    u.search = '';
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return u.href;
}

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

const isEncrypted = (t) => /encrypted/.test(t.format?.protocol || '');

/** Short list of streams SoundCloud offered for a track, e.g. "aac_160k (DRM), mp3 (превью 30 с)". */
export function describeStreams(track) {
  const tcs = (track.media?.transcodings || []).filter((t) => !/^abr/.test(t.preset || ''));
  if (!tcs.length) return 'нет';
  return [
    ...new Set(
      tcs.map((t) => {
        const notes = [isEncrypted(t) && 'DRM', t.snipped && 'превью 30 с'].filter(Boolean);
        return `${t.preset}${notes.length ? ` (${notes.join(', ')})` : ''}`;
      }),
    ),
  ].join(', ');
}

const DRM = 'Полная версия отдаётся только в зашифрованном виде (DRM): сайт может её проиграть, но сохранить файл нельзя';
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

export class PageSource {
  /**
   * @param {{ pageCall: (tabId:number, op:string, args?:object) => Promise<any>,
   *           pickTab: (preferred?:number|null) => Promise<number>,
   *           navigate: (tabId:number, url:string) => Promise<void> }} platform
   */
  constructor(platform) {
    this.platform = platform;
    this.locks = new Map();
  }

  /** One job at a time drives a tab's player (and possibly navigates it). */
  withTab(tabId, fn) {
    const prev = this.locks.get(tabId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(tabId, tail);
    tail.then(() => this.locks.get(tabId) === tail && this.locks.delete(tabId));
    return run;
  }

  async call(job, op, args) {
    job.tabId = await this.platform.pickTab(job.tabId);
    try {
      return await this.platform.pageCall(job.tabId, op, args);
    } catch (e) {
      if (!/No tab with id|Invalid tab|tab was closed/i.test(e.message)) throw e;
      // The user closed the tab: continue in another SoundCloud tab.
      job.tabId = await this.platform.pickTab(null);
      await this.platform.navigate(job.tabId, job.pageUrl || job.url);
      return this.platform.pageCall(job.tabId, op, args);
    }
  }

  async navigate(job, url) {
    job.tabId = await this.platform.pickTab(job.tabId);
    await this.platform.navigate(job.tabId, url);
  }

  async currentPath(job) {
    return (await this.call(job, 'ping'))?.path || '';
  }

  /** What the page knows about a URL; null if it is not on this page. */
  peek(job, url) {
    return this.call(job, 'resolve', { url });
  }

  /**
   * Track, playlist or profile behind a URL. Navigates the tab there if the page
   * does not have the data yet; for collections loads the whole list by scrolling.
   */
  async resolve(job, url, { signal } = {}) {
    job.tabId = await this.platform.pickTab(job.tabId);
    return this.withTab(job.tabId, async () => {
      let res = await this.peek(job, url);
      if (!res?.data) {
        await this.navigate(job, url);
        res = await this.peek(job, url);
      }
      signal?.throwIfAborted();
      if (!res?.data) throw new Error('Страница SoundCloud не отдала данные: откройте ссылку в браузере и проверьте, что она открывается');
      if (res.kind === 'track') return res;

      // Collections need their own page: its list holds the play buttons.
      let pageUrl = res.kind === 'user' ? `${cleanUrl(res.data.permalink_url || url)}/tracks` : res.data.permalink_url || url;
      job.pageUrl = pageUrl;
      const here = await this.currentPath(job);
      if (!samePath(`https://soundcloud.com${here}`, pageUrl)) await this.navigate(job, pageUrl);
      signal?.throwIfAborted();
      await this.call(job, 'loadAll', { expected: res.kind === 'user' ? 0 : res.data.track_count || res.data.tracks?.length || 0 });
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
    return this.withTab(job.tabId, async () => {
      signal?.throwIfAborted();
      if (job.blocker) throw new Error(job.blocker);
      const args ={ id: track.id, permalink: track.permalink_url, index, collection: job.pageUrl || null, fresh };
      let res = await this.call(job, 'grab', args);
      if (res?.error === 'not-found') {
        // The track's play button is not on the current page: open the job's page.
        await this.navigate(job, job.pageUrl || track.permalink_url || job.url);
        if (job.pageUrl) await this.call(job, 'loadAll', { expected: job.items?.length || 0 });
        signal?.throwIfAborted();
        res = await this.call(job, 'grab', args);
        if (res?.error === 'not-found' && job.pageUrl && track.permalink_url) {
          await this.navigate(job, track.permalink_url);
          res = await this.call(job, 'grab', args);
        }
      }
      if (res?.error === 'login') {
        job.blocker = 'SoundCloud просит войти: без входа плеер не воспроизводит треки. Войдите на soundcloud.com и повторите';
        throw new Error(job.blocker);
      }
      if (res?.error === 'not-found') throw new Error('Не нашёл на странице кнопку воспроизведения этого трека');
      if (res?.error === 'timeout') throw new Error('Плеер SoundCloud не начал загрузку трека. Проверьте, что трек играет на сайте, и повторите');
      if (!res?.url) throw new Error('Плеер SoundCloud не выдал ссылку на поток');
      if (res.preview) throw new Error(PREVIEW);
      if (/encrypted/.test(res.protocol || '')) throw new Error(DRM);
      return res;
    });
  }
}

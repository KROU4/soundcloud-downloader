// Thin client for SoundCloud's web API (api-v2), the same one soundcloud.com uses.
// It is the main source of tracks; the site's player (page-source.js) takes over only
// for tracks the API serves as a 30-second preview, or when the API is unreachable.

const API_HOST = 'api-v2.soundcloud.com';
const API = `https://${API_HOST}`;
const CLIENT_ID_KEY = 'clientId';
const CLIENT_ID_TTL = 12 * 60 * 60 * 1000;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Removes tracking/query noise and normalizes mobile and short links. */
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

/** Codec of a transcoding by mime type. */
export function codecOf(t) {
  const mime = t.format?.mime_type || '';
  if (/mp4a|aac|audio\/mp4/.test(mime)) return 'aac';
  if (/opus/.test(mime)) return 'opus';
  if (/audio\/mpeg$/.test(mime) || /^audio\/mpeg;/.test(mime)) return 'mp3';
  return null;
}

function kbpsOf(t, codec) {
  const m = (t.preset || '').match(/_(\d+)k/);
  if (m) return Number(m[1]);
  if (codec === 'aac') return t.quality === 'hq' ? 256 : 160;
  if (codec === 'opus') return 64;
  return 128;
}

// Rough perceptual equivalence: AAC and Opus beat MP3 at the same bitrate.
const CODEC_WEIGHT = { aac: 1.3, opus: 1.6, mp3: 1 };

/** Usable (non-DRM, full-length) transcodings, best first. */
export function rankTranscodings(transcodings = [], preferredCodec = 'best') {
  return transcodings
    .filter((t) => ['progressive', 'hls'].includes(t.format?.protocol) && !t.snipped && !/^abr/.test(t.preset || ''))
    .map((t) => {
      const codec = codecOf(t);
      const kbps = kbpsOf(t, codec);
      let score = kbps * (CODEC_WEIGHT[codec] || 0);
      if (preferredCodec !== 'best' && codec === preferredCodec) score += 10000;
      if (t.format.protocol === 'progressive') score += 0.5;
      return { t, codec, kbps, score };
    })
    .filter((x) => x.codec)
    .sort((a, b) => b.score - a.score);
}

export const isEncrypted = (t) => /encrypted/.test(t.format?.protocol || '');

export const DRM_REASON = 'Полная версия отдаётся только в зашифрованном виде (DRM): сайт может её проиграть, но сохранить файл нельзя';
const NO_STREAMS = 'У трека нет доступных потоков (заблокирован в регионе или удалён)';

/**
 * Where a track's audio comes from: 'api' (a full, unencrypted stream), 'player' (the
 * API offers only a 30-second preview: the site's player may get more), 'unknown' (no
 * stream data yet) or 'error' with a reason (DRM, nothing to play).
 * @returns {{ source: 'api'|'player'|'unknown'|'error', reason?: string }}
 */
export function streamPlan(track) {
  const tcs = track?.media?.transcodings;
  if (!tcs) return { source: 'unknown' };
  if (rankTranscodings(tcs).length) return { source: 'api' };
  if (!tcs.length) return { source: 'error', reason: NO_STREAMS };
  if (tcs.some((t) => isEncrypted(t) && !t.snipped)) return { source: 'error', reason: DRM_REASON };
  if (tcs.some((t) => t.snipped)) return { source: 'player' };
  return { source: 'error', reason: 'Нет подходящего формата потока' };
}

/** Short list of what SoundCloud actually offered, e.g. "aac_160k (DRM), mp3 (превью 30 с)". */
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

/**
 * Human readable reason why a track cannot be downloaded in full.
 * @param {{ loggedIn?: boolean, authRejected?: boolean }} session
 */
export function unavailableReason(track, { loggedIn = false, authRejected = false } = {}) {
  const tcs = track.media?.transcodings || [];
  if (!tcs.length) return NO_STREAMS;
  // Full length exists, but only encrypted: the site can play it through the browser's
  // DRM module, yet nobody (including extensions) gets the decrypted audio.
  if (tcs.some((t) => isEncrypted(t) && !t.snipped)) return DRM_REASON;
  if (tcs.some((t) => t.snipped)) {
    if (!loggedIn) return 'Без входа SoundCloud отдаёт только 30-секундное превью. Войдите на soundcloud.com в этом браузере и повторите';
    if (authRejected) return 'SoundCloud не принял ваш вход (сессия устарела). Выйдите и снова войдите на soundcloud.com, затем повторите';
    return 'Вашему аккаунту SoundCloud отдаёт только 30-секундное превью: полная версия — для подписчиков Go+';
  }
  return 'Нет подходящего формата потока';
}

export class SoundCloudApi {
  /**
   * @param {{ getToken: () => Promise<string|null>, cacheGet: (k:string)=>Promise<any>, cacheSet: (k:string,v:any)=>Promise<void> }} deps
   */
  constructor({ getToken, cacheGet, cacheSet, fetchFn = (...a) => fetch(...a) }) {
    this.getToken = getToken;
    this.cacheGet = cacheGet;
    this.cacheSet = cacheSet;
    this.fetch = fetchFn;
    this._clientId = null;
    /** Set when SoundCloud answered 401 to our session token (we then went on anonymously). */
    this.authRejected = false;
  }

  async clientId(force = false) {
    if (!force && this._clientId) return this._clientId;
    if (!force) {
      const cached = await this.cacheGet(CLIENT_ID_KEY);
      if (cached?.value && Date.now() - cached.at < CLIENT_ID_TTL) return (this._clientId = cached.value);
    }
    this._clientId = await this.discoverClientId();
    await this.cacheSet(CLIENT_ID_KEY, { value: this._clientId, at: Date.now() });
    return this._clientId;
  }

  /** client_id is embedded in soundcloud.com's JS bundles. */
  async discoverClientId() {
    const html = await (await this.fetch('https://soundcloud.com/', { credentials: 'omit' })).text();
    const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/[^"]+sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    for (const src of scripts.reverse()) {
      try {
        const js = await (await this.fetch(src, { credentials: 'omit' })).text();
        const m = js.match(/[{,]client_id:"([0-9a-zA-Z]{32})"/) || js.match(/client_id=([0-9a-zA-Z]{32})/);
        if (m) return m[1];
      } catch {
        // try the next bundle
      }
    }
    throw new ApiError('Не удалось получить client_id SoundCloud. Откройте soundcloud.com и попробуйте снова');
  }

  async request(pathOrUrl, params = {}, { signal, auth = true } = {}) {
    let token = auth ? await this.getToken() : null;
    let refreshed = false;
    for (;;) {
      const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
      url.searchParams.set('client_id', await this.clientId());
      const headers = { Accept: 'application/json' };
      // URLs from API responses (transcodings, next_href) are absolute: the session
      // token is attached only when the request really goes to SoundCloud's API.
      if (token && url.hostname === API_HOST) headers.Authorization = `OAuth ${token}`;
      const res = await this.fetch(url.href, { headers, signal, credentials: 'omit' });
      if (res.ok) {
        if (headers.Authorization) this.authRejected = false;
        return res.json();
      }
      if (res.status === 401 && headers.Authorization) {
        // Expired session: continue anonymously, but remember it so the error
        // message can tell the user to log in again instead of blaming Go+.
        this.authRejected = true;
        token = null;
        continue;
      }
      if ((res.status === 401 || res.status === 403) && !refreshed) {
        refreshed = true;
        await this.clientId(true);
        continue;
      }
      if (res.status === 404) throw new ApiError('Не найдено: ссылка неверна, трек удалён или приватный', 404);
      if (res.status === 429) throw new ApiError('SoundCloud ограничил частоту запросов, повторите позже', 429);
      throw new ApiError(`Ошибка API SoundCloud: HTTP ${res.status}`, res.status);
    }
  }

  async resolve(url, opts) {
    let target = cleanUrl(url);
    if (new URL(target).hostname === 'on.soundcloud.com') {
      const res = await this.fetch(target, { method: 'GET', redirect: 'follow', credentials: 'omit' });
      target = cleanUrl(res.url);
    }
    return this.request('/resolve', { url: target }, opts);
  }

  /** Full track objects for ids, in the given order (missing ones are skipped). */
  async tracks(ids, opts) {
    const byId = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const list = await this.request('/tracks', { ids: chunk.join(',') }, opts);
      for (const t of list) byId.set(t.id, t);
    }
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  /** Playlists only embed the first few tracks in full; fetch the rest. */
  async playlistTracks(playlist, opts) {
    const entries = (playlist.tracks || []).map((t) => t.track || t);
    const missing = entries.filter((t) => !t.media).map((t) => t.id);
    const fetched = missing.length ? await this.tracks(missing, opts) : [];
    const byId = new Map([...entries.filter((t) => t.media), ...fetched].map((t) => [t.id, t]));
    return entries.map((t) => byId.get(t.id) || { ...t, _unavailable: true });
  }

  async userTracks(user, opts) {
    const out = [];
    let next = `${API}/users/${user.id}/tracks`;
    let params = { limit: 200, linked_partitioning: 1 };
    while (next) {
      const page = await this.request(next, params, opts);
      out.push(...(page.collection || []));
      next = page.next_href || null;
      params = {};
    }
    return out;
  }

  async streamUrl(transcoding, track, opts) {
    const res = await this.request(transcoding.url, { track_authorization: track.track_authorization, secret_token: track.secret_token }, opts);
    if (!res?.url) throw new ApiError('SoundCloud не выдал ссылку на поток');
    return res.url;
  }

  /** Uploader's original file. Requires a logged-in session; null when unavailable. */
  async originalDownloadUrl(track, opts) {
    try {
      const res = await this.request(`/tracks/${track.id}/download`, { secret_token: track.secret_token }, opts);
      return res?.redirectUri || null;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return null;
    }
  }
}

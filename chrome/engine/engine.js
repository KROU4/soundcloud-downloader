// Download engine. Runs in a DOM context: the offscreen document in Chromium,
// the background page in Firefox. All browser specifics live in `platform`.
import { concat, utf8 } from '../lib/bytes.js';
import { buildPath, renderTemplate, sanitize } from '../lib/filename.js';
import { imageInfo } from '../lib/image.js';
import { parseMediaPlaylist } from '../lib/m3u8.js';
import { buildMeta, coverCandidates, templateValues } from '../lib/metadata.js';
import { withDefaults } from '../lib/settings.js';
import { writeTags } from '../lib/tags/index.js';
import { defragment } from '../lib/tags/mp4.js';
import { buildZip } from '../lib/zip.js';
import { SoundCloudApi, cleanUrl, describeStreams, rankTranscodings, unavailableReason } from './sc-api.js';

const ACTIVE = new Set(['resolving', 'queued', 'downloading']);
const SEGMENT_CONCURRENCY = 6;
const ZIP_PART_BYTES = 512 * 1024 * 1024;

/**
 * @typedef {object} Platform
 * @property {() => Promise<object>} getSettings
 * @property {() => Promise<string|null>} getToken  SoundCloud oauth_token cookie
 * @property {(k: string) => Promise<any>} cacheGet
 * @property {(k: string, v: any) => Promise<void>} cacheSet
 * @property {(bytes: Uint8Array | Uint8Array[], filename: string, opts?: { overwrite?: boolean }) => Promise<string>} saveFile  resolves with the final path; an array is saved as consecutive chunks
 * @property {(state: object) => void} broadcast
 * @property {() => void} keepAlive
 */

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  setLimit(n) {
    const limit = Math.max(1, n | 0);
    const extra = limit - this.limit;
    this.limit = limit;
    // Wake only as many waiters as new slots appeared, keeping FIFO order.
    for (let i = 0; i < extra && this.queue.length; i++) this.queue.shift()();
  }
  async run(fn) {
    while (this.active >= this.limit) await new Promise((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Runs `fn(item, signal)` with limited parallelism. The first failure aborts the
 * shared signal, so the remaining workers stop instead of downloading in vain.
 */
async function mapLimit(items, limit, fn, parentSignal) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) onParentAbort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !controller.signal.aborted) {
      const i = next++;
      try {
        out[i] = await fn(items[i], controller.signal);
      } catch (e) {
        controller.abort(e);
        throw e;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    controller.signal.throwIfAborted();
    return out;
  } finally {
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

function isAbort(e) {
  return e?.name === 'AbortError';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const COVER_CACHE_SIZE = 4;

/** Tiny LRU: playlists repeat the same artwork, but keeping every cover would eat memory. */
function rememberCover(cache, url, bytes) {
  cache.delete(url);
  cache.set(url, bytes);
  while (cache.size > COVER_CACHE_SIZE) cache.delete(cache.keys().next().value);
}

let jobSeq = 0;

export class Engine {
  /** @param {Platform} platform */
  constructor(platform) {
    this.platform = platform;
    this.api = new SoundCloudApi({ getToken: platform.getToken, cacheGet: platform.cacheGet, cacheSet: platform.cacheSet });
    this.jobs = [];
    this.controllers = new Map();
    this.trackSlots = new Semaphore(2);
    this._emitTimer = null;
    this._keepAliveTimer = null;
  }

  // ------------------------------------------------------------------ state

  snapshot() {
    return {
      jobs: this.jobs.map((j) => ({
        id: j.id,
        url: j.url,
        kind: j.kind,
        title: j.title,
        artwork: j.artwork,
        status: j.status,
        phase: j.phase || null,
        zip: !!j.zipMode,
        error: j.error,
        progress: j.items.length ? j.items.reduce((a, i) => a + (i.status === 'done' ? 1 : i.progress || 0), 0) / j.items.length : 0,
        counts: {
          total: j.items.length,
          done: j.items.filter((i) => i.status === 'done').length,
          failed: j.items.filter((i) => i.status === 'error').length,
        },
        items: j.items.map(({ id, title, artist, status, progress, quality, error, file, warning }) => ({
          id,
          title,
          artist,
          status,
          progress,
          quality,
          error,
          file,
          warning,
        })),
      })),
    };
  }

  emit(now = false) {
    const fire = () => {
      this._emitTimer = null;
      this.platform.broadcast(this.snapshot());
    };
    if (now) {
      clearTimeout(this._emitTimer);
      fire();
    } else if (!this._emitTimer) {
      this._emitTimer = setTimeout(fire, 250);
    }
    this.updateKeepAlive();
  }

  updateKeepAlive() {
    const busy = this.jobs.some((j) => ACTIVE.has(j.status));
    if (busy && !this._keepAliveTimer) {
      this._keepAliveTimer = setInterval(() => this.platform.keepAlive(), 20000);
      this.platform.keepAlive();
    } else if (!busy && this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  // --------------------------------------------------------------- commands

  async handle(cmd) {
    switch (cmd.cmd) {
      case 'enqueue':
        return { jobId: this.enqueue(cmd.url).id };
      case 'cancel':
        this.cancel(cmd.jobId);
        return { ok: true };
      case 'retry':
        this.retry(cmd.jobId);
        return { ok: true };
      case 'clear':
        this.jobs = this.jobs.filter((j) => ACTIVE.has(j.status));
        this.emit(true);
        return { ok: true };
      case 'remove':
        this.cancel(cmd.jobId);
        this.jobs = this.jobs.filter((j) => j.id !== cmd.jobId);
        this.emit(true);
        return { ok: true };
      case 'state':
        return this.snapshot();
      case 'inspect':
        return this.inspect(cmd.url);
      default:
        throw new Error(`Неизвестная команда ${cmd.cmd}`);
    }
  }

  enqueue(rawUrl) {
    const url = cleanUrl(rawUrl);
    const existing = this.jobs.find((j) => j.url === url && ACTIVE.has(j.status));
    if (existing) return existing;
    const job = { id: `job${Date.now()}_${++jobSeq}`, url, kind: null, title: url, artwork: null, status: 'resolving', error: null, items: [], runId: 0 };
    this.jobs.unshift(job);
    this.emit(true);
    job.runPromise = this.run(job);
    return job;
  }

  cancel(jobId) {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job || !ACTIVE.has(job.status)) return;
    this.controllers.get(jobId)?.abort();
    job.status = 'cancelled';
    for (const i of job.items) if (i.status === 'queued' || i.status === 'downloading') i.status = 'cancelled';
    this.emit(true);
  }

  retry(jobId) {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job || ACTIVE.has(job.status)) return;
    const resume = job.items.length > 0;
    job.error = null;
    job.status = resume ? 'queued' : 'resolving';
    // A ZIP holds the whole playlist, so in ZIP mode every track goes in again.
    const redo = job.zipMode ? ['error', 'cancelled', 'done'] : ['error', 'cancelled'];
    for (const i of job.items) {
      if (redo.includes(i.status)) Object.assign(i, { status: 'queued', error: null, progress: 0, file: null });
    }
    this.emit(true);
    // A cancelled run may still be unwinding (saving a file); start after it is gone.
    const previous = job.runPromise || Promise.resolve();
    job.runPromise = previous.then(() => (job.status === 'cancelled' ? undefined : this.run(job, { resume })));
  }

  /** Short description of a URL for the popup (no downloading). */
  async inspect(rawUrl) {
    const res = await this.api.resolve(rawUrl);
    const token = await this.platform.getToken();
    const info = { kind: res.kind, title: res.title || res.username, artist: res.user?.username, artwork: res.artwork_url || res.avatar_url, loggedIn: !!token };
    if (res.kind === 'track') {
      const best = rankTranscodings(res.media?.transcodings)[0];
      info.quality = best ? `${best.codec.toUpperCase()} ${best.kbps} kbps` : null;
      info.original = !!(res.downloadable && res.has_downloads_left !== false);
      info.problem = best ? null : unavailableReason(res, { loggedIn: !!token, authRejected: this.api.authRejected });
      info.streams = describeStreams(res);
      info.count = 1;
    } else if (res.kind === 'playlist' || res.kind === 'system-playlist') {
      info.count = res.track_count ?? res.tracks?.length;
      info.isAlbum = !!res.is_album;
    } else if (res.kind === 'user') {
      info.count = res.track_count;
    }
    return info;
  }

  // -------------------------------------------------------------- execution

  async run(job, { resume = false } = {}) {
    // Each run gets an id: a cancelled run that is still unwinding must not touch
    // the state (or the controller) of the run started by "retry".
    const runId = ++job.runId;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const { signal } = controller;
    job.coverCache = new Map();
    try {
      const settings = withDefaults(await this.platform.getSettings());
      this.trackSlots.setLimit(settings.concurrency);
      if (!resume) {
        await this.resolveJob(job, signal, settings);
        job.zipMode = job.context.type !== 'single' && settings.playlistAsZip;
      }
      if (signal.aborted) return;
      job.zip = job.zipMode
        ? { entries: [], bytes: 0, part: 0, names: new Set(), root: sanitize(job.context.name, 80), baseFolder: settings.baseFolder }
        : null;
      job.archives = [];
      job.status = 'downloading';
      this.emit();
      await Promise.all(
        job.items.map((item) =>
          item.status === 'queued' ? this.trackSlots.run(() => (signal.aborted ? null : this.processItem(job, item, settings, signal, runId))) : null,
        ),
      );
      if (signal.aborted) return;
      if (job.context.type !== 'single') await this.saveCollectionExtras(job, settings, signal);
      if (job.zip) await this.flushZip(job, true);
      const failed = job.items.filter((i) => i.status === 'error').length;
      const cancelled = job.items.filter((i) => i.status === 'cancelled').length;
      if (failed + cancelled === 0) job.status = 'done';
      else if (failed === job.items.length) job.status = 'error';
      else job.status = 'partial';
      if (job.status === 'error' && !job.error) job.error = job.items[0]?.error;
    } catch (e) {
      if (!signal.aborted && job.runId === runId) {
        job.status = 'error';
        job.error = e.message || String(e);
      }
    } finally {
      if (this.controllers.get(job.id) === controller) this.controllers.delete(job.id);
      if (job.runId === runId) {
        job.coverCache = null;
        job.zip = null; // drop collected audio of a cancelled/failed run
        job.phase = null;
      }
      this.emit(true);
    }
  }

  async resolveJob(job, signal, settings) {
    const res = await this.api.resolve(job.url, { signal });
    job.kind = res.kind;
    let tracks;
    if (res.kind === 'track') {
      job.title = `${res.user?.username ? `${res.user.username} — ` : ''}${res.title}`;
      job.artwork = res.artwork_url;
      job.context = { type: 'single', playlist: null, folder: settings.baseFolder };
      tracks = [res];
    } else if (res.kind === 'playlist' || res.kind === 'system-playlist') {
      job.title = res.title;
      job.artwork = res.artwork_url || res.tracks?.find((t) => t.artwork_url)?.artwork_url || null;
      this.emit();
      tracks = await this.api.playlistTracks(res, { signal });
      const playlist = { ...res, user: res.user || { username: 'SoundCloud' }, track_count: tracks.length };
      const name = renderTemplate(settings.playlistFolderTemplate, { playlist: playlist.title, playlistArtist: playlist.user.username }) || playlist.title;
      job.context = { type: 'playlist', playlist, name, folder: [settings.baseFolder, name].filter(Boolean).join('/') };
    } else if (res.kind === 'user') {
      job.title = `${res.username} — все треки`;
      job.artwork = res.avatar_url;
      this.emit();
      tracks = await this.api.userTracks(res, { signal });
      job.context = { type: 'user', playlist: null, name: res.username, folder: [settings.baseFolder, res.username].filter(Boolean).join('/') };
    } else {
      throw new Error('Эта ссылка не ведёт на трек, плейлист, альбом или профиль');
    }
    if (!tracks.length) throw new Error('Здесь нет треков');
    job.tracks = tracks;
    job.items = tracks.map((t, index) => ({
      id: t.id,
      index,
      title: t.title || `Трек ${t.id}`,
      artist: t.publisher_metadata?.artist || t.user?.username || '',
      status: t._unavailable ? 'error' : 'queued',
      error: t._unavailable ? 'Трек недоступен (удалён, приватный или заблокирован в регионе)' : null,
      progress: 0,
    }));
  }

  async processItem(job, item, settings, signal, runId) {
    const track = job.tracks[item.index];
    const ctx = job.context.type === 'playlist' ? { playlist: job.context.playlist, index: item.index } : {};
    const current = () => job.runId === runId;
    item.status = 'downloading';
    item.progress = 0;
    this.emit();
    try {
      const onProgress = (p) => {
        if (!current()) return;
        item.progress = Math.min(0.95, p * 0.95);
        this.emit();
      };
      const audio = await this.fetchAudio(track, settings, signal, onProgress);
      item.quality = audio.quality;

      const meta = buildMeta(track, { ...ctx, settings });
      const cover = await this.fetchCover(job, coverCandidates(track, ctx.playlist, settings), signal);
      if (cover) meta.cover = { data: cover, mime: imageInfo(cover).mime };

      const tagged = writeTags(audio.bytes, meta);
      if (!tagged.tagged) item.warning = `Теги не записаны: ${tagged.error}`;
      const ext = tagged.ext || audio.ext || 'bin';

      const template = ctx.playlist ? settings.playlistTrackTemplate : settings.trackTemplate;
      const base = renderTemplate(template, templateValues(meta, track, ctx)) || meta.title || String(track.id);
      signal.throwIfAborted();
      const file = job.zip
        ? await this.addZipEntry(job, { name: buildPath('', base, ext), data: tagged.bytes, order: item.index, item })
        : await this.platform.saveFile(tagged.bytes, buildPath(job.context.folder, base, ext));
      if (!current()) return;
      item.file = file;
      item.status = 'done';
      item.progress = 1;
    } catch (e) {
      if (!current()) return;
      if (isAbort(e) || signal.aborted) {
        item.status = 'cancelled';
      } else {
        item.status = 'error';
        item.error = e.message || String(e);
      }
    } finally {
      this.emit();
    }
  }

  /** Original file if allowed, otherwise the best full-length stream. */
  async fetchAudio(track, settings, signal, onProgress) {
    if (settings.preferOriginal && track.downloadable && track.has_downloads_left !== false && (await this.platform.getToken())) {
      const url = await this.api.originalDownloadUrl(track, { signal });
      if (url) {
        try {
          const { bytes, name } = await fetchFile(url, { signal, onProgress });
          // Extension from the server's file name: covers formats we cannot sniff (WMA, AMR…).
          return { bytes, quality: 'Оригинал', ext: name.match(/\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase() };
        } catch (e) {
          if (isAbort(e)) throw e;
          // fall back to streaming
        }
      }
    }
    const ranked = rankTranscodings(track.media?.transcodings, settings.preferredCodec);
    if (!ranked.length) {
      const reason = unavailableReason(track, { loggedIn: !!(await this.platform.getToken()), authRejected: this.api.authRejected });
      throw new Error(`${reason}. Потоки: ${describeStreams(track)}`);
    }
    let lastError;
    for (const { t, codec, kbps } of ranked) {
      try {
        const streamUrl = await this.api.streamUrl(t, track, { signal });
        const quality = `${codec.toUpperCase()} ${kbps} kbps`;
        if (t.format.protocol === 'progressive') {
          return { bytes: await fetchBytes(streamUrl, { signal, onProgress }), quality };
        }
        return { bytes: await this.fetchHls(streamUrl, signal, onProgress), quality };
      } catch (e) {
        if (isAbort(e)) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  async fetchHls(playlistUrl, signal, onProgress) {
    const text = await (await fetchWithRetry(playlistUrl, { signal })).text();
    const { map, segments } = parseMediaPlaylist(text, playlistUrl);
    let done = 0;
    const total = segments.length + (map ? 1 : 0);
    const tick = () => onProgress(++done / total);
    const init = map ? await fetchBytes(map, { signal }).then((b) => (tick(), b)) : null;
    const parts = await mapLimit(segments, SEGMENT_CONCURRENCY, (u, s) => fetchBytes(u, { signal: s }).then((b) => (tick(), b)), signal);
    // fMP4 → progressive M4A; MP3/Ogg segments are plain byte streams.
    return init ? defragment(init, parts) : concat(parts);
  }

  async fetchCover(job, candidates, signal) {
    const cache = job.coverCache || new Map();
    for (const url of candidates) {
      if (cache.has(url)) {
        const cached = cache.get(url);
        if (cached) return cached;
        continue;
      }
      try {
        const res = await fetch(url, { signal, credentials: 'omit' });
        const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
        rememberCover(cache, url, bytes);
        if (bytes?.length) return bytes;
      } catch (e) {
        if (isAbort(e)) throw e;
        rememberCover(cache, url, null);
      }
    }
    return null;
  }

  /** Playlist/profile folder: cover image and an .m3u8 playlist with relative paths. */
  async saveCollectionExtras(job, settings, signal) {
    const folder = job.context.folder;
    try {
      if (settings.saveCoverFile && job.context.type === 'playlist') {
        const pl = job.context.playlist;
        const cover = await this.fetchCover(job, coverCandidates({ artwork_url: pl.artwork_url || job.artwork, user: pl.user }, null, settings), signal);
        if (cover && job.zip) await this.addZipEntry(job, { name: buildPath('', 'cover', imageInfo(cover).ext), data: cover, order: -1 });
        // overwrite: a retried playlist must not leave "cover (1).jpg" next to the old one
        else if (cover) await this.platform.saveFile(cover, buildPath(folder, 'cover', imageInfo(cover).ext), { overwrite: true });
      }
      const saved = job.items.filter((i) => i.status === 'done' && i.file);
      if (settings.savePlaylistFile && saved.length > 1) {
        const lines = ['#EXTM3U'];
        for (const i of saved) {
          const track = job.tracks[i.index];
          lines.push(`#EXTINF:${Math.round((track.full_duration || track.duration || 0) / 1000)},${i.artist} - ${i.title}`);
          lines.push(i.file.split(/[\\/]/).pop());
        }
        const name = job.context.type === 'playlist' ? job.context.playlist.title : job.title;
        const data = utf8(lines.join('\n') + '\n');
        if (job.zip) await this.addZipEntry(job, { name: buildPath('', name, 'm3u8'), data, order: Infinity });
        else await this.platform.saveFile(data, buildPath(folder, name, 'm3u8'), { overwrite: true });
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      // extras are best-effort; the tracks themselves are already saved
    }
  }

  // -------------------------------------------------------------------- zip

  /** Adds a file to the playlist archive; returns its (deduplicated) name inside it. */
  async addZipEntry(job, entry) {
    const zip = job.zip;
    let name = entry.name;
    if (zip.names.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (zip.names.has(`${stem} (${n})${ext}`.toLowerCase())) n++;
      name = `${stem} (${n})${ext}`;
    }
    zip.names.add(name.toLowerCase());
    zip.entries.push({ ...entry, name });
    zip.bytes += entry.data.length;
    // Huge profiles are split so the browser never holds more than one part in memory.
    if (zip.bytes >= ZIP_PART_BYTES) await this.flushZip(job, false);
    return name;
  }

  async flushZip(job, final) {
    const zip = job.zip;
    if (!zip?.entries.length) return;
    const entries = zip.entries.sort((a, b) => a.order - b.order);
    zip.entries = [];
    zip.bytes = 0;
    zip.part++;
    const name = final && zip.part === 1 ? job.context.name : `${job.context.name} (часть ${zip.part})`;
    job.phase = 'zipping';
    this.emit(true);
    try {
      const chunks = buildZip(entries.map((e) => ({ name: `${zip.root}/${e.name}`, data: e.data })));
      job.archives.push(await this.platform.saveFile(chunks, buildPath(zip.baseFolder, name, 'zip'), { overwrite: true }));
    } catch (e) {
      if (isAbort(e)) throw e;
      for (const { item } of entries) if (item) Object.assign(item, { status: 'error', error: `Не удалось сохранить ZIP: ${e.message}` });
      throw e;
    } finally {
      job.phase = null;
      this.emit();
    }
  }
}

// ------------------------------------------------------------------ network

async function fetchWithRetry(url, { signal, retries = 3 } = {}) {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal, credentials: 'omit' });
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`HTTP ${res.status} при загрузке ${new URL(url).hostname}`), { fatal: true });
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (isAbort(e) || e.fatal || attempt >= retries) throw e;
      await sleep(delay, signal);
      delay *= 2;
    }
  }
}

/** File name from Content-Disposition, else from the final URL path. */
function responseFileName(res) {
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through
    }
  }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/);
  if (plain) return plain[1].trim();
  try {
    return decodeURIComponent(new URL(res.url).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

async function fetchFile(url, { signal, onProgress } = {}) {
  const res = await fetchWithRetry(url, { signal });
  const name = responseFileName(res);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!onProgress || !total || !res.body) return { bytes: new Uint8Array(await res.arrayBuffer()), name };
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  return { bytes: concat(chunks), name };
}

export async function fetchBytes(url, opts) {
  return (await fetchFile(url, opts)).bytes;
}

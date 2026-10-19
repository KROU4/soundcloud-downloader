// Source selection of the engine with the API and the page player replaced by stubs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../chrome/engine/engine.js';

const SETTINGS = { preferOriginal: true, preferredCodec: 'best' };
const hls = (preset, extra = {}) => ({ url: `https://api-v2.soundcloud.com/media/x/${preset}/stream/hls`, preset, snipped: false, format: { protocol: 'hls', mime_type: 'audio/mp4' }, ...extra });

function makeEngine({ token = null } = {}) {
  const engine = new Engine({
    getToken: async () => token,
    cacheGet: async () => null,
    cacheSet: async () => {},
    getSettings: async () => ({}),
    broadcast: () => {},
    keepAlive: () => {},
    saveFile: async (_bytes, name) => name,
    pickTab: async () => 1,
  });
  const calls = [];
  engine.fetchViaApi = async () => {
    calls.push('api');
    return { bytes: new Uint8Array(1), quality: 'AAC 160 kbps' };
  };
  engine.fetchViaPlayer = async () => {
    calls.push('player');
    return { bytes: new Uint8Array(1), quality: 'AAC 160 kbps · через плеер' };
  };
  return { engine, calls };
}

const job = (track, source = 'api') => ({ source, tracks: [track], context: { type: 'single' }, pageUrl: null });
const item = { index: 0 };

test('a full stream goes through the API', async () => {
  const { engine, calls } = makeEngine();
  await engine.fetchAudio(job({ id: 1, media: { transcodings: [hls('aac_160k')] } }), item, SETTINGS);
  assert.deepEqual(calls, ['api']);
});

test('a track the API serves as a 30-second preview goes through the player', async () => {
  const { engine, calls } = makeEngine();
  await engine.fetchAudio(job({ id: 1, media: { transcodings: [hls('aac_160k', { snipped: true })] } }), item, SETTINGS);
  assert.deepEqual(calls, ['player']);
});

test('a preview served to a working session is Go+: no pointless player run', async () => {
  const { engine, calls } = makeEngine({ token: 'tok' });
  await assert.rejects(engine.fetchAudio(job({ id: 1, media: { transcodings: [hls('aac_160k', { snipped: true })] } }), item, SETTINGS), /Go\+/);
  assert.deepEqual(calls, []);
});

test('a preview after SoundCloud rejected the session still tries the player', async () => {
  const { engine, calls } = makeEngine({ token: 'expired' });
  engine.api.authRejected = true;
  await engine.fetchAudio(job({ id: 1, media: { transcodings: [hls('aac_160k', { snipped: true })] } }), item, SETTINGS);
  assert.deepEqual(calls, ['player']);
});

test('DRM-only tracks fail without trying either source', async () => {
  const { engine, calls } = makeEngine();
  const drm = { id: 1, media: { transcodings: [hls('aac_160k', { format: { protocol: 'ctr-encrypted-hls', mime_type: 'audio/mp4' } })] } };
  await assert.rejects(engine.fetchAudio(job(drm), item, SETTINGS), /DRM/);
  assert.deepEqual(calls, []);
});

test('an API failure falls back to the player', async () => {
  const { engine, calls } = makeEngine();
  engine.fetchViaApi = async () => {
    calls.push('api');
    throw new Error('HTTP 403');
  };
  const res = await engine.fetchAudio(job({ id: 1, media: { transcodings: [hls('aac_160k')] } }), item, SETTINGS);
  assert.deepEqual(calls, ['api', 'player']);
  assert.match(res.quality, /через плеер/);
});

test('when both sources fail the error names both', async () => {
  const { engine } = makeEngine();
  engine.fetchViaApi = async () => {
    throw new Error('HTTP 403');
  };
  engine.fetchViaPlayer = async () => {
    throw new Error('SoundCloud просит войти');
  };
  await assert.rejects(engine.fetchAudio(job({ id: 1, media: { transcodings: [hls('aac_160k')] } }), item, SETTINGS), /HTTP 403.*через плеер тоже не вышло.*войти/);
});

test('a job resolved from the page always uses the player', async () => {
  const { engine, calls } = makeEngine();
  await engine.fetchAudio(job({ id: 1, media: { transcodings: [hls('aac_160k')] } }, 'page'), item, SETTINGS);
  assert.deepEqual(calls, ['player']);
});

test('the original file is preferred when allowed and logged in', async () => {
  const { engine, calls } = makeEngine({ token: 'tok' });
  engine.api.originalDownloadUrl = async () => 'data:audio/wav;base64,UklGRg==';
  const res = await engine.fetchAudio(job({ id: 1, downloadable: true, media: { transcodings: [hls('aac_160k')] } }), item, SETTINGS);
  assert.equal(res.quality, 'Оригинал');
  assert.deepEqual(calls, []);
});

test('resolve falls back to the page when the API is unreachable', async () => {
  const { engine } = makeEngine();
  engine.api.resolve = async () => {
    throw new Error('Не удалось получить client_id SoundCloud');
  };
  engine.source.resolve = async (j) => {
    j.pageUrl = 'https://soundcloud.com/a/sets/p';
    return { kind: 'playlist', data: { title: 'P', user: { username: 'A' }, tracks: [{ id: 5, title: 'T' }] } };
  };
  const j = { url: 'https://soundcloud.com/a/sets/p', items: [] };
  await engine.resolveJob(j, new AbortController().signal, { playlistFolderTemplate: '{playlist}', baseFolder: 'SoundCloud' });
  assert.equal(j.source, 'page');
  assert.equal(j.items.length, 1);
  assert.equal(j.items[0].status, 'queued');
});

test('API-resolved tracks with only a preview stay queued (the player will get them)', async () => {
  const { engine } = makeEngine();
  engine.api.resolve = async () => ({ kind: 'track', id: 1, title: 'T', user: { username: 'A' }, media: { transcodings: [hls('aac_160k', { snipped: true })] } });
  const j = { url: 'https://soundcloud.com/a/t', items: [] };
  await engine.resolveJob(j, new AbortController().signal, { baseFolder: 'SoundCloud' });
  assert.equal(j.source, 'api');
  assert.equal(j.items[0].status, 'queued');
});

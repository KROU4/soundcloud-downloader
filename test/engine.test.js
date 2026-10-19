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

const preview = (extra = {}) => ({ id: 1, media: { transcodings: [hls('aac_160k', { snipped: true })] }, ...extra });

test('a preview served to a working session is Go+: no pointless player run', async () => {
  const { engine, calls } = makeEngine({ token: 'tok' });
  await assert.rejects(engine.fetchAudio(job(preview({ _authed: true })), item, SETTINGS), /Go\+/);
  assert.deepEqual(calls, []);
});

test('retry after logging in: the track is asked again with the session and comes in full', async () => {
  const { engine, calls } = makeEngine({ token: 'tok' });
  engine.api.tracks = async () => [{ id: 1, _authed: true, media: { transcodings: [hls('aac_160k')] } }];
  await engine.fetchAudio(job(preview()), item, SETTINGS);
  assert.deepEqual(calls, ['api']);
});

test('asked again with the session and still a preview: Go+', async () => {
  const { engine, calls } = makeEngine({ token: 'tok' });
  engine.api.tracks = async () => [preview({ _authed: true })];
  await assert.rejects(engine.fetchAudio(job(preview()), item, SETTINGS), /Go\+/);
  assert.deepEqual(calls, []);
});

test('a preview when SoundCloud rejects the session still tries the player', async () => {
  const { engine, calls } = makeEngine({ token: 'expired' });
  engine.api.tracks = async () => [preview({ _authed: false })];
  await engine.fetchAudio(job(preview()), item, SETTINGS);
  assert.deepEqual(calls, ['player']);
});

test('a preview without any login goes straight to the player', async () => {
  const { engine, calls } = makeEngine();
  engine.api.tracks = async () => assert.fail('no session: nothing to ask again');
  await engine.fetchAudio(job(preview()), item, SETTINGS);
  assert.deepEqual(calls, ['player']);
});

test('a track the API did not return in a playlist is tried through the player', async () => {
  const { engine } = makeEngine();
  engine.api.resolve = async () => ({ kind: 'playlist', id: 7, title: 'P', permalink_url: 'https://soundcloud.com/a/sets/p', user: { username: 'A' }, tracks: [] });
  engine.api.playlistTracks = async () => [{ id: 5, _unavailable: true }];
  const j = { url: 'https://soundcloud.com/a/sets/p', items: [] };
  await engine.resolveJob(j, new AbortController().signal, { playlistFolderTemplate: '{playlist}', baseFolder: 'SoundCloud' });
  assert.equal(j.items[0].status, 'queued');
  assert.equal(j.pageUrl, 'https://soundcloud.com/a/sets/p');
});

test('a playlist track the API dropped for a working session is unavailable, no player run', async () => {
  const { engine, calls } = makeEngine({ token: 'tok' });
  await assert.rejects(engine.fetchAudio({ ...job({ id: 1, _unavailable: true, _authed: true }), pageUrl: 'https://soundcloud.com/a/sets/p' }, item, SETTINGS), /недоступен/);
  assert.deepEqual(calls, []);
});

test('a playlist track missing from an anonymous answer is tried through the player', async () => {
  const { engine, calls } = makeEngine();
  await engine.fetchAudio({ ...job({ id: 1, _unavailable: true, _authed: false }), pageUrl: 'https://soundcloud.com/a/sets/p' }, item, SETTINGS);
  assert.deepEqual(calls, ['player']);
});

test('the original wins over a DRM-only stream', async () => {
  const { engine } = makeEngine({ token: 'tok' });
  engine.api.resolve = async () => ({ kind: 'track', id: 1, title: 'T', downloadable: true, user: { username: 'A' }, media: { transcodings: [hls('aac_160k', { format: { protocol: 'ctr-encrypted-hls', mime_type: 'audio/mp4' } })] } });
  const j = { url: 'https://soundcloud.com/a/t', items: [] };
  await engine.resolveJob(j, new AbortController().signal, { ...SETTINGS, baseFolder: 'SoundCloud' });
  assert.equal(j.items[0].status, 'queued');
});

test('an original with a non-audio extension is not saved under that extension', async () => {
  const { engine } = makeEngine({ token: 'tok' });
  engine.api.originalDownloadUrl = async () => 'data:text/html;base64,PHNjcmlwdD4=';
  const res = await engine.fetchAudio(job({ id: 1, downloadable: true, media: { transcodings: [hls('aac_160k')] } }), item, SETTINGS);
  assert.equal(res.quality, 'Оригинал');
  assert.equal(res.ext, undefined);
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

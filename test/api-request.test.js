// SoundCloudApi.request retry order with a scripted fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SoundCloudApi } from '../chrome/engine/sc-api.js';

/** answers: [{ status, body }] consumed in order; returns the api and the request log. */
function scripted(answers, { token = 'tok', clientId = 'a'.repeat(32) } = {}) {
  const log = [];
  let discovered = 0;
  const api = new SoundCloudApi({
    getToken: async () => token,
    cacheGet: async () => ({ value: clientId, at: Date.now() }),
    cacheSet: async () => {},
    fetchFn: async (url, init) => {
      log.push({ url, auth: !!init?.headers?.Authorization });
      const next = answers.shift();
      return { ok: next.status === 200, status: next.status, json: async () => next.body };
    },
  });
  api.discoverClientId = async () => {
    discovered++;
    return 'b'.repeat(32);
  };
  return { api, log, discoveries: () => discovered };
}

test('an expired session falls back to anonymous without looking up client_id', async () => {
  const { api, log, discoveries } = scripted([{ status: 401 }, { status: 200, body: { kind: 'track', id: 1, media: { transcodings: [] } } }]);
  const res = await api.request('/resolve', { url: 'x' });
  assert.deepEqual(log.map((l) => l.auth), [true, false]);
  assert.equal(discoveries(), 0);
  assert.equal(api.authRejected, true);
  assert.equal(res._authed, false);
});

test('a stale client_id is looked up again and the session is used again', async () => {
  const { api, log, discoveries } = scripted([{ status: 401 }, { status: 401 }, { status: 200, body: { kind: 'track', id: 1, media: { transcodings: [] } } }]);
  const res = await api.request('/resolve', { url: 'x' });
  assert.deepEqual(log.map((l) => l.auth), [true, false, true]);
  assert.equal(discoveries(), 1);
  assert.ok(log[2].url.includes('b'.repeat(32)));
  assert.equal(res._authed, true);
  assert.equal(api.authRejected, false);
});

test('/download answers are final: no anonymous retry, no lookup', async () => {
  const { api, log, discoveries } = scripted([{ status: 401 }]);
  assert.equal(await api.originalDownloadUrl({ id: 5 }), null);
  assert.equal(log.length, 1);
  assert.equal(discoveries(), 0);
});

test('the token never goes to a non-API host or over http', async () => {
  const { api, log } = scripted([{ status: 200, body: {} }, { status: 200, body: {} }]);
  await api.request('https://evil.example/x');
  await api.request('http://api-v2.soundcloud.com/x');
  assert.deepEqual(log.map((l) => l.auth), [false, false]);
});

test('playlist tracks missing from a session answer are marked as really gone', async () => {
  const { api } = scripted([{ status: 200, body: [{ kind: 'track', id: 2, media: { transcodings: [] } }] }]);
  const tracks = await api.playlistTracks({ id: 9, tracks: [{ id: 2 }, { id: 3 }] });
  assert.equal(tracks[0].id, 2);
  assert.deepEqual([tracks[1]._unavailable, tracks[1]._authed], [true, true]);
});

test('private playlist tracks are asked with the playlist context', async () => {
  const { api, log } = scripted([{ status: 200, body: [] }]);
  await api.playlistTracks({ id: 9, secret_token: 's-abc', tracks: [{ id: 2 }] });
  const url = new URL(log[0].url);
  assert.equal(url.searchParams.get('playlistId'), '9');
  assert.equal(url.searchParams.get('playlistSecretToken'), 's-abc');
});

test('a 401 after another request already replaced the client_id retries with the session', async () => {
  const { api, log } = scripted([{ status: 401 }, { status: 200, body: { kind: 'track', id: 1, media: { transcodings: [] } } }]);
  await api.clientId();
  const origFetch = api.fetch;
  api.fetch = async (url, init) => {
    const res = await origFetch(url, init);
    api._clientId = 'c'.repeat(32); // replaced by a parallel request
    return res;
  };
  const res = await api.request('/resolve', { url: 'x' });
  assert.deepEqual(log.map((l) => l.auth), [true, true]);
  assert.equal(api.authRejected, false);
  assert.equal(res._authed, true);
});

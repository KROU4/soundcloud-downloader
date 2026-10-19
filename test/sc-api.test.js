import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanUrl, describeStreams, rankTranscodings, streamPlan, unavailableReason } from '../chrome/engine/sc-api.js';

const tc = (preset, { protocol = 'hls', mime = 'audio/mp4; codecs="mp4a.40.2"', snipped = false } = {}) => ({
  url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:1/${preset}/stream/${protocol}`,
  preset,
  snipped,
  format: { protocol, mime_type: mime },
});
const track = (transcodings) => ({ id: 1, media: { transcodings } });

test('cleanUrl normalizes host, query, hash and trailing slash', () => {
  assert.equal(cleanUrl('https://m.soundcloud.com/artist/track/?si=abc#t=10'), 'https://soundcloud.com/artist/track');
  assert.equal(cleanUrl('https://www.soundcloud.com/artist/sets/pl/'), 'https://soundcloud.com/artist/sets/pl');
});

test('rankTranscodings prefers AAC 160 over MP3 128 and skips previews and adaptive', () => {
  const ranked = rankTranscodings([
    tc('mp3_1_0', { protocol: 'progressive', mime: 'audio/mpeg' }),
    tc('aac_160k'),
    tc('aac_96k'),
    tc('abr_sq', { mime: 'audio/mpegurl' }),
    tc('aac_256k', { snipped: true }),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.t.preset),
    ['aac_160k', 'mp3_1_0', 'aac_96k'],
  );
});

test('rankTranscodings honours the preferred codec', () => {
  const ranked = rankTranscodings([tc('aac_160k'), tc('mp3_0_1', { protocol: 'progressive', mime: 'audio/mpeg' })], 'mp3');
  assert.equal(ranked[0].codec, 'mp3');
});

test('streamPlan: full stream → api', () => {
  assert.deepEqual(streamPlan(track([tc('aac_160k')])), { source: 'api' });
});

test('streamPlan: only a 30-second preview → player', () => {
  assert.deepEqual(streamPlan(track([tc('aac_160k', { snipped: true })])), { source: 'player' });
});

test('streamPlan: full version only encrypted → DRM error', () => {
  const plan = streamPlan(track([tc('aac_160k', { protocol: 'ctr-encrypted-hls' }), tc('aac_160k', { snipped: true })]));
  assert.equal(plan.source, 'error');
  assert.match(plan.reason, /DRM/);
});

test('streamPlan: no streams → error; no data yet → unknown', () => {
  assert.equal(streamPlan(track([])).source, 'error');
  assert.equal(streamPlan({ id: 1 }).source, 'unknown');
});

test('describeStreams marks DRM and previews', () => {
  const text = describeStreams(track([tc('aac_160k', { protocol: 'cbc-encrypted-hls' }), tc('mp3_0_0', { snipped: true })]));
  assert.equal(text, 'aac_160k (DRM), mp3_0_0 (превью 30 с)');
});

test('unavailableReason distinguishes login, expired session and Go+', () => {
  const preview = track([tc('aac_160k', { snipped: true })]);
  assert.match(unavailableReason(preview), /Без входа/);
  assert.match(unavailableReason(preview, { loggedIn: true, authRejected: true }), /не принял/);
  assert.match(unavailableReason(preview, { loggedIn: true }), /Go\+/);
});

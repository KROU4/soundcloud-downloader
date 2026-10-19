import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isScMediaUrl, isScPageUrl } from '../chrome/lib/hosts.js';

test('isScPageUrl accepts only https soundcloud.com pages', () => {
  assert.ok(isScPageUrl('https://soundcloud.com/a/sets/p'));
  assert.ok(isScPageUrl('https://m.soundcloud.com/a/t'));
  for (const bad of [
    'http://soundcloud.com/a',
    'https://soundcloud.com:8443/a',
    'https://evil.example/soundcloud.com',
    'https://soundcloud.com.evil.example/a',
    'https://api-v2.soundcloud.com/me',
    'https://user:pw@soundcloud.com/a',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'chrome://settings',
    undefined,
  ]) {
    assert.equal(isScPageUrl(bad), false, String(bad));
  }
});

test('isScMediaUrl accepts only SoundCloud CDNs over https', () => {
  assert.ok(isScMediaUrl('https://i1.sndcdn.com/artworks-x-original.jpg'));
  assert.ok(isScMediaUrl('https://playback.media-streaming.soundcloud.cloud/a/playlist.m3u8?sig=1'));
  for (const bad of ['http://i1.sndcdn.com/x.jpg', 'https://sndcdn.com.evil.example/x', 'https://evil.example/px', 'https://xsndcdn.com/x', null]) {
    assert.equal(isScMediaUrl(bad), false, String(bad));
  }
});

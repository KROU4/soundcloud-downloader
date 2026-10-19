import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPath, renderTemplate, sanitize } from '../chrome/lib/filename.js';
import { bestVariant, parseMediaPlaylist } from '../chrome/lib/m3u8.js';
import { artworkUrl, extractLyrics, splitArtistTitle } from '../chrome/lib/metadata.js';
import { buildZip, crc32 } from '../chrome/lib/zip.js';

test('sanitize keeps names valid on every OS', () => {
  assert.equal(sanitize('AC/DC: Back in Black?'), 'AC∕DC꞉ Back in Black？');
  assert.equal(sanitize('con'), '_con');
  assert.equal(sanitize('  ..hidden. '), 'hidden');
});

test('renderTemplate drops empty placeholders with their separators', () => {
  assert.equal(renderTemplate('{index} - {artist} - {title}', { artist: 'A', title: 'T' }), 'A - T');
  assert.equal(renderTemplate('{artist} - {title}', { artist: 'AC/DC', title: 'T' }), 'AC∕DC - T');
});

test('buildPath sanitizes every folder segment', () => {
  assert.equal(buildPath('SoundCloud/My: list', 'A - T', 'm4a'), 'SoundCloud/My꞉ list/A - T.m4a');
  assert.equal(buildPath('', 'cover', 'jpg'), 'cover.jpg');
});

test('bestVariant picks the highest bandwidth of a master playlist', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"',
    'low/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2"',
    'high/playlist.m3u8?sig=1',
  ].join('\n');
  assert.equal(bestVariant(master, 'https://cdn.example/x/master.m3u8'), 'https://cdn.example/x/high/playlist.m3u8?sig=1');
  assert.equal(bestVariant('#EXTM3U\n#EXTINF:10,\nseg.m4s', 'https://cdn.example/'), null);
});

test('parseMediaPlaylist resolves init and segments, rejects DRM', () => {
  const media = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:10.0,', 'data000.m4s', '#EXTINF:5.5,', 'data001.m4s', '#EXT-X-ENDLIST'].join('\n');
  const parsed = parseMediaPlaylist(media, 'https://cdn.example/t/playlist.m3u8');
  assert.equal(parsed.map, 'https://cdn.example/t/init.mp4');
  assert.deepEqual(parsed.segments, ['https://cdn.example/t/data000.m4s', 'https://cdn.example/t/data001.m4s']);
  assert.equal(parsed.duration, 15.5);
  assert.throws(() => parseMediaPlaylist(`${media}\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"`, 'https://cdn.example/'), /DRM/);
});

test('extractLyrics finds a marked section and stops at credits', () => {
  const description = 'New single!\n\nLyrics:\nfirst line of the song here\nsecond line of the song\n\nProduced by Someone';
  assert.equal(extractLyrics(description), 'first line of the song here\nsecond line of the song');
  assert.equal(extractLyrics('no lyrics here'), null);
});

test('splitArtistTitle and artworkUrl', () => {
  assert.deepEqual(splitArtistTitle('Artist - Song (Remix)'), { artist: 'Artist', title: 'Song (Remix)' });
  assert.equal(splitArtistTitle('Just a title'), null);
  assert.equal(artworkUrl('https://i1.sndcdn.com/artworks-abc-large.jpg', 't500x500'), 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg');
});

test('buildZip stores entries readable by their local headers', () => {
  const data = new TextEncoder().encode('hello');
  const zip = Buffer.concat(buildZip([{ name: '01 - A.m4a', data }], new Date(2026, 0, 1)).map((c) => Buffer.from(c)));
  assert.equal(zip.readUInt32LE(0), 0x04034b50); // local file header
  assert.equal(zip.readUInt32LE(14), crc32(data));
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString('utf8'), '01 - A.m4a');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50); // end of central directory
});

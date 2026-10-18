// WAV (RIFF, little-endian) and AIFF (IFF, big-endian): an embedded ID3v2 chunk is
// what foobar2000, iTunes, Mp3tag, VLC and ffmpeg read; WAV also gets LIST/INFO.
import { ascii, concat, latin1, readU32be, readU32le, u32be, u32le, utf8, writeU32be, writeU32le } from '../bytes.js';
import { buildId3 } from './id3.js';

/** Chunk list; sizes are clamped to the file (streamed WAVs declare 0xFFFFFFFF). */
function chunks(b, le, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    const id = ascii(b, o, o + 4);
    const declared = le ? readU32le(b, o + 4) : readU32be(b, o + 4);
    const size = Math.min(declared, end - o - 8);
    out.push({ id, dataStart: o + 8, size });
    o += 8 + declared + (declared & 1);
  }
  return out;
}

function chunk(id, body, le) {
  const pad = body.length & 1 ? Uint8Array.of(0) : new Uint8Array(0);
  return concat([latin1(id), le ? u32le(body.length) : u32be(body.length), body, pad]);
}

function infoList(meta) {
  const fields = [
    ['INAM', meta.title],
    ['IART', meta.artist],
    ['IPRD', meta.album],
    ['ICRD', meta.date || meta.year],
    ['IGNR', meta.genre],
    ['ICMT', meta.comment],
    ['ICOP', meta.copyright],
    ['ITRK', meta.trackNumber],
    ['ISFT', meta.encodedBy],
  ];
  const sub = fields
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([id, v]) => chunk(id, concat([utf8(String(v)), Uint8Array.of(0)]), true));
  return chunk('LIST', concat([latin1('INFO'), ...sub]), true);
}

export function tagRiff(b, meta) {
  const isWav = ascii(b, 0, 4) === 'RIFF';
  const le = isWav;
  const form = ascii(b, 8, 12);
  const kept = chunks(b, le, 12, b.length).filter((c) => {
    if (c.id === 'id3 ' || c.id === 'ID3 ') return false;
    if (isWav && c.id === 'LIST' && ascii(b, c.dataStart, c.dataStart + 4) === 'INFO') return false;
    return true;
  });
  // Re-serialize every chunk: fixes clamped sizes and adds a missing pad byte after
  // an odd-sized last chunk, so the chunks we append stay word-aligned.
  const body = [latin1(form), ...kept.map((c) => chunk(c.id, b.subarray(c.dataStart, c.dataStart + c.size), le))];
  if (isWav) body.push(infoList(meta));
  body.push(chunk(isWav ? 'id3 ' : 'ID3 ', buildId3(meta, { padding: 0 }), le));
  const content = concat(body);
  const out = concat([latin1(isWav ? 'RIFF' : 'FORM'), new Uint8Array(4), content]);
  if (le) writeU32le(out, 4, content.length);
  else writeU32be(out, 4, content.length);
  return out;
}

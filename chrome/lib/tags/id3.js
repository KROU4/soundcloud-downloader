// ID3v2.3 writer. v2.3 (not 2.4) because Windows Explorer, older car stereos and
// many hardware players still do not read v2.4. Text is UTF-16 with BOM.
import { concat, latin1, utf16WithBom, u32be, u8, startsWith } from '../bytes.js';

const UTF16 = 1;
const UTF16_NUL = Uint8Array.of(0, 0);
const NUL = Uint8Array.of(0);

function frame(id, body) {
  return concat([latin1(id), u32be(body.length), Uint8Array.of(0, 0), body]);
}

function textFrame(id, value) {
  return frame(id, concat([u8(UTF16), utf16WithBom(String(value))]));
}

/** COMM and USLT share layout: encoding, language, description, text. */
function langTextFrame(id, text, description = '') {
  return frame(id, concat([u8(UTF16), latin1('eng'), utf16WithBom(description), UTF16_NUL, utf16WithBom(text)]));
}

function txxx(description, value) {
  return frame('TXXX', concat([u8(UTF16), utf16WithBom(description), UTF16_NUL, utf16WithBom(String(value))]));
}

function apic(cover) {
  return frame('APIC', concat([u8(0), latin1(cover.mime), NUL, u8(3), NUL, cover.data]));
}

function syncsafe(n) {
  return Uint8Array.of((n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f);
}

/** Builds a complete ID3v2.3 tag from normalized metadata (see metadata.js). */
export function buildId3(meta, { padding = 512 } = {}) {
  const frames = [];
  const add = (id, v) => {
    if (v !== undefined && v !== null && v !== '') frames.push(textFrame(id, v));
  };
  add('TIT2', meta.title);
  add('TPE1', meta.artist);
  add('TALB', meta.album);
  add('TPE2', meta.albumArtist);
  if (meta.trackNumber) add('TRCK', meta.trackTotal ? `${meta.trackNumber}/${meta.trackTotal}` : meta.trackNumber);
  if (meta.discNumber) add('TPOS', meta.discNumber);
  if (meta.year) add('TYER', meta.year);
  if (meta.date && /^\d{4}-\d{2}-\d{2}/.test(meta.date)) add('TDAT', meta.date.slice(8, 10) + meta.date.slice(5, 7));
  add('TCON', meta.genre);
  add('TCOM', meta.composer);
  add('TPUB', meta.publisher || meta.label);
  add('TCOP', meta.copyright);
  add('TSRC', meta.isrc);
  add('TBPM', meta.bpm);
  add('TENC', meta.encodedBy);
  if (meta.comment) frames.push(langTextFrame('COMM', meta.comment));
  if (meta.lyrics) frames.push(langTextFrame('USLT', meta.lyrics));
  if (meta.url) frames.push(frame('WOAS', latin1(meta.url)));
  if (meta.artistUrl) frames.push(frame('WOAR', latin1(meta.artistUrl)));
  if (meta.purchaseUrl) frames.push(frame('WCOM', latin1(meta.purchaseUrl)));
  for (const [k, v] of Object.entries(meta.extra || {})) {
    if (v !== undefined && v !== null && v !== '') frames.push(txxx(k, v));
  }
  if (meta.cover) frames.push(apic(meta.cover));

  const body = concat([...frames, new Uint8Array(padding)]);
  return concat([latin1('ID3'), Uint8Array.of(3, 0, 0), syncsafe(body.length), body]);
}

/** Size of a leading ID3v2 tag (including header/footer), 0 if absent. */
export function id3v2Length(b, offset = 0) {
  if (!startsWith(b, 'ID3', offset) || b.length < offset + 10) return 0;
  const size = ((b[offset + 6] & 0x7f) << 21) | ((b[offset + 7] & 0x7f) << 14) | ((b[offset + 8] & 0x7f) << 7) | (b[offset + 9] & 0x7f);
  const footer = b[offset + 5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** Removes all leading ID3v2 tags and a trailing ID3v1 tag. */
export function stripId3(b) {
  let start = 0;
  let len;
  while ((len = id3v2Length(b, start)) > 0) start += len;
  let end = b.length;
  if (end - start >= 128 && startsWith(b, 'TAG', end - 128)) end -= 128;
  // APEv2 footer before ID3v1 is rare on SoundCloud originals; leave it alone.
  return b.subarray(start, end);
}

export function tagMp3(b, meta) {
  return concat([buildId3(meta), stripId3(b)]);
}

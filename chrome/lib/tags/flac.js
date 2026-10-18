import { concat, readU24be, startsWith, u24be, u8 } from '../bytes.js';
import { stripId3 } from './id3.js';
import { commentBody, flacPictureBody, vorbisFields } from './vorbis.js';

const STREAMINFO = 0;
const PADDING = 1;
const VORBIS_COMMENT = 4;
const PICTURE = 6;

function block(type, body, last) {
  if (body.length > 0xffffff) throw new Error('Блок метаданных FLAC слишком большой');
  return concat([u8((last ? 0x80 : 0) | type), u24be(body.length), body]);
}

/** Replaces VORBIS_COMMENT / PICTURE / PADDING blocks, keeps everything else. */
export function tagFlac(input, meta) {
  const b = stripId3(input);
  if (!startsWith(b, 'fLaC')) throw new Error('Это не FLAC');
  const kept = [];
  let o = 4;
  let last = false;
  while (!last && o + 4 <= b.length) {
    const header = b[o];
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = readU24be(b, o + 1);
    if (type !== VORBIS_COMMENT && type !== PICTURE && type !== PADDING) {
      kept.push({ type, body: b.subarray(o + 4, o + 4 + len) });
    }
    o += 4 + len;
  }
  if (!kept.length || kept[0].type !== STREAMINFO) throw new Error('В FLAC нет STREAMINFO');
  const blocks = [...kept, { type: VORBIS_COMMENT, body: commentBody(vorbisFields(meta)) }];
  if (meta.cover) blocks.push({ type: PICTURE, body: flacPictureBody(meta.cover) });
  blocks.push({ type: PADDING, body: new Uint8Array(1024) });
  const encoded = blocks.map((bl, i) => block(bl.type, bl.body, i === blocks.length - 1));
  return concat([b.subarray(0, 4), ...encoded, b.subarray(o)]);
}

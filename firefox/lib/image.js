import { readU16be, readU32be, startsWith } from './bytes.js';

/** Detects mime type and dimensions of a JPEG / PNG / GIF / WebP cover. */
export function imageInfo(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg', ...jpegSize(b) };
  if (startsWith(b, '\x89PNG')) {
    return { mime: 'image/png', ext: 'png', width: readU32be(b, 16), height: readU32be(b, 20), depth: b[24] * channels(b[25]) };
  }
  if (startsWith(b, 'GIF8')) return { mime: 'image/gif', ext: 'gif', width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), depth: 8 };
  if (startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)) return { mime: 'image/webp', ext: 'webp', width: 0, height: 0, depth: 24 };
  return { mime: 'image/jpeg', ext: 'jpg', width: 0, height: 0, depth: 24 };
}

function channels(colorType) {
  return { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 3;
}

function jpegSize(b) {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    const len = readU16be(b, o + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: readU16be(b, o + 5), width: readU16be(b, o + 7), depth: b[o + 4] * b[o + 9] };
    }
    o += 2 + len;
  }
  return { width: 0, height: 0, depth: 24 };
}

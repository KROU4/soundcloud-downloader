import { ascii, readU32be, startsWith } from '../bytes.js';
import { tagFlac } from './flac.js';
import { id3v2Length, tagMp3 } from './id3.js';
import { tagMp4 } from './mp4.js';
import { tagOgg } from './ogg.js';
import { tagRiff } from './riff.js';

// QuickTime files may start with any of these instead of ftyp.
const MP4_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']);

/** Detects the container from magic bytes. Returns { format, ext }. */
export function detectFormat(b) {
  const skip = id3v2Length(b);
  if (startsWith(b, 'fLaC', skip)) return { format: 'flac', ext: 'flac' };
  if (b.length >= 8 && MP4_FIRST_BOXES.has(ascii(b, 4, 8)) && readU32be(b, 0) >= 8) return { format: 'mp4', ext: 'm4a' };
  if (startsWith(b, 'OggS')) {
    const isOpus = ascii(b, 28, 36) === 'OpusHead';
    return { format: 'ogg', ext: isOpus ? 'opus' : 'ogg' };
  }
  if (startsWith(b, 'RIFF') && startsWith(b, 'WAVE', 8)) return { format: 'wav', ext: 'wav' };
  if (startsWith(b, 'FORM') && (startsWith(b, 'AIFF', 8) || startsWith(b, 'AIFC', 8))) return { format: 'aiff', ext: 'aiff' };
  const s = skip;
  if (b[s] === 0xff && (b[s + 1] & 0xf0) === 0xf0 && (b[s + 1] & 0x06) === 0) {
    // ADTS AAC: same sync word as MPEG audio but layer bits are 00. Kept untouched.
    return { format: 'aac', ext: 'aac' };
  }
  if (skip > 0 || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return { format: 'mp3', ext: 'mp3' };
  return { format: 'unknown', ext: null };
}

const WRITERS = { mp3: tagMp3, mp4: tagMp4, flac: tagFlac, ogg: tagOgg, wav: tagRiff, aiff: tagRiff };

/**
 * Writes metadata into the audio file. Unknown formats and writer failures fall
 * back to the untouched bytes, so a download never fails just because of tags.
 */
export function writeTags(bytes, meta) {
  const { format, ext } = detectFormat(bytes);
  const writer = WRITERS[format];
  if (!writer) return { bytes, format, ext, tagged: false, error: format === 'unknown' ? 'неизвестный формат' : `формат ${format.toUpperCase()} без поддержки тегов` };
  try {
    return { bytes: writer(bytes, meta), format, ext, tagged: true };
  } catch (e) {
    return { bytes, format, ext, tagged: false, error: e.message };
  }
}

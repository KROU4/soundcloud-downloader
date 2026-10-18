// Vorbis comments (used by FLAC, Ogg Opus, Ogg Vorbis) and the FLAC picture block.
import { base64, concat, latin1, u32be, u32le, utf8 } from '../bytes.js';
import { imageInfo } from '../image.js';

export const VENDOR = 'SoundCloud Downloader';

/** Normalized metadata → list of [FIELD, value] pairs. */
export function vorbisFields(meta, { embedPicture = false } = {}) {
  const f = [];
  const add = (k, v) => {
    if (v !== undefined && v !== null && v !== '') f.push([k, String(v)]);
  };
  add('TITLE', meta.title);
  add('ARTIST', meta.artist);
  add('ALBUM', meta.album);
  add('ALBUMARTIST', meta.albumArtist);
  add('TRACKNUMBER', meta.trackNumber);
  add('TRACKTOTAL', meta.trackTotal);
  add('DISCNUMBER', meta.discNumber);
  add('DATE', meta.date || meta.year);
  add('GENRE', meta.genre);
  add('COMPOSER', meta.composer);
  add('COMMENT', meta.comment);
  add('LYRICS', meta.lyrics);
  add('UNSYNCEDLYRICS', meta.lyrics);
  add('COPYRIGHT', meta.copyright);
  add('ORGANIZATION', meta.label);
  add('PUBLISHER', meta.publisher);
  add('ISRC', meta.isrc);
  add('CONTACT', meta.url);
  add('WEBSITE', meta.url);
  add('ENCODEDBY', meta.encodedBy);
  if (meta.explicit) add('ITUNESADVISORY', 1);
  for (const [k, v] of Object.entries(meta.extra || {})) add(k.toUpperCase(), v);
  if (embedPicture && meta.cover) add('METADATA_BLOCK_PICTURE', base64(flacPictureBody(meta.cover)));
  return f;
}

/** Comment payload without the codec-specific prefix / framing bit. */
export function commentBody(fields, vendor = VENDOR) {
  const v = utf8(vendor);
  const parts = [u32le(v.length), v, u32le(fields.length)];
  for (const [k, val] of fields) {
    const entry = utf8(`${k}=${val}`);
    parts.push(u32le(entry.length), entry);
  }
  return concat(parts);
}

/** Body of a FLAC PICTURE block (also base64-ed into METADATA_BLOCK_PICTURE). */
export function flacPictureBody(cover) {
  const info = imageInfo(cover.data);
  const mime = latin1(cover.mime || info.mime);
  const desc = utf8('Cover');
  return concat([
    u32be(3), // front cover
    u32be(mime.length),
    mime,
    u32be(desc.length),
    desc,
    u32be(info.width || 0),
    u32be(info.height || 0),
    u32be(info.depth || 24),
    u32be(0),
    u32be(cover.data.length),
    cover.data,
  ]);
}

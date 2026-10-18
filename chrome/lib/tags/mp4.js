// MP4/M4A support:
//  - defragment(): turns SoundCloud's HLS fMP4 (init.mp4 + *.m4s) into a regular,
//    non-fragmented M4A with a real sample table, so every player shows the right
//    duration and can seek;
//  - tagMp4(): writes iTunes-style metadata (moov/udta/meta/ilst) into any MP4,
//    shifting chunk offsets when moov sits before mdat.
import {
  ascii,
  concat,
  latin1,
  readU32be,
  readU64be,
  u16be,
  u32be,
  u8,
  utf8,
  writeU32be,
  writeU64be,
} from '../bytes.js';

// Containers whose children start right after the 8/16-byte box header.
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'mvex', 'moof', 'traf', 'dinf']);

export function parseBoxes(b, start = 0, end = b.length) {
  const boxes = [];
  let o = start;
  while (o + 8 <= end) {
    let size = readU32be(b, o);
    const type = ascii(b, o + 4, o + 8);
    let header = 8;
    if (size === 1) {
      size = readU64be(b, o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) break;
    boxes.push({ type, start: o, size, header, end: o + size });
    o += size;
  }
  return boxes;
}

const kids = (b, box) => parseBoxes(b, box.start + box.header, box.end);
const kid = (b, box, type) => kids(b, box).find((k) => k.type === type);
const raw = (b, box) => b.subarray(box.start, box.end);

export function box(type, ...payload) {
  const body = concat(payload);
  return concat([u32be(8 + body.length), latin1(type), body]);
}

function fullBox(type, version, flags, ...payload) {
  return box(type, u32be(((version & 0xff) << 24) | (flags & 0xffffff)), ...payload);
}

/**
 * Rebuilds a container box. `map(child)` returns replacement bytes, `null` to drop
 * the child, or `undefined` to keep it unchanged. `append` adds boxes at the end.
 */
function rebuild(b, container, map, append = []) {
  const out = [];
  for (const k of kids(b, container)) {
    const r = map(k);
    if (r === undefined) out.push(raw(b, k));
    else if (r !== null) out.push(r);
  }
  return box(container.type, ...out, ...append);
}

// ---------------------------------------------------------------------------
// Fragmented → progressive

/** Patches the duration field of an mvhd/mdhd box copy. */
function withDuration(b, bx, duration) {
  const copy = raw(b, bx).slice();
  const v = copy[8];
  if (v === 1) writeU64be(copy, 12 + 8 + 8 + 4, duration);
  else writeU32be(copy, 12 + 4 + 4 + 4, Math.min(duration, 0xffffffff));
  return copy;
}

function timescaleOf(b, bx) {
  return b[bx.start + 8] === 1 ? readU32be(b, bx.start + 12 + 16) : readU32be(b, bx.start + 12 + 8);
}

function tkhdWithDuration(b, bx, duration) {
  const copy = raw(b, bx).slice();
  if (copy[8] === 1) writeU64be(copy, 12 + 8 + 8 + 4 + 4, duration);
  else writeU32be(copy, 12 + 4 + 4 + 4 + 4, Math.min(duration, 0xffffffff));
  return copy;
}

/** Edit lists with segment_duration 0 mean "until the end" only in fragmented files. */
function elstFixed(b, bx, movieDuration) {
  const copy = raw(b, bx).slice();
  const v = copy[8];
  const count = readU32be(copy, 12);
  let o = 16;
  for (let i = 0; i < count; i++) {
    if (v === 1) {
      if (readU64be(copy, o) === 0) writeU64be(copy, o, movieDuration);
      o += 20;
    } else {
      if (readU32be(copy, o) === 0) writeU32be(copy, o, movieDuration);
      o += 12;
    }
  }
  return copy;
}

function readTrex(b, moov) {
  const mvex = kid(b, moov, 'mvex');
  const trex = mvex && kid(b, mvex, 'trex');
  if (!trex) return { duration: 0, size: 0 };
  return { duration: readU32be(b, trex.start + 20), size: readU32be(b, trex.start + 24) };
}

/** Collects samples from every moof/mdat pair in a media segment. */
function collectSamples(seg, trex, acc) {
  for (const moof of parseBoxes(seg)) {
    if (moof.type !== 'moof') continue;
    for (const traf of kids(seg, moof)) {
      if (traf.type !== 'traf') continue;
      const tfhd = kid(seg, traf, 'tfhd');
      const flags = readU32be(seg, tfhd.start + 8) & 0xffffff;
      let p = tfhd.start + 16; // after version/flags + track_ID
      let base = moof.start;
      if (flags & 0x1) {
        base = readU64be(seg, p);
        p += 8;
      }
      if (flags & 0x2) p += 4;
      let defDur = trex.duration;
      let defSize = trex.size;
      if (flags & 0x8) {
        defDur = readU32be(seg, p);
        p += 4;
      }
      if (flags & 0x10) defSize = readU32be(seg, p);

      let pos = base;
      for (const trun of kids(seg, traf)) {
        if (trun.type !== 'trun') continue;
        const tf = readU32be(seg, trun.start + 8) & 0xffffff;
        let q = trun.start + 12;
        const count = readU32be(seg, q);
        q += 4;
        if (tf & 0x1) {
          pos = base + (readU32be(seg, q) | 0);
          q += 4;
        }
        if (tf & 0x4) q += 4;
        const chunkStart = pos;
        for (let i = 0; i < count; i++) {
          let dur = defDur;
          let size = defSize;
          if (tf & 0x100) {
            dur = readU32be(seg, q);
            q += 4;
          }
          if (tf & 0x200) {
            size = readU32be(seg, q);
            q += 4;
          }
          if (tf & 0x400) q += 4;
          if (tf & 0x800) q += 4; // composition offsets: always 0 for audio
          acc.sizes.push(size);
          acc.durations.push(dur);
          pos += size;
        }
        if (pos > seg.length) throw new Error('Повреждённый сегмент: данные выходят за границы файла');
        acc.chunks.push({ data: seg.subarray(chunkStart, pos), count });
      }
    }
  }
}

function buildStbl(stsd, acc, chunkOffsets) {
  const stts = [];
  for (const d of acc.durations) {
    const last = stts[stts.length - 1];
    if (last && last[1] === d) last[0]++;
    else stts.push([1, d]);
  }
  const stsc = [];
  acc.chunks.forEach((c, i) => {
    const last = stsc[stsc.length - 1];
    if (!last || last[1] !== c.count) stsc.push([i + 1, c.count]);
  });
  const useCo64 = chunkOffsets.some((o) => o > 0xffffffff);
  return box(
    'stbl',
    stsd,
    fullBox('stts', 0, 0, u32be(stts.length), ...stts.flatMap(([n, d]) => [u32be(n), u32be(d)])),
    fullBox('stsc', 0, 0, u32be(stsc.length), ...stsc.flatMap(([f, n]) => [u32be(f), u32be(n), u32be(1)])),
    fullBox('stsz', 0, 0, u32be(0), u32be(acc.sizes.length), ...acc.sizes.map(u32be)),
    useCo64
      ? fullBox('co64', 0, 0, u32be(chunkOffsets.length), ...chunkOffsets.map((o) => concat([u32be(Math.floor(o / 2 ** 32)), u32be(o >>> 0)])))
      : fullBox('stco', 0, 0, u32be(chunkOffsets.length), ...chunkOffsets.map(u32be)),
  );
}

/**
 * Joins an fMP4 init segment and media segments into one progressive M4A.
 * `meta` (optional) is written as iTunes tags in the same pass.
 */
export function defragment(init, segments, meta) {
  const top = parseBoxes(init);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) throw new Error('В init-сегменте нет moov');
  const traks = kids(init, moov).filter((k) => k.type === 'trak');
  if (traks.length !== 1) throw new Error(`Ожидалась одна дорожка, найдено ${traks.length}`);
  const trak = traks[0];
  const mdia = kid(init, trak, 'mdia');
  const mdhd = kid(init, mdia, 'mdhd');
  const minf = kid(init, mdia, 'minf');
  const stbl = kid(init, minf, 'stbl');
  const stsd = raw(init, kid(init, stbl, 'stsd'));
  const mvhd = kid(init, moov, 'mvhd');

  const acc = { sizes: [], durations: [], chunks: [] };
  const trex = readTrex(init, moov);
  for (const seg of segments) collectSamples(seg, trex, acc);
  if (!acc.sizes.length) throw new Error('В сегментах нет аудиоданных');

  const mediaDuration = acc.durations.reduce((a, d) => a + d, 0);
  const movieDuration = Math.round((mediaDuration * timescaleOf(init, mvhd)) / timescaleOf(init, mdhd));

  const buildMoov = (offsets) => {
    const newStbl = buildStbl(stsd, acc, offsets);
    const newMinf = rebuild(init, minf, (k) => (k.type === 'stbl' ? newStbl : undefined));
    const newMdia = rebuild(init, mdia, (k) => {
      if (k.type === 'mdhd') return withDuration(init, k, mediaDuration);
      if (k.type === 'minf') return newMinf;
      return undefined;
    });
    const newTrak = rebuild(init, trak, (k) => {
      if (k.type === 'tkhd') return tkhdWithDuration(init, k, movieDuration);
      if (k.type === 'edts') return rebuild(init, k, (e) => (e.type === 'elst' ? elstFixed(init, e, movieDuration) : undefined));
      if (k.type === 'mdia') return newMdia;
      return undefined;
    });
    return rebuild(
      init,
      moov,
      (k) => {
        if (k.type === 'mvhd') return withDuration(init, k, movieDuration);
        if (k.type === 'trak') return newTrak;
        if (k.type === 'mvex' || k.type === 'udta') return null;
        return undefined;
      },
      meta ? [box('udta', buildMetaBox(meta))] : [],
    );
  };

  const ftyp = box('ftyp', latin1('M4A '), u32be(0x200), latin1('M4A '), latin1('isom'), latin1('iso2'), latin1('mp41'));
  const zeroOffsets = acc.chunks.map(() => 0);
  const moovLen = buildMoov(zeroOffsets).length;
  const offsets = [];
  let cursor = ftyp.length + moovLen + 8;
  for (const c of acc.chunks) {
    offsets.push(cursor);
    cursor += c.data.length;
  }
  const finalMoov = buildMoov(offsets);
  const mdatBody = concat(acc.chunks.map((c) => c.data));
  return concat([ftyp, finalMoov, u32be(8 + mdatBody.length), latin1('mdat'), mdatBody]);
}

// ---------------------------------------------------------------------------
// iTunes metadata

function dataAtom(type, payload) {
  return box('data', u32be(type), u32be(0), payload);
}

const item = (name, type, payload) => box(name, dataAtom(type, payload));
const textItem = (name, value) => item(name, 1, utf8(String(value)));

function freeform(name, value) {
  return box(
    '----',
    box('mean', u32be(0), utf8('com.apple.iTunes')),
    box('name', u32be(0), utf8(name)),
    dataAtom(1, utf8(String(value))),
  );
}

export function buildMetaBox(meta) {
  const items = [];
  const text = (name, v) => {
    if (v !== undefined && v !== null && v !== '') items.push(textItem(name, v));
  };
  text('\xa9nam', meta.title);
  text('\xa9ART', meta.artist);
  text('\xa9alb', meta.album);
  text('aART', meta.albumArtist);
  text('\xa9day', meta.date || meta.year);
  text('\xa9gen', meta.genre);
  text('\xa9wrt', meta.composer);
  text('\xa9cmt', meta.comment);
  text('\xa9lyr', meta.lyrics);
  text('cprt', meta.copyright);
  text('\xa9too', meta.encodedBy);
  if (meta.trackNumber) {
    items.push(item('trkn', 0, concat([u16be(0), u16be(meta.trackNumber), u16be(meta.trackTotal || 0), u16be(0)])));
  }
  if (meta.discNumber) items.push(item('disk', 0, concat([u16be(0), u16be(meta.discNumber), u16be(0)])));
  if (meta.explicit) items.push(item('rtng', 21, u8(1)));
  if (meta.cover) items.push(item('covr', meta.cover.mime === 'image/png' ? 14 : 13, meta.cover.data));
  const ff = { ISRC: meta.isrc, LABEL: meta.label, PUBLISHER: meta.publisher, URL: meta.url, ...meta.extra };
  for (const [k, v] of Object.entries(ff)) {
    if (v !== undefined && v !== null && v !== '') items.push(freeform(k, v));
  }
  const hdlr = fullBox('hdlr', 0, 0, u32be(0), latin1('mdir'), latin1('appl'), u32be(0), u32be(0), u8(0));
  return fullBox('meta', 0, 0, hdlr, box('ilst', ...items));
}

/** Shifts stco/co64 entries (and explicit tfhd base offsets) located at or after `from`. */
function shiftOffsets(b, container, from, delta) {
  for (const k of kids(b, container)) {
    if (k.type === 'stco') {
      const n = readU32be(b, k.start + 12);
      for (let i = 0; i < n; i++) {
        const o = k.start + 16 + i * 4;
        const v = readU32be(b, o);
        if (v >= from) writeU32be(b, o, v + delta);
      }
    } else if (k.type === 'co64') {
      const n = readU32be(b, k.start + 12);
      for (let i = 0; i < n; i++) {
        const o = k.start + 16 + i * 8;
        const v = readU64be(b, o);
        if (v >= from) writeU64be(b, o, v + delta);
      }
    } else if (k.type === 'tfhd') {
      if (readU32be(b, k.start + 8) & 0x1) {
        const o = k.start + 16;
        const v = readU64be(b, o);
        if (v >= from) writeU64be(b, o, v + delta);
      }
    } else if (CONTAINERS.has(k.type)) {
      shiftOffsets(b, k, from, delta);
    }
  }
}

/** Writes/replaces iTunes metadata in an MP4 file (regular or fragmented). */
export function tagMp4(input, meta) {
  const b = input.slice();
  const top = parseBoxes(b);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) throw new Error('В файле MP4 нет moov');
  const metaBox = buildMetaBox(meta);
  const hadUdta = kids(b, moov).some((k) => k.type === 'udta');
  const buildNew = () =>
    rebuild(
      b,
      moov,
      (k) => (k.type === 'udta' ? rebuild(b, k, (u) => (u.type === 'meta' ? null : undefined), [metaBox]) : undefined),
      hadUdta ? [] : [box('udta', metaBox)],
    );
  const delta = buildNew().length - moov.size;
  // Offsets inside moov must be shifted before we serialize it for real.
  if (delta !== 0) {
    shiftOffsets(b, moov, moov.end, delta);
    for (const t of top) if (t.type === 'moof' && t.start >= moov.end) shiftOffsets(b, t, moov.end, delta);
  }
  return concat([b.subarray(0, moov.start), buildNew(), b.subarray(moov.end)]);
}

export function isFragmented(b) {
  const top = parseBoxes(b);
  const moov = top.find((x) => x.type === 'moov');
  return top.some((x) => x.type === 'moof') || (moov && kids(b, moov).some((k) => k.type === 'mvex'));
}

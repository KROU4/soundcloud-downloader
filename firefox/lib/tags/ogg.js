// Ogg Opus / Ogg Vorbis tagging: replaces the comment header packet, re-paginates
// the header pages and renumbers the following pages (with fresh CRCs).
import { concat, latin1, readU32le, startsWith, writeU32le } from '../bytes.js';
import { commentBody, vorbisFields } from './vorbis.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(b) {
  let crc = 0;
  for (let i = 0; i < b.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

export function parsePages(b) {
  const pages = [];
  let o = 0;
  while (o + 27 <= b.length && startsWith(b, 'OggS', o)) {
    const nsegs = b[o + 26];
    const lacing = b.subarray(o + 27, o + 27 + nsegs);
    let dataLen = 0;
    for (const l of lacing) dataLen += l;
    const dataStart = o + 27 + nsegs;
    pages.push({
      start: o,
      end: dataStart + dataLen,
      headerType: b[o + 5],
      serial: readU32le(b, o + 14),
      seq: readU32le(b, o + 18),
      lacing,
      dataStart,
    });
    o = dataStart + dataLen;
  }
  if (o !== b.length) throw new Error('Повреждённый поток Ogg');
  return pages;
}

function sealPage(page) {
  page.fill(0, 22, 26);
  writeU32le(page, 22, oggCrc(page));
  return page;
}

function buildPage({ headerType, granule, serial, seq, lacing, data }) {
  const page = new Uint8Array(27 + lacing.length + data.length);
  page.set(latin1('OggS'), 0);
  page[4] = 0;
  page[5] = headerType;
  page.set(granule, 6);
  writeU32le(page, 14, serial);
  writeU32le(page, 18, seq);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(data, 27 + lacing.length);
  return sealPage(page);
}

/** Lays packets out on pages; every packet starts on a fresh page as Opus/Vorbis require for headers. */
function paginate(packets, serial, firstSeq) {
  const pages = [];
  let seq = firstSeq;
  const granule = new Uint8Array(8);
  for (const packet of packets) {
    const lacingAll = [];
    for (let left = packet.length; ; left -= 255) {
      if (left >= 255) lacingAll.push(255);
      else {
        lacingAll.push(left);
        break;
      }
    }
    let li = 0;
    let dataOff = 0;
    let continued = false;
    while (li < lacingAll.length) {
      const lacing = Uint8Array.from(lacingAll.slice(li, li + 255));
      const len = lacing.reduce((a, l) => a + l, 0);
      pages.push(
        buildPage({ headerType: continued ? 1 : 0, granule, serial, seq: seq++, lacing, data: packet.subarray(dataOff, dataOff + len) }),
      );
      li += lacing.length;
      dataOff += len;
      continued = true;
    }
  }
  return pages;
}

export function tagOgg(b, meta) {
  const pages = parsePages(b);
  if (!pages.length) throw new Error('Пустой поток Ogg');
  const serial = pages[0].serial;
  const first = b.subarray(pages[0].dataStart, pages[0].end);
  let codec;
  if (startsWith(first, 'OpusHead')) codec = 'opus';
  else if (first[0] === 1 && startsWith(first, 'vorbis', 1)) codec = 'vorbis';
  else throw new Error('Неизвестный кодек внутри Ogg');
  const headerCount = codec === 'opus' ? 2 : 3;

  // Reassemble header packets from the logical stream.
  const packets = [];
  let current = [];
  let lastHeaderPage = -1;
  for (let i = 0; i < pages.length && packets.length < headerCount; i++) {
    const p = pages[i];
    if (p.serial !== serial) continue;
    let o = p.dataStart;
    for (let s = 0; s < p.lacing.length; s++) {
      const l = p.lacing[s];
      current.push(b.subarray(o, o + l));
      o += l;
      if (l < 255) {
        packets.push(concat(current));
        current = [];
        if (packets.length === headerCount) {
          if (s !== p.lacing.length - 1) throw new Error('Заголовки Ogg не выровнены по страницам');
          lastHeaderPage = i;
          break;
        }
      }
    }
  }
  if (lastHeaderPage < 0) throw new Error('В потоке Ogg не найдены заголовки');

  const body = commentBody(vorbisFields(meta, { embedPicture: true }));
  const comment = codec === 'opus' ? concat([latin1('OpusTags'), body]) : concat([Uint8Array.of(3), latin1('vorbis'), body, Uint8Array.of(1)]);
  const newHeaderPackets = codec === 'opus' ? [comment] : [comment, packets[2]];
  const headerPages = paginate(newHeaderPackets, serial, 1);

  const oldHeaderPages = pages.filter((p, i) => i > 0 && i <= lastHeaderPage && p.serial === serial).length;
  const shift = headerPages.length - oldHeaderPages;
  const out = [];
  let headersEmitted = false;
  pages.forEach((p, i) => {
    if (p.serial !== serial || i === 0) out.push(b.subarray(p.start, p.end));
    else if (i <= lastHeaderPage) {
      if (!headersEmitted) out.push(...headerPages);
      headersEmitted = true;
    } else if (shift === 0) out.push(b.subarray(p.start, p.end));
    else {
      const copy = b.slice(p.start, p.end);
      writeU32le(copy, 18, p.seq + shift);
      out.push(sealPage(copy));
    }
  });
  return concat(out);
}

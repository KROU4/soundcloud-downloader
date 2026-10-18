// Low-level byte helpers shared by all tag writers. Everything works on Uint8Array.

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const utf8 = (s) => utf8Encoder.encode(s);
export const decodeUtf8 = (b) => utf8Decoder.decode(b);

/** ISO-8859-1; characters outside the range are replaced with '?'. */
export function latin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 256 ? c : 0x3f;
  }
  return out;
}

export function ascii(b, start = 0, end = b.length) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** UTF-16LE with BOM, as used by ID3v2.3 encoding 0x01. */
export function utf16WithBom(s) {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

export function u8(n) {
  return Uint8Array.of(n & 0xff);
}

export function u16be(n) {
  return Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
}

export function u24be(n) {
  return Uint8Array.of((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function u32be(n) {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function u64be(n) {
  const hi = Math.floor(n / 2 ** 32);
  return concat([u32be(hi), u32be(n >>> 0)]);
}

export function u32le(n) {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

export function readU16be(b, o) {
  return (b[o] << 8) | b[o + 1];
}

export function readU24be(b, o) {
  return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
}

export function readU32be(b, o) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

export function readU64be(b, o) {
  return readU32be(b, o) * 2 ** 32 + readU32be(b, o + 4);
}

export function readU32le(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function writeU32be(b, o, n) {
  b[o] = (n >>> 24) & 0xff;
  b[o + 1] = (n >>> 16) & 0xff;
  b[o + 2] = (n >>> 8) & 0xff;
  b[o + 3] = n & 0xff;
}

export function writeU64be(b, o, n) {
  writeU32be(b, o, Math.floor(n / 2 ** 32));
  writeU32be(b, o + 4, n >>> 0);
}

export function writeU32le(b, o, n) {
  b[o] = n & 0xff;
  b[o + 1] = (n >>> 8) & 0xff;
  b[o + 2] = (n >>> 16) & 0xff;
  b[o + 3] = (n >>> 24) & 0xff;
}

export function startsWith(b, sig, offset = 0) {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (b[offset + i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

export function base64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

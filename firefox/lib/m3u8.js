/** Parses an HLS media playlist. Encrypted (DRM) playlists are rejected. */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('Ответ не похож на плейлист HLS');
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) throw new Error('Получен мастер-плейлист вместо медиаплейлиста');
  const key = lines.find((l) => l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(l));
  if (key) throw new Error('Поток защищён DRM, такие треки не скачиваются');
  const resolve = (u) => new URL(u, baseUrl).href;
  let map = null;
  const segments = [];
  let duration = 0;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MAP:')) {
      const m = l.match(/URI="([^"]+)"/);
      if (m) map = resolve(m[1]);
    } else if (l.startsWith('#EXTINF:')) {
      duration += parseFloat(l.slice(8)) || 0;
    } else if (l && !l.startsWith('#')) {
      segments.push(resolve(l));
    }
  }
  if (!segments.length) throw new Error('В плейлисте HLS нет сегментов');
  return { map, segments, duration };
}

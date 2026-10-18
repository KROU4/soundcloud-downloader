// SoundCloud API objects → normalized metadata consumed by every tag writer.

const ENCODER = 'SoundCloud Downloader';

// `\b` is ASCII-only in JS regexes, so word ends are checked with a Unicode lookahead.
const END = '(?![\\p{L}\\p{N}])';
const LEAD = '^[\\s*_#~=•\\-–—>|\\p{Extended_Pictographic}]*';
const LYRICS_HEADING = new RegExp(
  `${LEAD}(lyrics?|текст(?:\\s+песни|\\s+трека)?|слова(?:\\s+песни)?|letras?|paroles|songtext|testo)${END}\\s*[:：\\-–—]*\\s*(.*)$`,
  'iu',
);
const LYRICS_STOP = new RegExp(
  `${LEAD}(credits?|prod(?:uced)?(?:\\s+by)?|mix(?:ed)?(?:\\s+by)?|master(?:ed|ing)?(?:\\s+by)?|recorded|engineer|artwork|cover\\s+art|written\\s+by|follow|stream|download|free\\s+download|buy|booking|contact|management|instagram|twitter|tiktok|spotify|apple\\s+music|youtube|bandcamp|битмейкер|сведение|мастеринг|бит|обложка|подписывайтесь)${END}`,
  'iu',
);

/** Extracts a lyrics section from a description: a "Lyrics:" heading followed by text. */
export function extractLyrics(description) {
  if (!description) return null;
  const lines = description.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => LYRICS_HEADING.test(l.trim()) && l.trim().length < 60 + (l.match(LYRICS_HEADING)?.[2]?.length || 0));
  if (start < 0) return null;
  const first = lines[start].trim().match(LYRICS_HEADING)[2].trim();
  const body = first ? [first] : [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (LYRICS_STOP.test(l.trim()) || /^\s*(https?:\/\/|www\.)\S+\s*$/i.test(l)) break;
    body.push(l.trimEnd());
  }
  const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length >= 20 ? text : null;
}

function isoDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function splitArtistTitle(title) {
  const m = String(title || '').match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
}

/** Artwork URL in the requested size (SoundCloud encodes the size in the file name). */
export function artworkUrl(url, size) {
  if (!url) return null;
  return url.replace(/-(large|t\d+x\d+|crop|original|tiny|small|badge|mini)(?=\.\w+(\?|$))/, `-${size}`);
}

/** Cover candidates from best to worst, so a 404 on "original" falls back gracefully. */
export function coverCandidates(track, playlist, settings) {
  const base = track.artwork_url || playlist?.artwork_url || (settings.avatarFallback ? track.user?.avatar_url : null);
  if (!base) return [];
  const sizes = settings.coverSize === 'original' ? ['original', 't500x500'] : ['t500x500'];
  return [...new Set([...sizes.map((s) => artworkUrl(base, s)), base])];
}

export function buildMeta(track, { playlist = null, index = null, settings }) {
  const pm = track.publisher_metadata || {};
  const uploader = track.user?.username || '';
  let artist = pm.artist || '';
  let title = track.title || '';
  if (!artist) {
    const split = settings.splitArtistFromTitle ? splitArtistTitle(title) : null;
    if (split) ({ artist, title } = split);
    else artist = uploader;
  }

  const date = isoDate(pm.release_date) || isoDate(track.release_date) || isoDate(track.display_date) || isoDate(track.created_at);
  const description = (track.description || '').trim();
  let lyrics = track.lyrics || null;
  if (!lyrics && settings.lyricsFromDescription) lyrics = extractLyrics(description);
  if (!lyrics && settings.descriptionAsLyrics && description) lyrics = description;

  const inPlaylist = playlist && index !== null;
  const album = pm.album_title || (inPlaylist && settings.playlistAsAlbum ? playlist.title : null);
  const albumArtist = inPlaylist && album === playlist.title ? playlist.user?.username || null : pm.album_title ? artist : null;

  const comment = [description, track.permalink_url].filter(Boolean).join('\n\n');
  return {
    title,
    artist,
    album,
    albumArtist,
    trackNumber: inPlaylist ? index + 1 : null,
    trackTotal: inPlaylist ? playlist.track_count || playlist.tracks?.length || null : null,
    date,
    year: date ? date.slice(0, 4) : null,
    genre: track.genre || null,
    composer: pm.writer_composer || null,
    publisher: pm.publisher || null,
    label: track.label_name || null,
    copyright: pm.p_line || pm.c_line || null,
    isrc: pm.isrc || null,
    explicit: pm.explicit === true,
    comment,
    lyrics,
    url: track.permalink_url,
    artistUrl: track.user?.permalink_url || null,
    purchaseUrl: track.purchase_url || null,
    encodedBy: ENCODER,
    extra: {
      SOUNDCLOUD_TRACK_ID: track.id,
      UPLOADER: uploader !== artist ? uploader : null,
      LICENSE: track.license && track.license !== 'all-rights-reserved' ? track.license : null,
    },
    cover: null,
  };
}

/** Values available to file name templates. */
export function templateValues(meta, track, { playlist = null, index = null } = {}) {
  const width = Math.max(2, String(playlist?.track_count || playlist?.tracks?.length || 0).length);
  return {
    artist: meta.artist,
    title: meta.title,
    album: meta.album,
    year: meta.year,
    genre: meta.genre,
    id: track.id,
    uploader: track.user?.username,
    index: index !== null ? String(index + 1).padStart(width, '0') : '',
    playlist: playlist?.title,
    playlistArtist: playlist?.user?.username,
  };
}

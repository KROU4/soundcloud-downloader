export const DEFAULT_SETTINGS = {
  /** Use the uploader's original file when downloads are enabled (needs SoundCloud login). */
  preferOriginal: true,
  /** best | aac | mp3 | opus — codec preference for streamed audio (API). */
  preferredCodec: 'best',
  /** original | t500x500 */
  coverSize: 'original',
  /** Use the artist avatar when a track has no artwork. */
  avatarFallback: true,
  baseFolder: 'SoundCloud',
  trackTemplate: '{artist} - {title}',
  playlistFolderTemplate: '{playlistArtist} - {playlist}',
  playlistTrackTemplate: '{index} - {artist} - {title}',
  /** Write the playlist title as album for tracks that have no album of their own. */
  playlistAsAlbum: true,
  /** "Artist - Title" uploads without publisher metadata: split into artist and title. */
  splitArtistFromTitle: true,
  /** Pull a "Lyrics:" / "Текст:" section out of the description. */
  lyricsFromDescription: true,
  /** If no marked section exists, put the whole description into the lyrics tag. */
  descriptionAsLyrics: false,
  /** Playlists, albums and profiles arrive as one ZIP archive instead of a folder of files. */
  playlistAsZip: true,
  saveCoverFile: true,
  savePlaylistFile: true,
  concurrency: 2,
};

export const SETTINGS_KEY = 'settings';

export function withDefaults(stored) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

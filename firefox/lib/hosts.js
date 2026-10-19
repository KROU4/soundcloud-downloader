// Hosts the extension talks to: the site and API, artwork/asset CDN (sndcdn.com)
// and the audio CDN (soundcloud.cloud). Kept in sync with manifest host_permissions.
export const HOST_ORIGINS = ['https://soundcloud.com/*', 'https://*.soundcloud.com/*', 'https://*.sndcdn.com/*', 'https://*.soundcloud.cloud/*'];

const PAGE_HOST = /^(m\.|www\.)?soundcloud\.com$/;
const MEDIA_HOST = /(^|\.)(sndcdn\.com|soundcloud\.cloud)$/;

function parse(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

/**
 * A soundcloud.com page. Data from the page (another script there could answer for
 * page-hook.js) is checked with these before the extension acts on it.
 */
export const isScPageUrl = (url) => PAGE_HOST.test(parse(url)?.hostname || '');

/** SoundCloud's artwork and audio CDNs. */
export const isScMediaUrl = (url) => MEDIA_HOST.test(parse(url)?.hostname || '');

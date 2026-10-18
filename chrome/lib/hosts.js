// Hosts the extension talks to: the site and API, artwork/asset CDN (sndcdn.com)
// and the audio CDN (soundcloud.cloud). Kept in sync with manifest host_permissions.
export const HOST_ORIGINS = ['*://soundcloud.com/*', '*://*.soundcloud.com/*', '*://*.sndcdn.com/*', '*://*.soundcloud.cloud/*'];

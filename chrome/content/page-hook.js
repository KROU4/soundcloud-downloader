// Runs in the page's own JavaScript world (MAIN) before soundcloud.com's scripts.
// The extension never calls SoundCloud's API itself: this script only watches what
// the site's player loads (track data and signed stream links) and drives the
// player through its own UI (play buttons) when a track has to be fetched.
// It talks to content.js through window.postMessage.
(() => {
  if (window.__scdlHook) return;
  window.__scdlHook = true;

  const TAG_IN = 'scdl:cs';
  const TAG_OUT = 'scdl:page';
  const API_HOST = 'api-v2.soundcloud.com';
  const STREAM_PATH = /\/media\/soundcloud:tracks:(\d+)\/[^/]+\/(stream|preview)\/(hls|progressive)/;
  const ITEM_SELECTOR =
    '.trackList__item, .trackItem, .soundList__item, .searchList__item, .soundBadge, .sound, .compactTrackListItem, .systemPlaylistTrackList__item, .historicalPlays__item';
  const LIST_ITEM_SELECTOR = '.trackList__item, .soundList__item, .systemPlaylistTrackList__item';
  const TITLE_SELECTOR = 'a.trackItem__trackTitle, a.soundTitle__title, a.soundBadge__title, a.compactTrackListItem__trackTitle, a[class*="TrackTitle"]';
  const GRAB_TIMEOUT = 15000;
  /** A captured link is reused without touching the player while it is this fresh. */
  const CAPTURE_FRESH = 10 * 60 * 1000;

  const tracks = new Map();
  const playlists = new Map();
  const users = new Map();
  /** pathname → { kind, id } */
  const byPath = new Map();
  /** track id → { url, path, at } — signed stream links the player received */
  const captures = new Map();
  const captureWaiters = new Set();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function pathOf(href) {
    try {
      const u = new URL(href, location.origin);
      return decodeURIComponent(u.pathname).replace(/\/+$/, '').toLowerCase() || '/';
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ harvesting

  function store(map, obj) {
    const old = map.get(obj.id);
    // Stubs (id + kind only) must never overwrite a full object, and a newer full
    // object (fresh track_authorization, media) wins over an older one.
    const merged = old ? { ...old, ...obj } : obj;
    if (old?.media && !obj.media) merged.media = old.media;
    map.set(obj.id, merged);
    if (obj.permalink_url) {
      const p = pathOf(obj.permalink_url);
      if (p) byPath.set(p, { kind: obj.kind, id: obj.id });
    }
  }

  function harvest(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const x of node) harvest(x, depth + 1);
      return;
    }
    if (node.id != null) {
      if (node.kind === 'track') store(tracks, node);
      else if (node.kind === 'playlist' || node.kind === 'system-playlist') store(playlists, node);
      else if (node.kind === 'user') store(users, node);
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') harvest(v, depth + 1);
    }
  }

  let hydrated = false;
  function harvestHydration() {
    const h = window.__sc_hydration;
    if (!Array.isArray(h) || hydrated) return;
    hydrated = true;
    for (const entry of h) if (entry?.data) harvest(entry.data);
  }

  function onApiResponse(url, text) {
    let u;
    try {
      u = new URL(url, location.origin);
    } catch {
      return;
    }
    if (u.hostname !== API_HOST || !text) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const m = u.pathname.match(STREAM_PATH);
    if (m && json?.url) {
      const capture = { url: json.url, path: u.pathname, preview: m[2] === 'preview', protocol: m[3], at: Date.now() };
      captures.set(Number(m[1]), capture);
      for (const w of captureWaiters) w(Number(m[1]), capture);
      return;
    }
    harvest(json);
  }

  const XHR = XMLHttpRequest.prototype;
  const xhrOpen = XHR.open;
  XHR.open = function (method, url, ...rest) {
    try {
      if (String(url).includes(API_HOST)) {
        const target = String(url);
        this.addEventListener('load', () => {
          try {
            if (this.status !== 200) return;
            const type = this.responseType;
            if (type === '' || type === 'text') onApiResponse(target, this.responseText);
            else if (type === 'json' && this.response) onApiResponse(target, JSON.stringify(this.response));
          } catch {
            // never break the site
          }
        });
      }
    } catch {
      // never break the site
    }
    return xhrOpen.call(this, method, url, ...rest);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes(API_HOST)) {
        p.then((res) => {
          if (res.ok) res.clone().text().then((t) => onApiResponse(url, t), () => {});
        }, () => {});
      }
    } catch {
      // never break the site
    }
    return p;
  };

  // ------------------------------------------------------- muted capturing

  let capturing = 0;
  /** Media elements we muted, to unmute once the player is paused again. */
  const mutedByUs = new Set();
  const mediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (capturing && !this.muted) {
      this.muted = true;
      mutedByUs.add(this);
    }
    return mediaPlay.apply(this, arguments);
  };

  const playButton = () => document.querySelector('.playControls__play');
  const isPlaying = () => !!playButton()?.classList.contains('playing');

  let settleTimer = null;
  function settleLater() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(async () => {
      if (capturing) return;
      if (isPlaying()) playButton().click();
      for (const el of mutedByUs) if (!el.paused) el.pause();
      await sleep(300);
      if (capturing) return;
      for (const el of mutedByUs) el.muted = false;
      mutedByUs.clear();
    }, 600);
  }

  function waitCapture(id, since, timeout) {
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        clearInterval(poll);
        captureWaiters.delete(waiter);
        resolve(value);
      };
      const waiter = (gotId, capture) => {
        if (gotId === id && capture.at >= since) done(capture);
      };
      const timer = setTimeout(() => done(null), timeout);
      // The sign-in dialog replaces playback for visitors who are not logged in.
      const poll = setInterval(() => {
        if (loginPrompted()) done('login');
      }, 300);
      captureWaiters.add(waiter);
    });
  }

  /** The site's sign-in dialog is on screen (it replaces playback for visitors). */
  function loginPrompted() {
    return [...document.querySelectorAll('.auth-modal, iframe[src*="web-auth"]')].some((el) => el.getClientRects().length > 0);
  }

  function loggedIn() {
    const h = Array.isArray(window.__sc_hydration) ? window.__sc_hydration : [];
    return h.some((e) => e?.hydratable === 'meUser' || e?.hydratable === 'me');
  }

  // ----------------------------------------------------------- UI driving

  /**
   * A play button on the page that starts this very track. `index` is its position
   * in the collection whose page is open: the fallback for tracks the page knows only
   * by id (the captured stream is checked against the id anyway).
   */
  function findPlayButton(track, index, collection) {
    const path = pathOf(track.permalink_url);
    if (!path) {
      if (index == null || !collection || pathOf(location.href) !== pathOf(collection)) return null;
      return document.querySelectorAll(LIST_ITEM_SELECTOR)[index]?.querySelector('.sc-button-play, .playButton') || null;
    }
    for (const a of document.querySelectorAll(TITLE_SELECTOR)) {
      if (pathOf(a.getAttribute('href')) !== path || a.closest('.playControls')) continue;
      const btn = a.closest(ITEM_SELECTOR)?.querySelector('.sc-button-play, .playButton');
      if (btn) return btn;
    }
    if (pathOf(location.href) === path) {
      const hero = document.querySelector('.sc-button-play.sc-button-xxlarge, .sc-button-play.sc-button-xlarge, .fullHero .sc-button-play, .listenHero .sc-button-play');
      if (hero) return hero;
    }
    // The track is already loaded in the bottom player: resume it.
    const badge = document.querySelector('.playbackSoundBadge__titleLink');
    if (badge && pathOf(badge.getAttribute('href')) === path && !isPlaying()) return playButton();
    return null;
  }

  function transcodingFor(track, capture) {
    return (track?.media?.transcodings || []).find((t) => {
      try {
        return new URL(t.url).pathname === capture.path;
      } catch {
        return false;
      }
    });
  }

  function grabResult(id, capture) {
    const track = tracks.get(id) || null;
    const t = transcodingFor(track, capture);
    return {
      track,
      url: capture.url,
      age: Date.now() - capture.at,
      preview: capture.preview || !!t?.snipped,
      protocol: t?.format?.protocol || capture.protocol,
      mime: t?.format?.mime_type || null,
      preset: t?.preset || null,
    };
  }

  let chain = Promise.resolve();
  /** One track at a time: there is only one player. */
  function serialized(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  async function grab({ id, permalink, index = null, collection = null, fresh = false }) {
    const known = captures.get(id);
    if (!fresh && known && Date.now() - known.at < CAPTURE_FRESH) return grabResult(id, known);
    return serialized(async () => {
      const again = captures.get(id);
      if (!fresh && again && Date.now() - again.at < CAPTURE_FRESH) return grabResult(id, again);
      const track = tracks.get(id) || { id, permalink_url: permalink };
      if (!track.permalink_url) track.permalink_url = permalink;
      const btn = findPlayButton(track, index, collection);
      if (!btn) return { error: 'not-found' };
      capturing++;
      clearTimeout(settleTimer);
      try {
        const since = Date.now();
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        const capture = await waitCapture(id, since, GRAB_TIMEOUT);
        if (capture === 'login') return { error: 'login' };
        if (capture) return grabResult(id, capture);
        // Resuming a paused track reuses the link the player already has.
        if (!fresh && captures.get(id)) return grabResult(id, captures.get(id));
        return { error: loggedIn() ? 'timeout' : 'login' };
      } finally {
        capturing--;
        settleLater();
      }
    });
  }

  /** Scrolls a list page to its end so the site loads every entry. */
  async function loadAll({ expected = 0 } = {}) {
    const count = () => document.querySelectorAll(LIST_ITEM_SELECTOR).length;
    const startY = window.scrollY;
    let last = -1;
    let still = 0;
    for (let i = 0; i < 300 && still < 5; i++) {
      const n = count();
      if (expected && n >= expected) break;
      if (n === last) still++;
      else {
        still = 0;
        last = n;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(600);
    }
    window.scrollTo(0, startY);
    return count();
  }

  // ------------------------------------------------------------- resolving

  const USER_SUBPAGE = /^\/([^/]+)\/(tracks|popular-tracks)$/;

  function fullTrack(t) {
    return tracks.get(t.id) || t;
  }

  /** Tracks of the list currently shown on the page, in page order. */
  function listedTracks(filter) {
    const out = [];
    const seen = new Set();
    for (const item of document.querySelectorAll(LIST_ITEM_SELECTOR)) {
      const a = item.querySelector(TITLE_SELECTOR);
      const ref = a && byPath.get(pathOf(a.getAttribute('href')));
      if (ref?.kind !== 'track' || seen.has(ref.id)) continue;
      const t = tracks.get(ref.id);
      if (t && filter(t)) {
        seen.add(ref.id);
        out.push(t);
      }
    }
    return out;
  }

  function resolve({ url }) {
    harvestHydration();
    const path = pathOf(url);
    if (!path) return null;
    let ref = byPath.get(path);
    let userList = false;
    const sub = path.match(USER_SUBPAGE);
    if (!ref && sub) {
      ref = byPath.get(`/${sub[1]}`);
      userList = ref?.kind === 'user';
    }
    if (!ref) return null;
    if (ref.kind === 'track') return { kind: 'track', data: tracks.get(ref.id) };
    if (ref.kind === 'playlist' || ref.kind === 'system-playlist') {
      const pl = playlists.get(ref.id);
      return { kind: pl.kind, data: { ...pl, tracks: (pl.tracks || []).map(fullTrack) } };
    }
    if (ref.kind === 'user') {
      const user = users.get(ref.id);
      // Only the profile's own uploads, taken from the "Tracks" list when it is open.
      const onList = userList && pathOf(location.href) === path;
      return { kind: 'user', data: user, tracks: onList ? listedTracks((t) => t.user_id === user.id || t.user?.id === user.id) : null };
    }
    return null;
  }

  function ping() {
    harvestHydration();
    const h = Array.isArray(window.__sc_hydration) ? window.__sc_hydration : [];
    return { ready: document.readyState !== 'loading' && h.length > 0, path: pathOf(location.href), loggedIn: loggedIn() };
  }

  // -------------------------------------------------------------- messages

  const OPS = { ping, resolve, grab, loadAll };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.tag !== TAG_IN) return;
    let req;
    try {
      req = JSON.parse(e.data.payload);
    } catch {
      return;
    }
    let reply;
    try {
      const op = OPS[req.op];
      if (!op) throw new Error(`unknown op ${req.op}`);
      reply = { id: req.id, ok: true, result: (await op(req.args || {})) ?? null };
    } catch (err) {
      reply = { id: req.id, ok: false, error: err?.message || String(err) };
    }
    window.postMessage({ tag: TAG_OUT, payload: JSON.stringify(reply) }, location.origin);
  });

  document.addEventListener('DOMContentLoaded', harvestHydration, { once: true });
})();

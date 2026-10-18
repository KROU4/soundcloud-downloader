// Adds "Скачать" buttons on soundcloud.com: next to Like/Repost on track and
// playlist pages and in lists, in the header of system playlists (Discover, mixes)
// and in the bottom player bar. Also relays the engine's requests to page-hook.js,
// which watches and drives the site's player.
// Content scripts cannot be ES modules, so this file is self-contained.
(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const BTN = 'scdl-btn';
  const ICON_PATH = 'M7.25 1.5h1.5v7.19l2.47-2.47 1.06 1.06L8 11.56 3.72 7.28l1.06-1.06 2.47 2.47V1.5zM2.5 12.5h11V14h-11z';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ITEM_SELECTOR =
    '.trackList__item, .trackItem, .soundList__item, .searchList__item, .soundBadge, .sound, .compactTrackListItem, .systemPlaylistTrackList__item, .historicalPlays__item';
  const TITLE_SELECTOR = 'a.trackItem__trackTitle, a.soundTitle__title, a.soundBadge__title, a.compactTrackListItem__trackTitle, a[class*="TrackTitle"]';
  const PLAYER_ACTIONS = '.playbackSoundBadge__actions';
  const SYSTEM_PLAYLIST_CONTROLS = '.systemPlaylistDetails__controls';
  /** Track, playlist, album and system playlist pages (not feeds, search or settings). */
  const CONTENT_PAGE = /^\/(?!(?:you|search|charts|settings|stations|feed|upload|messages|notifications|pages)(?:\/|$))[^/]+\/[^/]+/;

  let jobs = [];

  // ------------------------------------------------------- page-hook bridge

  const TAG_IN = 'scdl:cs';
  const TAG_OUT = 'scdl:page';
  const pending = new Map();
  let reqSeq = 0;

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.tag !== TAG_OUT) return;
    let reply;
    try {
      reply = JSON.parse(e.data.payload);
    } catch {
      return;
    }
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error));
  });

  function pageCall(op, args, timeout) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}_${++reqSeq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Страница SoundCloud не ответила'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ tag: TAG_IN, payload: JSON.stringify({ id, op, args }) }, location.origin);
    });
  }

  const OP_TIMEOUT = { ping: 2000, resolve: 5000, grab: 30000, loadAll: 5 * 60 * 1000 };

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.to === 'ui' && msg.type === 'state') {
      jobs = msg.state.jobs;
      paint();
      return false;
    }
    if (msg?.to !== 'page') return false;
    pageCall(msg.op, msg.args, OP_TIMEOUT[msg.op] || 10000).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: e.message }),
    );
    return true;
  });

  // ---------------------------------------------------------------- buttons

  /** Same normalization as the engine's cleanUrl, so job URLs match button URLs. */
  function cleanUrl(href) {
    const u = new URL(href, location.origin);
    return `https://soundcloud.com${u.pathname.replace(/\/+$/, '')}`;
  }

  /** The URL a button belongs to, computed lazily because SoundCloud reuses DOM nodes. */
  function urlFor(btn) {
    const badge = btn.closest('.playControls');
    if (badge) {
      const link = document.querySelector('.playbackSoundBadge__titleLink');
      return link ? cleanUrl(link.getAttribute('href')) : null;
    }
    const item = btn.closest(ITEM_SELECTOR);
    if (item) {
      const link = item.querySelector(TITLE_SELECTOR);
      return link ? cleanUrl(link.getAttribute('href')) : null;
    }
    // Header of a track, playlist, album or system playlist page: the page itself.
    return CONTENT_PAGE.test(location.pathname) ? cleanUrl(location.href) : null;
  }

  function sizeClass(group) {
    const sample = group.querySelector('.sc-button');
    for (const c of ['sc-button-small', 'sc-button-medium', 'sc-button-large']) if (sample?.classList.contains(c)) return c;
    return 'sc-button-small';
  }

  function makeIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', ICON_PATH);
    svg.append(path);
    return svg;
  }

  function makeButton(size, extraClass = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sc-button-secondary sc-button ${size} sc-button-icon sc-button-responsive ${BTN} ${extraClass}`.trim();
    b.title = 'Скачать';
    b.setAttribute('aria-label', 'Скачать');
    const icon = document.createElement('span');
    icon.className = 'scdl-icon';
    icon.append(makeIcon());
    const label = document.createElement('span');
    label.className = 'sc-button-label scdl-label';
    label.textContent = 'Скачать';
    b.append(icon, label);
    b.addEventListener('click', onClick, true);
    return b;
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const url = urlFor(btn);
    if (!url) return toast('Не удалось определить, что скачивать', true);
    btn.dataset.state = 'busy';
    btn.style.setProperty('--scdl-p', '0%');
    try {
      const res = await ext.runtime.sendMessage({ to: 'engine', cmd: 'enqueue', url });
      if (!res?.ok) throw new Error(res?.error || 'нет ответа');
      toast('Добавлено в загрузки');
    } catch (err) {
      btn.dataset.state = 'error';
      btn.title = err.message;
      toast(`Ошибка: ${err.message}`, true);
    }
  }

  function scan() {
    // Like/Repost/Share groups: page headers and list items.
    for (const group of document.querySelectorAll('.soundActions .sc-button-group')) {
      if (group.querySelector(`.${BTN}`) || group.closest('.playControls')) continue;
      const probe = group.querySelector('.sc-button') || group;
      if (!urlFor(probe)) continue;
      const more = group.querySelector('.sc-button-more');
      group.insertBefore(makeButton(sizeClass(group)), more || null);
    }
    // System playlists (Discover, "Your Mix", charts) have their own header.
    for (const controls of document.querySelectorAll(SYSTEM_PLAYLIST_CONTROLS)) {
      if (controls.querySelector(`.${BTN}`)) continue;
      const wrap = document.createElement('div');
      wrap.className = 'systemPlaylistDetails__button';
      wrap.append(makeButton('sc-button-medium', 'scdl-btn-labeled'));
      // Before "More" if there is one, else right after the last button (the likes
      // counter that follows is pushed to the right edge).
      const buttons = controls.querySelectorAll(':scope > .systemPlaylistDetails__button');
      const more = controls.querySelector('.sc-button-more')?.closest('.systemPlaylistDetails__button');
      const after = buttons[buttons.length - 1];
      controls.insertBefore(wrap, more || after?.nextSibling || null);
    }
    // Bottom player: the rightmost button after Like, Follow and Next up.
    const actions = document.querySelector(PLAYER_ACTIONS);
    if (actions && !actions.querySelector(`.${BTN}`)) actions.append(makeButton('sc-button-small', 'scdl-btn-player'));
    paint();
  }

  /** Writing the same text still counts as a DOM mutation and would wake our observer. */
  function setLabel(label, text) {
    if (label && label.textContent !== text) label.textContent = text;
  }

  /** Reflects engine state on every visible button. */
  function paint() {
    for (const btn of document.querySelectorAll(`.${BTN}`)) {
      const url = urlFor(btn);
      const job = url && jobs.find((j) => j.url === url);
      const label = btn.querySelector('.scdl-label');
      if (btn.dataset.url !== url) {
        // The player bar button now belongs to another track: forget the old state.
        btn.dataset.url = url || '';
        if (!job) delete btn.dataset.state;
      }
      if (!job) {
        if (btn.dataset.state !== 'busy' && btn.dataset.state !== 'error') {
          delete btn.dataset.state;
          btn.title = 'Скачать';
          setLabel(label, 'Скачать');
        }
        continue;
      }
      const pct = Math.round(job.progress * 100);
      if (job.status === 'resolving' || job.status === 'queued' || job.status === 'downloading') {
        btn.dataset.state = 'busy';
        btn.style.setProperty('--scdl-p', `${pct}%`);
        const counts = job.counts.total > 1 ? ` (${job.counts.done}/${job.counts.total})` : '';
        btn.title = `Загрузка ${pct}%${counts}`;
        setLabel(label, `${pct}%${counts}`);
      } else if (job.status === 'done') {
        btn.dataset.state = 'done';
        btn.title = 'Скачано. Нажмите, чтобы скачать ещё раз';
        setLabel(label, 'Скачано');
      } else if (job.status === 'partial') {
        btn.dataset.state = 'error';
        btn.title = `Скачано ${job.counts.done} из ${job.counts.total}. Подробности в окне расширения`;
        setLabel(label, `${job.counts.done}/${job.counts.total}`);
      } else if (job.status === 'error') {
        btn.dataset.state = 'error';
        btn.title = job.error || 'Ошибка';
        setLabel(label, 'Ошибка');
      } else {
        delete btn.dataset.state;
        setLabel(label, 'Скачать');
      }
    }
  }

  let toastTimer;
  function toast(text, isError = false) {
    let el = document.getElementById('scdl-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scdl-toast';
      el.setAttribute('role', 'status');
      document.body.append(el);
    }
    el.textContent = text;
    el.dataset.error = String(isError);
    el.dataset.visible = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.dataset.visible = 'false'), isError ? 6000 : 2500);
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: false });
  scan();
})();

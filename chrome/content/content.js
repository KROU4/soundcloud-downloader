// Adds a "Скачать" button next to Like/Repost on soundcloud.com: track and playlist
// pages, stream/likes/search lists and the tracks inside a playlist.
// Content scripts cannot be ES modules, so this file is self-contained.
(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const BTN = 'scdl-btn';
  const ICON_PATH = 'M7.25 1.5h1.5v7.19l2.47-2.47 1.06 1.06L8 11.56 3.72 7.28l1.06-1.06 2.47 2.47V1.5zM2.5 12.5h11V14h-11z';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ITEM_SELECTOR =
    '.trackList__item, .trackItem, .soundList__item, .searchList__item, .soundBadge, .sound, .compactTrackListItem, .systemPlaylistTrackList__item, .historicalPlays__item';
  const TITLE_SELECTOR = 'a.trackItem__trackTitle, a.soundTitle__title, a.soundBadge__title, a.compactTrackListItem__trackTitle, a[class*="TrackTitle"]';

  let jobs = [];

  /** Same normalization as the engine's cleanUrl, so job URLs match button URLs. */
  function cleanUrl(href) {
    const u = new URL(href, location.origin);
    return `https://soundcloud.com${u.pathname.replace(/\/+$/, '')}`;
  }

  /** The URL a button group belongs to, computed lazily because SoundCloud reuses DOM nodes. */
  function urlFor(group) {
    const item = group.closest(ITEM_SELECTOR);
    const link = item?.querySelector(TITLE_SELECTOR);
    if (link) return cleanUrl(link.href);
    if (group.closest('.listenEngagement, .l-listen-hero, .fullHero, .l-about-top')) return cleanUrl(location.href);
    return null;
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

  function makeButton(group) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sc-button-secondary sc-button ${sizeClass(group)} sc-button-icon sc-button-responsive ${BTN}`;
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
    const url = urlFor(btn.parentElement);
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
    for (const group of document.querySelectorAll('.soundActions .sc-button-group')) {
      if (group.querySelector(`.${BTN}`) || !urlFor(group)) continue;
      const more = group.querySelector('.sc-button-more');
      group.insertBefore(makeButton(group), more || null);
    }
    paint();
  }

  /** Reflects engine state on every visible button. */
  function paint() {
    for (const btn of document.querySelectorAll(`.${BTN}`)) {
      const url = btn.parentElement && urlFor(btn.parentElement);
      const job = url && jobs.find((j) => j.url === url);
      const label = btn.querySelector('.scdl-label');
      if (!job) {
        if (btn.dataset.state !== 'busy' && btn.dataset.state !== 'error') {
          delete btn.dataset.state;
          btn.title = 'Скачать';
          if (label) label.textContent = 'Скачать';
        }
        continue;
      }
      const pct = Math.round(job.progress * 100);
      if (job.status === 'resolving' || job.status === 'queued' || job.status === 'downloading') {
        btn.dataset.state = 'busy';
        btn.style.setProperty('--scdl-p', `${pct}%`);
        const counts = job.counts.total > 1 ? ` (${job.counts.done}/${job.counts.total})` : '';
        btn.title = `Загрузка ${pct}%${counts}`;
        if (label) label.textContent = `${pct}%${counts}`;
      } else if (job.status === 'done') {
        btn.dataset.state = 'done';
        btn.title = 'Скачано. Нажмите, чтобы скачать ещё раз';
        if (label) label.textContent = 'Скачано';
      } else if (job.status === 'partial') {
        btn.dataset.state = 'error';
        btn.title = `Скачано ${job.counts.done} из ${job.counts.total}. Подробности в окне расширения`;
        if (label) label.textContent = `${job.counts.done}/${job.counts.total}`;
      } else if (job.status === 'error') {
        btn.dataset.state = 'error';
        btn.title = job.error || 'Ошибка';
        if (label) label.textContent = 'Ошибка';
      } else {
        delete btn.dataset.state;
        if (label) label.textContent = 'Скачать';
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

  ext.runtime.onMessage.addListener((msg) => {
    if (msg?.to === 'ui' && msg.type === 'state') {
      jobs = msg.state.jobs;
      paint();
    }
  });

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();

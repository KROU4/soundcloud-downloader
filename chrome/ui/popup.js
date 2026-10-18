import { call, ext } from '../lib/browser.js';
import { HOST_ORIGINS } from '../lib/hosts.js';

const $ = (id) => document.getElementById(id);
const KIND = { track: 'Трек', playlist: 'Плейлист', 'system-playlist': 'Подборка', user: 'Профиль: все треки' };
const openItems = new Set();

const engine = (cmd, extra = {}) => call({ to: 'engine', cmd, ...extra }, { retries: 5 });

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function jobStatusText(job) {
  const { total, done, failed } = job.counts;
  const pct = Math.round(job.progress * 100);
  const single = total <= 1;
  switch (job.status) {
    case 'resolving':
      return 'Получаю информацию…';
    case 'queued':
    case 'downloading':
      if (job.phase === 'zipping') return 'Упаковываю в ZIP…';
      return single ? `Загрузка ${pct}%` : `${done} из ${total} · ${pct}%`;
    case 'done':
      if (single) return `Готово · ${job.items[0]?.quality || ''}`;
      return `Готово: ${total} ${plural(total, 'трек', 'трека', 'треков')}${job.zip ? ' в ZIP' : ''}`;
    case 'partial':
      return `Скачано ${done} из ${total}, ошибок: ${failed}`;
    case 'error':
      return job.error || 'Ошибка';
    case 'cancelled':
      return 'Отменено';
    default:
      return job.status;
  }
}

function itemStateText(item) {
  if (item.status === 'done') return `✓ ${item.quality || ''}${item.warning ? ` · ${item.warning}` : ''}`;
  if (item.status === 'downloading') return `${Math.round((item.progress || 0) * 100)}%`;
  if (item.status === 'error') return item.error || 'ошибка';
  if (item.status === 'cancelled') return 'отменено';
  return 'в очереди';
}

// Job nodes are kept and patched in place: state arrives several times a second
// and rebuilding the list would swallow clicks and reset scrolling.
const jobNodes = new Map();

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function createJobNode(jobId) {
  const node = $('job-tpl').content.firstElementChild.cloneNode(true);
  node.querySelector('.act-cancel').onclick = () => engine('cancel', { jobId });
  node.querySelector('.act-retry').onclick = () => engine('retry', { jobId });
  node.querySelector('.act-remove').onclick = () => engine('remove', { jobId });
  const details = node.querySelector('.job-items');
  details.open = openItems.has(jobId);
  details.ontoggle = () => (details.open ? openItems.add(jobId) : openItems.delete(jobId));
  return node;
}

function updateItems(ol, items) {
  while (ol.children.length > items.length) ol.lastElementChild.remove();
  items.forEach((item, i) => {
    let li = ol.children[i];
    if (!li) {
      li = document.createElement('li');
      li.append(document.createTextNode(''), document.createElement('span'));
      ol.append(li);
    }
    const label = `${item.artist ? `${item.artist} — ` : ''}${item.title} `;
    if (li.firstChild.data !== label) li.firstChild.data = label;
    const state = li.lastChild;
    const cls = `item-state${item.status === 'done' ? ' done' : ''}${item.status === 'error' ? ' item-error' : ''}`;
    if (state.className !== cls) state.className = cls;
    setText(state, itemStateText(item));
  });
}

function updateJobNode(node, job) {
  node.dataset.status = job.status;
  const art = node.querySelector('.job-art');
  if (job.artwork && art.getAttribute('src') !== job.artwork) art.src = job.artwork;
  const title = node.querySelector('.job-title');
  setText(title, job.title);
  title.title = job.title;
  setText(node.querySelector('.job-status'), jobStatusText(job));
  const pct = job.status === 'done' ? 100 : Math.round(job.progress * 100);
  node.querySelector('.bar span').style.width = `${pct}%`;
  node.querySelector('.bar').setAttribute('aria-valuenow', String(pct));

  const active = ['resolving', 'queued', 'downloading'].includes(job.status);
  node.querySelector('.act-cancel').classList.toggle('hidden', !active);
  node.querySelector('.act-retry').classList.toggle('hidden', !['error', 'partial', 'cancelled'].includes(job.status));
  node.querySelector('.act-remove').classList.toggle('hidden', active);

  const showItems = job.items.length > 1 || job.items.some((i) => i.status === 'error' || i.warning);
  const details = node.querySelector('.job-items');
  details.classList.toggle('hidden', !showItems);
  if (showItems) {
    setText(details.querySelector('summary'), `Треки (${job.items.length})`);
    updateItems(details.querySelector('ol'), job.items);
  }
}

function render(state) {
  const list = $('job-list');
  $('empty').classList.toggle('hidden', state.jobs.length > 0);
  const seen = new Set();
  state.jobs.forEach((job, index) => {
    seen.add(job.id);
    let node = jobNodes.get(job.id);
    if (!node) {
      node = createJobNode(job.id);
      jobNodes.set(job.id, node);
    }
    updateJobNode(node, job);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  for (const [id, node] of jobNodes) {
    if (seen.has(id)) continue;
    node.remove();
    jobNodes.delete(id);
  }
}

async function showCurrent(url) {
  const box = $('current');
  try {
    const info = await engine('inspect', { url });
    box.classList.remove('hidden');
    if (info.artwork) $('cur-art').src = info.artwork;
    $('cur-kind').textContent = (info.isAlbum ? 'Альбом' : KIND[info.kind]) || info.kind;
    $('cur-title').textContent = info.title || url;
    const meta = [];
    if (info.artist && info.kind !== 'user') meta.push(info.artist);
    if (info.kind !== 'track' && info.count) meta.push(`${info.count} ${plural(info.count, 'трек', 'трека', 'треков')}`);
    if (info.kind === 'track') {
      if (info.original && info.loggedIn) meta.push('Оригинальный файл');
      else if (info.quality) meta.push(info.quality);
    }
    $('cur-meta').textContent = meta.join(' · ');
    if (info.problem) {
      $('cur-problem').textContent = `${info.problem}. Потоки: ${info.streams}${info.loggedIn ? '' : ' · вход не найден'}`;
      $('cur-problem').classList.remove('hidden');
    }
    const btn = $('cur-download');
    btn.disabled = !!info.problem;
    btn.textContent = info.kind === 'track' ? 'Скачать трек' : info.kind === 'user' ? 'Скачать все треки' : `Скачать ${info.isAlbum ? 'альбом' : 'плейлист'}`;
    btn.onclick = async () => {
      btn.disabled = true;
      await engine('enqueue', { url });
      btn.disabled = false;
    };
  } catch {
    box.classList.add('hidden'); // not a downloadable page (feed, search, settings…)
  }
}

async function init() {
  $('open-options').onclick = () => ext.runtime.openOptionsPage();

  if (!(await ext.permissions.contains({ origins: HOST_ORIGINS }))) {
    $('permission').classList.remove('hidden');
    $('grant').onclick = async () => {
      if (await ext.permissions.request({ origins: HOST_ORIGINS })) location.reload();
    };
    return;
  }

  ext.runtime.onMessage.addListener((msg) => {
    if (msg?.to === 'ui' && msg.type === 'state') render(msg.state);
  });

  $('url-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('url');
    try {
      await engine('enqueue', { url: input.value });
      input.value = '';
    } catch (err) {
      input.setCustomValidity(err.message);
      input.reportValidity();
      setTimeout(() => input.setCustomValidity(''), 3000);
    }
  };
  $('clear').onclick = () => engine('clear');

  const cookie = await ext.cookies.get({ url: 'https://soundcloud.com/', name: 'oauth_token' }).catch(() => null);
  $('login-hint').classList.toggle('hidden', !!cookie?.value);

  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https:\/\/(m\.|www\.|on\.)?soundcloud\.com\/[^/?#]+/.test(tab.url)) showCurrent(tab.url);

  render(await engine('state'));
}

init().catch((e) => {
  $('empty').textContent = `Ошибка: ${e.message}`;
});

// Generates store listing images into store/: screenshots 1280x800 (Chrome Web Store,
// Edge, AMO), the 440x280 promo tile and the 1400x560 marquee.
// Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium):
//   node tools/store-assets.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'chrome');
const out = path.join(root, 'store');
const PLAYLIST = 'https://soundcloud.com/buzzing-playlists/sets/buzzing-electronic';

function loadPlaywright() {
  const candidates = [path.join(root, 'x.js'), path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'x.js'), '/usr/lib/node_modules/x.js'];
  for (const c of candidates) {
    try {
      return createRequire(c)('playwright');
    } catch {
      // next
    }
  }
  throw new Error('Playwright not found: npm i -g playwright && npx playwright install chromium');
}

const { chromium } = loadPlaywright();
const icon = `data:image/png;base64,${fs.readFileSync(path.join(ext, 'icons/icon-128.png')).toString('base64')}`;
fs.mkdirSync(out, { recursive: true });

const frame = (img, title, subtitle) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:'Segoe UI',Roboto,Arial,sans-serif}
  body{background:linear-gradient(135deg,#ff7a1a 0%,#ff5500 45%,#d93d00 100%);display:flex;align-items:center;gap:56px;padding:0 80px;box-sizing:border-box;color:#fff}
  .text{flex:1}.text img{width:72px;height:72px;margin-bottom:28px}
  h1{font-size:46px;line-height:1.15;margin:0 0 20px;font-weight:700}
  p{font-size:23px;line-height:1.45;margin:0;opacity:.95}
  .shot{flex:none;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.35);background:#fff}
  .shot img{display:block}
</style></head><body><div class="text"><img src="${icon}" alt=""><h1>${title}</h1><p>${subtitle}</p></div><div class="shot">${img}</div></body></html>`;

const tile = (w, h, big) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:'Segoe UI',Roboto,Arial,sans-serif}
  body{background:linear-gradient(135deg,#ff7a1a,#ff5500 50%,#d93d00);display:flex;align-items:center;justify-content:center;gap:${big ? 48 : 22}px;color:#fff}
  img{width:${big ? 200 : 96}px;height:${big ? 200 : 96}px}
  h1{font-size:${big ? 64 : 30}px;margin:0 0 ${big ? 14 : 8}px;font-weight:700;line-height:1.1}
  p{font-size:${big ? 30 : 16}px;margin:0;opacity:.95;max-width:${big ? 760 : 250}px;line-height:1.3}
</style></head><body><img src="${icon}" alt=""><div><h1>SoundCloud Downloader</h1><p>Треки, альбомы и плейлисты — в лучшем качестве, с обложкой и тегами</p></div></body></html>`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scdl-store-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  // 1. The button on a playlist page.
  const page = await ctx.newPage();
  await page.goto(PLAYLIST, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const reject = page.getByRole('button', { name: /reject all/i }).first();
  if (await reject.isVisible().catch(() => false)) await reject.click();
  await page.waitForSelector('.l-about-top .scdl-btn, .listenEngagement .scdl-btn', { timeout: 20000 });
  // Sign-in dialogs, cookie and promo banners would hide the page: drop every overlay
  // except the site header and the bottom player, and mark our button.
  const clean = () =>
    page.evaluate(() => {
      const keep = (el) => el.closest('header, .header, .playControls');
      for (const el of document.querySelectorAll('body *')) {
        if (keep(el)) continue;
        const style = getComputedStyle(el);
        if (style.position === 'fixed' || el.matches('.modal, .auth-modal, #onetrust-consent-sdk')) el.style.setProperty('display', 'none', 'important');
      }
      for (const el of document.querySelectorAll('div, section')) {
        if (el.children.length < 6 && /Now available/i.test(el.textContent || '') && el.getBoundingClientRect().height < 120) {
          el.style.setProperty('display', 'none', 'important');
        }
      }
      document.body.style.overflow = 'auto';
      const btn = document.querySelector('.l-about-top .scdl-btn, .listenEngagement .scdl-btn');
      btn.style.setProperty('box-shadow', '0 0 0 3px #ff5500, 0 0 24px rgba(255,85,0,.8)', 'important');
      window.scrollTo(0, 0);
    });
  await clean();
  await page.waitForTimeout(800);
  const pageShot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 800 } });
  fs.writeFileSync(path.join(out, 'screenshot-1-page.png'), pageShot);

  // 2. Download the playlist and show the popup with the result.
  // A real click: the extension ignores synthetic ones.
  await page.locator('.l-about-top .scdl-btn, .listenEngagement .scdl-btn').first().click();
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 400, height: 560 });
  await popup.goto(`chrome-extension://${extId}/ui/popup.html`);
  for (let i = 0; i < 240; i++) {
    await popup.waitForTimeout(1000);
    const state = await popup.evaluate(() => chrome.runtime.sendMessage({ to: 'engine', cmd: 'state' }));
    const job = state?.result?.jobs?.[0];
    if (job && !['resolving', 'queued', 'downloading'].includes(job.status)) break;
  }
  await page.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(1500);
  await popup.evaluate(() => document.querySelector('.job-items')?.setAttribute('open', ''));
  await popup.waitForTimeout(300);
  const popupShot = (await popup.screenshot({ type: 'png' })).toString('base64');

  // 3. Settings.
  const options = await ctx.newPage();
  await options.setViewportSize({ width: 760, height: 640 });
  await options.goto(`chrome-extension://${extId}/ui/options.html`);
  await options.waitForTimeout(800);
  const optionsShot = (await options.screenshot({ type: 'png' })).toString('base64');

  const render = async (html, file, w = 1280, h = 800) => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(html, { waitUntil: 'load' });
    await p.screenshot({ path: path.join(out, file), type: 'png' });
    await p.close();
  };
  await render(
    frame(`<img src="data:image/png;base64,${popupShot}" width="400" height="560">`, 'Плейлист целиком — одним ZIP', 'Лучшее качество через API SoundCloud, обложка, теги и текст песни. Треки, которые API отдаёт превью, — через плеер сайта.'),
    'screenshot-2-popup.png',
  );
  await render(
    frame(`<img src="data:image/png;base64,${optionsShot}" width="560" height="472" style="width:560px;height:auto">`, 'Всё настраивается', 'Шаблоны имён файлов, папка, оригинальный файл автора, кодек, обложка, ZIP и плейлист .m3u8.'),
    'screenshot-3-options.png',
  );
  await render(tile(440, 280, false), 'promo-small-440x280.png', 440, 280);
  await render(tile(1400, 560, true), 'promo-marquee-1400x560.png', 1400, 560);
  fs.copyFileSync(path.join(ext, 'icons/icon-128.png'), path.join(out, 'icon-128.png'));
  console.log(fs.readdirSync(out).join('\n'));
} finally {
  await ctx.close();
}

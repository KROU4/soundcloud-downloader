// Live smoke test of the API path: runs the real engine in Node against SoundCloud
// and saves the results to smoke-out/. No browser, no login (anonymous API).
//   node tools/smoke.mjs [url ...]
// Exits non-zero if any job does not finish completely.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../chrome/engine/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'smoke-out');
const urls = process.argv.slice(2);
if (!urls.length) urls.push('https://soundcloud.com/macewfr/lady-gaga-love-game-macew-chaps-rolling-edit-2');

const cache = new Map();
const engine = new Engine({
  getSettings: async () => ({ baseFolder: '' }),
  getToken: async () => null,
  cacheGet: async (k) => cache.get(k),
  cacheSet: async (k, v) => void cache.set(k, v),
  broadcast: () => {},
  keepAlive: () => {},
  async saveFile(bytes, filename) {
    const target = path.join(out, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.concat((Array.isArray(bytes) ? bytes : [bytes]).map((b) => Buffer.from(b))));
    return target;
  },
  // No browser here: a track that needs the site's player fails with this message.
  pickTab: async () => {
    throw new Error('нет браузера (smoke-тест проверяет только путь через API)');
  },
});

let failed = false;
for (const url of urls) {
  const { jobId } = await engine.handle({ cmd: 'enqueue', url });
  const job = engine.jobs.find((j) => j.id === jobId);
  await job.runPromise;
  console.log(`\n${job.status.toUpperCase()}  ${job.title}  [${job.kind}, источник: ${job.source}]`);
  if (job.error) console.log(`  ошибка: ${job.error}`);
  for (const item of job.items) {
    console.log(`  ${item.status === 'done' ? '✓' : '✗'} ${item.artist} — ${item.title}  ${item.quality || ''}  ${item.file || item.error || ''}`);
  }
  for (const zip of job.archives || []) console.log(`  ZIP: ${zip}`);
  if (job.status !== 'done') failed = true;
}
process.exit(failed ? 1 : 0);

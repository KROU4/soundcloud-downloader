// Syncs the shared sources from chrome/ into firefox/ and packs both into zips.
//   node tools/build.mjs           sync + pack
//   node tools/build.mjs --check   fail if firefox/ differs from chrome/ (no writes)
// chrome/ is the source of truth; only the manifests and the Chromium offscreen
// host (engine/host.*) differ between the two builds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = path.join(root, 'chrome');
const FIREFOX = path.join(root, 'firefox');
const CHROME_ONLY = new Set(['manifest.json', 'engine/host.html', 'engine/host.js']);
const FIREFOX_ONLY = new Set(['manifest.json']);
const check = process.argv.includes('--check');

function list(dir, base = dir) {
  // Dot entries are tool caches (.ruff_cache…), never part of the extension.
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? list(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

const shared = list(CHROME).filter((f) => !CHROME_ONLY.has(f));
const stale = list(FIREFOX).filter((f) => !FIREFOX_ONLY.has(f) && !shared.includes(f));
const differs = shared.filter((f) => {
  const target = path.join(FIREFOX, f);
  return !fs.existsSync(target) || !fs.readFileSync(target).equals(fs.readFileSync(path.join(CHROME, f)));
});

if (check) {
  if (differs.length || stale.length) {
    console.error(`firefox/ is out of sync:\n${[...differs, ...stale.map((f) => `${f} (only in firefox)`)].join('\n')}`);
    process.exit(1);
  }
  console.log('firefox/ is in sync');
  process.exit(0);
}

for (const f of differs) {
  fs.mkdirSync(path.dirname(path.join(FIREFOX, f)), { recursive: true });
  fs.copyFileSync(path.join(CHROME, f), path.join(FIREFOX, f));
}
for (const f of stale) fs.rmSync(path.join(FIREFOX, f));
console.log(`synced ${differs.length} file(s), removed ${stale.length}`);

const { buildZip } = await import(pathToFileURL(path.join(CHROME, 'lib/zip.js')).href);
for (const [name, dir] of [['chrome', CHROME], ['firefox', FIREFOX]]) {
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const entries = list(dir)
    .sort()
    .map((f) => ({ name: f, data: new Uint8Array(fs.readFileSync(path.join(dir, f))) }));
  const out = path.join(root, `soundcloud-downloader-${name}-${version}.zip`);
  // A fixed date keeps the archives reproducible.
  fs.writeFileSync(out, Buffer.concat(buildZip(entries, new Date(2026, 0, 1)).map((c) => Buffer.from(c))));
  console.log(`${path.basename(out)}: ${entries.length} files`);
}

// Syncs the shared sources from chrome/ into firefox/ and packs both into dist/.
//   node tools/build.mjs                        sync + pack
//   node tools/build.mjs --check                fail if firefox/ differs from chrome/ or versions disagree (no writes)
//   node tools/build.mjs --check --version 1.2.0   …and require this version (release tags)
// chrome/ is the source of truth; only the manifests and the Chromium offscreen
// host (engine/host.*) differ between the two builds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = path.join(root, 'chrome');
const FIREFOX = path.join(root, 'firefox');
const DIST = path.join(root, 'dist');
const CHROME_ONLY = new Set(['manifest.json', 'engine/host.html', 'engine/host.js']);
const FIREFOX_ONLY = new Set(['manifest.json']);
const args = process.argv.slice(2);
const check = args.includes('--check');
const expected = args.includes('--version') ? args[args.indexOf('--version') + 1]?.replace(/^v/, '') : null;

function list(dir, base = dir) {
  // Dot entries are tool caches (.ruff_cache…), never part of the extension.
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? list(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const versions = {
  'chrome/manifest.json': readJson(path.join(CHROME, 'manifest.json')).version,
  'firefox/manifest.json': readJson(path.join(FIREFOX, 'manifest.json')).version,
  'package.json': readJson(path.join(root, 'package.json')).version,
};
const problems = [];
const distinct = [...new Set(Object.values(versions))];
if (distinct.length > 1) problems.push(`versions disagree: ${JSON.stringify(versions)}`);
if (expected && distinct[0] !== expected) problems.push(`version ${distinct[0]} does not match the expected ${expected}`);

const shared = list(CHROME).filter((f) => !CHROME_ONLY.has(f));
const stale = list(FIREFOX).filter((f) => !FIREFOX_ONLY.has(f) && !shared.includes(f));
const differs = shared.filter((f) => {
  const target = path.join(FIREFOX, f);
  return !fs.existsSync(target) || !fs.readFileSync(target).equals(fs.readFileSync(path.join(CHROME, f)));
});

if (check) {
  if (differs.length || stale.length) {
    problems.push(`firefox/ is out of sync (run node tools/build.mjs):\n${[...differs, ...stale.map((f) => `${f} (only in firefox)`)].join('\n')}`);
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`ok: firefox/ in sync, version ${distinct[0]}`);
  process.exit(0);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

for (const f of differs) {
  fs.mkdirSync(path.dirname(path.join(FIREFOX, f)), { recursive: true });
  fs.copyFileSync(path.join(CHROME, f), path.join(FIREFOX, f));
}
for (const f of stale) fs.rmSync(path.join(FIREFOX, f));
console.log(`synced ${differs.length} file(s), removed ${stale.length}`);

const { buildZip } = await import(pathToFileURL(path.join(CHROME, 'lib/zip.js')).href);
fs.mkdirSync(DIST, { recursive: true });
for (const [name, dir] of [['chrome', CHROME], ['firefox', FIREFOX]]) {
  const entries = list(dir)
    .sort()
    .map((f) => ({ name: f, data: new Uint8Array(fs.readFileSync(path.join(dir, f))) }));
  const out = path.join(DIST, `soundcloud-downloader-${name}-${distinct[0]}.zip`);
  // A fixed date keeps the archives reproducible.
  fs.writeFileSync(out, Buffer.concat(buildZip(entries, new Date(2026, 0, 1)).map((c) => Buffer.from(c))));
  console.log(`dist/${path.basename(out)}: ${entries.length} files`);
}

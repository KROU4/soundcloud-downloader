// Prints the CHANGELOG.md section of one version (release notes).
//   node tools/changelog.mjs v1.2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] || '').replace(/^v/, '');
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (!version || start < 0) {
  console.error(`CHANGELOG.md has no section for ${version || '(no version given)'}`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
console.log(
  lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim(),
);

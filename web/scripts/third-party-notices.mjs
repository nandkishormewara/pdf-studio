// Writes THIRD-PARTY-NOTICES.txt: name, version, licence and the full licence (and NOTICE) text of every
// package that ends up in the production bundle (the "dependencies" tree, not devDependencies).
// MIT, Apache-2.0 and similar licences require this text to ship with the code.
//
//   node scripts/third-party-notices.mjs                      → public/THIRD-PARTY-NOTICES.txt (copied into dist by Vite)
//   node scripts/third-party-notices.mjs <project dir> <out>   → for another npm project
//
// Fails if a package has no recognisable licence, or a licence outside ALLOWED (so nothing slips in unnoticed).
// The project's own workspace packages (not under node_modules) are skipped. A package that declares MIT or
// Apache-2.0 but ships no licence file gets the standard text (MIT with its author as the copyright holder).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(process.argv[2] ?? path.join(here, '..'));
const out = path.resolve(process.argv[3] ?? path.join(project, 'public', 'THIRD-PARTY-NOTICES.txt'));
const ALLOWED = /^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|Zlib|MIT-0|BlueOak-1\.0\.0|Unlicense|CC0-1\.0|Python-2\.0|\(MIT AND Zlib\)|\(MIT OR Apache-2\.0\)|\(Apache-2\.0 OR MIT\)|OFL-1\.1|MIT AND OFL-1\.1)$/;
const LICENSE_FILE = /^(licen[cs]e|copying)(_font)?(\.(md|txt))?$/i; // LICENSE_FONT: a font's OFL next to its code's licence
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;

// Packages whose package.json has no licence field, checked by hand. Add one only after reading the package's own licence.
const DECLARED_ELSEWHERE = {
  'combine-errors': 'MIT', // "License: MIT" in its Readme.md (checked 27 Oct 2026; used by tus-js-client)
};

const APACHE = path.join(here, '..', '..', 'Documents', 'tools', 'licenses', 'Apache-2.0.txt');
const authorOf = (pkg) => (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name) || `the ${pkg.name} authors`;
function standardText(license, pkg) {
  if (license === 'Apache-2.0' && fs.existsSync(APACHE)) return fs.readFileSync(APACHE, 'utf8').trim();
  if (license === 'ISC')
    return `ISC License\n\nCopyright (c) ${authorOf(pkg)}\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
  if (license === 'MIT')
    return `MIT License\n\nCopyright (c) ${authorOf(pkg)}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
  return null;
}

const seen = new Map();
function walk(name, from) {
  let dir;
  try {
    dir = path.dirname(createRequire(path.join(from, 'noop.js')).resolve(`${name}/package.json`));
  } catch {
    // Packages whose "exports" hide package.json (harfbuzzjs): look for the folder on the usual module paths.
    dir = createRequire(path.join(from, 'noop.js')).resolve.paths(name)?.map((p) => path.join(p, name)).find((d) => fs.existsSync(path.join(d, 'package.json')));
    if (!dir) return; // optional dependency not installed on this platform
  }
  if (seen.has(dir)) return;
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = fs.readdirSync(dir);
  const read = (re) => files.filter((f) => re.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
  const license = (typeof pkg.license === 'string' ? pkg.license : (pkg.licenses ?? []).map((l) => l.type ?? l).join(' OR ')) || DECLARED_ELSEWHERE[pkg.name] || '';
  const own = !dir.split(path.sep).includes('node_modules'); // a workspace package: the project's own code
  let texts = read(LICENSE_FILE);
  let note = '';
  if (!own && !texts.length) {
    const standard = standardText(license, pkg);
    if (standard) { texts = [standard]; note = '(no licence file in the package; standard text for its declared licence)'; }
  }
  seen.set(dir, { own, name: pkg.name, version: pkg.version, license, note, homepage: pkg.homepage ?? pkg.repository?.url ?? pkg.repository ?? '', texts, notices: read(NOTICE_FILE) });
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir);
}

const root = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
for (const dep of Object.keys(root.dependencies ?? {})) walk(dep, project);

const list = [...seen.values()].filter((p) => !p.own).sort((a, b) => a.name.localeCompare(b.name));
const problems = list.filter((p) => !ALLOWED.test(p.license) || !p.texts.length);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p.name}@${p.version}: licence "${p.license}"${p.texts.length ? '' : ', no licence file'}`);
  console.error('Review these packages (and extend ALLOWED only after checking the licence) before shipping.');
  process.exit(1);
}

const line = '='.repeat(78);
const parts = [
  `THIRD-PARTY SOFTWARE NOTICES for ${root.name ?? path.basename(project)}`,
  '',
  'This product includes the open-source software listed below. Each component is used under its own',
  'licence, reproduced in full. Generated by scripts/third-party-notices.mjs; do not edit by hand.',
  '',
  ...list.map((p) => `  ${p.name} ${p.version}  (${p.license})`),
  '',
];
for (const p of list) {
  parts.push(line, `${p.name} ${p.version}`, `Licence: ${p.license}` + (p.note ? ` ${p.note}` : ''));
  if (p.homepage) parts.push(`Source: ${String(p.homepage).replace(/^git\+/, '')}`);
  parts.push('', ...p.texts.map((t) => `${t}\n`));
  if (p.notices.length) parts.push('NOTICE:', ...p.notices.map((t) => `${t}\n`));
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, parts.join('\n') + '\n');
console.log(`${list.length} packages → ${path.relative(process.cwd(), out)}`);

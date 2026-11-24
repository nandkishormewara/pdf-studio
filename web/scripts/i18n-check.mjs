// Lists every translatable string in src/ and reports what each dictionary is missing.
//   node scripts/i18n-check.mjs            → summary
//   node scripts/i18n-check.mjs --keys     → print all keys as JSON (for translators)
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { if (f !== 'i18n') walk(p); } else if (/\.tsx?$/.test(f)) files.push(p);
  }
})(root);

const keys = new Set();
const strings = (n) => {
  if (ts.isStringLiteralLike(n)) keys.add(n.text);
  else if (ts.isConditionalExpression(n)) { strings(n.whenTrue); strings(n.whenFalse); }
  else if (ts.isParenthesizedExpression(n)) strings(n.expression);
};
for (const file of files) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 't' && n.arguments[0]) strings(n.arguments[0]);
    // Labels passed to t() through a variable: tool names and annotation-type names.
    if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.initializer)) {
      const name = n.name.getText(sf);
      const parent = n.parent?.parent?.parent;
      const owner = parent && ts.isVariableDeclaration(parent) ? parent.name.getText(sf) : '';
      if ((name === 'label' && /TOOLS/.test(owner)) || /LABELS/.test(n.parent?.parent?.getText(sf).slice(0, 0) + owner)) keys.add(n.initializer.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
// LABELS object values (components/labels.ts)
const cp = fs.readFileSync(path.join(root, 'components/labels.ts'), 'utf8');
for (const m of cp.matchAll(/^\s*(?:\w+: '[^']*',?\s*)+$/gm)) for (const v of m[0].matchAll(/: '([^']*)'/g)) keys.add(v[1]);

const all = [...keys].sort();
if (process.argv.includes('--keys')) { console.log(JSON.stringify(all, null, 2)); process.exit(0); }
let missingTotal = 0;
for (const code of ['hi', 'ar', 'ms']) {
  const src = fs.readFileSync(path.join(root, 'i18n', `${code}.ts`), 'utf8');
  const have = new Set([...src.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1].replace(/\\(.)/g, '$1')));
  const missing = all.filter((k) => !have.has(k));
  const unused = [...have].filter((k) => !keys.has(k));
  missingTotal += missing.length;
  console.log(`${code}: ${all.length - missing.length}/${all.length} translated` + (unused.length ? `, ${unused.length} unused` : ''));
  if (process.argv.includes('--missing')) missing.forEach((k) => console.log('   - ' + k));
}
process.exit(missingTotal && process.argv.includes('--strict') ? 1 : 0);

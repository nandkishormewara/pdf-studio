// Opt-in check of stored PDFTron markup: every XFDF under LEGACY_DIR through the web reader, one JSON line per file
// into LEGACY_OUT (appended; LEGACY_START / LEGACY_COUNT select a slice, because jsdom keeps memory between files).
// Android (LegacyXfdfCheckTest) and iOS (LegacyXfdfCheckTests) write the same; scripts/compare_legacy_xfdf.py
// compares the three. Skipped unless LEGACY_DIR and LEGACY_OUT are set. See docs/migrating-from-pdftron.md.
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import { importXfdf } from '../src/xfdfCompat';
import type { ViewportLike } from '../src/xfdfCompat';

const dir = process.env.LEGACY_DIR, out = process.env.LEGACY_OUT;
const vp = { convertToPdfPoint: (x: number, y: number) => [x, 792 - y], convertToViewportPoint: (x: number, y: number) => [x, 792 - y] } as ViewportLike;
const vps = Array.from({ length: 400 }, () => vp);
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.xfdf') ? [p] : []; });

it.runIf(dir && out)('reads every legacy XFDF', () => {
  const fd = openSync(out!, 'a');
  const w = { write: (s: string) => writeSync(fd, s), end: () => closeSync(fd) };
  const start = Number(process.env.LEGACY_START ?? 0), count = Number(process.env.LEGACY_COUNT ?? 1e9);
  const files = walk(dir!).sort().slice(start, start + count);
  for (const f of files) {
    const rel = path.relative(dir!, f);
    try {
      const imp = importXfdf(readFileSync(f, 'utf8'), vps);
      w.write(JSON.stringify({ file: rel, partial: !!imp.partial, annotations: imp.annotations }) + '\n');
    } catch (e) {
      w.write(JSON.stringify({ file: rel, error: String(e instanceof Error ? e.message : e) }) + '\n');
    }
  }
  w.end();
  console.log(`web: ${files.length} files`);
}, 3_600_000);

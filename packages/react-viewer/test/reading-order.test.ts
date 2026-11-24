import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRtl, readingOrder, splitAtGaps } from '../../../web/src/sdk/readingOrder';
import type { OrderLine, TableLike } from '../../../web/src/sdk/readingOrder';

// Same cases as the server, Android and iOS tests: all four must produce the same order.
const { cases } = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../mobile/shared/reading-order/cases.json'), 'utf8')) as {
  cases: { name: string; lines: OrderLine[]; tables: TableLike[]; expected: string[] }[];
};
const byName = (n: string) => cases.find((c) => c.name === n)!;

describe('reading order', () => {
  for (const c of cases)
    it(`matches the shared case "${c.name}"`, () => {
      expect(readingOrder(c.lines, { tables: c.tables }).map((l) => l.text)).toEqual(c.expected);
    });

  it('reads a newsletter drawn in the wrong order in numbered order', () => {
    const out = readingOrder(byName('newsletter').lines, { tables: byName('newsletter').tables }).map((l) => l.text);
    const numbers = out.map((t) => t.match(/^(\d\d) /)?.[1]).filter(Boolean);
    expect(numbers).toEqual(Array.from({ length: 16 }, (_, i) => String(i + 1).padStart(2, '0')));
    expect(out).toContain('User1\t88\t91\t79');
  });

  it('splits a line drawn across a column gap, keeping word order', () => {
    const line = byName('newsletter').lines.find((l) => l.text.startsWith('02 '))!;
    expect(splitAtGaps(line).map((l) => l.text)).toEqual(['02 Admissions open in May for', '05 Sports day is on the second']);
  });

  it('reads a ruled table as its grid, merged cells in their first row', () => {
    const c = byName('tables');
    expect(readingOrder(c.lines, { tables: c.tables }).slice(1, 3).map((l) => l.text)).toEqual(['Class\tFees (INR)', '\tTerm 1\tTerm 2']);
  });

  it('reads right-to-left pages from the right column', () => {
    expect(isRtl(byName('rtl-two-columns').lines)).toBe(true);
    expect(isRtl(byName('newsletter').lines)).toBe(false);
  });

  it('copes with nothing', () => {
    expect(readingOrder([])).toEqual([]);
  });
});

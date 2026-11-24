import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectTables, tableToGrid } from '../../../web/src/sdk/tables';
import type { Segment, Table, TableWord } from '../../../web/src/sdk/tables';
import { tableToCsv, tablesToXlsx } from '../../../web/src/sdk/extract';

// Same input and expected tables as the server's tests (server/app/tables.py): the two must stay in step.
const fixture = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../mobile/shared/tables/tables-page.json'), 'utf8')) as {
  page: number;
  words: TableWord[];
  segments: number[][];
  expected: Pick<Table, 'method' | 'rows' | 'cols' | 'cells'>[];
};
const segments: Segment[] = fixture.segments.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));
const strip = (t: Table) => ({ method: t.method, rows: t.rows, cols: t.cols, cells: t.cells.map(({ box: _b, ...c }) => c) });

describe('table detection', () => {
  const tables = detectTables(fixture.page, fixture.words, segments);

  it('finds the same tables as the server', () => {
    expect(tables.map(strip)).toEqual(fixture.expected);
  });

  it('keeps merged cells of a ruled table', () => {
    expect(tableToGrid(tables[0]).slice(0, 2)).toEqual([['Class', 'Fees (INR)', ''], ['', 'Term 1', 'Term 2']]);
    expect(tables[0].cells.filter((c) => c.rowSpan > 1 || c.colSpan > 1).map((c) => [c.row, c.col, c.rowSpan, c.colSpan])).toEqual([[0, 0, 2, 1], [0, 1, 1, 2]]);
  });

  it('reads borders drawn as thin filled boxes and tables without borders', () => {
    expect(tables.map((t) => t.method)).toEqual(['lattice', 'lattice', 'stream']);
    expect(tableToGrid(tables[1])).toEqual([['Item', 'Qty'], ['Pens', '4'], ['Notebooks', '6']]);
    expect(tableToGrid(tables[2])[2]).toEqual(['User Two', '102', '76', '84']);
  });

  it('does not take two columns of running text, or an empty grid, for a table', () => {
    expect(tables).toHaveLength(3);
    const box = (x: number, y: number, w: number, h: number): Segment[] => [
      { x1: x, y1: y, x2: x + w, y2: y }, { x1: x, y1: y + h, x2: x + w, y2: y + h },
      { x1: x, y1: y, x2: x, y2: y + h }, { x1: x + w, y1: y, x2: x + w, y2: y + h }, { x1: x + w / 2, y1: y, x2: x + w / 2, y2: y + h },
    ];
    expect(detectTables(0, [], box(50, 50, 200, 40))).toEqual([]);
  });

  it('writes CSV that Excel cannot run as a formula, and an xlsx with merged cells', () => {
    const t: Table = {
      page: 0, method: 'lattice', box: { x: 0, y: 0, w: 10, h: 10 }, rows: 1, cols: 2,
      cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, text: '=1+1', box: { x: 0, y: 0, w: 5, h: 10 } },
        { row: 0, col: 1, rowSpan: 1, colSpan: 1, text: 'a, "b"', box: { x: 5, y: 0, w: 5, h: 10 } }],
    };
    expect(tableToCsv(t)).toBe('﻿\'=1+1,"a, ""b"""\r\n');
    const xml = new TextDecoder().decode(tablesToXlsx(tables));
    expect(xml).toContain('<sheet name="Page 1 table 1" sheetId="1"');
    expect(xml).toContain('<mergeCell ref="A1:A2"/><mergeCell ref="B1:C1"/>');
    expect(xml).toContain('<t xml:space="preserve">Fees (INR)</t>');
  });
});

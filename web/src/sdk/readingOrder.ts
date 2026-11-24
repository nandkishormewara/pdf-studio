/**
 * Reading order: puts a page's text lines in the order a person reads them (title, then each column top to
 * bottom, then what comes after), instead of the order the file happens to draw them.
 *
 * 1. Lines are split where a gap is wider than a column gap, because some files draw a line of the left
 *    column and a line of the right column as one line, and where a word starts a new row (PDFKit on iOS
 *    hands back several rows of a column as one line).
 * 2. A band of empty space across the whole page taller than SECTION_GAP lines ends a section; sections are
 *    read top to bottom (so a heading under the first of three columns waits for all three).
 * 3. Within a section, pieces are ordered with Breuel's two rules ("High performance document layout analysis", 2003):
 *    a comes before b when (1) they overlap horizontally and a is higher, or (2) a is entirely left of b and
 *    no piece between them vertically crosses the gap between them. A topological sort (higher, then
 *    further left, first among those free to go) gives the order. Right-to-left pages mirror rule 2.
 * 4. Lines inside a table (from table detection) stay together and are read row by row, each row as one
 *    line with its cells separated by tabs, as the table's grid has them (a merged cell in its first row and
 *    column, empty cells as empty strings).
 *
 * Pure geometry, no pdf.js. The server (`server/app/reading_order.py`), Android (`ReadingOrder.kt`) and iOS
 * (`ReadingOrder.swift`) implement the same steps; `mobile/shared/reading-order/` keeps them in step.
 */
import type { Rect } from './types';
import { COLUMN_GAP } from './tables';

export interface OrderWord {
  text: string;
  box: Rect;
}
export interface OrderLine {
  text: string;
  box: Rect;
  words: OrderWord[];
}

/** empty space across the page taller than this many line heights separates two sections */
export const SECTION_GAP = 1.5;

const cy = (b: Rect) => b.y + b.h / 2;
const unionRect = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { x: r2(x), y: r2(y), w: r2(Math.max(...rs.map((r) => r.x + r.w)) - x), h: r2(Math.max(...rs.map((r) => r.y + r.h)) - y) };
};
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms
const RTL = /[֐-߿יִ-﷿ﹰ-﻿]/g;
const LETTER = /\p{L}/gu;

/** True when most letters on the page are in a right-to-left script. */
export function isRtl(lines: OrderLine[]): boolean {
  const text = lines.map((l) => l.text).join('');
  const letters = text.match(LETTER)?.length ?? 0;
  return letters > 0 && (text.match(RTL)?.length ?? 0) / letters > 0.5;
}

/**
 * The line cut into pieces: first where a word starts a new row (it overlaps the row so far by less than
 * half its height), then within each row where a gap between neighbouring words (left to right on the
 * page) is wider than COLUMN_GAP × the word height. Words keep their order in the line, so right-to-left
 * text stays in logical order. Vertical text and a line without such breaks are returned as is.
 */
export function splitAtGaps<L extends OrderLine>(line: L): L[] {
  const words = line.words;
  if (words.length < 2 || line.box.h > line.box.w) return [line];
  const rows: number[][] = [];
  let top = 0, bottom = 0;
  words.forEach((w, i) => {
    const overlap = Math.min(bottom, w.box.y + w.box.h) - Math.max(top, w.box.y);
    if (rows.length && overlap >= 0.5 * Math.min(w.box.h, bottom - top)) {
      rows[rows.length - 1].push(i);
      top = Math.min(top, w.box.y);
      bottom = Math.max(bottom, w.box.y + w.box.h);
    } else {
      rows.push([i]);
      top = w.box.y;
      bottom = w.box.y + w.box.h;
    }
  });
  const piece = new Array<number>(words.length);
  let n = -1;
  for (const row of rows) {
    const height = median(row.map((i) => words[i].box.h)) || 1;
    let right = -Infinity;
    for (const i of [...row].sort((a, b) => words[a].box.x - words[b].box.x)) {
      if (right === -Infinity || words[i].box.x - right > COLUMN_GAP * height) n++;
      piece[i] = n;
      right = Math.max(right, words[i].box.x + words[i].box.w);
    }
  }
  if (n === 0) return [line];
  return Array.from({ length: n + 1 }, (_, k) => {
    const ws = words.filter((_, i) => piece[i] === k);
    return { ...line, text: ws.map((w) => w.text).join(' '), box: unionRect(ws.map((w) => w.box)), words: ws };
  });
}

/** What reading order needs of a detected table (`Table` from tables.ts fits). */
export interface TableLike {
  box: Rect;
  cells: { row: number; col: number; box: Rect }[];
}

const inside = (p: Rect, b: Rect) => {
  const x = p.x + p.w / 2, y = cy(p);
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
};

interface Unit<L> {
  lines: L[];
  box: Rect;
  cy: number;
}

/** A table's pieces as its rows: each piece goes to the cell holding its centre (else the nearest cell). */
function tableRows<L extends OrderLine>(table: TableLike, pieces: L[]): L[] {
  const dist = (p: Rect, b: Rect) => Math.hypot(p.x + p.w / 2 - (b.x + b.w / 2), cy(p) - cy(b));
  const byCell = new Map<number, L[]>();
  for (const p of pieces) {
    let k = table.cells.findIndex((c) => inside(p.box, c.box));
    if (k < 0) k = table.cells.reduce((best, c, i) => (dist(p.box, c.box) < dist(p.box, table.cells[best].box) ? i : best), 0);
    byCell.set(k, [...(byCell.get(k) ?? []), p]);
  }
  const rows = new Map<number, { col: number; ls: L[] }[]>();
  for (const [k, ls] of byCell) {
    const c = table.cells[k];
    ls.sort((a, b) => cy(a.box) - cy(b.box) || a.box.x - b.box.x);
    rows.set(c.row, [...(rows.get(c.row) ?? []), { col: c.col, ls }]);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => {
    cells.sort((a, b) => a.col - b.col);
    const texts = Array<string>(cells[cells.length - 1].col + 1).fill('');
    for (const c of cells) texts[c.col] = c.ls.map((l) => l.text).join(' ');
    const ls = cells.flatMap((c) => c.ls);
    return { ...ls[0], text: texts.join('\t'), box: unionRect(ls.map((l) => l.box)), words: ls.flatMap((l) => l.words) };
  });
}

/**
 * The page's lines in reading order. `tables` come from `detectTables`: lines whose centre lies inside one
 * are read as that table's rows. `rtl` defaults to what the text says (`isRtl`).
 */
export function readingOrder<L extends OrderLine>(lines: L[], opts: { tables?: TableLike[]; rtl?: boolean } = {}): L[] {
  const rtl = opts.rtl ?? isRtl(lines);
  const pieces = lines.flatMap((l) => splitAtGaps(l));
  const units: Unit<L>[] = [];
  const inTable = new Map<number, L[]>();
  for (const p of pieces) {
    const t = (opts.tables ?? []).findIndex((tb) => inside(p.box, tb.box));
    if (t >= 0) inTable.set(t, [...(inTable.get(t) ?? []), p]);
    else units.push({ lines: [p], box: p.box, cy: cy(p.box) });
  }
  for (const [t, ls] of inTable) units.push({ lines: tableRows(opts.tables![t], ls), box: opts.tables![t].box, cy: cy(opts.tables![t].box) });

  // sections: cut where nothing spans a horizontal band taller than SECTION_GAP line heights
  const lineH = median(pieces.map((p) => p.box.h)) || 1;
  const sections: Unit<L>[][] = [];
  let bottom = -Infinity;
  for (const u of [...units].sort((a, b) => a.box.y - b.box.y)) {
    if (!sections.length || u.box.y - bottom > SECTION_GAP * lineH) sections.push([]);
    sections[sections.length - 1].push(u);
    bottom = Math.max(bottom, u.box.y + u.box.h);
  }
  return sections.flatMap((sec) => orderSection(sec, rtl));
}

function orderSection<L extends OrderLine>(units: Unit<L>[], rtl: boolean): L[] {
  // mirror x for right-to-left pages, so "left of" means "read first"
  const x0 = (u: Unit<L>) => (rtl ? -(u.box.x + u.box.w) : u.box.x);
  const x1 = (u: Unit<L>) => (rtl ? -u.box.x : u.box.x + u.box.w);
  const n = units.length;
  const before: number[][] = Array.from({ length: n }, () => []); // before[b] = units that must come before b
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const A = units[a], B = units[b];
      const overlap = Math.min(x1(A), x1(B)) - Math.max(x0(A), x0(B));
      if (overlap > 1) {
        if (A.cy < B.cy) before[b].push(a); // rule 1
      } else if (x1(A) <= x0(B) + 1) {
        // rule 2, unless something between them vertically crosses the gap between them
        const lo = Math.min(A.cy, B.cy), hi = Math.max(A.cy, B.cy);
        const blocked = units.some((C, c) => c !== a && c !== b && C.cy > lo && C.cy < hi && x0(C) < x1(A) && x1(C) > x0(B));
        if (!blocked) before[b].push(a);
      }
    }

  const done = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  const key = (u: Unit<L>) => [u.cy, x0(u)];
  const first = (cands: number[]) =>
    cands.reduce((best, i) => {
      const [y, x] = key(units[i]), [by, bx] = key(units[best]);
      return y < by - 0.5 || (Math.abs(y - by) <= 0.5 && x < bx) ? i : best;
    });
  while (order.length < n) {
    const free = [];
    for (let i = 0; i < n; i++) if (!done[i] && before[i].every((j) => done[j])) free.push(i);
    // a cycle (unusual layouts): take the highest remaining piece and carry on
    const pick = first(free.length ? free : Array.from({ length: n }, (_, i) => i).filter((i) => !done[i]));
    done[pick] = true;
    order.push(pick);
  }
  return order.flatMap((i) => units[i].lines);
}

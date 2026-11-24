/**
 * Table detection: finds tables on a page from its words (with boxes) and its ruling lines, and returns
 * them as rows and columns. Pure geometry, no pdf.js: `extract.ts` supplies the words and lines.
 *
 * Two methods, as in Camelot / Tabula:
 * - **lattice**: tables drawn with lines. Lines that cross each other form a grid; a missing line inside
 *   the grid means a merged cell.
 * - **stream**: tables without lines. Rows of text with wide gaps that line up from row to row.
 *
 * The server (`server/app/tables.py`) implements the same steps with the same constants; the shared
 * cases in `mobile/shared/tables/` keep them in step. Units are page units (points, top-left origin).
 */
import type { Rect } from './types';

export interface TableWord {
  text: string;
  box: Rect;
}
/** A straight line drawn on the page, in page units. Only horizontal and vertical ones are used. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface TableCell {
  /** 0-based */
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  /** lines inside a cell are joined with "\n" */
  text: string;
  box: Rect;
}
export interface Table {
  /** 0-based page */
  page: number;
  method: 'lattice' | 'stream';
  box: Rect;
  rows: number;
  cols: number;
  cells: TableCell[];
}

/** lines closer than this (points) are the same line; ends closer than this touch */
export const SNAP = 3;
/** shorter lines are ignored (underlines of single characters, tick marks) */
export const MIN_LINE = 5;
/** grid lines closer than this are one (double borders) */
export const MIN_CELL = 5;
/** a gap wider than this many word heights separates two columns of a borderless table */
export const COLUMN_GAP = 0.9;
/** rows further apart than this many line heights end a borderless table */
export const ROW_GAP = 1.2;
/** a borderless table needs this many rows with two or more columns */
export const MIN_STREAM_ROWS = 3;

const r2 = (v: number) => Math.round(v * 100) / 100;
const roundRect = (r: Rect): Rect => ({ x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) });
const cx = (b: Rect) => b.x + b.w / 2;
const cy = (b: Rect) => b.y + b.h / 2;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const unionRect = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Words of one cell or chunk as text: lines top to bottom, words left to right. */
export function wordsToText(words: TableWord[]): string {
  const sorted = [...words].sort((a, b) => cy(a.box) - cy(b.box) || a.box.x - b.box.x);
  const lines: TableWord[][] = [];
  for (const w of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(cy(w.box) - cy(line[0].box)) <= 0.5 * Math.min(w.box.h, line[0].box.h)) line.push(w);
    else lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.box.x - b.box.x).map((w) => w.text).join(' ')).join('\n');
}

// ------------------------------------------------------------------ lattice

/** a horizontal (pos = y, from/to = x) or vertical (pos = x, from/to = y) line */
interface Line {
  pos: number;
  from: number;
  to: number;
}

/** Joins lines on the same position that overlap or touch. */
function mergeLines(lines: Line[]): Line[] {
  const sorted = [...lines].sort((a, b) => a.pos - b.pos || a.from - b.from);
  // positions within SNAP are one band, placed at their mean
  const bands: Line[][] = [];
  for (const l of sorted) {
    const band = bands[bands.length - 1];
    if (band && l.pos - band[0].pos <= SNAP) band.push(l);
    else bands.push([l]);
  }
  const out: Line[] = [];
  for (const band of bands) {
    const pos = band.reduce((s, l) => s + l.pos, 0) / band.length;
    let cur: Line | null = null;
    for (const l of [...band].sort((a, b) => a.from - b.from)) {
      if (cur && l.from <= cur.to + SNAP) cur.to = Math.max(cur.to, l.to);
      else {
        if (cur) out.push(cur);
        cur = { pos, from: l.from, to: l.to };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Grid positions with near-duplicates (double borders) removed. */
function gridPositions(values: number[]): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] >= MIN_CELL) out.push(v);
  return out;
}

const covers = (lines: Line[], pos: number, at: number) =>
  lines.some((l) => Math.abs(l.pos - pos) < MIN_CELL && l.from - SNAP <= at && at <= l.to + SNAP);

function latticeTables(page: number, words: TableWord[], segments: Segment[], used: Set<number>): Table[] {
  const hs: Line[] = [], vs: Line[] = [];
  for (const s of segments) {
    const dx = Math.abs(s.x2 - s.x1), dy = Math.abs(s.y2 - s.y1);
    if (dy < 1 && dx >= MIN_LINE) hs.push({ pos: (s.y1 + s.y2) / 2, from: Math.min(s.x1, s.x2), to: Math.max(s.x1, s.x2) });
    else if (dx < 1 && dy >= MIN_LINE) vs.push({ pos: (s.x1 + s.x2) / 2, from: Math.min(s.y1, s.y2), to: Math.max(s.y1, s.y2) });
  }
  const H = mergeLines(hs), V = mergeLines(vs);
  // lines that cross or touch belong to the same table
  const uf = new UnionFind(H.length + V.length);
  H.forEach((h, i) =>
    V.forEach((v, j) => {
      if (v.pos >= h.from - SNAP && v.pos <= h.to + SNAP && h.pos >= v.from - SNAP && h.pos <= v.to + SNAP) uf.union(i, H.length + j);
    }));
  const groups = new Map<number, { h: Line[]; v: Line[] }>();
  H.forEach((h, i) => {
    const g = groups.get(uf.find(i)) ?? { h: [], v: [] };
    g.h.push(h);
    groups.set(uf.find(i), g);
  });
  V.forEach((v, j) => {
    const g = groups.get(uf.find(H.length + j)) ?? { h: [], v: [] };
    g.v.push(v);
    groups.set(uf.find(H.length + j), g);
  });

  const tables: Table[] = [];
  for (const { h, v } of groups.values()) {
    if (h.length < 2 || v.length < 2) continue;
    const ys = gridPositions(h.map((l) => l.pos)), xs = gridPositions(v.map((l) => l.pos));
    const rows = ys.length - 1, cols = xs.length - 1;
    if (rows < 1 || cols < 1 || rows * cols < 2) continue;
    // a base cell joins its neighbour when the line between them is missing at the middle of their edge
    const cellUf = new UnionFind(rows * cols);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (c < cols - 1 && !covers(v, xs[c + 1], (ys[r] + ys[r + 1]) / 2)) cellUf.union(r * cols + c, r * cols + c + 1);
        if (r < rows - 1 && !covers(h, ys[r + 1], (xs[c] + xs[c + 1]) / 2)) cellUf.union(r * cols + c, (r + 1) * cols + c);
      }
    const spans = new Map<number, { r0: number; r1: number; c0: number; c1: number }>();
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const root = cellUf.find(r * cols + c);
        const s = spans.get(root);
        if (!s) spans.set(root, { r0: r, r1: r, c0: c, c1: c });
        else Object.assign(s, { r0: Math.min(s.r0, r), r1: Math.max(s.r1, r), c0: Math.min(s.c0, c), c1: Math.max(s.c1, c) });
      }
    const cells: TableCell[] = [];
    const tableWords: number[] = [];
    for (const s of [...spans.values()].sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0)) {
      const box = { x: xs[s.c0], y: ys[s.r0], w: xs[s.c1 + 1] - xs[s.c0], h: ys[s.r1 + 1] - ys[s.r0] };
      const inside: TableWord[] = [];
      words.forEach((w, i) => {
        if (used.has(i)) return;
        const x = cx(w.box), y = cy(w.box);
        if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
          inside.push(w);
          tableWords.push(i);
        }
      });
      cells.push({ row: s.r0, col: s.c0, rowSpan: s.r1 - s.r0 + 1, colSpan: s.c1 - s.c0 + 1, text: wordsToText(inside), box: roundRect(box) });
    }
    if (!tableWords.length) continue; // an empty grid (answer boxes, graph paper) is not worth exporting
    for (const i of tableWords) used.add(i);
    tables.push({ page, method: 'lattice', box: roundRect({ x: xs[0], y: ys[0], w: xs[cols] - xs[0], h: ys[rows] - ys[0] }), rows, cols, cells });
  }
  return tables;
}

// ------------------------------------------------------------------ stream

interface Chunk {
  words: TableWord[];
  x0: number;
  x1: number;
}
interface TextRow {
  words: TableWord[];
  top: number;
  bottom: number;
  height: number;
  chunks: Chunk[];
}

/** Words grouped into rows (same height on the page), each split into chunks at wide gaps. */
function textRows(words: TableWord[]): TextRow[] {
  const sorted = [...words].sort((a, b) => cy(a.box) - cy(b.box) || a.box.x - b.box.x);
  const groups: TableWord[][] = [];
  for (const w of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(cy(w.box) - cy(g[0].box)) <= 0.5 * Math.min(w.box.h, g[0].box.h)) g.push(w);
    else groups.push([w]);
  }
  return groups.map((g) => {
    const ws = g.sort((a, b) => a.box.x - b.box.x);
    const height = median(ws.map((w) => w.box.h)) || 1;
    const chunks: Chunk[] = [];
    for (const w of ws) {
      const c = chunks[chunks.length - 1];
      if (c && w.box.x - c.x1 <= COLUMN_GAP * height) {
        c.words.push(w);
        c.x1 = Math.max(c.x1, w.box.x + w.box.w);
      } else chunks.push({ words: [w], x0: w.box.x, x1: w.box.x + w.box.w });
    }
    return { words: ws, top: Math.min(...ws.map((w) => w.box.y)), bottom: Math.max(...ws.map((w) => w.box.y + w.box.h)), height, chunks };
  });
}

/** Column bands: the x ranges of the chunks of the rows with the most common column count, merged where they overlap. */
function columnBands(rows: TextRow[]): [number, number][] {
  const multi = rows.filter((r) => r.chunks.length >= 2);
  const counts = new Map<number, number>();
  for (const r of multi) counts.set(r.chunks.length, (counts.get(r.chunks.length) ?? 0) + 1);
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
  const spans = multi.filter((r) => r.chunks.length === mode).flatMap((r) => r.chunks.map((c) => [c.x0, c.x1] as [number, number]));
  spans.sort((a, b) => a[0] - b[0]);
  const bands: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = bands[bands.length - 1];
    if (last && a <= last[1] + SNAP) last[1] = Math.max(last[1], b);
    else bands.push([a, b]);
  }
  return bands;
}

/** Bands a chunk overlaps (first, last); a chunk in a gap goes to the nearest band. */
function bandsOf(c: Chunk, bands: [number, number][]): [number, number] {
  const hit = bands.map((b, i) => (c.x0 < b[1] - SNAP && c.x1 > b[0] + SNAP ? i : -1)).filter((i) => i >= 0);
  if (hit.length) return [hit[0], hit[hit.length - 1]];
  const mid = (c.x0 + c.x1) / 2;
  let best = 0;
  bands.forEach((b, i) => {
    if (Math.abs((b[0] + b[1]) / 2 - mid) < Math.abs((bands[best][0] + bands[best][1]) / 2 - mid)) best = i;
  });
  return [best, best];
}

function streamTable(page: number, rows: TextRow[]): Table[] {
  // a table starts and ends with a row that has two or more columns
  let a = 0, b = rows.length - 1;
  while (a <= b && rows[a].chunks.length < 2) a++;
  while (b >= a && rows[b].chunks.length < 2) b--;
  if (a > b) return [];
  rows = rows.slice(a, b + 1);
  const bands = columnBands(rows);
  // a one-column row that runs across two columns is prose, not part of the table: split there
  const cut = rows.findIndex((r) => r.chunks.length === 1 && bandsOf(r.chunks[0], bands)[1] > bandsOf(r.chunks[0], bands)[0]);
  if (cut >= 0) return [...streamTable(page, rows.slice(0, cut)), ...streamTable(page, rows.slice(cut + 1))];
  const multi = rows.filter((r) => r.chunks.length >= 2);
  if (multi.length < MIN_STREAM_ROWS || bands.length < 2) return [];
  const width = bands[bands.length - 1][1] - bands[0][0];
  // two columns of running text look like a two-column table: require short entries then
  if (bands.length === 2 && median(multi.flatMap((r) => r.chunks.map((c) => c.x1 - c.x0))) > 0.3 * width) return [];

  const cells: TableCell[] = [];
  rows.forEach((r, ri) => {
    const byCol = new Map<number, { words: TableWord[]; last: number }>();
    for (const c of r.chunks) {
      const [first, last] = bandsOf(c, bands);
      const cell = byCol.get(first);
      if (cell) {
        cell.words.push(...c.words);
        cell.last = Math.max(cell.last, last);
      } else byCol.set(first, { words: [...c.words], last });
    }
    for (const [col, { words, last }] of [...byCol.entries()].sort((x, y) => x[0] - y[0]))
      cells.push({ row: ri, col, rowSpan: 1, colSpan: last - col + 1, text: wordsToText(words), box: roundRect(unionRect(words.map((w) => w.box))) });
  });
  const all = rows.flatMap((r) => r.words.map((w) => w.box));
  const box = unionRect([...all, { x: bands[0][0], y: rows[0].top, w: width, h: 0 }]);
  return [{ page, method: 'stream', box: roundRect(box), rows: rows.length, cols: bands.length, cells }];
}

function streamTables(page: number, words: TableWord[]): Table[] {
  const rows = textRows(words);
  const tables: Table[] = [];
  let block: TextRow[] = [];
  const flush = () => {
    tables.push(...streamTable(page, block));
    block = [];
  };
  for (const r of rows) {
    const prev = block[block.length - 1];
    if (prev && r.top - prev.bottom > ROW_GAP * Math.max(prev.height, r.height)) flush();
    block.push(r);
  }
  flush();
  return tables;
}

// ------------------------------------------------------------------ entry points

/**
 * Tables on one page: first those drawn with lines, then borderless ones among the remaining words.
 * Sorted top to bottom.
 */
export function detectTables(page: number, words: TableWord[], segments: Segment[]): Table[] {
  const used = new Set<number>();
  const lattice = latticeTables(page, words, segments, used);
  const stream = streamTables(page, words.filter((_, i) => !used.has(i)));
  return [...lattice, ...stream].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/** The table as a rectangular grid of strings; a merged cell's text is in its top-left position. */
export function tableToGrid(t: Table): string[][] {
  const grid = Array.from({ length: t.rows }, () => Array<string>(t.cols).fill(''));
  for (const c of t.cells) if (grid[c.row] && c.col < t.cols) grid[c.row][c.col] = c.text;
  return grid;
}

/**
 * Extraction: text (plain, or lines and words with positions), tables, embedded images, and fonts.
 *
 * Text and images come from pdf.js (it decodes every image format and handles rotation); the font list
 * comes from pdf-lib, which sees the font dictionaries as they are in the file (type, embedded, subset)
 * and can hand back the embedded font programs.
 *
 * Positions are page units: points, origin at the top-left of the page as displayed (rotation applied),
 * the same space as annotations.
 */
import { getDocument, OPS, Util } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import type { Rect } from './types';
import { detectTables, tableToGrid } from './tables';
import type { Segment, Table } from './tables';
import { makeXlsx } from './xlsx';
import { readingOrder } from './readingOrder';

type Matrix = [number, number, number, number, number, number];

export interface Progress {
  done: number;
  total: number;
}
export interface ExtractControl {
  onProgress?: (p: Progress) => void;
  /** set `cancelled = true` to stop between pages */
  signal?: { cancelled: boolean };
}

export class ExtractCancelled extends Error {
  constructor() {
    super('Extraction cancelled.');
  }
}

/**
 * Opens a separate copy of the document for extraction, with font names kept (pdf.js drops them
 * unless `fontExtraProperties` is set, which costs memory we don't want while viewing).
 * Call `destroy()` on the result's `loadingTask` when done.
 */
export function openForExtraction(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  return getDocument({ data: bytes.slice(), fontExtraProperties: true, password }).promise;
}

// ------------------------------------------------------------------ text

export interface Word {
  text: string;
  box: Rect;
}
export interface Line {
  text: string;
  box: Rect;
  /** font as named in the file when known (e.g. "Arial-BoldMT"), otherwise a generic family */
  font: string;
  /** font size in points */
  size: number;
  words: Word[];
}
export interface PageText {
  /** 0-based */
  page: number;
  width: number;
  height: number;
  lines: Line[];
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const round = (r: Rect): Rect => ({ x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.w.toFixed(2), h: +r.h.toFixed(2) });

/** Axis-aligned page-unit box of a run of text from `from` to `to` (fractions of its width). */
function runBox(vp: PageViewport, m: number[], width: number, ascent: number, descent: number, from = 0, to = 1): Rect {
  const [a, b, c, d, e, f] = m;
  const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;
  const dir = [a / (Math.hypot(a, b) || 1), b / (Math.hypot(a, b) || 1)];
  const up = [c / size, d / size];
  const pts: number[][] = [];
  for (const t of [from, to])
    for (const h of [descent * size, ascent * size]) pts.push([e + dir[0] * width * t + up[0] * h, f + dir[1] * width * t + up[1] * h]);
  const v = pts.map(([x, y]) => vp.convertToViewportPoint(x, y));
  const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * Text of one page as lines and words, in the order the file draws it.
 * Word boxes inside a run are proportional to character count (pdf.js gives one width per run).
 */
export async function pageText(page: PDFPageProxy, fontNames?: Map<string, string>): Promise<PageText> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily: string; ascent: number; descent: number }>;
  const lines: Line[] = [];
  let cur: (Line & { base: number; dir: number[]; end: number[] }) | null = null;
  const finish = () => {
    if (cur && cur.text.trim()) {
      const { base: _b, dir: _d, end: _e, ...line } = cur;
      lines.push({ ...line, text: line.text.trim(), box: round(line.box), words: line.words.map((w) => ({ ...w, box: round(w.box) })) });
    }
    cur = null;
  };
  for (const item of content.items as TextItemLike[]) {
    if (!('str' in item)) continue;
    // control characters come from broken ToUnicode maps (often in shaped Indic text); they are never real text
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    const raw = { ...item, str: item.str.replace(/[\u0000-\u0008\u000B-\u001F\u007F\uFFFD]/g, '') };
    const m = raw.transform;
    const size = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]);
    const style = styles[raw.fontName] ?? { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2 };
    const ascent = style.ascent || 0.8, descent = style.descent || -0.2;
    const font = fontNames?.get(raw.fontName) ?? style.fontFamily;
    const dir = [m[0] / (Math.hypot(m[0], m[1]) || 1), m[1] / (Math.hypot(m[0], m[1]) || 1)];
    // baseline position across the text direction, to tell lines apart
    const base = -dir[1] * m[4] + dir[0] * m[5];
    if (raw.str.length) {
      const box = runBox(vp, m, raw.width, ascent, descent);
      const sameLine = cur !== null && Math.abs(cur.base - base) < size * 0.5 && Math.abs(cur.dir[0] - dir[0]) < 0.01 && Math.abs(cur.dir[1] - dir[1]) < 0.01;
      if (!sameLine) {
        finish();
        cur = { text: '', box, font, size: +size.toFixed(2), words: [], base, dir, end: [m[4], m[5]] };
      }
      const line = cur!;
      // a visible gap since the previous run means a space the file didn't draw
      const gap = (m[4] - line.end[0]) * dir[0] + (m[5] - line.end[1]) * dir[1];
      if (line.text && !/\s$/.test(line.text) && !/^\s/.test(raw.str) && gap > size * 0.15) line.text += ' ';
      const startsNewWord = !line.text || /\s$/.test(line.text);
      line.text += raw.str;
      line.box = union(line.box, box);
      line.end = [m[4] + dir[0] * raw.width, m[5] + dir[1] * raw.width];
      // words: split on whitespace, positioned proportionally inside the run
      const n = raw.str.length;
      let i = 0;
      for (const part of raw.str.split(/(\s+)/)) {
        if (part && !/^\s+$/.test(part)) {
          const wbox = runBox(vp, m, raw.width, ascent, descent, i / n, (i + part.length) / n);
          const last = line.words[line.words.length - 1];
          if (last && i === 0 && !startsNewWord) {
            last.text += part; // continues a word split across runs (e.g. a change of style)
            last.box = union(last.box, wbox);
          } else line.words.push({ text: part, box: wbox });
        }
        i += part.length;
      }
    }
    if (raw.hasEOL) finish();
  }
  finish();
  return { page: page.pageNumber - 1, width: vp.width, height: vp.height, lines };
}

const check = (c?: ExtractControl) => {
  if (c?.signal?.cancelled) throw new ExtractCancelled();
};

/**
 * `reading` (default): lines in reading order, columns one after another and table rows as one line with
 * tab-separated cells (see `readingOrder.ts`). `drawn`: the order the file draws them.
 */
export type TextOrder = 'reading' | 'drawn';

/** The page's lines in reading order, with tables found the same way as table extraction. */
export async function inReadingOrder(page: PDFPageProxy, text: PageText): Promise<PageText> {
  const tables = detectTables(text.page, text.lines.flatMap((l) => l.words), await pageRulings(page));
  return { ...text, lines: readingOrder(text.lines, { tables }) };
}

export async function extractText(pdf: PDFDocumentProxy, pages: number[], control?: ExtractControl, order: TextOrder = 'reading'): Promise<PageText[]> {
  const out: PageText[] = [];
  for (const [i, p] of pages.entries()) {
    check(control);
    const page = await pdf.getPage(p + 1);
    const text = await pageText(page, await fontNamesOf(page));
    out.push(order === 'reading' ? await inReadingOrder(page, text) : text);
    control?.onProgress?.({ done: i + 1, total: pages.length });
  }
  return out;
}

/** pdf.js font ids → names as in the file; needs the page's operator list (fonts are loaded with it). */
async function fontNamesOf(page: PDFPageProxy): Promise<Map<string, string>> {
  const ops = await page.getOperatorList();
  const names = new Map<string, string>();
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== OPS.setFont) continue;
    const id = ops.argsArray[i][0] as string;
    if (names.has(id)) continue;
    try {
      const font = page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
      if (font?.name) names.set(id, String(font.name).replace(/^[A-Z]{6}\+/, ''));
    } catch { /* not loaded */ }
  }
  return names;
}

export function textToPlain(pages: PageText[], pageMarkers = true): string {
  return pages.map((p) => (pageMarkers ? `===== Page ${p.page + 1} =====\n` : '') + p.lines.map((l) => l.text).join('\n')).join('\n\n') + '\n';
}

export function textToJson(pages: PageText[], fileName: string): string {
  return JSON.stringify({
    format: 'pdf-studio-text',
    version: 1,
    file: fileName,
    units: 'PDF points; origin top-left of the page as displayed; box = {x, y, w, h}',
    pages: pages.map((p) => ({ page: p.page + 1, width: +p.width.toFixed(2), height: +p.height.toFixed(2), lines: p.lines })),
  }, null, 2);
}

const csvCell = (v: string | number) => {
  const s = String(v);
  // a leading = + - @ would run as a formula in Excel
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === 'string' ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One row per word: page, line, word, text, x, y, width, height, font, size. */
export function textToCsv(pages: PageText[]): string {
  const rows: (string | number)[][] = [['page', 'line', 'word', 'text', 'x', 'y', 'width', 'height', 'font', 'size']];
  for (const p of pages)
    p.lines.forEach((l, li) => l.words.forEach((w, wi) => rows.push([p.page + 1, li + 1, wi + 1, w.text, w.box.x, w.box.y, w.box.w, w.box.h, l.font, l.size])));
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; // BOM: Excel opens UTF-8 (Hindi) correctly
}

// ------------------------------------------------------------------ tables

const PAINT_STROKE = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const PAINT_FILL = new Set<number>([OPS.fill, OPS.eoFill]);
/** a filled shape thinner than this is drawn as a line (office suites draw table borders as thin filled boxes) */
const THIN_FILL = 3;

/**
 * Straight lines drawn on a page (stroked paths, and filled boxes thin enough to be lines), in page units.
 * Curves are skipped; clipping paths are not drawn, so they are skipped too.
 */
export async function pageRulings(page: PDFPageProxy): Promise<Segment[]> {
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const out: Segment[] = [];
  const stack: number[][] = [];
  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  const toPage = (x: number, y: number) => vp.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]);
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm as Matrix, args as Matrix) as unknown as number[];
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args[0]) ctm = Util.transform(ctm as Matrix, args[0] as Matrix) as unknown as number[];
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      // pdf.js 5+: [paint operator, [path data], bounding box]; path data is DrawOPS codes followed by their points
      const [paint, [data]] = args as [number, [ArrayLike<number> | null]];
      const stroke = PAINT_STROKE.has(paint), fill = PAINT_FILL.has(paint);
      if (!data || (!stroke && !fill)) continue;
      const subpaths: number[][][] = [];
      let cur: number[][] = [];
      for (let k = 0; k < data.length;) {
        const op = data[k++];
        if (op === 0) { // moveTo
          if (cur.length) subpaths.push(cur);
          cur = [toPage(data[k++], data[k++])];
        } else if (op === 1) cur.push(toPage(data[k++], data[k++])); // lineTo
        else if (op === 2 || op === 3) { // curves: not lines; restart from their end point
          k += op === 2 ? 4 : 2;
          if (cur.length) subpaths.push(cur);
          cur = [toPage(data[k++], data[k++])];
        } else if (op === 4) { // closePath
          if (cur.length > 2) cur.push(cur[0]);
        } else break; // unknown code: stop reading this path
      }
      if (cur.length) subpaths.push(cur);
      for (const pts of subpaths) {
        if (stroke) {
          for (let k = 1; k < pts.length; k++) out.push({ x1: pts[k - 1][0], y1: pts[k - 1][1], x2: pts[k][0], y2: pts[k][1] });
        } else {
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          if (y1 - y0 <= THIN_FILL && x1 - x0 > THIN_FILL) out.push({ x1: x0, y1: (y0 + y1) / 2, x2: x1, y2: (y0 + y1) / 2 });
          else if (x1 - x0 <= THIN_FILL && y1 - y0 > THIN_FILL) out.push({ x1: (x0 + x1) / 2, y1: y0, x2: (x0 + x1) / 2, y2: y1 });
        }
      }
    }
  }
  return out;
}

/** Tables on the given pages, drawn with lines or not (see `tables.ts`). */
export async function extractTables(pdf: PDFDocumentProxy, pages: number[], control?: ExtractControl): Promise<Table[]> {
  const out: Table[] = [];
  for (const [i, p] of pages.entries()) {
    check(control);
    const page = await pdf.getPage(p + 1);
    const text = await pageText(page);
    out.push(...detectTables(p, text.lines.flatMap((l) => l.words), await pageRulings(page)));
    control?.onProgress?.({ done: i + 1, total: pages.length });
  }
  return out;
}

/** "page-003-table-01": the name of a table's file or sheet. */
export function tableName(tables: Table[], t: Table): string {
  const n = tables.filter((x) => x.page === t.page).indexOf(t) + 1;
  return `page-${String(t.page + 1).padStart(3, '0')}-table-${String(n).padStart(2, '0')}`;
}

export function tableToCsv(t: Table): string {
  return '\ufeff' + tableToGrid(t).map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** One Excel workbook, one sheet per table, merged cells kept. */
export function tablesToXlsx(tables: Table[]): Uint8Array {
  return makeXlsx(tables.map((t) => ({
    name: tableName(tables, t).replace(/^page-0*(\d+)-table-0*(\d+)$/, 'Page $1 table $2'),
    rows: tableToGrid(t),
    merges: t.cells.filter((c) => c.rowSpan > 1 || c.colSpan > 1).map((c) => ({ r0: c.row, c0: c.col, r1: c.row + c.rowSpan - 1, c1: c.col + c.colSpan - 1 })),
  })));
}

export function tablesToJson(tables: Table[], fileName: string): string {
  return JSON.stringify({
    format: 'pdf-studio-tables', version: 1, file: fileName,
    units: 'PDF points; origin top-left of the page as displayed; box = {x, y, w, h}; row, col 0-based',
    tables: tables.map((t) => ({ name: tableName(tables, t), ...t, page: t.page + 1, grid: tableToGrid(t) })),
  }, null, 2);
}

// ------------------------------------------------------------------ images

export interface ExtractedImage {
  /** file name inside the export, e.g. "page-003-image-02.png" */
  name: string;
  /** 0-based page where it appears first */
  page: number;
  /** pages (0-based) where the same image is drawn */
  pages: number[];
  /** where it is drawn on `page`, in page units */
  box: Rect;
  widthPx: number;
  heightPx: number;
  data: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
}

export interface ImageOptions {
  format: 'png' | 'jpeg';
  /** skip images smaller than this many pixels on their longer side (icons, bullets) */
  minPixels: number;
}

interface DecodedImage {
  width: number;
  height: number;
  bitmap?: ImageBitmap;
  data?: Uint8Array | Uint8ClampedArray;
  kind?: number;
}

const objectOf = (page: PDFPageProxy, id: string) =>
  new Promise<DecodedImage | null>((resolve) => {
    const store = id.startsWith('g_') ? page.commonObjs : page.objs;
    try {
      store.get(id, (v: DecodedImage | null) => resolve(v ?? null));
    } catch {
      resolve(null);
    }
    setTimeout(() => resolve(null), 15000); // never hang on an object pdf.js doesn't deliver
  });

/** Draws a decoded pdf.js image into a canvas (pixels as stored, before any page transform). */
function toCanvas(img: DecodedImage): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (!ctx || !img.width || !img.height) return null;
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return c;
  }
  if (!img.data) return null;
  const out = ctx.createImageData(img.width, img.height);
  const px = img.width * img.height, src = img.data, dst = out.data;
  if (img.kind === 3) dst.set(src.subarray(0, px * 4)); // RGBA_32BPP
  else if (img.kind === 2) { // RGB_24BPP
    for (let i = 0, j = 0; i < px; i++, j += 3) { dst[i * 4] = src[j]; dst[i * 4 + 1] = src[j + 1]; dst[i * 4 + 2] = src[j + 2]; dst[i * 4 + 3] = 255; }
  } else if (img.kind === 1) { // GRAYSCALE_1BPP, rows padded to bytes
    const rowBytes = (img.width + 7) >> 3;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const on = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const k = (y * img.width + x) * 4;
        dst[k] = dst[k + 1] = dst[k + 2] = on ? 255 : 0;
        dst[k + 3] = 255;
      }
  } else return null;
  ctx.putImageData(out, 0, 0);
  return c;
}

const toBlobBytes = (c: HTMLCanvasElement, mime: string) =>
  new Promise<Uint8Array>((resolve, reject) =>
    c.toBlob((b) => (b ? b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject) : reject(new Error('Image encoding failed'))), mime, 0.92));

/** Where the unit square lands under `ctm`, in page units. */
function placement(vp: PageViewport, ctm: number[]): Rect {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
  const v = pts.map(([x, y]) => vp.convertToViewportPoint(x, y));
  const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]);
  return round({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
}

/**
 * Embedded images drawn on the given pages, decoded to PNG or JPEG at their own resolution.
 * The same image used on several pages is exported once. Stencil masks (one-colour shapes) are skipped.
 */
export async function extractImages(pdf: PDFDocumentProxy, pages: number[], opts: ImageOptions, control?: ExtractControl): Promise<ExtractedImage[]> {
  const out: ExtractedImage[] = [];
  const seen = new Map<string, ExtractedImage>();
  const ext = opts.format === 'png' ? 'png' : 'jpg';
  const mime = opts.format === 'png' ? 'image/png' : 'image/jpeg';
  for (const [pi, p] of pages.entries()) {
    check(control);
    const page = await pdf.getPage(p + 1);
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const stack: number[][] = [];
    let ctm: number[] = [1, 0, 0, 1, 0, 0];
    let n = 0;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = Util.transform(ctm as Matrix, args as Matrix) as unknown as number[];
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args[0]) ctm = Util.transform(ctm as Matrix, args[0] as Matrix) as unknown as number[];
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
        const id = typeof args[0] === 'string' ? (args[0] as string) : null;
        if (id && seen.has(id)) {
          const prev = seen.get(id)!;
          if (!prev.pages.includes(p)) prev.pages.push(p);
          continue;
        }
        const img = id ? await objectOf(page, id) : (args[0] as DecodedImage);
        if (!img || Math.max(img.width, img.height) < opts.minPixels) continue;
        const canvas = toCanvas(img);
        if (!canvas) continue;
        n++;
        const item: ExtractedImage = {
          name: `page-${String(p + 1).padStart(3, '0')}-image-${String(n).padStart(2, '0')}.${ext}`,
          page: p, pages: [p], box: placement(vp, ctm), widthPx: img.width, heightPx: img.height,
          data: await toBlobBytes(canvas, mime), mime,
        };
        out.push(item);
        if (id) seen.set(id, item);
      }
    }
    control?.onProgress?.({ done: pi + 1, total: pages.length });
  }
  return out;
}

export function imagesToJson(images: ExtractedImage[], fileName: string): string {
  return JSON.stringify({
    format: 'pdf-studio-images', version: 1, file: fileName,
    units: 'PDF points; origin top-left of the page as displayed',
    images: images.map(({ data: _d, ...i }) => ({ ...i, page: i.page + 1, pages: i.pages.map((x) => x + 1) })),
  }, null, 2);
}

// ------------------------------------------------------------------ fonts

export interface FontInfo {
  /** name as in the file without the subset prefix, e.g. "Arial-BoldMT" */
  name: string;
  /** full /BaseFont, e.g. "ABCDEF+Arial-BoldMT" */
  baseFont: string;
  /** Type1, TrueType, Type0 (composite), Type3, MMType1 */
  type: string;
  embedded: boolean;
  /** only the characters used are embedded (ABCDEF+ prefix) */
  subset: boolean;
  /** kind of embedded program: TrueType, Type1, CFF, OpenType */
  program?: string;
  /** 0-based pages that use it */
  pages: number[];
  /** the embedded font program, when asked for */
  file?: { name: string; data: Uint8Array };
}

const nameOf = (d: PDFDict, key: string) => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : undefined;
};

function fontProgram(desc: PDFDict | undefined): { stream: PDFStream; program: string; ext: string } | null {
  if (!desc) return null;
  const f1 = desc.lookup(PDFName.of('FontFile')), f2 = desc.lookup(PDFName.of('FontFile2')), f3 = desc.lookup(PDFName.of('FontFile3'));
  if (f2 instanceof PDFStream) return { stream: f2, program: 'TrueType', ext: 'ttf' };
  if (f1 instanceof PDFStream) return { stream: f1, program: 'Type1', ext: 'pfa' };
  if (f3 instanceof PDFStream) {
    const sub = nameOf(f3.dict, 'Subtype');
    return sub === 'OpenType' ? { stream: f3, program: 'OpenType', ext: 'otf' } : { stream: f3, program: 'CFF', ext: 'cff' };
  }
  return null;
}

function streamBytes(s: PDFStream): Uint8Array | null {
  try {
    return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
  } catch {
    return null; // unsupported filter
  }
}

/**
 * Fonts used on the given pages (including inside form XObjects). With `withFiles`, embedded font
 * programs are returned too. Font files are usually licensed: they may only be reused as their licence allows.
 */
export async function extractFonts(bytes: Uint8Array, pages: number[], withFiles: boolean): Promise<FontInfo[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const fonts = new Map<PDFRef | PDFDict, FontInfo>();
  const visitResources = (res: PDFDict | undefined, page: number, depth: number, seenForms: Set<unknown>) => {
    if (!res || depth > 8) return;
    const fontDict = res.lookupMaybe(PDFName.of('Font'), PDFDict);
    for (const [, value] of fontDict?.entries() ?? []) {
      const key = value instanceof PDFRef ? value : (value as PDFDict);
      const font = value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (!(font instanceof PDFDict)) continue;
      const existing = fonts.get(key);
      if (existing) {
        if (!existing.pages.includes(page)) existing.pages.push(page);
        continue;
      }
      const type = nameOf(font, 'Subtype') ?? 'Unknown';
      const baseFont = nameOf(font, 'BaseFont') ?? (type === 'Type3' ? 'Type3 font' : 'Unnamed font');
      let desc = font.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
      if (type === 'Type0') {
        const kids = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
        const kid = kids?.lookup(0);
        if (kid instanceof PDFDict) desc = kid.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
      }
      const prog = fontProgram(desc);
      const info: FontInfo = {
        name: baseFont.replace(/^[A-Z]{6}\+/, ''), baseFont, type, embedded: !!prog || type === 'Type3',
        subset: /^[A-Z]{6}\+/.test(baseFont), program: prog?.program ?? (type === 'Type3' ? 'Type3 (drawn glyphs)' : undefined), pages: [page],
      };
      if (withFiles && prog) {
        const data = streamBytes(prog.stream);
        if (data) info.file = { name: `${baseFont.replace(/[^\w.+-]/g, '_')}.${prog.ext}`, data };
      }
      fonts.set(key, info);
    }
    const xobjects = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
    for (const [, value] of xobjects?.entries() ?? []) {
      const xo = value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (!(xo instanceof PDFStream) || nameOf(xo.dict, 'Subtype') !== 'Form' || seenForms.has(xo)) continue;
      seenForms.add(xo);
      visitResources(xo.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), page, depth + 1, seenForms);
    }
  };
  const all = doc.getPages();
  for (const p of pages) {
    const page = all[p];
    if (page) visitResources(page.node.Resources(), p, 0, new Set());
  }
  // a file named twice (same subset name in two dictionaries) gets a number
  const used = new Set<string>();
  const list = [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of list) {
    if (!f.file) continue;
    let name = f.file.name, i = 2;
    while (used.has(name)) name = f.file.name.replace(/(\.\w+)$/, `-${i++}$1`);
    used.add(name);
    f.file.name = name;
  }
  return list;
}

export function fontsToCsv(fonts: FontInfo[]): string {
  const rows: (string | number)[][] = [['font', 'type', 'embedded', 'subset', 'program', 'pages', 'file']];
  for (const f of fonts) rows.push([f.name, f.type, f.embedded ? 'yes' : 'no', f.subset ? 'yes' : 'no', f.program ?? '', f.pages.map((p) => p + 1).join(' '), f.file?.name ?? '']);
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ pages

/** Parses "1-3, 7" (1-based, as people type it) into sorted 0-based indices; null when invalid. */
export function parsePageRange(input: string, pageCount: number): number[] | null {
  const pages = new Set<number>();
  for (const part of input.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > pageCount) return null;
    for (let p = a; p <= b; p++) pages.add(p - 1);
  }
  return pages.size ? [...pages].sort((x, y) => x - y) : null;
}

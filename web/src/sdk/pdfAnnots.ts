/**
 * Writing annotations as real PDF annotation objects (editable in Acrobat, Chrome, Preview…)
 * or burning them into page content, and reading them back when a PDF is opened.
 *
 * Every annotation gets an appearance stream (/AP) generated here, so it looks identical in
 * every viewer. A private /PDFStudio key carries our full JSON so a round trip is lossless.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString,
  StandardFonts, drawObject, popGraphicsState, pushGraphicsState,
} from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import { arrowHead, ellipsePoints, hexToRgb01, normRect, rectPoints, textBox, textLayoutBox, textOrigin, uid } from './geometry';
import { labelAnchor, measureLabel } from './measure';
import { dataUrlToBytes, isLatin, renderRichTextImage, renderTextImage } from './textImage';
import { EmbeddedFonts, getTextShaper, glyphHex, placeGlyphs, scriptRuns, textHex, type TextShaper } from './unicodeText';
import { isPlainRuns, plainText, relativeTo, runsToLines, runsToXhtml, xhtmlToRuns } from './richtext';
import type { TextRun } from './richtext';
import type { Annotation, Pt, Rect } from './types';

const KEY = 'PDFStudio';
const KEY_M = 'PDFStudioM';

// ---------------------------------------------------------------- helpers

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();

export function pdfDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** PDF date (D:YYYYMMDDHHmmSS with an optional Z or +HH'mm' / -HH'mm' offset) as an ISO UTC string. */
export function parsePdfDate(s: string | undefined): string {
  const m = s?.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})'?(\d{2})?'?)?/);
  if (!m) return new Date().toISOString();
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', , sign, oh = '00', om = '00'] = m;
  // the time is local to the writer: India files say +05'30', Gulf files +04'00'
  const offset = sign ? (sign === '-' ? -1 : 1) * (+oh * 60 + +om) : 0;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi - offset, +se));
  return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** WinAnsi hex string for Helvetica text operators. */
const hexText = (s: string) =>
  '<' + Array.from(s).map((c) => Math.min(255, c.charCodeAt(0)).toString(16).padStart(2, '0')).join('') + '>';

const rgbOp = (hex: string, stroke: boolean) => {
  const [r, g, b] = hexToRgb01(hex);
  return `${f(r)} ${f(g)} ${f(b)} ${stroke ? 'RG' : 'rg'}`;
};

const path = (pts: Pt[], close: boolean) =>
  pts.map((p, i) => `${f(p.x)} ${f(p.y)} ${i ? 'l' : 'm'}`).join(' ') + (close ? ' h' : '');

interface Built {
  content: string[];
  points: Pt[]; // PDF-space points that the appearance covers (for BBox)
  resources: { ExtGState: Record<string, unknown>; Font: Record<string, PDFRef>; XObject: Record<string, PDFRef> };
}

interface Env {
  doc: PDFDocument;
  vp: PageViewport;
  helv: PDFFont;
  helvBold: PDFFont;
  helvItalic: PDFFont;
  helvBoldItalic: PDFFont;
  /** shapes non-Latin text into real PDF text; null → such text is drawn as an image */
  shaper: TextShaper | null;
  fonts: EmbeddedFonts;
}

/** A styled piece of one line of text. */
interface Piece { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color: string }

/**
 * Writes lines of styled pieces as real text: Latin runs in Helvetica, other scripts shaped into the embedded Unicode
 * font. Returns the drawn size, or null (nothing written) when there is no shaper or the font lacks a character.
 */
function drawShapedLines(env: Env, b: Built, lines: Piece[][], topLeft: Pt, size: number): { w: number; h: number } | null {
  const shaper = env.shaper;
  if (!shaper) return null;
  type Item =
    | { latin: true; piece: Piece; text: string; font: PDFFont; name: string; w: number }
    | { latin: false; piece: Piece; text: string; placed: NonNullable<ReturnType<typeof placeGlyphs>>; w: number };
  const helvFace = (p: Piece): [PDFFont, string] =>
    p.bold ? (p.italic ? [env.helvBoldItalic, 'HelvBI'] : [env.helvBold, 'HelvB']) : p.italic ? [env.helvItalic, 'HelvI'] : [env.helv, 'Helv'];
  const laid: Item[][] = [];
  for (const line of lines) {
    const items: Item[] = [];
    for (const piece of line) {
      for (const run of scriptRuns(piece.text)) {
        if (run.latin) {
          const [font, name] = helvFace(piece);
          items.push({ latin: true, piece, text: run.text, font, name, w: font.widthOfTextAtSize(run.text, size) });
        } else {
          const placed = placeGlyphs(piece.bold ? shaper.bold : shaper.regular, run.text, size);
          if (!placed) return null;
          items.push({ latin: false, piece, text: run.text, placed, w: placed.width });
        }
      }
    }
    laid.push(items);
  }
  const toPdf = (p: Pt): Pt => { const [x, y] = env.vp.convertToPdfPoint(p.x, p.y); return { x, y }; };
  let maxW = 0;
  laid.forEach((items, li) => {
    const baseline = topLeft.y + size * (li + 0.85) + size * 0.15 * li;
    let x = topLeft.x;
    for (const it of items) {
      const color = rgbOp(it.piece.color, false);
      if (it.latin) {
        b.resources.Font[it.name] = it.font.ref;
        const { o, u, v } = basis(env.vp, { x, y: baseline });
        b.content.push(`BT /${it.name} ${f(size)} Tf ${color} ${f(u.x)} ${f(u.y)} ${f(v.x)} ${f(v.y)} ${f(o.x)} ${f(o.y)} Tm ${hexText(it.text)} Tj ET`);
      } else {
        const { name, ref, codes } = env.fonts.use(it.placed.font, it.placed.glyphs);
        b.resources.Font[name] = ref;
        // Each glyph at its shaped position (marks carry their own offsets); text space is page units here.
        const ops: string[] = [];
        let px = 0, py = 0;
        it.placed.glyphs.forEach((g, i) => {
          ops.push(`${f(g.x - px)} ${f(g.dy - py)} Td ${glyphHex([codes[i]])} Tj`);
          px = g.x; py = g.dy;
        });
        const { o, u, v } = basis(env.vp, { x, y: baseline });
        // ActualText gives readers the exact text of the run (copy, search), whatever the glyph order.
        b.content.push(`/Span <</ActualText ${textHex(it.text)}>> BDC BT /${name} ${f(size)} Tf ${color} ${f(u.x)} ${f(u.y)} ${f(v.x)} ${f(v.y)} ${f(o.x)} ${f(o.y)} Tm ${ops.join(' ')} ET EMC`);
      }
      if (it.piece.underline) {
        const y = baseline + size * 0.12;
        const p1 = toPdf({ x, y }), p2 = toPdf({ x: x + it.w, y });
        b.content.push(`${rgbOp(it.piece.color, true)} ${f(Math.max(0.6, size / 16))} w ${f(p1.x)} ${f(p1.y)} m ${f(p2.x)} ${f(p2.y)} l S`);
      }
      x += it.w;
    }
    maxW = Math.max(maxW, x - topLeft.x);
  });
  const h = lines.length * size * 1.15;
  b.points.push(...rectPoints({ x: topLeft.x, y: topLeft.y, w: maxW, h }).map(toPdf));
  return { w: maxW, h };
}

/** Affine basis for drawing upright (as displayed) content at a page-unit origin. */
function basis(vp: PageViewport, origin: Pt) {
  const [ox, oy] = vp.convertToPdfPoint(origin.x, origin.y);
  const [rx, ry] = vp.convertToPdfPoint(origin.x + 1, origin.y);
  const [ux, uy] = vp.convertToPdfPoint(origin.x, origin.y - 1);
  return { o: { x: ox, y: oy }, u: { x: rx - ox, y: ry - oy }, v: { x: ux - ox, y: uy - oy } };
}

async function drawText(
  env: Env, b: Built, text: string, topLeft: Pt, size: number, color: string, bold = false, opacity = 1,
): Promise<{ w: number; h: number }> {
  const toPdf = (p: Pt): Pt => { const [x, y] = env.vp.convertToPdfPoint(p.x, p.y); return { x, y }; };
  if (isLatin(text)) {
    const font = bold ? env.helvBold : env.helv;
    const name = bold ? 'HelvB' : 'Helv';
    b.resources.Font[name] = font.ref;
    const lines = text.split('\n');
    const w = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)));
    lines.forEach((line, i) => {
      const { o, u, v } = basis(env.vp, { x: topLeft.x, y: topLeft.y + size * (i + 0.85) + size * 0.15 * i });
      b.content.push(`BT /${name} ${f(size)} Tf ${rgbOp(color, false)} ${f(u.x)} ${f(u.y)} ${f(v.x)} ${f(v.y)} ${f(o.x)} ${f(o.y)} Tm ${hexText(line)} Tj ET`);
    });
    const h = lines.length * size * 1.15;
    b.points.push(...rectPoints({ x: topLeft.x, y: topLeft.y, w, h }).map(toPdf));
    return { w, h };
  }
  // Non-Latin scripts: real text when a shaper is plugged in and covers it, otherwise an image rendered by the browser.
  const shaped = drawShapedLines(env, b, text.split('\n').map((l) => [{ text: l, bold, color }]), topLeft, size);
  if (shaped) return shaped;
  const img = await renderTextImage(text, size, color, bold);
  const embedded = await env.doc.embedPng(img.png);
  const name = `Im${Object.keys(b.resources.XObject).length}`;
  b.resources.XObject[name] = embedded.ref;
  imageOps(env.vp, b, name, { x: topLeft.x, y: topLeft.y, w: img.width, h: img.height }, opacity);
  return { w: img.width, h: img.height };
}

/** Styled runs: Latin text stays real PDF text in the four Helvetica faces; other scripts become an image. */
async function drawRichText(env: Env, b: Built, runs: TextRun[], topLeft: Pt, size: number, baseColor: string) {
  const toPdf = (p: Pt): Pt => { const [x, y] = env.vp.convertToPdfPoint(p.x, p.y); return { x, y }; };
  if (!isLatin(plainText(runs))) {
    const pieces = runsToLines(runs).map((line) => line.map((r) => ({ ...r, color: r.color ?? baseColor })));
    if (drawShapedLines(env, b, pieces, topLeft, size)) return;
    const img = await renderRichTextImage(runs, size, baseColor);
    const embedded = await env.doc.embedPng(img.png);
    const name = `Im${Object.keys(b.resources.XObject).length}`;
    b.resources.XObject[name] = embedded.ref;
    imageOps(env.vp, b, name, { x: topLeft.x, y: topLeft.y, w: img.width, h: img.height }, 1);
    return;
  }
  const faces: Record<string, [PDFFont, string]> = {
    '': [env.helv, 'Helv'], b: [env.helvBold, 'HelvB'], i: [env.helvItalic, 'HelvI'], bi: [env.helvBoldItalic, 'HelvBI'],
  };
  let maxW = 0;
  const lines = runsToLines(runs);
  lines.forEach((line, li) => {
    const baseline = topLeft.y + size * (li + 0.85) + size * 0.15 * li;
    let x = topLeft.x;
    for (const r of line) {
      const [font, name] = faces[(r.bold ? 'b' : '') + (r.italic ? 'i' : '')];
      b.resources.Font[name] = font.ref;
      const color = r.color ?? baseColor;
      const { o, u, v } = basis(env.vp, { x, y: baseline });
      b.content.push(`BT /${name} ${f(size)} Tf ${rgbOp(color, false)} ${f(u.x)} ${f(u.y)} ${f(v.x)} ${f(v.y)} ${f(o.x)} ${f(o.y)} Tm ${hexText(r.text)} Tj ET`);
      const w = font.widthOfTextAtSize(r.text, size);
      if (r.underline) {
        const y = baseline + size * 0.12;
        const p1 = toPdf({ x, y }), p2 = toPdf({ x: x + w, y });
        b.content.push(`${rgbOp(color, true)} ${f(Math.max(0.6, size / 16))} w ${f(p1.x)} ${f(p1.y)} m ${f(p2.x)} ${f(p2.y)} l S`);
      }
      x += w;
    }
    maxW = Math.max(maxW, x - topLeft.x);
  });
  b.points.push(...rectPoints({ x: topLeft.x, y: topLeft.y, w: maxW, h: lines.length * size * 1.15 }).map(toPdf));
}

function imageOps(vp: PageViewport, b: Built, name: string, r: Rect, _opacity: number) {
  const { o } = basis(vp, { x: r.x, y: r.y + r.h });
  const [px, py] = vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
  const [qx, qy] = vp.convertToPdfPoint(r.x, r.y);
  b.content.push(`q ${f(px - o.x)} ${f(py - o.y)} ${f(qx - o.x)} ${f(qy - o.y)} ${f(o.x)} ${f(o.y)} cm /${name} Do Q`);
  b.points.push(...rectPoints(r).map((p) => { const [x, y] = vp.convertToPdfPoint(p.x, p.y); return { x, y }; }));
}

// ---------------------------------------------------------------- appearance

async function buildAppearance(env: Env, a: Annotation): Promise<Built> {
  const { vp } = env;
  const toPdf = (p: Pt): Pt => { const [x, y] = vp.convertToPdfPoint(p.x, p.y); return { x, y }; };
  const b: Built = { content: [], points: [], resources: { ExtGState: {}, Font: {}, XObject: {} } };
  const gs = (name: string, opacity: number, multiply = false) => {
    b.resources.ExtGState[name] = { Type: 'ExtGState', CA: opacity, ca: opacity, BM: multiply ? 'Multiply' : 'Normal' };
    b.content.push(`/${name} gs`);
  };
  const stroke = (pts: Pt[], close: boolean, width = a.strokeWidth) => {
    const pdf = pts.map(toPdf);
    b.points.push(...pdf);
    b.content.push(`${rgbOp(a.color, true)} ${f(width)} w 1 J 1 j ${path(pdf, close)} S`);
  };
  const fill = (pts: Pt[], color = a.color) => {
    const pdf = pts.map(toPdf);
    b.points.push(...pdf);
    b.content.push(`${rgbOp(color, false)} ${path(pdf, true)} f`);
  };

  b.content.push('q');
  switch (a.kind) {
    case 'highlight':
      gs('GS0', a.opacity, true);
      for (const r of a.rects ?? []) fill(rectPoints(r));
      break;
    case 'underline':
    case 'strikeout':
      gs('GS0', a.opacity);
      for (const r of a.rects ?? []) {
        const y = a.kind === 'underline' ? r.y + r.h * 0.92 : r.y + r.h * 0.55;
        stroke([{ x: r.x, y }, { x: r.x + r.w, y }], false, Math.max(1, a.strokeWidth));
        b.points.push(...rectPoints(r).map(toPdf));
      }
      break;
    case 'rect':
    case 'ellipse':
      gs('GS0', a.opacity);
      if (a.rect) {
        const outline = a.kind === 'rect' ? rectPoints(a.rect) : ellipsePoints(a.rect, 64);
        if (a.fill) fill(outline, a.fill);
        if (a.strokeWidth > 0) stroke(outline, true);
        else b.points.push(...outline.map(toPdf));
      }
      break;
    case 'line':
    case 'arrow':
      gs('GS0', a.opacity);
      if (a.points?.length === 2) {
        stroke(a.points, false);
        if (a.kind === 'arrow') fill(arrowHead(a.points[0], a.points[1], a.strokeWidth));
      }
      break;
    case 'ink':
      gs('GS0', a.opacity);
      for (const p of a.paths ?? []) {
        if (p.length > 1) stroke(p, false);
        else if (p.length === 1) {
          // pen tap: a dot the width of the pen
          const r = Math.max(0.5, a.strokeWidth / 2);
          fill(ellipsePoints({ x: p[0].x - r, y: p[0].y - r, w: r * 2, h: r * 2 }, 16));
        }
      }
      break;
    case 'distance':
    case 'perimeter':
    case 'area': {
      const pts = a.points ?? [];
      if (pts.length < 2) break;
      if (a.kind === 'area') {
        gs('GS1', 0.15);
        fill(pts);
      }
      gs('GS0', a.opacity);
      stroke(pts, a.kind === 'area');
      if (a.kind === 'distance') {
        // end ticks
        const [p, q] = pts;
        const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        const nx = (-(q.y - p.y) / len) * 6;
        const ny = ((q.x - p.x) / len) * 6;
        for (const e of [p, q]) stroke([{ x: e.x - nx, y: e.y - ny }, { x: e.x + nx, y: e.y + ny }], false);
      }
      const label = measureLabel(a);
      const size = 10;
      const w = env.helv.widthOfTextAtSize(label, size);
      const c = labelAnchor(a);
      const box = { x: c.x - w / 2 - 3, y: c.y - size / 2 - 3, w: w + 6, h: size + 6 };
      gs('GS2', 0.9);
      fill(rectPoints(box), '#ffffff');
      gs('GS3', 1);
      await drawText(env, b, label, { x: box.x + 3, y: box.y + 2 }, size, a.color);
      break;
    }
    case 'freetext':
      if (a.rect && a.text) {
        gs('GS0', a.opacity);
        const box = textBox(a)!;
        const callout = a.callout && a.callout.length >= 2 ? a.callout : null;
        if (a.fill) fill(rectPoints(box), a.fill);
        if (callout) {
          stroke(rectPoints(box), true);
          stroke(callout, false);
          if (/Closed/.test(a.calloutEnd ?? '')) fill(arrowHead(callout[1], callout[0], a.strokeWidth));
          else if (/Arrow/.test(a.calloutEnd ?? '')) {
            const [tip, l, r] = arrowHead(callout[1], callout[0], a.strokeWidth);
            stroke([l, tip, r], false);
          }
        }
        // Rotated text: lay out upright in the turned box, then turn it about the box centre (counter-clockwise).
        const lay = textLayoutBox(box, a.rotation);
        if (a.rotation) {
          const c = toPdf({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
          const t = (a.rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
          b.content.push(`q ${f(cos)} ${f(sin)} ${f(-sin)} ${f(cos)} ${f(c.x - cos * c.x + sin * c.y)} ${f(c.y - sin * c.x - cos * c.y)} cm`);
        }
        const lines = a.richText?.length ? runsToLines(a.richText).length : a.text.split('\n').length;
        const at = textOrigin(lay, a.rotation, a.fontSize ?? 14, lines);
        if (a.richText?.length) await drawRichText(env, b, a.richText, at, a.fontSize ?? 14, a.color);
        else await drawText(env, b, a.text, at, a.fontSize ?? 14, a.color, false, a.opacity);
        if (a.rotation) b.content.push('Q');
        b.points.push(...rectPoints(a.rect).map(toPdf));
      }
      break;
    case 'note':
      if (a.rect) {
        const r = a.rect;
        fill(rectPoints(r));
        b.content.push('0.3 0.3 0.3 RG 0.75 w ' + path(rectPoints(r).map(toPdf), true) + ' S');
        for (const [dy, frac] of [[7, 1], [12, 1], [17, 0.6]] as const)
          stroke([{ x: r.x + 5, y: r.y + dy }, { x: r.x + 5 + (r.w - 10) * frac, y: r.y + dy }], false, 1.4);
      }
      break;
    case 'stamp':
      if (a.rect) {
        gs('GS0', a.opacity);
        stroke(rectPoints(a.rect), true);
        const label = a.text ?? 'APPROVED';
        if (isLatin(label)) {
          const size = Math.min(a.rect.h * 0.55, (a.rect.w * 0.85) / Math.max(1, env.helvBold.widthOfTextAtSize(label, 1)));
          const tw = env.helvBold.widthOfTextAtSize(label, size);
          await drawText(env, b, label, { x: a.rect.x + (a.rect.w - tw) / 2, y: a.rect.y + (a.rect.h - size) / 2 }, size, a.color, true);
        } else {
          await drawText(env, b, label, { x: a.rect.x + 6, y: a.rect.y + 4 }, a.rect.h * 0.5, a.color, true);
        }
      }
      break;
    case 'redact':
      if (a.rect) b.content.push('1 0 0 RG 1 w [4 2] 0 d ' + path(rectPoints(a.rect).map(toPdf), true) + ' S');
      if (a.rect) b.points.push(...rectPoints(a.rect).map(toPdf));
      break;
    case 'signature':
      if (a.rect && a.image) {
        const img = await env.doc.embedPng(dataUrlToBytes(a.image));
        b.resources.XObject.Sig = img.ref;
        gs('GS0', a.opacity);
        imageOps(vp, b, 'Sig', a.rect, a.opacity);
      }
      break;
  }
  b.content.push('Q');
  return b;
}

function bboxOf(points: Pt[], pad: number): number[] {
  if (!points.length) return [0, 0, 0, 0];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

// ---------------------------------------------------------------- writing

const SUBTYPE: Record<Annotation['kind'], string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', rect: 'Square', ellipse: 'Circle',
  line: 'Line', arrow: 'Line', ink: 'Ink', freetext: 'FreeText', note: 'Text', stamp: 'Stamp', signature: 'Stamp',
  distance: 'Line', perimeter: 'PolyLine', area: 'Polygon', redact: 'Redact',
};

export interface WriteOptions {
  mode: 'editable' | 'flatten';
}

export async function writeAnnotations(doc: PDFDocument, viewports: PageViewport[], annotations: Annotation[], opts: WriteOptions) {
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvItalic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const helvBoldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const pages = doc.getPages();
  const ctx = doc.context;
  let n = 0;
  const needsShaping = annotations.some((a) => [a.text, a.comment, ...(a.richText ?? []).map((r) => r.text)].some((t) => t && !isLatin(t)));
  const shaper = needsShaping ? await getTextShaper() : null;
  const fonts = new EmbeddedFonts(ctx);

  for (const a of annotations) {
    const page = pages[a.page];
    const vp = viewports[a.page];
    if (!page || !vp) continue;
    // Redaction marks are instructions, never page content; they travel as /Redact annotations.
    if (a.kind === 'redact' && opts.mode === 'flatten') continue;
    const env: Env = { doc, vp, helv, helvBold, helvItalic, helvBoldItalic, shaper, fonts };
    const built = await buildAppearance(env, a);
    const bbox = bboxOf(built.points, a.strokeWidth / 2 + 2);
    const res: Record<string, unknown> = {};
    if (Object.keys(built.resources.ExtGState).length) res.ExtGState = built.resources.ExtGState;
    if (Object.keys(built.resources.Font).length) res.Font = built.resources.Font;
    if (Object.keys(built.resources.XObject).length) res.XObject = built.resources.XObject;
    const ap = ctx.register(
      ctx.flateStream(built.content.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: res as never }),
    );

    if (opts.mode === 'flatten') {
      const name = PDFName.of(`PSA${n++}_${a.id.slice(0, 6)}`);
      page.node.setXObject(name, ap);
      page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
      continue;
    }
    page.node.addAnnot(ctx.register(annotationDict(doc, page, vp, a, bbox, ap)));
  }
  fonts.finish();
}

function annotationDict(doc: PDFDocument, page: PDFPage, vp: PageViewport, a: Annotation, bbox: number[], ap: PDFRef): PDFDict {
  const ctx = doc.context;
  const toPdf = (p: Pt) => vp.convertToPdfPoint(p.x, p.y);
  const [r, g, b] = hexToRgb01(a.color);
  const date = pdfDate(a.modifiedAt);
  const text = (s: string) => PDFHexString.fromText(s);
  const fields: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: SUBTYPE[a.kind],
    Rect: bbox,
    F: 4,
    P: page.ref,
    NM: text(a.id),
    T: text(a.author),
    M: PDFString.of(date),
    CreationDate: PDFString.of(pdfDate(a.createdAt)),
    C: [r, g, b],
    CA: a.opacity,
    Border: [0, 0, a.strokeWidth],
    BS: { Type: 'Border', W: a.strokeWidth, S: 'S' },
    AP: { N: ap },
    [KEY]: text(JSON.stringify(a)),
    [KEY_M]: PDFString.of(date),
  };
  const contents = a.kind === 'freetext' ? a.text : a.kind === 'stamp' ? a.text : (a.measure ? measureLabel(a) : '') + (a.comment ? (a.measure ? '\n' : '') + a.comment : '');
  if (contents) fields.Contents = text(contents);

  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      fields.QuadPoints = (a.rects ?? []).flatMap((rc) =>
        [{ x: rc.x, y: rc.y }, { x: rc.x + rc.w, y: rc.y }, { x: rc.x, y: rc.y + rc.h }, { x: rc.x + rc.w, y: rc.y + rc.h }].flatMap(toPdf));
      break;
    case 'line':
    case 'arrow':
    case 'distance':
      fields.L = (a.points ?? []).flatMap(toPdf);
      fields.LE = ['None', a.kind === 'arrow' ? 'ClosedArrow' : 'None'];
      if (a.kind === 'arrow') fields.IC = [r, g, b];
      if (a.kind === 'distance') fields.IT = 'LineDimension';
      break;
    case 'perimeter':
    case 'area':
      fields.Vertices = (a.points ?? []).flatMap(toPdf);
      fields.IT = a.kind === 'area' ? 'PolygonDimension' : 'PolyLineDimension';
      break;
    case 'rect':
    case 'ellipse':
      if (a.fill) fields.IC = hexToRgb01(a.fill);
      break;
    case 'ink':
      fields.InkList = (a.paths ?? []).map((p) => p.flatMap(toPdf));
      break;
    case 'freetext':
      fields.DA = PDFString.of(`/Helv ${a.fontSize ?? 14} Tf ${r} ${g} ${b} rg`);
      // Rich content (Acrobat / Apryse read this to show and edit the styling).
      if (a.richText?.length) fields.RC = text(runsToXhtml(a.richText, a.color, a.fontSize ?? 14));
      break;
    case 'note':
      fields.Name = 'Comment';
      fields.Open = false;
      break;
    case 'stamp':
      fields.Name = (a.text ?? 'Approved').replace(/[^A-Za-z]/g, '') || 'Approved';
      break;
    case 'signature':
      fields.Name = 'Signature';
      break;
  }
  return ctx.obj(fields as never) as unknown as PDFDict;
}

// ---------------------------------------------------------------- reading

export const IMPORTABLE = new Set(['Highlight', 'Underline', 'StrikeOut', 'Square', 'Circle', 'Line', 'Ink', 'FreeText', 'Text', 'PolyLine', 'Polygon', 'Redact']);

export interface RawAnnot {
  page: number;
  subtype: string;
  json?: Annotation;
  rect: number[];
  color?: number[];
  /** /IC interior colour (Square, Circle) */
  ic?: number[];
  opacity: number;
  width: number;
  contents?: string;
  author?: string;
  date?: string;
  quads?: number[];
  ink?: number[][];
  line?: number[];
  le?: string[];
  vertices?: number[];
  da?: string;
  rc?: string;
  /** /NM: the annotation's name. Apryse uses it as the XFDF `name`, so saved XFDF replaces this copy instead of doubling it */
  name?: string;
}

export interface ExtractResult {
  bytes: Uint8Array;
  raw: RawAnnot[];
}

/**
 * Removes annotations we can edit from the PDF and returns them, so they are shown by our
 * editor rather than baked into the page image. Anything else (links, widgets, 3rd-party
 * stamps, file attachments…) is left untouched.
 */
export async function extractAnnotations(bytes: Uint8Array): Promise<ExtractResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return { bytes, raw: [] }; // encrypted or unparsable: render as is
  }
  const raw: RawAnnot[] = [];
  let changed = false;
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const remove = new Set<unknown>();
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = name(dict, 'Subtype');
      const ours = str(dict, KEY);
      if (!subtype || (!IMPORTABLE.has(subtype) && !ours)) continue;
      const flags = num(dict, 'F') ?? 0;
      if (flags & 2) continue; // hidden
      let json: Annotation | undefined;
      if (ours && str(dict, KEY_M) === str(dict, 'M')) {
        try { json = JSON.parse(ours); } catch { /* fall back to generic parse */ }
      }
      if (!json && !IMPORTABLE.has(subtype)) continue;
      const bs = dict.lookup(PDFName.of('BS'));
      raw.push({
        page: pageIndex,
        subtype,
        json,
        rect: nums(dict, 'Rect') ?? [0, 0, 0, 0],
        color: nums(dict, 'C'),
        ic: nums(dict, 'IC'),
        opacity: num(dict, 'CA') ?? 1,
        width: (bs instanceof PDFDict ? num(bs, 'W') : undefined) ?? nums(dict, 'Border')?.[2] ?? 1,
        contents: str(dict, 'Contents'),
        author: str(dict, 'T'),
        date: str(dict, 'M'),
        quads: nums(dict, 'QuadPoints'),
        ink: inkList(dict),
        line: nums(dict, 'L'),
        le: names(dict, 'LE'),
        vertices: nums(dict, 'Vertices'),
        da: str(dict, 'DA'),
        rc: str(dict, 'RC'),
        name: str(dict, 'NM') || undefined,
      });
      remove.add(annots.get(i));
      const popup = dict.get(PDFName.of('Popup'));
      if (popup) remove.add(popup);
    }
    if (!remove.size) return;
    const keep = annots.asArray().filter((o) => !remove.has(o));
    page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
    changed = true;
  });
  if (!changed) return { bytes, raw };
  return { bytes: await doc.save(), raw };
}

export function rawToAnnotations(raw: RawAnnot[], viewports: PageViewport[]): Annotation[] {
  const out: Annotation[] = [];
  for (const r of raw) {
    const vp = viewports[r.page];
    if (!vp) continue;
    if (r.json) {
      out.push({ ...r.json, page: r.page });
      continue;
    }
    const pt = (x: number, y: number) => { const [vx, vy] = vp.convertToViewportPoint(x, y); return { x: vx, y: vy }; };
    const pairs = (arr: number[]) => Array.from({ length: Math.floor(arr.length / 2) }, (_, i) => pt(arr[i * 2], arr[i * 2 + 1]));
    const rect = normRect(pt(r.rect[0], r.rect[1]), pt(r.rect[2], r.rect[3]));
    const now = parsePdfDate(r.date);
    const base = {
      id: r.name || uid(), page: r.page, color: colorHex(r.color) ?? '#e5484d', opacity: r.opacity, strokeWidth: r.width || 1,
      status: 'none' as const, author: r.author || 'Unknown', createdAt: now, modifiedAt: now,
    };
    switch (r.subtype) {
      case 'Highlight':
      case 'Underline':
      case 'StrikeOut': {
        const quads = r.quads?.length ? r.quads : [r.rect[0], r.rect[3], r.rect[2], r.rect[3], r.rect[0], r.rect[1], r.rect[2], r.rect[1]];
        const rects: Rect[] = [];
        for (let i = 0; i + 7 < quads.length; i += 8) {
          const ps = pairs(quads.slice(i, i + 8));
          const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
          rects.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
        }
        const kind = r.subtype === 'Highlight' ? 'highlight' : r.subtype === 'Underline' ? 'underline' : 'strikeout';
        out.push({ ...base, kind, rects, comment: r.contents, color: colorHex(r.color) ?? '#ffd84d',
          opacity: kind === 'highlight' ? Math.min(r.opacity, 0.45) : r.opacity });
        break;
      }
      case 'Square':
      case 'Circle':
        out.push({ ...base, kind: r.subtype === 'Square' ? 'rect' : 'ellipse', rect, comment: r.contents,
          ...(r.ic?.length === 3 ? { fill: colorHex(r.ic) } : {}) });
        break;
      case 'Line':
        if (r.line?.length === 4)
          out.push({ ...base, kind: r.le?.some((e) => /Arrow/.test(e)) ? 'arrow' : 'line', points: pairs(r.line), comment: r.contents });
        break;
      case 'Ink':
        if (r.ink?.length) out.push({ ...base, kind: 'ink', paths: r.ink.map(pairs), comment: r.contents });
        break;
      case 'PolyLine':
      case 'Polygon':
        if (r.vertices?.length) {
          const pts = pairs(r.vertices);
          out.push({ ...base, kind: 'ink', paths: [r.subtype === 'Polygon' ? [...pts, pts[0]] : pts], comment: r.contents });
        }
        break;
      case 'FreeText': {
        const size = Number(r.da?.match(/([\d.]+)\s+Tf/)?.[1]) || 12;
        const rgbM = r.da?.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
        const color = rgbM ? colorHex([+rgbM[1], +rgbM[2], +rgbM[3]]) : colorHex(r.color);
        const baseColor = color ?? '#111111';
        const parsed = r.rc ? xhtmlToRuns(r.rc) : null;
        const runs = parsed && relativeTo(parsed, baseColor);
        out.push({ ...base, kind: 'freetext', rect, text: runs ? plainText(runs) : r.contents ?? '', fontSize: size, color: baseColor,
          richText: runs && !isPlainRuns(runs, baseColor) ? runs : undefined });
        break;
      }
      case 'Redact':
        out.push({ ...base, kind: 'redact', rect, color: '#e5484d', opacity: 1, comment: r.contents });
        break;
      case 'Text':
        out.push({ ...base, kind: 'note', color: colorHex(r.color) ?? '#ffd84d', opacity: 1, comment: r.contents ?? '',
          rect: { x: rect.x, y: rect.y, w: 22, h: 22 } });
        break;
    }
  }
  return out;
}

// pdf-lib dictionary readers
function name(d: PDFDict, k: string) {
  const v = d.lookup(PDFName.of(k));
  return v instanceof PDFName ? v.decodeText() : undefined;
}
function names(d: PDFDict, k: string) {
  const v = d.lookup(PDFName.of(k));
  return v instanceof PDFArray ? v.asArray().map((o) => (o instanceof PDFName ? o.decodeText() : '')) : undefined;
}
function str(d: PDFDict, k: string) {
  const v = d.lookup(PDFName.of(k));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}
function num(d: PDFDict, k: string) {
  const v = d.lookup(PDFName.of(k));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}
function nums(d: PDFDict, k: string) {
  const v = d.lookup(PDFName.of(k));
  return v instanceof PDFArray ? v.asArray().map((o) => (o instanceof PDFNumber ? o.asNumber() : 0)) : undefined;
}
function inkList(d: PDFDict) {
  const v = d.lookup(PDFName.of('InkList'));
  if (!(v instanceof PDFArray)) return undefined;
  return v.asArray().map((_, i) => {
    const s = v.lookup(i);
    return s instanceof PDFArray ? s.asArray().map((o) => (o instanceof PDFNumber ? o.asNumber() : 0)) : [];
  });
}
function colorHex(c?: number[]): string | undefined {
  if (!c?.length) return undefined;
  let [r, g, b] = c;
  if (c.length === 1) r = g = b = c[0];
  if (c.length === 4) {
    const [C, M, Y, K] = c;
    [r, g, b] = [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)];
  }
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

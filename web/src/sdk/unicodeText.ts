// Real, selectable text for scripts Helvetica can't write (Hindi first).
//
// Text is shaped by a pluggable TextShaper (the web app plugs in HarfBuzz with Noto Sans Devanagari, see
// hbShaper.ts) and written as glyph ids in an embedded TrueType font (Type0 / CIDFontType2, Identity-H), with a
// ToUnicode map so readers can select, search and copy it. Without a shaper, or when the font lacks a character,
// callers fall back to drawing the text as an image, as before.
import { PDFContext, PDFHexString, PDFName, PDFRef } from 'pdf-lib';
import { isLatin } from './textImage';

export interface ShapedGlyph {
  gid: number;
  /** index into the shaped text (UTF-16) where this glyph's cluster starts */
  cluster: number;
  /** font units */
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

/** One font the shaper can lay text out in. Units are font units (upem per em). */
export interface ShapingFont {
  /** PostScript-style name without spaces, e.g. NotoSansDevanagari-Bold */
  name: string;
  upem: number;
  ascender: number;
  descender: number;
  /** xMin, yMin, xMax, yMax in font units */
  bbox: [number, number, number, number];
  /** the TrueType file, embedded as is */
  bytes: Uint8Array;
  /** default advance of a glyph (hmtx), for the PDF width table */
  advance(gid: number): number;
  /** Shapes one run of text (one script, left to right). Missing characters come back as gid 0. */
  shape(text: string): ShapedGlyph[];
}

export interface TextShaper {
  regular: ShapingFont;
  bold: ShapingFont;
}

let loader: (() => Promise<TextShaper>) | undefined;
let loaded: Promise<TextShaper | null> | undefined;

/**
 * Plugs in the shaper used for non-Latin annotation text in saved PDFs. Without one, such text is saved as an image.
 * The loader runs once, on first use; if it fails, text is saved as an image.
 */
export function setTextShaper(load: (() => Promise<TextShaper>) | undefined) {
  loader = load;
  loaded = undefined;
}

export function getTextShaper(): Promise<TextShaper | null> {
  if (!loader) return Promise.resolve(null);
  loaded ??= loader().catch((e) => {
    console.warn('PDF Studio: text shaper unavailable, non-Latin text will be saved as images.', e);
    return null;
  });
  return loaded;
}

/** A run of text written with one kind of font: Helvetica (`latin`) or the shaping font. */
export interface ScriptRun {
  text: string;
  latin: boolean;
}

const strongLatin = /[A-Za-z0-9\xC0-\xFF]/;

/**
 * Splits a line into runs that Helvetica can write and runs that need shaping. Spaces and punctuation stay with the
 * run they're in, so a Hindi phrase with spaces is shaped as one run.
 */
export function scriptRuns(line: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  for (const ch of Array.from(line)) {
    const latin = isLatin(ch);
    const strong = latin ? strongLatin.test(ch) : true;
    const last = runs[runs.length - 1];
    if (!last) runs.push({ text: ch, latin });
    else if (last.latin === latin || !strong) last.text += ch;
    else runs.push({ text: ch, latin });
  }
  // A leading neutral run (spaces, quotes) joins the next run.
  if (runs.length > 1 && !Array.from(runs[0].text).some((c) => strongLatin.test(c)) && runs[0].latin && !runs[1].latin) {
    runs[1] = { text: runs[0].text + runs[1].text, latin: false };
    runs.shift();
  }
  return runs;
}

/** A shaped run placed on a line, in page units relative to the line start. */
export interface PlacedGlyphs {
  font: ShapingFont;
  /**
   * Each glyph's pen position (x along the baseline, dy above it) in page units, and the part of the text it reads
   * as. Read in drawing order, the parts give back the text, even where a vowel sign is drawn before its consonant.
   */
  glyphs: { gid: number; text: string; x: number; dy: number }[];
  width: number;
}

/** Shapes [text] at [size] (page units); null when the font lacks one of its characters. */
export function placeGlyphs(font: ShapingFont, text: string, size: number): PlacedGlyphs | null {
  const shaped = font.shape(text);
  if (!shaped.length || shaped.some((g) => g.gid === 0)) return null;
  const k = size / font.upem;
  const parts = clusterParts(shaped, text);
  let pen = 0;
  const glyphs = shaped.map((g, i) => {
    const placed = { gid: g.gid, text: parts[i], x: (pen + g.xOffset) * k, dy: g.yOffset * k };
    pen += g.xAdvance;
    return placed;
  });
  return { font, glyphs, width: pen * k };
}

/**
 * The text each glyph reads as: a cluster's characters spread over its glyphs in drawing order, one each, the last
 * glyph taking what is left. A cluster with more glyphs than characters leaves its extra glyphs empty.
 */
function clusterParts(shaped: ShapedGlyph[], text: string): string[] {
  const starts = [...new Set(shaped.map((g) => g.cluster))].sort((a, b) => a - b);
  const clusterText = (c: number) => Array.from(text.slice(c, starts.find((s) => s > c) ?? text.length));
  const parts: string[] = new Array(shaped.length).fill('');
  const byCluster = new Map<number, number[]>();
  shaped.forEach((g, i) => byCluster.set(g.cluster, [...(byCluster.get(g.cluster) ?? []), i]));
  for (const [c, idx] of byCluster) {
    const chars = clusterText(c);
    idx.forEach((gi, j) => { parts[gi] = j === idx.length - 1 ? chars.slice(j).join('') : chars[j] ?? ''; });
  }
  return parts;
}

/**
 * The fonts of one PDF being written. Each glyph-and-text pair gets its own character code (CID), so the ToUnicode
 * map can say exactly what every drawn glyph reads as; a CIDToGIDMap points the codes at the font's glyphs. Each font
 * is written once, at [finish]; until then appearances refer to it by a reserved reference.
 */
export class EmbeddedFonts {
  private used = new Map<ShapingFont, { ref: PDFRef; name: string; codes: Map<string, number>; gids: number[]; texts: string[] }>();
  private ctx: PDFContext;

  constructor(ctx: PDFContext) {
    this.ctx = ctx;
  }

  /** The resource name, reference and character codes for drawing [glyphs] with [font]. */
  use(font: ShapingFont, glyphs: { gid: number; text: string }[]): { name: string; ref: PDFRef; codes: number[] } {
    let e = this.used.get(font);
    if (!e) {
      // code 0 stays unused (.notdef)
      e = { ref: this.ctx.nextRef(), name: `PSU${this.used.size}`, codes: new Map(), gids: [0], texts: [''] };
      this.used.set(font, e);
    }
    const entry = e;
    const codes = glyphs.map(({ gid, text }) => {
      const key = `${gid}\u0000${text}`;
      let code = entry.codes.get(key);
      if (code === undefined) {
        code = entry.gids.length;
        entry.gids.push(gid); entry.texts.push(text); entry.codes.set(key, code);
      }
      return code;
    });
    return { name: e.name, ref: e.ref, codes };
  }

  finish() {
    for (const [font, e] of this.used) this.ctx.assign(e.ref, this.fontDict(font, e.gids, e.texts));
    this.used.clear();
  }

  private fontDict(font: ShapingFont, gids: number[], texts: string[]) {
    const ctx = this.ctx;
    const k = 1000 / font.upem;
    const r = (n: number) => Math.round(n * k);
    const file = ctx.register(ctx.flateStream(font.bytes, { Length1: font.bytes.length }));
    const descriptor = ctx.register(ctx.obj({
      Type: 'FontDescriptor',
      FontName: font.name,
      Flags: 32, // non-symbolic
      FontBBox: font.bbox.map(r),
      ItalicAngle: 0,
      Ascent: r(font.ascender),
      Descent: r(font.descender),
      CapHeight: r(font.ascender * 0.7),
      StemV: 80,
      FontFile2: file,
    }));
    const cidToGid = new Uint8Array(gids.length * 2);
    gids.forEach((g, cid) => { cidToGid[cid * 2] = g >> 8; cidToGid[cid * 2 + 1] = g & 0xff; });
    const widths: (number | number[])[] = [1, gids.slice(1).map((g) => r(font.advance(g)))];
    const cid = ctx.register(ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: font.name,
      CIDSystemInfo: { Registry: PDFHexString.fromText('Adobe'), Ordering: PDFHexString.fromText('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      CIDToGIDMap: ctx.register(ctx.flateStream(cidToGid)),
      DW: 0,
      W: ctx.obj(widths as never),
    }));
    const map = new Map(texts.map((t, code) => [code, t] as const).filter(([code, t]) => code > 0 && t));
    const toUnicode = ctx.register(ctx.flateStream(toUnicodeCMap([...map.keys()], map)));
    return ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: font.name,
      Encoding: PDFName.of('Identity-H'),
      DescendantFonts: [cid],
      ToUnicode: toUnicode,
    });
  }
}

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
const utf16Hex = (s: string) => Array.from(s).map((c) => {
  const cp = c.codePointAt(0)!;
  if (cp < 0x10000) return hex4(cp);
  const v = cp - 0x10000;
  return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
}).join('');

/** A ToUnicode CMap mapping character codes to the text they read as. */
export function toUnicodeCMap(codes: number[], text: Map<number, string>): string {
  const entries = codes.filter((c) => text.get(c)).map((c) => `<${hex4(c)}> <${utf16Hex(text.get(c)!)}>`);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /PDFStudio-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/** Text as a UTF-16BE hex string (with BOM), e.g. for /ActualText. */
export const textHex = (s: string) => '<FEFF' + utf16Hex(s) + '>';

/** Character codes as a hex string for a Tj operator with an Identity-H font. */
export const glyphHex = (codes: number[]) => '<' + codes.map(hex4).join('') + '>';

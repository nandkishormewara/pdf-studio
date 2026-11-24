// Real, selectable text for scripts Helvetica can't write: Devanagari (Hindi), Arabic and Hebrew.
//
// Text is shaped by a pluggable TextShaper (the web app plugs in HarfBuzz with Noto Sans fonts, one family per script,
// see hbShaper.ts) and written as glyph ids in an embedded TrueType font (Type0 / CIDFontType2, Identity-H), with a
// ToUnicode map so readers can select, search and copy it. Each line is laid out with a small bidi algorithm, so
// right-to-left runs (Arabic, Hebrew) and the Latin words and numbers inside them land in the right visual order.
// The embedded fonts are subset (ttfSubset.ts) to the glyphs the file uses. Without a shaper, or when a font lacks a
// character (CJK, emoji, other Indic scripts...), callers fall back to drawing the text as an image, as before.
import { PDFContext, PDFHexString, PDFName, PDFRef } from 'pdf-lib';
import { isLatin } from './textImage';
import { subsetTrueType } from './ttfSubset';

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
  /** the TrueType file; the glyphs a PDF uses are subset from it when the PDF is written */
  bytes: Uint8Array;
  /** default advance of a glyph (hmtx), for the PDF width table */
  advance(gid: number): number;
  /** A glyph's outline as PDF path operators in font units (y up), for marks drawn as shapes; null if none. */
  outline?(gid: number): string | null;
  /** an empty glyph with no advance (e.g. the ZERO WIDTH JOINER's), to carry text of combining marks */
  blank?: number;
  /**
   * Shapes one run of text (one script, one direction). Glyphs come back in visual order, left to right, so a
   * right-to-left run starts with its last character. Missing characters come back as gid 0.
   */
  shape(text: string, rtl?: boolean, script?: ShapedScript): ShapedGlyph[];
}

export interface ScriptFonts {
  regular: ShapingFont;
  bold: ShapingFont;
}

/** Scripts a shaper can provide fonts for. Anything else is drawn as an image. */
export type ShapedScript = 'devanagari' | 'arabic' | 'hebrew';

export interface TextShaper {
  /** The fonts for [script], loaded on first request (so Arabic fonts aren't fetched for Hindi); null if not covered. */
  fonts(script: ShapedScript): Promise<ScriptFonts | null>;
  /** The script whose font writes punctuation and symbols Helvetica lacks (—, ₹) on lines with no other script. */
  defaultScript: ShapedScript;
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

/** The loaded fonts for one save: what drawing needs, synchronously. */
export interface ShapingFonts {
  fonts: Map<ShapedScript, ScriptFonts>;
  defaultScript: ShapedScript;
}

const isShaped = (s: CharScript): s is ShapedScript => s === 'arabic' || s === 'hebrew' || s === 'devanagari';

/** Loads the fonts [texts] need, and only those scripts' fonts. Null when there is no shaper. */
export async function loadShapingFonts(shaper: TextShaper | null, texts: string[]): Promise<ShapingFonts | null> {
  if (!shaper) return null;
  const want = new Set<ShapedScript>();
  for (const t of texts) {
    if (isLatin(t)) continue;
    let any = false;
    for (const ch of t) {
      const s = scriptOf(ch.codePointAt(0)!);
      if (isShaped(s)) { want.add(s); any = true; }
    }
    if (!any) want.add(shaper.defaultScript);
  }
  const fonts = new Map<ShapedScript, ScriptFonts>();
  await Promise.all([...want].map(async (s) => {
    const f = await shaper.fonts(s).catch((e) => {
      console.warn(`PDF Studio: no ${s} font, such text will be saved as images.`, e);
      return null;
    });
    if (f) fonts.set(s, f);
  }));
  return { fonts, defaultScript: shaper.defaultScript };
}

// ---------------------------------------------------------------- scripts and bidi

/** 'latin' = Helvetica (WinAnsi letters and digits); 'common' = spaces, punctuation, symbols, combining marks. */
export type CharScript = 'latin' | 'common' | ShapedScript | 'other';

const inRange = (cp: number, ranges: number[]) => {
  for (let i = 0; i < ranges.length; i += 2) if (cp >= ranges[i] && cp <= ranges[i + 1]) return true;
  return false;
};
const ARABIC = [0x0600, 0x06ff, 0x0750, 0x077f, 0x0870, 0x08ff, 0xfb50, 0xfdff, 0xfe70, 0xfeff];
const HEBREW = [0x0590, 0x05ff, 0xfb1d, 0xfb4f];
const DEVANAGARI = [0x0900, 0x097f, 0xa8e0, 0xa8ff, 0x1cd0, 0x1cff];
// punctuation, symbols, combining marks and format characters that any of the fonts may write
const COMMON = [0x0300, 0x036f, 0x2000, 0x2bff, 0x2e00, 0x2e7f, 0xfe00, 0xfe0f];

/** Which font writes a character. */
export function scriptOf(cp: number): CharScript {
  if (cp <= 0xff) {
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39)) return 'latin';
    if ((cp >= 0xc0 && cp !== 0xd7 && cp !== 0xf7) || cp === 0xaa || cp === 0xb5 || cp === 0xba) return 'latin';
    return 'common';
  }
  if (cp === 0xfeff) return 'common'; // byte order mark, inside the Arabic presentation forms range
  if (inRange(cp, ARABIC)) return 'arabic';
  if (inRange(cp, HEBREW)) return 'hebrew';
  if (inRange(cp, DEVANAGARI)) return 'devanagari';
  if (inRange(cp, COMMON)) return 'common';
  return 'other';
}

type BidiType = 'L' | 'R' | 'AL' | 'EN' | 'AN' | 'ES' | 'ET' | 'CS' | 'NSM' | 'WS' | 'ON';

/** Unicode bidi class of a character, for the ranges this module writes (everything else counts as L). */
export function bidiType(cp: number): BidiType {
  if (cp >= 0x30 && cp <= 0x39) return 'EN';
  if (cp === 0x20 || cp === 0x09 || cp === 0x0c || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x205f || cp === 0x3000) return 'WS';
  if (cp === 0x2b || cp === 0x2d || cp === 0x2212) return 'ES';
  if (cp === 0x23 || cp === 0x24 || cp === 0x25 || (cp >= 0xa2 && cp <= 0xa5) || cp === 0xb0 || cp === 0xb1
    || (cp >= 0x20a0 && cp <= 0x20cf) || cp === 0x066a || cp === 0x2030 || cp === 0x0609 || cp === 0x060a) return 'ET';
  if (cp === 0x2c || cp === 0x2e || cp === 0x2f || cp === 0x3a || cp === 0xa0 || cp === 0x060c || cp === 0x202f) return 'CS';
  if (cp === 0x200e) return 'L';
  if (cp === 0x200f) return 'R';
  // zero-width joiners, variation selectors and combining marks take the class of what they follow
  if ((cp >= 0x200b && cp <= 0x200d) || cp === 0xfeff || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 'NSM';
  if (cp <= 0xff) {
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp !== 0xd7 && cp !== 0xf7) || cp === 0xaa || cp === 0xb5 || cp === 0xba) return 'L';
    return 'ON';
  }
  if (inRange(cp, HEBREW)) {
    if (inRange(cp, [0x0591, 0x05bd, 0x05bf, 0x05bf, 0x05c1, 0x05c2, 0x05c4, 0x05c5, 0x05c7, 0x05c7, 0xfb1e, 0xfb1e])) return 'NSM';
    return 'R';
  }
  if (inRange(cp, ARABIC)) {
    if (inRange(cp, [0x0600, 0x0605, 0x0660, 0x0669, 0x066b, 0x066c, 0x06dd, 0x06dd, 0x0890, 0x0891, 0x08e2, 0x08e2])) return 'AN';
    if (cp >= 0x06f0 && cp <= 0x06f9) return 'EN';
    if (inRange(cp, [0x0610, 0x061a, 0x064b, 0x065f, 0x0670, 0x0670, 0x06d6, 0x06dc, 0x06df, 0x06e4, 0x06e7, 0x06e8,
      0x06ea, 0x06ed, 0x0898, 0x089f, 0x08ca, 0x08ff, 0xfe20, 0xfe2f])) return 'NSM';
    if (inRange(cp, [0x0606, 0x0608, 0x060e, 0x060f, 0x06de, 0x06de, 0x06e9, 0x06e9, 0xfd3e, 0xfd3f])) return 'ON';
    return 'AL';
  }
  if (cp >= 0x2010 && cp <= 0x2bff) return 'ON';
  return 'L';
}

/**
 * Embedding levels of one line (0 = left to right, 1 = right to left, 2 = left to right inside right to left), by
 * the Unicode bidi algorithm without explicit embeddings or isolates (UAX #9 rules P2-P3, W1-W7, N1-N2, I1-I2, L1).
 * The base direction comes from the first strong character, left to right when there is none.
 */
export function bidiLevels(cps: number[]): { levels: number[]; base: 0 | 1 } {
  const types = cps.map(bidiType);
  const first = types.find((t) => t === 'L' || t === 'R' || t === 'AL');
  const base: 0 | 1 = first === 'R' || first === 'AL' ? 1 : 0;
  const sor: BidiType = base ? 'R' : 'L';
  const n = types.length;
  // W1: marks take the class of what they follow
  for (let i = 0; i < n; i++) if (types[i] === 'NSM') types[i] = i ? types[i - 1] : sor;
  // W2: European digits after Arabic letters are Arabic numbers; W3: AL is R
  let strong: BidiType = sor;
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === 'EN' && strong === 'AL') types[i] = 'AN';
    if (t === 'L' || t === 'R' || t === 'AL') strong = t;
  }
  for (let i = 0; i < n; i++) if (types[i] === 'AL') types[i] = 'R';
  // W4: one separator between two numbers of the same kind joins them (1,000  3.5)
  for (let i = 1; i < n - 1; i++) {
    const a = types[i - 1], t = types[i], c = types[i + 1];
    if (t === 'ES' && a === 'EN' && c === 'EN') types[i] = 'EN';
    else if (t === 'CS' && (a === 'EN' || a === 'AN') && c === a) types[i] = a;
  }
  // W5: terminators next to European numbers (50%  $5) are numbers
  for (let i = 0; i < n; i++) {
    if (types[i] !== 'EN') continue;
    for (let j = i - 1; j >= 0 && types[j] === 'ET'; j--) types[j] = 'EN';
    for (let j = i + 1; j < n && types[j] === 'ET'; j++) types[j] = 'EN';
  }
  // W6: remaining separators and terminators are neutral
  for (let i = 0; i < n; i++) if (types[i] === 'ES' || types[i] === 'ET' || types[i] === 'CS') types[i] = 'ON';
  // W7: European numbers in a left-to-right context are L
  strong = sor;
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === 'EN' && strong === 'L') types[i] = 'L';
    if (t === 'L' || t === 'R') strong = t;
  }
  // N1/N2: neutrals between two of the same direction take it (numbers count as R), others the base direction
  const dirOf = (t: BidiType) => (t === 'L' ? 'L' : t === 'R' || t === 'EN' || t === 'AN' ? 'R' : null);
  for (let i = 0; i < n; i++) {
    if (dirOf(types[i])) continue;
    let end = i;
    while (end < n && !dirOf(types[end])) end++;
    const before = i ? dirOf(types[i - 1])! : sor;
    const after = end < n ? dirOf(types[end])! : sor;
    const dir: BidiType = before === after ? before : sor;
    for (let j = i; j < end; j++) types[j] = dir;
    i = end - 1;
  }
  // I1/I2
  const levels = types.map((t) => (base === 0
    ? (t === 'R' ? 1 : t === 'AN' || t === 'EN' ? 2 : 0)
    : (t === 'L' || t === 'EN' || t === 'AN' ? 2 : 1)));
  // L1: trailing whitespace goes back to the base level
  for (let i = n - 1; i >= 0 && bidiType(cps[i]) === 'WS'; i--) levels[i] = base;
  return { levels, base };
}

/** A run of text written with one font: Helvetica (`latin`) or a shaping font, in one direction. */
export interface ScriptRun {
  /** in logical order */
  text: string;
  /** written in Helvetica */
  latin: boolean;
  /** the script whose font writes it; 'latin' for Helvetica, 'other' when no font covers it (draw as an image) */
  script: CharScript;
  /** drawn right to left: shaped with RTL direction, or a Helvetica run of neutrals reversed */
  rtl: boolean;
  /** index of the styled piece of the line it comes from */
  piece: number;
}

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };

/**
 * Splits a line (given as styled pieces) into runs that one font can write, in visual order (left to right on the
 * page). Spaces and punctuation stay with the run they're in, so an Arabic or Hindi phrase with spaces is shaped as
 * one run. Right-to-left runs keep their text in logical order; the shaper returns their glyphs right to left.
 */
export function bidiRuns(pieces: string[], defaultScript: ShapedScript = 'devanagari'): ScriptRun[] {
  const chars: { ch: string; cp: number; piece: number }[] = [];
  pieces.forEach((p, piece) => { for (const ch of p) chars.push({ ch, cp: ch.codePointAt(0)!, piece }); });
  if (!chars.length) return [];
  const { levels } = bidiLevels(chars.map((c) => c.cp));
  const scripts = chars.map((c) => scriptOf(c.cp));
  const lineScript = scripts.find(isShaped);
  // Common characters join the run they're in, or at the start of a level run the run they lead into.
  for (let i = 0; i < chars.length;) {
    let end = i;
    while (end < chars.length && levels[end] === levels[i]) end++;
    let last: CharScript | undefined;
    for (let j = i; j < end; j++) {
      if (scripts[j] !== 'common') { last = scripts[j]; continue; }
      let s = last ?? scripts.slice(j, end).find((x) => x !== 'common');
      if (!s) s = chars.slice(i, end).every((c) => isLatin(c.ch)) ? 'latin' : lineScript ?? defaultScript;
      // Helvetica writes only WinAnsi: other punctuation (— ₹ ...) goes to a shaping font
      if (s === 'latin' && !isLatin(chars[j].ch)) s = lineScript ?? defaultScript;
      scripts[j] = s;
    }
    i = end;
  }
  // Logical runs: same level, script and piece.
  const logical: (ScriptRun & { level: number })[] = [];
  chars.forEach((c, i) => {
    const prev = logical[logical.length - 1];
    if (prev && prev.level === levels[i] && prev.script === scripts[i] && prev.piece === c.piece) prev.text += c.ch;
    else logical.push({ text: c.ch, latin: scripts[i] === 'latin', script: scripts[i], rtl: levels[i] % 2 === 1, piece: c.piece, level: levels[i] });
  });
  // L2: from the highest level down to 1, reverse every sequence of runs at that level or higher.
  const max = Math.max(...levels);
  for (let k = max; k >= 1; k--) {
    for (let i = 0; i < logical.length; i++) {
      if (logical[i].level < k) continue;
      let end = i;
      while (end < logical.length && logical[end].level >= k) end++;
      logical.splice(i, end - i, ...logical.slice(i, end).reverse());
      i = end - 1;
    }
  }
  return logical.map(({ level: _level, ...r }) => r);
}

/** One line split into font runs in visual order; see [bidiRuns]. */
export const scriptRuns = (line: string, defaultScript?: ShapedScript) => bidiRuns([line], defaultScript);

/** A Helvetica run as drawn: neutrals inside Arabic or Hebrew are reversed, with brackets mirrored. */
export const visualLatin = (r: ScriptRun) => (r.rtl ? Array.from(r.text).reverse().map((c) => MIRROR[c] ?? c).join('') : r.text);

// ---------------------------------------------------------------- placing glyphs

/** A shaped run placed on a line, in page units relative to the run start. */
export interface PlacedGlyphs {
  font: ShapingFont;
  /**
   * Each glyph's pen position (x along the baseline, dy above it) in page units, and the part of the text it reads
   * as. Text sits on the glyphs that advance the pen on the baseline (`carrier`): read in drawing order (left to
   * right), their parts give the run's text in visual order: its logical text for a left-to-right run (even where a
   * vowel sign is drawn before its consonant), reversed for a right-to-left run, which is what PDF readers expect
   * before they apply their own bidi to extracted text. The other glyphs (marks, Noto Sans Arabic's separate dots)
   * read as nothing; their characters belong to the carrier of their cluster.
   */
  glyphs: { gid: number; text: string; x: number; dy: number; carrier: boolean }[];
  width: number;
  rtl: boolean;
}

/** Shapes [text] at [size] (page units); null when the font lacks one of its characters. */
export function placeGlyphs(font: ShapingFont, text: string, size: number, rtl = false, script?: ShapedScript): PlacedGlyphs | null {
  const shaped = font.shape(text, rtl, script);
  if (!shaped.length || shaped.some((g) => g.gid === 0)) return null;
  const k = size / font.upem;
  const carrier = shaped.map((g) => g.xAdvance > 0 && g.yOffset === 0);
  if (!carrier.some(Boolean)) carrier[0] = true;
  const parts = clusterParts(shaped, text, rtl, carrier);
  let pen = 0;
  const glyphs: PlacedGlyphs['glyphs'] = [];
  shaped.forEach((g, i) => {
    const x = (pen + g.xOffset) * k;
    pen += g.xAdvance;
    const part = parts[i];
    // PDF.js counts a glyph whose text has a combining mark (virama, harakat, u-matra) as zero-width and then sees a
    // gap after it, which it reads as a space ("दु निया"). Such marks ride on an empty zero-width glyph next to the
    // carrier instead: before it when the part starts with them (right-to-left text), after it otherwise.
    const m = carrier[i] && font.blank !== undefined ? /^(\p{Mn}*)(\P{Mn}+)(.*)$/u.exec(part) : null;
    if (m && (m[1] || m[3])) {
      if (m[1]) glyphs.push({ gid: font.blank!, text: m[1], x, dy: 0, carrier: true });
      glyphs.push({ gid: g.gid, text: m[2], x, dy: g.yOffset * k, carrier: true });
      if (m[3]) glyphs.push({ gid: font.blank!, text: m[3], x: x + g.xAdvance * k, dy: 0, carrier: true });
    } else glyphs.push({ gid: g.gid, text: part, x, dy: g.yOffset * k, carrier: carrier[i] && part !== '' });
  });
  return { font, glyphs, width: pen * k, rtl };
}

/**
 * The text each glyph reads as: a cluster's characters spread over its carrier glyphs in drawing order, one each, the
 * last carrier taking what is left; a cluster without a carrier adds its characters to the carrier drawn before it
 * (or after, at the start of a run). In a right-to-left run the characters are spread in reverse, so the parts read in
 * drawing order give the run's text reversed (visual order): a lam-alef ligature reads "ال", which a reader's bidi
 * turns back into "لا".
 */
function clusterParts(shaped: ShapedGlyph[], text: string, rtl: boolean, carrier: boolean[]): string[] {
  const starts = [...new Set(shaped.map((g) => g.cluster))].sort((a, b) => a - b);
  // invisible format characters (ZWJ, ZWNJ) are left out: PDF.js drops a glyph whose text ends with one
  const clusterText = (c: number) => Array.from(text.slice(c, starts.find((s) => s > c) ?? text.length)).filter((ch) => !/\p{Cf}/u.test(ch));
  const parts: string[] = new Array(shaped.length).fill('');
  // clusters in drawing order (glyphs of one cluster are adjacent)
  const clusters: { c: number; idx: number[] }[] = [];
  shaped.forEach((g, i) => {
    const last = clusters[clusters.length - 1];
    if (last && last.c === g.cluster) last.idx.push(i);
    else clusters.push({ c: g.cluster, idx: [i] });
  });
  let pending = ''; // text of carrier-less clusters at the start of the run
  let lastCarrier = -1;
  const seen = new Set<number>();
  for (const { c, idx } of clusters) {
    // a cluster's text is given out once, even if its glyphs aren't drawn next to each other
    const chars = seen.has(c) ? [] : rtl ? clusterText(c).reverse() : clusterText(c);
    seen.add(c);
    const carriers = idx.filter((i) => carrier[i]);
    if (!carriers.length) {
      if (lastCarrier >= 0) parts[lastCarrier] += chars.join('');
      else pending += chars.join('');
      continue;
    }
    carriers.forEach((gi, j) => { parts[gi] = j === carriers.length - 1 ? chars.slice(j).join('') : chars[j] ?? ''; });
    if (pending) { parts[carriers[0]] = pending + parts[carriers[0]]; pending = ''; }
    lastCarrier = carriers[carriers.length - 1];
  }
  return parts;
}

// ---------------------------------------------------------------- embedding

/**
 * The fonts of one PDF being written. Each glyph-and-text pair gets its own character code (CID), so the ToUnicode
 * map can say exactly what every drawn glyph reads as; a CIDToGIDMap points the codes at the font's glyphs. Each font
 * is written once, at [finish], subset to the glyphs used; until then appearances refer to it by a reserved reference.
 */
export class EmbeddedFonts {
  private used = new Map<ShapingFont, { ref: PDFRef; name: string; codes: Map<string, number>; gids: number[]; texts: string[] }>();
  private ctx: PDFContext;
  private subset: boolean;

  /** [subset] false embeds whole font files (for comparisons). */
  constructor(ctx: PDFContext, opts: { subset?: boolean } = {}) {
    this.ctx = ctx;
    this.subset = opts.subset ?? true;
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
    // A subset font's name starts with a six-letter tag that depends on the glyphs in it (PDF 32000-1, 9.6.4).
    const bytes = this.subset ? subsetTrueType(font.bytes, gids) : font.bytes;
    const name = this.subset ? `${subsetTag(gids)}+${font.name}` : font.name;
    const file = ctx.register(ctx.flateStream(bytes, { Length1: bytes.length }));
    const descriptor = ctx.register(ctx.obj({
      Type: 'FontDescriptor',
      FontName: name,
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
      BaseFont: name,
      CIDSystemInfo: { Registry: PDFHexString.fromText('Adobe'), Ordering: PDFHexString.fromText('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      CIDToGIDMap: ctx.register(ctx.flateStream(cidToGid)),
      DW: 0,
      W: ctx.obj(widths as never),
    }));
    // Glyphs that read as nothing (a letter's separate dots, extra parts of a conjunct) map to ZERO WIDTH SPACE:
    // without a mapping PDF.js would read the character code itself; with it, PDF.js skips them (format character).
    const map = new Map(texts.map((t, code) => [code, t] as const).filter(([code, t]) => code > 0 && t));
    const toUnicode = ctx.register(ctx.flateStream(toUnicodeCMap([...map.keys()], map)));
    return ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: name,
      Encoding: PDFName.of('Identity-H'),
      DescendantFonts: [cid],
      ToUnicode: toUnicode,
    });
  }
}

/** Six capital letters derived from the glyph ids, e.g. QXHBAE. */
function subsetTag(gids: number[]): string {
  let h = 2166136261;
  for (const g of gids) h = Math.imul(h ^ g, 16777619) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
  }
  return tag;
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

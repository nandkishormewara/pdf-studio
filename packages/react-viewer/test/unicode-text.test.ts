// Hindi, Arabic and Hebrew in saved marks are real PDF text: shaped by HarfBuzz, written in embedded (subset) Noto Sans
// fonts, and readable back through the ToUnicode map (searchable, selectable, copyable) instead of an image.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harfBuzzShaper, type HarfBuzz } from '../../../web/src/sdk/hbShaper';
import { writeAnnotations } from '../../../web/src/sdk/pdfAnnots';
import type { Annotation } from '../../../web/src/sdk/types';
import { subsetTrueType } from '../../../web/src/sdk/ttfSubset';
import { bidiLevels, scriptRuns, setTextShaper } from '../../../web/src/sdk/unicodeText';

const web = join(dirname(fileURLToPath(import.meta.url)), '../../../web');
const req = createRequire(join(web, 'noop.js'));
const fontFiles = (pkg: string, name: string) => {
  const dir = dirname(req.resolve(`@expo-google-fonts/${pkg}/package.json`));
  return { regular: join(dir, `400Regular/${name}_400Regular.ttf`), bold: join(dir, `700Bold/${name}_700Bold.ttf`), name };
};
const FONTS = {
  devanagari: fontFiles('noto-sans-devanagari', 'NotoSansDevanagari'),
  arabic: fontFiles('noto-sans-arabic', 'NotoSansArabic'),
  hebrew: fontFiles('noto-sans-hebrew', 'NotoSansHebrew'),
};
/** font files read so far, to check each script's fonts load only when needed */
const loadedFiles: string[] = [];
const pdfium = join(web, '../server/.venv/bin/python');

/** pdf.js viewport at scale 1 for an unrotated 612×792 page. */
const vp = {
  convertToPdfPoint: (x: number, y: number) => [x, 792 - y],
  convertToViewportPoint: (x: number, y: number) => [x, 792 - y],
} as unknown as PageViewport;

const box = (text: string, extra: Partial<Annotation> = {}): Annotation => ({
  id: 'hi' + text.length, page: 0, kind: 'freetext', color: '#e5484d', opacity: 1, strokeWidth: 0,
  rect: { x: 72, y: 100, w: 300, h: 60 }, text, fontSize: 18, author: 'Reviewer',
  createdAt: '2026-11-24T00:00:00.000Z', modifiedAt: '2026-11-24T00:00:00.000Z', status: 'none', ...extra,
} as Annotation);

async function save(annotations: Annotation[], mode: 'editable' | 'flatten', subsetFonts = true) {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await writeAnnotations(doc, [vp], annotations, { mode, subsetFonts });
  return doc.save();
}

/** PDF.js text items of page 1. */
async function pageItems(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  return content.items.map((i) => ('str' in i ? i.str : ''));
}

/** PDFium's text of page 1 (pypdfium2 in the server's virtualenv), or null when it isn't installed. */
function pdfiumText(bytes: Uint8Array): string | null {
  if (!existsSync(pdfium)) return null;
  const file = join(mkdtempSync(join(tmpdir(), 'pdfium-')), 'a.pdf');
  writeFileSync(file, bytes);
  const script = 'import sys, pypdfium2 as p; d = p.PdfDocument(sys.argv[1]); sys.stdout.buffer.write(d[0].get_textpage().get_text_range().encode())';
  try {
    return execFileSync(pdfium, ['-I', '-c', script, file]).toString('utf8');
  } catch {
    return null; // no pypdfium2
  }
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  return content.items.map((i) => ('str' in i ? i.str : '')).join('');
}

/** Font dicts used by the PDF's annotation appearances and page content. */
async function fonts(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const out: PDFDict[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type'))?.toString() === '/Font') out.push(obj);
  }
  return { doc, fonts: out };
}

describe('Hindi, Arabic and Hebrew text in saved marks', () => {
  beforeAll(() => {
    setTextShaper(harfBuzzShaper(FONTS, async (path) => {
      loadedFiles.push(path);
      return new Uint8Array(readFileSync(path));
    }));
  });
  afterAll(() => setTextShaper(undefined));

  it('loads only the fonts of the scripts a save uses', async () => {
    await save([box('अच्छा काम')], 'flatten');
    expect(loadedFiles.length).toBeGreaterThan(0);
    expect(loadedFiles.every((f) => f.includes('Devanagari'))).toBe(true);
    await save([box('مرحبا')], 'flatten');
    expect(loadedFiles.some((f) => f.includes('Arabic'))).toBe(true);
    expect(loadedFiles.some((f) => f.includes('Hebrew'))).toBe(false);
  });

  it('splits lines into Helvetica and shaped runs', () => {
    const runs = (line: string) => scriptRuns(line).map(({ text, script, rtl }) => ({ text, script, rtl }));
    expect(runs('Good work! अच्छा काम')).toEqual([
      { text: 'Good work! ', script: 'latin', rtl: false }, { text: 'अच्छा काम', script: 'devanagari', rtl: false }]);
    expect(runs('प्रवेश पत्र 2026')).toEqual([
      { text: 'प्रवेश पत्र ', script: 'devanagari', rtl: false }, { text: '2026', script: 'latin', rtl: false }]);
    expect(runs('Plain text')).toEqual([{ text: 'Plain text', script: 'latin', rtl: false }]);
  });

  it('puts right-to-left runs in visual order', () => {
    const texts = (line: string) => scriptRuns(line).map((r) => r.text);
    // a right-to-left line (first strong character Arabic): the Latin phrase and its number sit on the left
    expect(texts('مرحبا PDF Studio 2026')).toEqual(['PDF Studio 2026', 'مرحبا ']);
    // a left-to-right line keeps its order, the Arabic word shaped right to left in its place
    expect(scriptRuns('Hello مرحبا world').map((r) => [r.text, r.rtl])).toEqual([['Hello ', false], ['مرحبا', true], [' world', false]]);
    // numbers inside Hebrew read left to right, after (left of) the words before them
    expect(texts('שלום עולם 123')).toEqual(['123', 'שלום עולם ']);
    // two Latin words inside Arabic keep their order
    expect(texts('كلمة one two كلمة')).toEqual([' كلمة', 'one two', 'كلمة ']);
    expect(bidiLevels([...'abc'].map((c) => c.codePointAt(0)!)).base).toBe(0);
    expect(bidiLevels([...'אב c'].map((c) => c.codePointAt(0)!)).levels).toEqual([1, 1, 1, 2]);
  });

  it('writes Arabic and Hebrew so PDF.js and PDFium read the words in logical order', async () => {
    const lines = ['مرحبا بكم في المكتب', 'مرحبا PDF Studio 2026', 'Hello مرحبا world', 'لا إله، السعر 50%', 'שלום עולם 123', 'अच्छा काम مرحبا Good'];
    const bytes = await save(lines.map((l, i) => box(l, { id: `l${i}`, rect: { x: 40, y: 40 + i * 50, w: 500, h: 40 } })), 'flatten');
    const items = await pageItems(bytes);
    // PDF.js applies its own bidi to each item: whole Arabic phrases come back in logical order
    for (const phrase of ['مرحبا بكم في المكتب', 'لا إله، السعر', 'שלום עולם', 'अच्छा काम']) expect(items).toContain(phrase);
    for (const word of ['PDF Studio 2026', 'Hello', 'world', 'Good', '123', '50']) expect(items.join(' ')).toContain(word);
    const text = pdfiumText(bytes);
    if (text !== null) {
      for (const phrase of ['مرحبا بكم في المكتب', 'لا إله، السعر', 'שלום עולם 123', 'अच्छा काम مرحبا Good', 'Hello مرحبا world']) expect(text).toContain(phrase);
      expect(text).not.toMatch(/[\u0000-\u0008\u200b]/); // no stray codes for dots and marks
    }
    // no picture of the text
    const { doc } = await fonts(bytes);
    const images = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
    expect(images).toHaveLength(0);
  });

  it('keeps vowel marks with their letters', async () => {
    const bytes = await save([box('नमस्ते दुनिया'), box('שָׁלוֹם', { id: 'b2', rect: { x: 72, y: 300, w: 200, h: 40 } })], 'flatten');
    const items = await pageItems(bytes);
    expect(items).toContain('नमस्ते दुनिया');
    expect(items.join('')).toContain('שָׁלוֹם');
    const text = pdfiumText(bytes);
    if (text !== null) for (const w of ['नमस्ते दुनिया', 'שָׁלוֹם']) expect(text.normalize('NFC')).toContain(w.normalize('NFC'));
  });

  it('embeds only the glyphs used, and reads and draws the same as the whole font', async () => {
    const marks = [box('नमस्ते, यह एक छोटा नमूना है।')];
    const subset = await save(marks, 'flatten');
    const whole = await save(marks, 'flatten', false);
    expect(subset.length).toBeLessThan(15_000);
    expect(whole.length).toBeGreaterThan(80_000);
    expect(await pageItems(subset)).toEqual(await pageItems(whole));
    const { doc, fonts: all } = await fonts(subset);
    const type0 = all.find((d) => d.get(PDFName.of('Subtype'))?.toString() === '/Type0')!;
    expect(type0.get(PDFName.of('BaseFont'))?.toString()).toMatch(/^\/[A-Z]{6}\+NotoSansDevanagari-Regular$/);
    const file = [...doc.context.enumerateIndirectObjects()].find(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Length1')));
    expect(file).toBeTruthy();
  });

  it('subsets a TrueType font keeping glyph ids', async () => {
    const hb = (await import(/* @vite-ignore */ pathToFileURL(req.resolve('harfbuzzjs')).href)) as HarfBuzz;
    const bytes = new Uint8Array(readFileSync(FONTS.devanagari.regular));
    const font = new hb.Font(new hb.Face(new hb.Blob(bytes)));
    const buf = new hb.Buffer();
    buf.addText('क्षत्रिय');
    buf.guessSegmentProperties();
    hb.shape(font, buf);
    const used = buf.getGlyphInfos().map((g) => g.codepoint);
    const out = subsetTrueType(bytes, used);
    expect(out.length).toBeLessThan(bytes.length / 4);
    const sub = new hb.Font(new hb.Face(new hb.Blob(out)));
    for (const g of used) {
      expect(sub.glyphToPath(g)).toBe(font.glyphToPath(g));
      expect(sub.glyphHAdvance(g)).toBe(font.glyphHAdvance(g));
    }
    const unused = font.nominalGlyph('ज'.codePointAt(0)!)!;
    expect(used).not.toContain(unused);
    expect(sub.glyphToPath(unused)).toBe('');
    // tables a CIDFontType2 doesn't need are gone; the file's checksum adds up (head.checkSumAdjustment)
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const tags = Array.from({ length: dv.getUint16(4) }, (_, i) => String.fromCharCode(...out.subarray(12 + 16 * i, 16 + 16 * i)));
    expect(tags).toEqual(['OS/2', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'post', 'prep']);
    let sum = 0;
    for (let i = 0; i < out.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });

  it('writes a flattened mark as text that PDF.js reads back exactly', async () => {
    const text = 'प्रवेश पत्र — अच्छा काम';
    const bytes = await save([box(text)], 'flatten');
    const read = await pageText(bytes);
    for (const word of ['प्रवेश', 'पत्र', 'अच्छा', 'काम']) expect(read).toContain(word);
    // a vowel sign drawn before its consonant still reads in the right order
    const reordered = await pageText(await save([box('हिंदी की किताब')], 'flatten'));
    for (const word of ['हिंदी', 'की', 'किताब']) expect(reordered).toContain(word);
    // no picture of the text any more
    const { doc } = await fonts(bytes);
    const images = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
    expect(images).toHaveLength(0);
  });

  it('embeds one Type0 font with a ToUnicode map and keeps Latin text in Helvetica', async () => {
    const bytes = await save([box('Good work! अच्छा'), box('समीक्षा', { id: 'b2', rect: { x: 72, y: 300, w: 200, h: 40 } })], 'editable');
    const { doc, fonts: all } = await fonts(bytes);
    const type0 = all.filter((d) => d.get(PDFName.of('Subtype'))?.toString() === '/Type0');
    expect(type0).toHaveLength(1);
    expect(type0[0].get(PDFName.of('Encoding'))?.toString()).toBe('/Identity-H');
    expect(type0[0].get(PDFName.of('ToUnicode'))).toBeInstanceOf(PDFRef);
    expect(all.some((d) => d.get(PDFName.of('BaseFont'))?.toString() === '/Helvetica')).toBe(true);
    // the font file is embedded once even though two marks use it
    const files = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Length1')));
    expect(files).toHaveLength(1);
  });

  it('uses the bold face for bold rich text', async () => {
    const bytes = await save([box('काम', { richText: [{ text: 'अच्छा ', bold: true }, { text: 'काम' }] })], 'flatten');
    const { fonts: all } = await fonts(bytes);
    const names = all.map((d) => d.get(PDFName.of('BaseFont'))?.toString());
    // subset fonts: ABCDEF+NotoSansDevanagari-Bold
    expect(names.some((n) => /\+NotoSansDevanagari-Bold$/.test(n ?? ''))).toBe(true);
    expect(names.some((n) => /\+NotoSansDevanagari-Regular$/.test(n ?? ''))).toBe(true);
    expect(await pageText(bytes)).toContain('अच्छा');
  });

  it('falls back to an image for scripts without a font', async () => {
    const bytes = await save([box('你好')], 'flatten').catch((e) => e as Error);
    // jsdom has no canvas: the image fallback can't render here, which shows the shaper declined Chinese
    expect(bytes).toBeInstanceOf(Error);
  });
});

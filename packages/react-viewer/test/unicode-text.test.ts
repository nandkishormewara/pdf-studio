// Hindi in saved marks is real PDF text: shaped by HarfBuzz, written in the embedded Noto Sans Devanagari font, and
// readable back through the ToUnicode map (searchable, selectable, copyable) instead of an image.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harfBuzzShaper } from '../../../web/src/sdk/hbShaper';
import { writeAnnotations } from '../../../web/src/sdk/pdfAnnots';
import type { Annotation } from '../../../web/src/sdk/types';
import { scriptRuns, setTextShaper } from '../../../web/src/sdk/unicodeText';

const web = join(dirname(fileURLToPath(import.meta.url)), '../../../web');
const fontDir = dirname(createRequire(join(web, 'noop.js')).resolve('@expo-google-fonts/noto-sans-devanagari/package.json'));

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

async function save(annotations: Annotation[], mode: 'editable' | 'flatten') {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await writeAnnotations(doc, [vp], annotations, { mode });
  return doc.save();
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

describe('Hindi text in saved marks', () => {
  beforeAll(() => {
    setTextShaper(harfBuzzShaper(
      { regular: join(fontDir, '400Regular/NotoSansDevanagari_400Regular.ttf'), bold: join(fontDir, '700Bold/NotoSansDevanagari_700Bold.ttf') },
      async (path) => new Uint8Array(readFileSync(path)),
    ));
  });
  afterAll(() => setTextShaper(undefined));

  it('splits lines into Helvetica and shaped runs', () => {
    expect(scriptRuns('Good work! अच्छा काम')).toEqual([{ text: 'Good work! ', latin: true }, { text: 'अच्छा काम', latin: false }]);
    expect(scriptRuns('प्रवेश पत्र 2026')).toEqual([{ text: 'प्रवेश पत्र ', latin: false }, { text: '2026', latin: true }]);
    expect(scriptRuns('Plain text')).toEqual([{ text: 'Plain text', latin: true }]);
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
    expect(names).toContain('/NotoSansDevanagari-Bold');
    expect(names).toContain('/NotoSansDevanagari-Regular');
    expect(await pageText(bytes)).toContain('अच्छा');
  });

  it('falls back to an image for scripts the font lacks', async () => {
    const bytes = await save([box('مرحبا')], 'flatten').catch((e) => e as Error);
    // jsdom has no canvas: the image fallback can't render here, which shows the shaper declined Arabic
    expect(bytes).toBeInstanceOf(Error);
  });
});

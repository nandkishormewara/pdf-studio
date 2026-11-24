import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormValues } from '../../../web/src/sdk/types';
import { createPdfWebViewerHandle } from '../src/handle';
import type { ViewerInstance } from '../src/handle';
import type { PdfWebViewerHandle } from '../src/types';
import type { ViewerAnnotation, ViewportLike } from '../src/xfdfCompat';

// jsdom has no canvas; non-Latin free text is drawn through one when flattening. A 1×1 PNG is enough here.
vi.mock('../../../web/src/sdk/textImage', async (orig) => ({
  ...(await orig<typeof import('../../../web/src/sdk/textImage')>()),
  renderTextImage: async () => ({
    png: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)),
    width: 10, height: 10,
  }),
}));

const shared = resolve(import.meta.dirname, '../../../mobile/shared/xfdf');
const fixture = (name: string) => readFileSync(resolve(shared, name), 'utf8');
const expected = JSON.parse(fixture('expected.json'));

/** pdf.js viewport at scale 1 for an unrotated page: PDF y grows up, page units grow down. */
function viewport(height: number): ViewportLike {
  return {
    convertToPdfPoint: (x: number, y: number) => [x, height - y],
    convertToViewportPoint: (x: number, y: number) => [x, height - y],
  } as ViewportLike;
}

/** A stand-in for the mounted viewer: a 2-page 612×792 document, as expected.json assumes. */
async function makeInstance() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  const bytes = await pdf.save();
  const state = { annotations: [] as ViewerAnnotation[], fields: {} as FormValues };
  const loadDocument = vi.fn(async () => {});
  const instance: ViewerInstance = {
    getDocument: () => ({ bytes, viewports: [viewport(792), viewport(792)] }),
    getAnnotations: () => state.annotations,
    setAnnotations: (list) => { state.annotations = list; },
    getFormValues: () => state.fields,
    setFormValues: (v) => { state.fields = v; },
    loadDocument,
  };
  return { instance, state, loadDocument, handle: createPdfWebViewerHandle(instance) };
}

/** jsdom's Blob has no arrayBuffer(); FileReader works everywhere. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((ok, fail) => {
    const reader = new FileReader();
    reader.onload = () => ok(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => fail(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const round = (r: { x: number; y: number; w: number; h: number }) => [r.x, r.y, r.w, r.h].map((v) => Math.round(v));
const firstPoint = (a: ViewerAnnotation) => {
  const p = a.points?.[0] ?? a.paths?.[0]?.[0];
  return p ? [Math.round(p.x), Math.round(p.y)] : undefined;
};

/** Checks one annotation against an expected.json entry (same keys every SDK checks). */
function checkAnnotation(a: ViewerAnnotation | undefined, want: Record<string, unknown>) {
  expect(a, JSON.stringify(want)).toBeDefined();
  for (const [key, value] of Object.entries(want)) {
    switch (key) {
      case 'rect': {
        const box = a!.rect ?? a!.rects?.[0];
        expect(round(box!)).toEqual(value);
        break;
      }
      case 'firstPoint':
        expect(firstPoint(a!)).toEqual(value);
        break;
      case 'paths':
        expect(a!.paths?.length).toBe(value);
        break;
      case 'pointsInFirstPath':
        expect(a!.paths?.[0].length).toBe(value);
        break;
      case 'opacity':
        expect(a!.opacity).toBeCloseTo(value as number, 2);
        break;
      default:
        expect((a as unknown as Record<string, unknown>)[key]).toEqual(value);
    }
  }
}

function checkAfterAnnots(list: ViewerAnnotation[], fields: FormValues) {
  const want = expected.afterAnnots;
  expect(list).toHaveLength(want.count);
  for (const [id, entry] of Object.entries(want.byId)) checkAnnotation(list.find((a) => a.id === id), entry as Record<string, unknown>);
  for (const id of want.absent) expect(list.find((a) => a.id === id)).toBeUndefined();
  expect(fields).toEqual(want.fields);
}

describe('handle.importAnnotations with the shared Apryse fixtures', () => {
  let ctx: Awaited<ReturnType<typeof makeInstance>>;
  beforeEach(async () => { ctx = await makeInstance(); });

  it('imports apryse-annots.xfdf as expected.json says', async () => {
    await ctx.handle.importAnnotations(fixture('apryse-annots.xfdf'));
    checkAfterAnnots(ctx.state.annotations, ctx.state.fields);
  });

  it('remembers the Apryse types PDF Studio has no kind for', async () => {
    await ctx.handle.importAnnotations(fixture('apryse-annots.xfdf'));
    const byId = (id: string) => ctx.state.annotations.find((a) => a.id === id)!;
    expect(byId('f-sq-1').subtype).toBe('squiggly');
    expect(byId('f-poly-1').subtype).toBe('polygon');
    expect(byId('f-ink-1').subtype).toBeUndefined();
  });

  it('applies apryse-commands.xfdf (<add>/<modify>/<delete>) on top', async () => {
    await ctx.handle.importAnnotations(fixture('apryse-annots.xfdf'));
    await ctx.handle.importAnnotations(fixture('apryse-commands.xfdf'));
    const want = expected.afterCommands;
    const list = ctx.state.annotations;
    expect(list).toHaveLength(want.count);
    expect(list.find((a) => a.id === want.added)).toBeDefined();
    expect(list.find((a) => a.id === want.removed)).toBeUndefined();
    const { id, ...modified } = want.modified;
    checkAnnotation(list.find((a) => a.id === id), modified);
  });

  it('ignores empty input', async () => {
    await ctx.handle.importAnnotations('   ');
    expect(ctx.state.annotations).toHaveLength(0);
  });

  it('rejects malformed XFDF without touching existing marks', async () => {
    await ctx.handle.importAnnotations(fixture('apryse-annots.xfdf'));
    await expect(ctx.handle.importAnnotations('<nope')).rejects.toThrow(/not valid XFDF/);
    expect(ctx.state.annotations).toHaveLength(expected.afterAnnots.count);
  });

  it('folds WebViewer replies into the parent comment', async () => {
    await ctx.handle.importAnnotations(`<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>
      <text page="0" rect="10,10,30,30" name="n1" title="Reviewer"><contents>Check this</contents></text>
      <text page="0" rect="10,10,30,30" name="r1" inreplyto="n1" title="Student"><contents>Done</contents></text>
    </annots></xfdf>`);
    expect(ctx.state.annotations).toHaveLength(1);
    expect(ctx.state.annotations[0].comment).toBe('Check this\nStudent: Done');
  });
});

describe('handle.exportXfdf', () => {
  let ctx: Awaited<ReturnType<typeof makeInstance>>;
  let exported: string;
  beforeEach(async () => {
    ctx = await makeInstance();
    await ctx.handle.importAnnotations(fixture('apryse-annots.xfdf'));
    exported = await ctx.handle.exportXfdf();
  });

  const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
  const element = (xml: string, name: string) =>
    Array.from(parse(xml).getElementsByTagNameNS('*', 'annots')[0].children).find((e) => e.getAttribute('name') === name)!;

  it('is well-formed XFDF in the Adobe namespace', () => {
    const doc = parse(exported);
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.localName).toBe('xfdf');
    expect(doc.documentElement.namespaceURI).toBe('http://ns.adobe.com/xfdf/');
  });

  it('writes squiggly and polygon back as Apryse wrote them', () => {
    const sq = element(exported, 'f-sq-1');
    expect(sq.localName).toBe('squiggly');
    expect(sq.getAttribute('coords')?.split(',').map(Number)).toEqual([70, 664, 180, 664, 70, 650, 180, 650]);
    const poly = element(exported, 'f-poly-1');
    expect(poly.localName).toBe('polygon');
    expect(poly.getElementsByTagNameNS('*', 'vertices')[0].textContent).toBe('100,200;200,200;150,280');
    expect(poly.getElementsByTagNameNS('*', 'inklist')).toHaveLength(0);
  });

  it('writes free text the way WebViewer reads it (TextColor, FontSize, no border colour)', () => {
    const ft = element(exported, 'f-ft-1');
    expect(ft.getAttribute('TextColor')).toBe('#E44234');
    expect(ft.getAttribute('FontSize')).toBe('16');
    expect(ft.hasAttribute('color')).toBe(false);
    expect(ft.getElementsByTagNameNS('*', 'contents')[0].textContent).toBe('Good work! अच्छा');
  });

  it('keeps PDF coordinates of the source XFDF', () => {
    expect(element(exported, 'f-box-1').getAttribute('rect')).toBe('300,500,420,560');
    const arrow = element(exported, 'f-arrow-1');
    expect([arrow.getAttribute('start'), arrow.getAttribute('end')]).toEqual(['100,450', '300,470']);
    expect(element(exported, 'f-ink-1').getElementsByTagNameNS('*', 'gesture')[0].textContent).toBe('100,600;130,640;160,610;200,660');
  });

  it('round-trips: importing the export reproduces expected.json', async () => {
    const fresh = await makeInstance();
    await fresh.handle.importAnnotations(exported);
    checkAfterAnnots(fresh.state.annotations, fresh.state.fields);
    expect(fresh.state.annotations.find((a) => a.id === 'f-sq-1')?.subtype).toBe('squiggly');
    expect(fresh.state.annotations.find((a) => a.id === 'f-poly-1')?.subtype).toBe('polygon');
  });

  it('writes clouds as cloudy polygons and polylines as polylines', async () => {
    const fresh = await makeInstance();
    const base = { page: 0, color: '#e44234', opacity: 1, strokeWidth: 2, status: 'none' as const, author: 'Reviewer',
      createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z', kind: 'ink' as const };
    const tri = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 150, y: 180 }];
    fresh.state.annotations = [
      { ...base, id: 'cloud-1', subtype: 'cloud', paths: [[...tri, tri[0]]] },
      { ...base, id: 'pl-1', subtype: 'polyline', paths: [tri] },
    ];
    const xml = await fresh.handle.exportXfdf();
    const cloud = element(xml, 'cloud-1');
    expect(cloud.localName).toBe('polygon');
    expect(cloud.getAttribute('style')).toBe('cloudy');
    expect(cloud.getElementsByTagNameNS('*', 'vertices')[0].textContent).toBe('100,692;200,692;150,612');
    expect(element(xml, 'pl-1').localName).toBe('polyline');

    const again = await makeInstance();
    await again.handle.importAnnotations(xml);
    expect(again.state.annotations.map((a) => [a.id, a.kind, a.subtype])).toEqual([['cloud-1', 'ink', 'cloud'], ['pl-1', 'ink', 'polyline']]);
  });

  it('returns an empty XFDF document when nothing is loaded', async () => {
    const handle = createPdfWebViewerHandle({ ...ctx.instance, getDocument: () => null });
    const xml = await handle.exportXfdf();
    expect(parse(xml).documentElement.localName).toBe('xfdf');
  });
});

describe('handle.exportAnnotatedPdf', () => {
  it('returns a flattened PDF blob with the same pages', async () => {
    const { handle } = await makeInstance();
    await handle.importAnnotations(fixture('apryse-annots.xfdf'));
    const blob = await handle.exportAnnotatedPdf();
    expect(blob.type).toBe('application/pdf');
    const bytes = await blobBytes(blob);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    // flattened: drawn into the page, no annotation objects left behind
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it('fails clearly without a document', async () => {
    const { instance } = await makeInstance();
    const handle: PdfWebViewerHandle = createPdfWebViewerHandle({ ...instance, getDocument: () => null });
    await expect(handle.exportAnnotatedPdf()).rejects.toThrow('No document loaded.');
    await expect(handle.importAnnotations(fixture('apryse-annots.xfdf'))).rejects.toThrow('No document loaded.');
  });
});

describe('handle.loadDocument', () => {
  it('passes url and options to the viewer', async () => {
    const { handle, loadDocument } = await makeInstance();
    const opts = { extension: 'pdf', customHeaders: { Authorization: 'Bearer x', 'session-id': 's' } };
    await handle.loadDocument('https://example.test/stream/1', opts);
    expect(loadDocument).toHaveBeenCalledWith('https://example.test/stream/1', opts);
  });
});

import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { extractAnnotations, rawToAnnotations } from '../../../web/src/sdk/pdfAnnots';
import { wrapRuns } from '../../../web/src/sdk/richtext';
import { mergeXfdf } from '../../../web/src/sdk/xfdf';
import { exportXfdf, importXfdf } from '../src/xfdfCompat';
import type { ViewportLike } from '../src/xfdfCompat';
import type { PageViewport } from 'pdfjs-dist';

// Cases found in real-world XFDF saved by Apryse WebViewer 7.2.
// Each one rendered differently from WebViewer, or was dropped, before this was fixed.

/** pdf.js viewport at scale 1 for an unrotated 612×792 page. */
const vp = {
  convertToPdfPoint: (x: number, y: number) => [x, 792 - y],
  convertToViewportPoint: (x: number, y: number) => [x, 792 - y],
} as ViewportLike;
const vps = [vp, vp];
// rawToAnnotations is typed for full pdf.js viewports but only uses the two conversions above.
const pdfVps = vps as unknown as PageViewport[];

const xfdf = (annots: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><fields/><annots>${annots}</annots></xfdf>`;
const exported = (list: ReturnType<typeof importXfdf>['annotations']) =>
  new DOMParser().parseFromString(exportXfdf(list, vps), 'application/xml');
const first = (doc: Document, tag: string) => doc.getElementsByTagNameNS('*', tag)[0];

describe('Apryse WebViewer markup', () => {
  it('keeps the fill of filled boxes (interior-color) and writes it back', () => {
    const { annotations: [box] } = importXfdf(xfdf(
      `<square page="0" rect="100,500,200,540" color="#E2A1E6" interior-color="#F1A099" opacity="0.354637" width="1.94" name="b1" title="T"/>`,
    ), vps);
    expect(box).toMatchObject({ kind: 'rect', fill: '#f1a099', color: '#e2a1e6', opacity: 0.354637 });
    expect(first(exported([box]), 'square').getAttribute('interior-color')).toBe('#F1A099');
  });

  it('reads free text `color` as the box background, except on typewriter text', () => {
    const style = '<defaultstyle>font: Helvetica 12pt; text-align: left; color: #007A3B</defaultstyle>';
    const { annotations: [boxed, typed] } = importXfdf(xfdf(
      `<freetext page="0" rect="57,466,556,488" color="#FFFFFF" TextColor="#007A3B" name="w1" title="T"><contents>glucose</contents>${style}</freetext>` +
      `<freetext page="0" rect="123,689,168,701" color="#0078D4" TextColor="#0077D4" IT="FreeTextTypewriter" name="t1" title="T"><contents>John Doe</contents>${style}</freetext>`,
    ), vps);
    expect(boxed).toMatchObject({ kind: 'freetext', color: '#007a3b', fill: '#ffffff' });
    expect(typed.fill).toBeUndefined();
    expect(typed.intent).toBe('FreeTextTypewriter');
    const doc = exported([boxed, typed]);
    const [w, t] = Array.from(doc.getElementsByTagNameNS('*', 'freetext'));
    expect(w.getAttribute('color')).toBe('#FFFFFF');
    expect(w.getAttribute('TextColor')).toBe('#007A3B');
    expect(t.hasAttribute('color')).toBe(false);
    expect(t.getAttribute('IT')).toBe('FreeTextTypewriter');
  });

  it('keeps PDF Studio’s own older free text, where `color` was the text colour, unfilled', () => {
    const { annotations: [a] } = importXfdf(xfdf(
      `<freetext page="0" rect="10,10,90,30" color="#E5484D" name="o1" title="T"><contents>old</contents><defaultappearance>/Helv 14 Tf 0.9 0.28 0.3 rg</defaultappearance></freetext>`,
    ), vps);
    expect(a.fill).toBeUndefined();
  });

  it('keeps the rotation of free text written on sideways pages', () => {
    const { annotations: [a] } = importXfdf(xfdf(
      `<freetext page="0" rect="172.38,217.84,185.46,234.6" rotation="90" TextColor="#E44234" FontSize="12" width="0" name="r1" title="T"><contents>1</contents></freetext>`,
    ), vps);
    expect(a.rotation).toBe(90);
    expect(first(exported([a]), 'freetext').getAttribute('rotation')).toBe('90');
  });

  it('reads callouts: leader line, open arrow and the text box inside the fringe', () => {
    const { annotations: [a] } = importXfdf(xfdf(
      `<freetext page="1" rect="74.509,406.72,305.18,447.48" fringe="0.5,10.26,80.171,0.5" callout="304.68,408.29,267,407.22,225.01,431.98"
        head="OpenArrow" IT="FreeTextCallout" color="#FFFFFF" name="c1" title="T"><contents>ans: 60 degree</contents>
        <defaultstyle>font: Helvetica 9pt; color: #E44234</defaultstyle></freetext>`,
    ), vps);
    expect(a.callout).toHaveLength(3);
    expect(a.callout![0].x).toBeCloseTo(304.68);
    expect(a.callout![0].y).toBeCloseTo(792 - 408.29);
    expect(a.calloutEnd).toBe('OpenArrow');
    expect(a.fill).toBe('#ffffff');
    // text box: rect less the fringe, which Apryse writes as left, bottom, right, top (0.5, 10.26, 80.171, 0.5)
    expect(a.inset!.map((v) => Math.round(v * 100) / 100)).toEqual([0.5, 0.5, 80.17, 10.26]);
    // as WebViewer draws it, the leader line ends half-way down the box
    expect(a.callout![2].y).toBeCloseTo(a.rect!.y + a.inset![1] + (a.rect!.h - a.inset![1] - a.inset![3]) / 2, 1);
    const out = first(exported([a]), 'freetext');
    expect(out.getAttribute('callout')).toBe('304.68,408.29,267,407.22,225.01,431.98');
    expect(out.getAttribute('head')).toBe('OpenArrow');
    expect(out.getAttribute('fringe')).toBe('0.5,10.26,80.17,0.5');
    expect(out.getAttribute('IT')).toBe('FreeTextCallout');
  });

  it('draws grouped marks (replyType="group") instead of folding them into a comment', () => {
    const { annotations } = importXfdf(xfdf(
      `<line page="0" rect="10,10,60,60" start="10,10" end="60,60" name="g1" title="T"/>` +
      `<line page="0" rect="60,60,90,90" start="60,60" end="90,90" inreplyto="g1" replyType="group" name="g2" title="T"/>` +
      `<text page="0" rect="10,10,30,30" inreplyto="g1" name="r1" title="Student"><contents>Done</contents></text>`,
    ), vps);
    expect(annotations.map((a) => a.id)).toEqual(['g1', 'g2']);
    expect(annotations[0].comment).toBe('Student: Done');
  });

  it('keeps pen taps (one-point strokes) and draws them as dots', async () => {
    // one-point strokes are common: decimal points, full stops, the dot of an i
    const { annotations: [ink] } = importXfdf(xfdf(
      '<ink page="0" rect="0,0,50,50" width="3.4" name="d1" title="T"><inklist><gesture>10,10;20,20</gesture><gesture>30,30</gesture></inklist></ink>',
    ), vps);
    expect(ink.paths!.map((p) => p.length)).toEqual([2, 1]);
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { AnnotationShape } = await import('../../../web/src/components/AnnotationShape');
    const svg = renderToStaticMarkup(createElement('svg', null, createElement(AnnotationShape, { a: ink })));
    expect(svg).toMatch(/<circle[^>]*cx="30"[^>]*r="1.7"/);
  });

  it('keeps the complete marks of a file cut off mid-write', () => {
    const whole = xfdf(
      '<ink page="0" rect="0,0,50,50" name="i1" title="T"><inklist><gesture>1,1;20,20</gesture></inklist></ink>' +
      '<ink page="0" rect="0,0,50,50" name="i2" title="T"><popup open="no" rect="0,0,1,1"></popup><inklist><gesture>2,2;30,30</gesture></inklist></ink>' +
      '<ink page="0" rect="0,0,50,50" name="i3" title="T"><popup open="no" rect="0,0,1,1"></popup><inklist><gesture>3,3;40,40',
    ).replace(/<\/annots><\/xfdf>$/, '');
    const imp = importXfdf(whole, vps);
    expect(imp.partial).toBe(true);
    expect(imp.annotations.map((a) => a.id)).toEqual(['i1', 'i2']);
  });

  it('reads mark times with their time-zone offset, as Android and iOS do', () => {
    const { annotations: [a] } = importXfdf(xfdf(
      `<square page="0" rect="100,500,200,540" color="#E44234" name="d1" title="T" creationdate="D:20260730133732+05'30'" date="D:20260730133737+05'30'"/>`,
    ), vps);
    expect(a.createdAt).toBe('2026-07-30T08:07:32.000Z');
    expect(a.modifiedAt).toBe('2026-07-30T08:07:37.000Z');
    const { annotations: [b] } = importXfdf(xfdf(`<square page="0" rect="100,500,200,540" name="d2" date="D:20250424154102-04'00'"/>`), vps);
    expect(b.modifiedAt).toBe('2025-04-24T19:41:02.000Z');
    const { annotations: [c] } = importXfdf(xfdf(`<square page="0" rect="100,500,200,540" name="d3" date="D:20250619175333Z"/>`), vps);
    expect(c.modifiedAt).toBe('2025-06-19T17:53:33.000Z');
    expect(c.createdAt).toBe('2025-06-19T17:53:33.000Z'); // no creationdate: as old as its last change
  });

  it('replaces a mark stored in the PDF with the saved XFDF mark of the same name, as WebViewer does', async () => {
    // the uploaded PDF already holds the teacher's six callouts; the XFDF holds them again
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annot = doc.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [100, 500, 300, 540], Contents: PDFString.of('ans: 270 degree'),
      NM: PDFString.of('c6'), DA: PDFString.of('/Helv 9 Tf 1 0 0 rg'), F: 4 });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
    const ex = await extractAnnotations(await doc.save());
    const inFile = rawToAnnotations(ex.raw, pdfVps);
    expect(inFile.map((a) => a.id)).toEqual(['c6']);
    const imp = importXfdf(xfdf(`<freetext page="0" rect="100,500,300,540" TextColor="#E44234" name="c6" title="T"><contents>ans: 270 degree</contents></freetext>`), vps);
    expect(mergeXfdf(inFile, imp)).toHaveLength(1);
  });

  it('replaces an unnamed mark stored in the PDF with the unnamed XFDF copy of it', async () => {
    // the student typed their name with Apple Markup (no /NM); Apryse exported it unnamed into the XFDF
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const mk = (contents: string, rect: number[]) => doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: rect,
      Contents: PDFString.of(contents), DA: PDFString.of('/Helvetica 12 Tf 0 g'), F: 4 }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([mk('Jane Doe', [108.4149, 681.6878, 207.4149, 706.6878]), mk('1', [300, 600, 310, 610])]));
    const inFile = rawToAnnotations((await extractAnnotations(await doc.save())).raw, pdfVps);
    const imp = importXfdf(xfdf(`<freetext page="0" rect="108.415,681.688,207.415,706.688" TextColor="#FC3141" FontSize="16" title="Mobile User"><contents>Jane Doe</contents></freetext>`
      + `<freetext page="0" rect="300,600,310,610" title="T"><contents>2</contents></freetext>`), vps);
    const merged = mergeXfdf(inFile, imp);
    expect(merged.map((a) => a.text)).toEqual(['Jane Doe', '1', '2']); // the different text is a different mark
    expect(merged[0].color).toBe('#fc3141');
  });

  it('wraps typed comments between words at the box edge, as WebViewer does', () => {
    // "my ans-51 kg of sugar sold in total" in a 115 pt box; every character 6 units wide here
    const measure = (t: string) => t.length * 6;
    const lines = wrapRuns([{ text: 'my ans-' }, { text: '51 kg of sugar sold in total', bold: true }], 120, measure);
    expect(lines.map((l) => l.map((r) => r.text).join(''))).toEqual(['my ans-51 kg of', 'sugar sold in total']);
    expect(lines[0]).toEqual([{ text: 'my ans-' }, { text: '51 kg of', bold: true }]);
    // text that fits stays on one line; a paragraph break is kept; a word wider than the box stays whole
    expect(wrapRuns([{ text: 'ans: 60 degree' }], 200, measure)).toHaveLength(1);
    expect(wrapRuns([{ text: 'one\ntwo' }], 200, measure).map((l) => l[0]?.text)).toEqual(['one', 'two']);
    expect(wrapRuns([{ text: 'photosynthesis' }], 30, measure).map((l) => l[0].text)).toEqual(['photosynthesis']);
  });
});

import { GlobalWorkerOptions, getDocument, PasswordResponses } from 'pdfjs-dist';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { endMarkedContent, PDFDocument, PDFName, PDFOperator, PDFOperatorNames, PDFString, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { extractAnnotations, IMPORTABLE, rawToAnnotations } from './pdfAnnots';
import type { RawAnnot } from './pdfAnnots';
import { looksSigned } from './server';
import { signedFieldNames } from './forms';
import type { Annotation, PageSize } from './types';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface LoadedDoc {
  pdf: PDFDocumentProxy;
  /** shown from a URL while the rest of the file still downloads: bytes/original are empty */
  partial?: boolean;
  /** the bytes exactly as opened (used to verify signatures) */
  original: Uint8Array;
  /** the file contains a digital signature */
  signed: boolean;
  /** signature fields that are already signed */
  signedFields: string[];
  /** the document without the annotations we imported (those live in the editor) */
  bytes: Uint8Array;
  name: string;
  /** annotations found in the file, now editable */
  imported: Annotation[];
  pageSizes: PageSize[];
  /** scale-1 viewports, used to convert page units to PDF user space on export */
  viewports: PageViewport[];
  /** SHA-256 of the opened bytes, used as the autosave key */
  key: string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

type AskPassword = (retry: boolean) => string | null;

function openTask(src: Parameters<typeof getDocument>[0], askPassword: AskPassword, onProgress?: (fraction: number) => void) {
  const task = getDocument(src);
  if (onProgress) task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => total && onProgress(Math.min(1, loaded / total));
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    const pw = askPassword(reason === PasswordResponses.INCORRECT_PASSWORD);
    if (pw === null) task.destroy();
    else update(pw);
  };
  return task.promise;
}

/** Page sizes for every page, fetched in parallel (pdf.js only reads the page dictionaries). */
const pageViewports = (pdf: PDFDocumentProxy) =>
  Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1).then((p) => p.getViewport({ scale: 1 }))));

/** Annotation subtypes worth a full parse with pdf-lib (our stamps and signatures are /Stamp). */
async function hasEditableAnnotations(pdf: PDFDocumentProxy): Promise<boolean> {
  const found = await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => {
    const annots = await (await pdf.getPage(i + 1)).getAnnotations();
    return annots.some((a: { subtype?: string }) => !!a.subtype && (IMPORTABLE.has(a.subtype) || a.subtype === 'Stamp'));
  }));
  return found.some(Boolean);
}

export async function loadPdf(data: Uint8Array, name: string, askPassword: AskPassword): Promise<LoadedDoc> {
  const key = await sha256(data);
  // pdf.js first: it parses lazily, so a large file without annotations never gets a full pdf-lib parse.
  let pdf = await openTask({ data: data.slice() }, askPassword); // pdf.js transfers its buffer to the worker
  let bytes = data;
  let raw: RawAnnot[] = [];
  if (await hasEditableAnnotations(pdf)) {
    const ex = await extractAnnotations(data.slice());
    raw = ex.raw;
    if (ex.bytes !== data && raw.length) {
      bytes = ex.bytes;
      await pdf.loadingTask.destroy();
      pdf = await openTask({ data: bytes.slice() }, askPassword);
    }
  }
  const viewports = await pageViewports(pdf);
  const signed = looksSigned(data);
  return {
    pdf,
    original: data,
    signed,
    signedFields: signed ? await signedFieldNames(data) : [],
    bytes,
    name,
    viewports,
    pageSizes: viewports.map((v) => ({ width: v.width, height: v.height })),
    imported: rawToAnnotations(raw, viewports),
    key,
  };
}

export interface StreamedDoc {
  pdf: PDFDocumentProxy;
  name: string;
  viewports: PageViewport[];
  pageSizes: PageSize[];
  /** resolves with the whole file once it has downloaded in the background */
  complete: Promise<Uint8Array>;
}

/**
 * Opens a PDF from a URL with HTTP range requests: pdf.js fetches only what the visible pages
 * need (the first page of a linearized file arrives first), so large files show in seconds.
 * The full file keeps downloading in the background for annotations, search and saving.
 * The server must allow range requests (Accept-Ranges: bytes, and CORS exposing it if cross-origin).
 */
export async function streamPdf(
  url: string, askPassword: AskPassword, name = fileNameFromUrl(url), onProgress?: (fraction: number) => void,
): Promise<StreamedDoc> {
  const pdf = await openTask({ url, rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: true }, askPassword, onProgress);
  const viewports = await pageViewports(pdf);
  return {
    pdf, name, viewports,
    pageSizes: viewports.map((v) => ({ width: v.width, height: v.height })),
    complete: pdf.getData(),
  };
}

export function fileNameFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() ?? '');
    return last || 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

/**
 * A floor plan drawn in optional-content layers: Walls, Furniture, Electrical (off at first),
 * and Metric / Imperial dimensions as a radio pair under a "Dimensions" heading.
 */
function drawLayeredPlan(doc: PDFDocument, page: PDFPage, font: PDFFont) {
  const ctx = doc.context;
  const names = ['Walls', 'Furniture', 'Electrical', 'Metric', 'Imperial'] as const;
  const refs = Object.fromEntries(names.map((n) => [n, ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(n) }))])) as Record<typeof names[number], ReturnType<typeof ctx.register>>;
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({
    OCGs: names.map((n) => refs[n]),
    D: {
      Name: PDFString.of('Plan'),
      Order: [refs.Walls, refs.Furniture, refs.Electrical, [PDFString.of('Dimensions'), refs.Metric, refs.Imperial]],
      OFF: [refs.Electrical, refs.Imperial],
      RBGroups: [[refs.Metric, refs.Imperial]],
    },
  }));
  const resources = page.node.Resources()!;
  resources.set(PDFName.of('Properties'), ctx.obj(Object.fromEntries(names.map((n) => [n, refs[n]]))));
  const layer = (name: typeof names[number], draw: () => void) => {
    page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of(name)]));
    draw();
    page.pushOperators(endMarkedContent());
  };
  const dark = rgb(0.2, 0.2, 0.25);
  layer('Walls', () => {
    page.drawRectangle({ x: 80, y: 165, width: 450, height: 150, borderColor: dark, borderWidth: 4 });
    page.drawLine({ start: { x: 300, y: 165 }, end: { x: 300, y: 260 }, thickness: 3, color: dark });
    page.drawLine({ start: { x: 300, y: 290 }, end: { x: 300, y: 315 }, thickness: 3, color: dark });
    page.drawText('Bedroom', { x: 170, y: 295, size: 10, font, color: dark });
    page.drawText('Living room', { x: 390, y: 295, size: 10, font, color: dark });
  });
  layer('Furniture', () => {
    const wood = rgb(0.72, 0.52, 0.32);
    page.drawRectangle({ x: 95, y: 190, width: 80, height: 95, color: rgb(0.93, 0.88, 0.8), borderColor: wood, borderWidth: 1 });
    page.drawRectangle({ x: 100, y: 265, width: 70, height: 16, color: rgb(1, 1, 1), borderColor: wood, borderWidth: 1 });
    page.drawRectangle({ x: 400, y: 200, width: 70, height: 45, borderColor: wood, borderWidth: 1.5 });
    page.drawRectangle({ x: 330, y: 180, width: 30, height: 80, color: rgb(0.85, 0.9, 0.95), borderColor: wood, borderWidth: 1 });
  });
  layer('Electrical', () => {
    const red = rgb(0.85, 0.2, 0.2);
    for (const [x, y] of [[90, 175], [290, 230], [315, 175], [520, 300], [520, 175]]) {
      page.drawCircle({ x, y, size: 5, borderColor: red, borderWidth: 1.5 });
      page.drawText('S', { x: x - 2.5, y: y - 3, size: 7, font, color: red });
    }
  });
  const blue = rgb(0.15, 0.35, 0.8);
  layer('Metric', () => {
    page.drawText('9.0 m', { x: 290, y: 150, size: 9, font, color: blue });
    page.drawText('3.0 m', { x: 535, y: 236, size: 9, font, color: blue });
  });
  layer('Imperial', () => {
    page.drawText('29 ft 6 in', { x: 282, y: 150, size: 9, font, color: blue });
    page.drawText('9 ft 10 in', { x: 535, y: 236, size: 9, font, color: blue });
  });
}

/** Builds a small multi-page document so every feature can be tried without a file. */
export async function createSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const para =
    'PDF Studio is a document viewer built from open-source parts. Select this text with the ' +
    'highlight tool to mark it, draw shapes and ink, drop sticky notes, add stamps and place a ' +
    'signature. Use search to find words across every page, then download a flattened copy.';
  const sections = [
    ['1. Introduction', para],
    ['2. Viewing', 'Zoom, fit to width, jump between pages with the thumbnails, and switch themes.'],
    ['3. Annotating', 'Every annotation can be moved, restyled, commented on and given a review status.'],
    ['4. Exporting', 'Download a PDF with annotations burned in, or export them as JSON to share.'],
  ];
  for (let p = 1; p <= 3; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Sample document - page ${p}`, { x: 56, y: 730, size: 22, font: bold });
    page.drawRectangle({ x: 56, y: 715, width: 500, height: 2, color: rgb(0.2, 0.4, 0.9) });
    let y = 680;
    for (const [head, body] of sections) {
      page.drawText(head, { x: 56, y, size: 14, font: bold });
      y -= 22;
      for (const line of wrap(body, font, 11, 500)) {
        page.drawText(line, { x: 56, y, size: 11, font, color: rgb(0.15, 0.15, 0.15) });
        y -= 16;
      }
      y -= 14;
    }
    page.drawRectangle({
      x: 56, y: 140, width: 500, height: 200,
      borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 1,
    });
    if (p === 1) {
      page.drawText('Floor plan with layers - open the Layers panel (stack icon, top right)', { x: 56, y: 348, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
      drawLayeredPlan(doc, page, font);
    } else {
      page.drawText('Floor plan area - try the shape and ink tools here', {
        x: 160, y: 235, size: 12, font, color: rgb(0.5, 0.5, 0.5),
      });
    }
  }
  // A form page, for trying form filling.
  const form = doc.getForm();
  const fp = doc.addPage([612, 792]);
  fp.drawText('Sample form', { x: 56, y: 730, size: 22, font: bold });
  const label = (t: string, y: number) => fp.drawText(t, { x: 56, y, size: 12, font });
  label('Full name', 680);
  form.createTextField('applicant.name').addToPage(fp, { x: 180, y: 672, width: 300, height: 22, font });
  label('Email', 640);
  form.createTextField('applicant.email').addToPage(fp, { x: 180, y: 632, width: 300, height: 22, font });
  label('Course', 600);
  const course = form.createDropdown('applicant.course');
  course.addOptions(['Science', 'Commerce', 'Arts', 'Other']);
  course.addToPage(fp, { x: 180, y: 592, width: 200, height: 22, font });
  label('Mode', 560);
  const mode = form.createRadioGroup('applicant.mode');
  mode.addOptionToPage('Online', fp, { x: 180, y: 556, width: 14, height: 14 });
  fp.drawText('Online', { x: 200, y: 559, size: 11, font });
  mode.addOptionToPage('Classroom', fp, { x: 270, y: 556, width: 14, height: 14 });
  fp.drawText('Classroom', { x: 290, y: 559, size: 11, font });
  label('Comments', 520);
  const notes = form.createTextField('applicant.comments');
  notes.enableMultiline();
  notes.addToPage(fp, { x: 180, y: 440, width: 300, height: 90, font });
  form.createCheckBox('applicant.agree').addToPage(fp, { x: 56, y: 400, width: 14, height: 14 });
  fp.drawText('I agree to the terms', { x: 78, y: 403, size: 11, font });

  // A link on page 1 that jumps to the form page.
  const first = doc.getPage(0);
  first.drawText('Go to the sample form (page 4) >', { x: 56, y: 100, size: 12, font, color: rgb(0.15, 0.35, 0.85) });
  const link = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [56, 96, 260, 112], Border: [0, 0, 0],
    Dest: [fp.ref, PDFName.of('XYZ'), 0, 792, 0],
  }));
  first.node.addAnnot(link);
  const web = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [300, 96, 470, 112], Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of('https://mozilla.github.io/pdf.js/') },
  }));
  first.drawText('PDF.js project website', { x: 300, y: 100, size: 12, font, color: rgb(0.15, 0.35, 0.85) });
  first.node.addAnnot(web);
  return doc.save();
}

function wrap(text: string, font: { widthOfTextAtSize(t: string, s: number): number }, size: number, max: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

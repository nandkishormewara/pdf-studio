/**
 * Page organisation. Each operation returns new PDF bytes plus the annotation list
 * re-mapped to the new page order/geometry.
 */
import { PDFDocument, degrees } from 'pdf-lib';
import type { Annotation, PageSize, Pt, Rect } from './types';

export interface PageOpResult {
  bytes: Uint8Array;
  annotations: Annotation[];
}

const load = (bytes: Uint8Array) => PDFDocument.load(bytes).catch((e) => {
  throw new Error(/encrypt/i.test(String(e)) ? 'Page changes are not supported on encrypted PDFs.' : String(e));
});

// ---- rotation of annotation geometry (page units, top-left origin)

function rotatePoint(p: Pt, size: PageSize, cw: boolean): Pt {
  return cw ? { x: size.height - p.y, y: p.x } : { x: p.y, y: size.width - p.x };
}
function rotateRect(r: Rect, size: PageSize, cw: boolean): Rect {
  const a = rotatePoint({ x: r.x, y: r.y }, size, cw);
  const b = rotatePoint({ x: r.x + r.w, y: r.y + r.h }, size, cw);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function rotateAnnotation(a: Annotation, size: PageSize, cw: boolean): Annotation {
  const rp = (p: Pt) => rotatePoint(p, size, cw);
  const rotated: Annotation = {
    ...a,
    rects: a.rects?.map((r) => rotateRect(r, size, cw)),
    points: a.points?.map(rp),
    paths: a.paths?.map((p) => p.map(rp)),
  };
  if (a.rect) {
    // Box content (text, stamps, signatures) stays upright: rotate the centre, keep the size.
    const c = rp({ x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h / 2 });
    rotated.rect = { ...a.rect, x: c.x - a.rect.w / 2, y: c.y - a.rect.h / 2 };
  }
  return rotated;
}

export async function rotatePages(bytes: Uint8Array, indices: number[], cw: boolean, sizes: PageSize[], annotations: Annotation[]): Promise<PageOpResult> {
  const doc = await load(bytes);
  for (const i of indices) {
    const page = doc.getPage(i);
    page.setRotation(degrees((page.getRotation().angle + (cw ? 90 : 270)) % 360));
  }
  const set = new Set(indices);
  return {
    bytes: await doc.save(),
    annotations: annotations.map((a) => (set.has(a.page) ? rotateAnnotation(a, sizes[a.page], cw) : a)),
  };
}

export async function deletePages(bytes: Uint8Array, indices: number[], annotations: Annotation[]): Promise<PageOpResult> {
  const doc = await load(bytes);
  if (indices.length >= doc.getPageCount()) throw new Error('A document needs at least one page.');
  const sorted = [...indices].sort((a, b) => b - a);
  for (const i of sorted) doc.removePage(i);
  const removed = new Set(indices);
  return {
    bytes: await doc.save(),
    annotations: annotations
      .filter((a) => !removed.has(a.page))
      .map((a) => ({ ...a, page: a.page - indices.filter((i) => i < a.page).length })),
  };
}

/** Moves page `from` so that it ends up at index `to` (in place, so form fields stay linked). */
export async function movePage(bytes: Uint8Array, from: number, to: number, annotations: Annotation[]): Promise<PageOpResult> {
  if (from === to) return { bytes, annotations };
  const doc = await load(bytes);
  const page = doc.getPage(from);
  doc.removePage(from);
  doc.insertPage(to, page);
  const order = Array.from({ length: doc.getPageCount() }, (_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  const newIndexOf = new Map(order.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  return {
    bytes: await doc.save(),
    annotations: annotations.map((a) => ({ ...a, page: newIndexOf.get(a.page) ?? a.page })),
  };
}

export async function insertBlankPage(bytes: Uint8Array, at: number, size: PageSize, annotations: Annotation[]): Promise<PageOpResult> {
  const doc = await load(bytes);
  doc.insertPage(at, [size.width, size.height]);
  return { bytes: await doc.save(), annotations: shiftFrom(annotations, at, 1) };
}

export async function insertPdf(bytes: Uint8Array, other: Uint8Array, at: number, annotations: Annotation[]): Promise<PageOpResult & { inserted: number }> {
  const doc = await load(bytes);
  const src = await load(other);
  const pages = await doc.copyPages(src, src.getPageIndices());
  pages.forEach((p, i) => doc.insertPage(at + i, p));
  return { bytes: await doc.save(), annotations: shiftFrom(annotations, at, pages.length), inserted: pages.length };
}

export async function insertImages(bytes: Uint8Array | null, files: File[], at: number, annotations: Annotation[]): Promise<PageOpResult> {
  const doc = bytes ? await load(bytes) : await PDFDocument.create();
  let i = 0;
  for (const file of files) {
    const { data, type } = await normaliseImage(file);
    const img = type === 'jpg' ? await doc.embedJpg(data) : await doc.embedPng(data);
    // 96 dpi images → points, capped to A4-ish so phone photos aren't enormous pages
    let w = (img.width * 72) / 96;
    let h = (img.height * 72) / 96;
    const fit = Math.min(1, 842 / Math.max(w, h));
    w *= fit;
    h *= fit;
    const page = doc.insertPage(at + i++, [w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return { bytes: await doc.save(), annotations: shiftFrom(annotations, at, i) };
}

export async function extractPages(bytes: Uint8Array, indices: number[], annotations: Annotation[]): Promise<PageOpResult> {
  const doc = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, indices);
  pages.forEach((p) => out.addPage(p));
  const map = new Map(indices.map((old, n) => [old, n]));
  return {
    bytes: await out.save(),
    annotations: annotations.filter((a) => map.has(a.page)).map((a) => ({ ...a, page: map.get(a.page)! })),
  };
}

function shiftFrom(annotations: Annotation[], at: number, by: number) {
  return annotations.map((a) => (a.page >= at ? { ...a, page: a.page + by } : a));
}

/** JPEG and PNG embed directly; anything else the browser can decode is converted to PNG. */
async function normaliseImage(file: File): Promise<{ data: Uint8Array; type: 'jpg' | 'png' }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xd8) return { data: buf, type: 'jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { data: buf, type: 'png' };
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error(`Can't read ${file.name}`))), 'image/png'));
  return { data: new Uint8Array(await blob.arrayBuffer()), type: 'png' };
}


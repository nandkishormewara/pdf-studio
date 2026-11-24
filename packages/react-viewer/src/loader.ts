/**
 * Fetching and type detection. Stream URLs often have no extension, so the first bytes decide the
 * type; `extension` / `filename` are only a fallback. Images become a one-page PDF.
 */
import { PDFDocument } from 'pdf-lib';

export type SniffedType = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'office';

const IMAGE_EXT: Record<string, SniffedType> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };
const OFFICE_EXT = new Set(['doc', 'docx', 'ppt', 'pptx', 'pps', 'ppsx', 'xls', 'xlsx', 'odt', 'odp', 'ods', 'rtf']);

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export function sniffType(bytes: Uint8Array): SniffedType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  // %PDF may follow some junk (e.g. a BOM or HTTP preamble); readers accept it within the first 1 KB.
  const head = bytes.subarray(0, 1024);
  const pdf = ascii('%PDF-');
  for (let i = 0; i + pdf.length <= head.length; i++) if (startsWith(head, pdf, i)) return 'pdf';
  // ZIP (docx/pptx/xlsx) or OLE2 (doc/ppt/xls)
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'office';
  return null;
}

export function typeFromHint(...hints: (string | undefined)[]): SniffedType | null {
  for (const hint of hints) {
    if (!hint) continue;
    const ext = hint.split(/[?#]/)[0].split('.').pop()!.toLowerCase().replace(/^\./, '');
    if (ext === 'pdf') return 'pdf';
    if (IMAGE_EXT[ext]) return IMAGE_EXT[ext];
    if (OFFICE_EXT.has(ext)) return 'office';
  }
  return null;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 0–1, only called when the server sends Content-Length */
  onProgress?: (fraction: number) => void;
}

export async function fetchBytes(url: string, opts: FetchOptions = {}): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { headers: opts.headers, signal: opts.signal, credentials: 'same-origin' });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new Error('Could not download the document. Check your connection and try again.');
  }
  if (!res.ok) throw new Error(`Could not download the document (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    // Compressed responses report the compressed length; never go past 100%.
    if (total) opts.onProgress?.(Math.min(1, received / total));
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface ResolvedDocument {
  /** PDF bytes ready for PDF Studio's loadPdf */
  pdf: Uint8Array;
  type: SniffedType;
}

/** Turns downloaded bytes into a PDF: PDFs pass through, images become one page. */
export async function toPdfBytes(bytes: Uint8Array, hints: { extension?: string; filename?: string; url?: string } = {}): Promise<ResolvedDocument> {
  if (!bytes.length) throw new Error('The document is empty.');
  const type = sniffType(bytes) ?? typeFromHint(hints.extension, hints.filename, hints.url);
  switch (type) {
    case 'pdf':
      return { pdf: bytes, type };
    case 'png':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return { pdf: await imageToPdf(bytes, type), type };
    case 'office':
      throw new Error('Office documents must be converted to PDF on the server before they can be shown here.');
    default:
      if (looksLikeHtml(bytes)) throw new Error('The server sent a web page instead of the document. The link may have expired; try again.');
      throw new Error('This file type is not supported. Open a PDF or an image.');
  }
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body');
}

/** One page the size of the image (1 px = 1 pt, like Apryse shows images at 100%). */
export async function imageToPdf(bytes: Uint8Array, type: 'png' | 'jpeg' | 'gif' | 'webp'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image =
    type === 'jpeg' ? await doc.embedJpg(bytes)
    : type === 'png' ? await doc.embedPng(bytes)
    : await doc.embedPng(await rasterToPng(bytes, type)); // pdf-lib only embeds PNG and JPEG
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return doc.save();
}

/** GIF (first frame) / WebP → PNG through the browser's decoder. */
async function rasterToPng(bytes: Uint8Array, type: 'gif' | 'webp'): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: `image/${type}` }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not decode the image.'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

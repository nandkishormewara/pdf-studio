import type { Rect } from './types';
/** Client for the PDF Studio processing server (server/). All calls are optional features. */

export interface ServerHealth {
  ok: boolean;
  version: string;
  features: { convert: boolean; ocr: boolean; redact: boolean; sign: boolean; verify: boolean; optimize?: boolean; extract?: boolean };
  ocrLanguages: string[];
  convertExtensions: string[];
  signer: { subject: string; development: boolean; timestamping: boolean };
  maxUploadMb: number;
}

export interface SignatureCheck {
  field: string;
  intact: boolean;
  valid: boolean;
  trusted: boolean;
  signer?: string;
  issuer?: string;
  signed_at?: string;
  timestamped?: boolean;
  coverage?: string;
  modification_level?: string;
  reason?: string;
  location?: string;
  summary?: string;
  error?: string;
}

export interface RedactRegion {
  page: number;
  rects: [number, number, number, number][]; // PDF user space
  /** exact text to remove near a mark; the server redacts its precise glyph boxes */
  texts?: { text: string; near: [number, number, number, number] }[];
}

export interface SignOptions {
  reason?: string;
  location?: string;
  signerName?: string;
  fieldName?: string;
  page?: number;
  box?: [number, number, number, number];
  imagePng?: Blob;
  certify?: boolean;
}

/** OCR languages pre-selected in dialogs: English and Hindi when the server has them. */
export const defaultLanguages = (h: ServerHealth) => ['eng', 'hin'].filter((l) => h.ocrLanguages.includes(l));

export const DEFAULT_SERVER = (import.meta.env.VITE_PDFSTUDIO_SERVER as string | undefined) ?? 'http://localhost:8787';

/** JSON from `POST /extract` (`format: 'json'`). Boxes are page units, as in sdk/extract.ts. */
export interface ServerExtractJson {
  format: 'pdf-studio-extract';
  version: number;
  units: string;
  pages?: { page: number; width: number; height: number; lines: { text: string; box: Rect; font: string; size: number; words: { text: string; box: Rect }[] }[] }[];
  images?: { name: string; page: number; pages: number[]; box: Rect; widthPx: number; heightPx: number; mime: string }[];
  fonts?: { name: string; baseFont: string; type: string; embedded: boolean; subset: boolean; program: string | null; pages: number[]; file?: string }[];
}

export class ServerError extends Error {}

export class PdfServer {
  readonly base: string;
  constructor(base: string) {
    this.base = base.replace(/\/+$/, '');
  }

  async health(timeoutMs = 2500): Promise<ServerHealth> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${this.base}/health`, { signal: ctrl.signal });
      if (!r.ok) throw new ServerError(`Server responded ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  private async post(path: string, form: FormData): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(`${this.base}${path}`, { method: 'POST', body: form });
    } catch {
      throw new ServerError(`Can't reach the PDF Studio server at ${this.base}. Is it running?`);
    }
    if (!r.ok) {
      let msg = `Server error ${r.status}`;
      try {
        const body = await r.json();
        msg = body.error ?? body.detail ?? msg;
        if (typeof msg !== 'string') msg = JSON.stringify(msg);
      } catch { /* not JSON */ }
      throw new ServerError(msg);
    }
    return r;
  }

  private static async pdfResult<T = Record<string, unknown>>(r: Response): Promise<{ bytes: Uint8Array; report: T }> {
    const header = r.headers.get('X-PDFStudio-Report');
    const report = header ? JSON.parse(atob(header)) : {}; // server sends ASCII-only JSON
    return { bytes: new Uint8Array(await r.arrayBuffer()), report };
  }

  private static file(bytes: Uint8Array | Blob) {
    return bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: 'application/pdf' });
  }

  async convert(file: File) {
    const form = new FormData();
    form.append('file', file, file.name);
    return PdfServer.pdfResult(await this.post('/convert', form));
  }

  async ocr(bytes: Uint8Array, languages: string[], opts: { pages?: number[]; force?: boolean } = {}) {
    const form = new FormData();
    form.append('file', PdfServer.file(bytes), 'doc.pdf');
    form.append('languages', languages.join('+'));
    if (opts.pages) form.append('pages', JSON.stringify(opts.pages));
    if (opts.force) form.append('force', 'true');
    return PdfServer.pdfResult<{ ocrPages: number[]; skippedPages: number[] }>(await this.post('/ocr', form));
  }

  async redact(bytes: Uint8Array, regions: RedactRegion[], opts: { sanitize?: boolean; ocrLanguages?: string[] } = {}) {
    const form = new FormData();
    form.append('file', PdfServer.file(bytes), 'doc.pdf');
    form.append('regions', JSON.stringify(regions));
    form.append('sanitize', String(opts.sanitize ?? true));
    if (opts.ocrLanguages?.length) form.append('ocr_languages', opts.ocrLanguages.join('+'));
    return PdfServer.pdfResult<{ pages: number[]; regions: number; annotationsRemoved: number; sanitized: string[]; ocrPages: number[] }>(
      await this.post('/redact', form));
  }

  async sign(bytes: Uint8Array, o: SignOptions) {
    const form = new FormData();
    form.append('file', PdfServer.file(bytes), 'doc.pdf');
    if (o.reason) form.append('reason', o.reason);
    if (o.location) form.append('location', o.location);
    if (o.signerName) form.append('signer_name', o.signerName);
    if (o.fieldName) form.append('field_name', o.fieldName);
    form.append('page', String(o.page ?? 0));
    if (o.box) form.append('box', JSON.stringify(o.box));
    if (o.certify) form.append('certify', 'true');
    if (o.imagePng) form.append('image', o.imagePng, 'signature.png');
    return PdfServer.pdfResult<{ signer: string; development: boolean }>(await this.post('/sign', form));
  }

  /** Linearized ("fast web view") and recompressed copy; `maxImageDpi` also downsamples large images. */
  async optimize(bytes: Uint8Array, opts: { maxImageDpi?: number; jpegQuality?: number } = {}) {
    const form = new FormData();
    form.append('file', PdfServer.file(bytes), 'doc.pdf');
    if (opts.maxImageDpi) form.append('max_image_dpi', String(opts.maxImageDpi));
    if (opts.jpegQuality) form.append('jpeg_quality', String(opts.jpegQuality));
    return PdfServer.pdfResult<{ bytesBefore: number; bytesAfter: number; linearized: boolean; imagesDownsampled: number; notes: string[] }>(
      await this.post('/optimize', form));
  }

  /**
   * Server-side extraction (same results and coordinates as sdk/extract.ts). Useful without a browser, and for
   * Indic text in office-made PDFs, which PDFium decodes better than pdf.js. `format: 'zip'` adds image and font files.
   */
  async extract(bytes: Uint8Array, opts: {
    pages?: number[]; text?: boolean; images?: boolean; imageFormat?: 'png' | 'jpeg'; minImagePx?: number;
    fonts?: boolean; fontFiles?: boolean; format?: 'json' | 'zip' | 'txt';
  } = {}) {
    const form = new FormData();
    form.append('file', PdfServer.file(bytes), 'doc.pdf');
    if (opts.pages) form.append('pages', JSON.stringify(opts.pages));
    form.append('text', String(opts.text ?? true));
    form.append('images', String(opts.images ?? false));
    if (opts.imageFormat) form.append('image_format', opts.imageFormat);
    if (opts.minImagePx !== undefined) form.append('min_image_px', String(opts.minImagePx));
    form.append('fonts', String(opts.fonts ?? false));
    form.append('font_files', String(opts.fontFiles ?? false));
    form.append('format', opts.format ?? 'json');
    const r = await this.post('/extract', form);
    return opts.format === 'zip' || opts.format === 'txt' ? new Uint8Array(await r.arrayBuffer()) : ((await r.json()) as ServerExtractJson);
  }

  async verify(bytes: Uint8Array): Promise<SignatureCheck[]> {
    const form = new FormData();
    form.append('file', PdfServer.file(bytes), 'doc.pdf');
    const r = await this.post('/verify', form);
    return (await r.json()).signatures;
  }

  certificateUrl() {
    return `${this.base}/certificate.pem`;
  }
}

/** Cheap check for an existing digital signature, used to warn before modifying. */
export function looksSigned(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 64 * 1024 * 1024);
  const needle = [0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]; // "/ByteRange"
  outer: for (let i = 0; i < n - needle.length; i++) {
    if (bytes[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

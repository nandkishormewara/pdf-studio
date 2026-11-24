import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBytes, sniffType, toPdfBytes, typeFromHint } from '../src/loader';

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)));
// 1×1 PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

describe('sniffType', () => {
  it('recognises documents by their first bytes', () => {
    expect(sniffType(bytes('%PDF-1.7\n'))).toBe('pdf');
    expect(sniffType(bytes([0xef, 0xbb, 0xbf], '\n%PDF-1.4'))).toBe('pdf');
    expect(sniffType(PNG)).toBe('png');
    expect(sniffType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffType(bytes('GIF89a'))).toBe('gif');
    expect(sniffType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('webp');
    expect(sniffType(bytes([0x50, 0x4b, 0x03, 0x04]))).toBe('office');
    expect(sniffType(bytes('hello'))).toBeNull();
  });

  it('falls back to the extension / filename hint', () => {
    expect(typeFromHint(undefined, 'answer.JPG')).toBe('jpeg');
    expect(typeFromHint('pdf')).toBe('pdf');
    expect(typeFromHint('.png')).toBe('png');
    expect(typeFromHint(undefined, undefined, 'https://x.test/a/notes.pptx?sig=1')).toBe('office');
    expect(typeFromHint(undefined, undefined, 'https://x.test/stream/123')).toBeNull();
  });
});

describe('toPdfBytes', () => {
  it('passes PDFs through', async () => {
    const pdf = bytes('%PDF-1.7 rest');
    expect((await toPdfBytes(pdf)).pdf).toBe(pdf);
  });

  it('turns an extension-less PNG stream into a one-page PDF of the image size', async () => {
    const out = await toPdfBytes(PNG, { url: 'https://x.test/stream/9' });
    expect(out.type).toBe('png');
    const doc = await PDFDocument.load(out.pdf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 1, height: 1 });
  });

  it('explains what went wrong for unsupported input', async () => {
    await expect(toPdfBytes(new Uint8Array())).rejects.toThrow(/empty/);
    await expect(toPdfBytes(bytes('<!DOCTYPE html><html>login</html>'))).rejects.toThrow(/web page/);
    await expect(toPdfBytes(bytes([0x50, 0x4b, 0x03, 0x04]))).rejects.toThrow(/converted to PDF on the server/);
    await expect(toPdfBytes(bytes('plain text'), { extension: 'txt' })).rejects.toThrow(/not supported/);
  });
});

describe('fetchBytes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends custom headers and reports progress when the size is known', async () => {
    const body = new Uint8Array(1000).fill(7);
    const stream = () => new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(body.slice(0, 400)); c.enqueue(body.slice(400)); c.close(); },
    });
    const fetchMock = vi.fn(async () => new Response(stream(), { headers: { 'content-length': '1000' } }));
    vi.stubGlobal('fetch', fetchMock);
    const progress: number[] = [];
    const out = await fetchBytes('https://x.test/stream/1', {
      headers: { Authorization: 'Bearer t', 'session-id': 's1' },
      onProgress: (f) => progress.push(f),
    });
    expect(out).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('https://x.test/stream/1', expect.objectContaining({ headers: { Authorization: 'Bearer t', 'session-id': 's1' } }));
    expect(progress).toEqual([0.4, 1]);
  });

  it('turns HTTP errors into a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(fetchBytes('https://x.test/stream/1')).rejects.toThrow('Could not download the document (HTTP 403).');
  });
});

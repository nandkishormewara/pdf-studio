import { runsToLines } from './richtext';
import type { TextRun } from './richtext';

/** True when every character can be written with the standard Helvetica (WinAnsi) font. */
export const isLatin = (s: string) => /^[\x20-\x7E\xA0-\xFF\n\r\t]*$/.test(s);

export interface TextImage {
  png: Uint8Array;
  /** size in PDF points at the requested font size */
  width: number;
  height: number;
}

const RES = 4; // pixels per point, keeps print output sharp

/**
 * Renders text with the browser's own shaping engine (correct for Devanagari,
 * Arabic, CJK, emoji …) into a transparent PNG for embedding in a PDF.
 */
export async function renderTextImage(text: string, fontSize: number, color: string, bold = false): Promise<TextImage> {
  const lines = text.split('\n');
  const font = `${bold ? '700 ' : ''}${fontSize * RES}px "Noto Sans", "Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", system-ui, sans-serif`;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const widthPx = Math.ceil(Math.max(1, ...lines.map((l) => probe.measureText(l).width))) + 2;
  const lineH = fontSize * 1.25 * RES;
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = Math.ceil(lineH * lines.length);
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, 1, i * lineH + fontSize * 0.1 * RES));
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width / RES, height: canvas.height / RES };
}

/** Styled runs rendered by the browser (correct shaping for every script) into a PNG. */
export async function renderRichTextImage(runs: TextRun[], fontSize: number, baseColor: string): Promise<TextImage> {
  const lines = runsToLines(runs);
  const fontFor = (r: TextRun) => `${r.italic ? 'italic ' : ''}${r.bold ? '700 ' : ''}${fontSize * RES}px "Noto Sans", "Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", system-ui, sans-serif`;
  const probe = document.createElement('canvas').getContext('2d')!;
  const widthOf = (line: TextRun[]) => line.reduce((w, r) => { probe.font = fontFor(r); return w + probe.measureText(r.text).width; }, 0);
  const widthPx = Math.ceil(Math.max(1, ...lines.map(widthOf))) + 2;
  const lineH = fontSize * 1.25 * RES;
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = Math.ceil(lineH * lines.length);
  const ctx = canvas.getContext('2d')!;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    let x = 1;
    const y = i * lineH + fontSize * 0.1 * RES;
    for (const r of line) {
      ctx.font = fontFor(r);
      ctx.fillStyle = r.color ?? baseColor;
      ctx.fillText(r.text, x, y);
      const w = ctx.measureText(r.text).width;
      if (r.underline) ctx.fillRect(x, y + fontSize * 1.05 * RES, w, Math.max(1, fontSize * 0.07 * RES));
      x += w;
    }
  });
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width / RES, height: canvas.height / RES };
}

export function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

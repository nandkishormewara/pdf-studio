/**
 * Per-user watermark: one line of text drawn diagonally across every page, from the bottom-left
 * towards the top-right corner, so a leaked screenshot or printout can be traced to the viewer.
 * Defaults match a typical PDFTron `setWatermark({ diagonal: … })` call
 * (22 pt, sans-serif, red, 22% opacity).
 */
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import { hexToRgb01 } from './geometry';
import { isLatin, renderTextImage } from './textImage';

export interface Watermark {
  text: string;
  /** CSS hex colour (#rrggbb); default red */
  color?: string;
  /** 0–1; default 0.22 */
  opacity?: number;
  /** points, on the page (it zooms with the page); default 22 */
  fontSize?: number;
}

export type ResolvedWatermark = Required<Watermark>;

/** Accepts a plain string or an object; null when there is nothing to draw. */
export function resolveWatermark(w: string | Watermark | null | undefined): ResolvedWatermark | null {
  const wm = typeof w === 'string' ? { text: w } : w;
  const text = wm?.text?.trim();
  if (!wm || !text) return null;
  const color = /^#[0-9a-f]{6}$/i.test(wm.color ?? '') ? wm.color! : '#ff0000';
  const opacity = Number.isFinite(wm.opacity) ? Math.min(1, Math.max(0, wm.opacity!)) : 0.22;
  const fontSize = Number.isFinite(wm.fontSize) && wm.fontSize! > 0 ? wm.fontSize! : 22;
  return { text, color, opacity, fontSize };
}

/** Centre and angle (degrees, counter-clockwise on screen) of the diagonal for a page as displayed. */
export function watermarkPlacement(width: number, height: number) {
  return { cx: width / 2, cy: height / 2, angle: (Math.atan2(height, width) * 180) / Math.PI };
}

/**
 * Draws the watermark into every page of `doc` (for printing or a flattened copy).
 * Latin text stays real text; other scripts are drawn as a browser-rendered image, like other text in PDF Studio.
 */
export async function stampWatermark(doc: PDFDocument, viewports: PageViewport[], w: ResolvedWatermark) {
  const latin = isLatin(w.text);
  const font = latin ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const img = latin ? null : await renderTextImage(w.text, w.fontSize, w.color);
  const png = img ? await doc.embedPng(img.png) : null;
  const [r, g, b] = hexToRgb01(w.color);
  doc.getPages().forEach((page, i) => {
    const vp = viewports[i];
    if (!vp) return;
    const { cx, cy, angle } = watermarkPlacement(vp.width, vp.height);
    // Work in page units, then map the text's start point and direction into PDF user space.
    const textW = font ? font.widthOfTextAtSize(w.text, w.fontSize) : img!.width;
    const textH = font ? w.fontSize * 0.7 : img!.height; // cap height for text, full box for the image
    const rad = (angle * Math.PI) / 180;
    const ux = Math.cos(rad), uy = -Math.sin(rad); // along the text, on screen (y down)
    const vx = Math.sin(rad), vy = Math.cos(rad); // "down" across the text, on screen
    const startX = cx - (ux * textW) / 2 + (vx * textH) / 2;
    const startY = cy - (uy * textW) / 2 + (vy * textH) / 2;
    const [px, py] = vp.convertToPdfPoint(startX, startY);
    const [qx, qy] = vp.convertToPdfPoint(startX + ux, startY + uy);
    const rotate = degrees((Math.atan2(qy - py, qx - px) * 180) / Math.PI);
    if (font) page.drawText(w.text, { x: px, y: py, size: w.fontSize, font, color: rgb(r, g, b), opacity: w.opacity, rotate });
    else page.drawImage(png!, { x: px, y: py, width: img!.width, height: img!.height, opacity: w.opacity, rotate });
  });
}

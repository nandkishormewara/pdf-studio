import type { Annotation, Pt, Rect } from './types';

export const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function normRect(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function unionRects(rects: Rect[]): Rect {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function bbox(a: Annotation): Rect {
  if (a.rect) return a.rect;
  if (a.rects?.length) return unionRects(a.rects);
  const pts = a.points ?? a.paths?.flat() ?? [];
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = a.strokeWidth / 2;
  const r = unionRects(pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

/** A freetext's text box: its rect less `inset` (room left for a callout line). */
export function textBox(a: Annotation): Rect | undefined {
  if (!a.rect) return undefined;
  if (!a.inset) return a.rect;
  const [l, t, r, b] = a.inset;
  return { x: a.rect.x + l, y: a.rect.y + t, w: Math.max(1, a.rect.w - l - r), h: Math.max(1, a.rect.h - t - b) };
}

/** Where to lay out text so that, turned by `rotation` about the box centre, it fills the box. */
export function textLayoutBox(box: Rect, rotation = 0): Rect {
  if (rotation % 180 === 0) return box;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return { x: cx - box.h / 2, y: cy - box.w / 2, w: box.h, h: box.w };
}

/**
 * Top-left of the first line inside a layout box. Upright text keeps PDF Studio's 4-unit padding; turned text
 * (Apryse sizes those boxes tightly to the text) is padded only as far as the box allows, so it stays inside.
 */
export function textOrigin(lay: Rect, rotation: number | undefined, size: number, lines: number): Pt {
  if (!rotation) return { x: lay.x + 4, y: lay.y + 4 };
  const room = (span: number, used: number) => Math.min(4, Math.max(0, (span - used) / 2));
  return { x: lay.x + room(lay.w, size * 0.6), y: lay.y + room(lay.h, size * 1.15 * lines) };
}

const shift = (p: Pt, dx: number, dy: number): Pt => ({ x: p.x + dx, y: p.y + dy });
const shiftR = (r: Rect, dx: number, dy: number): Rect => ({ ...r, x: r.x + dx, y: r.y + dy });

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  return {
    ...a,
    rect: a.rect && shiftR(a.rect, dx, dy),
    rects: a.rects?.map((r) => shiftR(r, dx, dy)),
    points: a.points?.map((p) => shift(p, dx, dy)),
    paths: a.paths?.map((path) => path.map((p) => shift(p, dx, dy))),
    callout: a.callout?.map((p) => shift(p, dx, dy)),
  };
}

/** Arrow head triangle for a line from a to b, in the same units. */
export function arrowHead(a: Pt, b: Pt, width: number): Pt[] {
  const len = Math.max(8, width * 4);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = Math.PI / 7;
  return [
    b,
    { x: b.x - len * Math.cos(ang - spread), y: b.y - len * Math.sin(ang - spread) },
    { x: b.x - len * Math.cos(ang + spread), y: b.y - len * Math.sin(ang + spread) },
  ];
}

export function ellipsePoints(r: Rect, n = 48): Pt[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + (r.w / 2) * Math.cos(t), y: cy + (r.h / 2) * Math.sin(t) };
  });
}

export function rectPoints(r: Rect): Pt[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

export function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

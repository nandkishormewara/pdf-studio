import type { Annotation, MeasureScale, Pt } from './types';

/** PDF points per unit of paper measurement. */
export const PAPER_UNITS: Record<string, number> = { in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1 };
export const WORLD_UNITS = ['in', 'ft', 'yd', 'mi', 'mm', 'cm', 'm', 'km', 'pt'];

export interface ScaleSetting {
  paperValue: number;
  paperUnit: string;
  worldValue: number;
  worldUnit: string;
  precision: number;
}

export const DEFAULT_SCALE: ScaleSetting = { paperValue: 1, paperUnit: 'in', worldValue: 1, worldUnit: 'in', precision: 2 };

export function toMeasureScale(s: ScaleSetting): MeasureScale {
  return {
    factor: s.worldValue / (s.paperValue * (PAPER_UNITS[s.paperUnit] ?? 72)),
    unit: s.worldUnit,
    precision: s.precision,
  };
}

export const describeScale = (s: ScaleSetting) => `${s.paperValue} ${s.paperUnit} = ${s.worldValue} ${s.worldUnit}`;

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

export function polylineLength(pts: Pt[], closed = false): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) total += dist(pts[pts.length - 1], pts[0]);
  return total;
}

export function polygonArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Raw value in real-world units (area kinds return squared units). */
export function measureValue(a: Annotation): number {
  const m = a.measure;
  const pts = a.points ?? [];
  if (!m) return 0;
  if (a.kind === 'area') return polygonArea(pts) * m.factor * m.factor;
  return polylineLength(pts) * m.factor;
}

export function measureLabel(a: Annotation): string {
  if (!a.measure) return '';
  const v = measureValue(a).toFixed(a.measure.precision);
  return a.kind === 'area' ? `${v} ${a.measure.unit}²` : `${v} ${a.measure.unit}`;
}

/** Where the label sits, in page units. */
export function labelAnchor(a: Annotation): Pt {
  const pts = a.points ?? [];
  if (!pts.length) return { x: 0, y: 0 };
  if (a.kind === 'area') {
    const c = pts.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
    return { x: c.x / pts.length, y: c.y / pts.length };
  }
  if (a.kind === 'distance') return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 - 6 };
  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y - 8 };
}

/** Given a distance annotation and its real length, return the matching scale factor. */
export function calibrate(a: Annotation, realLength: number): number {
  const len = polylineLength(a.points ?? []);
  return len > 0 ? realLength / len : 0;
}

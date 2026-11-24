import { AnnotationShape } from '../../../web/src/components/AnnotationShape';
import type { Pt, Rect } from '../../../web/src/sdk/types';
import type { ViewerAnnotation } from './xfdfCompat';

/** Renders one annotation in page units: PDF Studio's shapes, plus squiggly and cloud. */
export function ViewerShape({ a }: { a: ViewerAnnotation }) {
  if (a.subtype === 'squiggly' && a.rects) {
    const w = Math.max(1, a.strokeWidth);
    return (
      <g stroke={a.color} strokeOpacity={a.opacity} strokeWidth={w} fill="none" strokeLinejoin="round">
        {a.rects.map((r, i) => <path key={i} d={squigglePath(r)} />)}
        {a.rects.map((r, i) => <rect key={`h${i}`} x={r.x} y={r.y} width={r.w} height={r.h} stroke="none" fill="transparent" />)}
      </g>
    );
  }
  if (a.subtype === 'cloud' && a.paths?.[0]) {
    const pts = openPath(a.paths[0]);
    return (
      <g>
        <path d={cloudPath(pts, a.strokeWidth)} stroke={a.color} strokeOpacity={a.opacity} strokeWidth={a.strokeWidth} fill="none" strokeLinejoin="round" />
        <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} stroke="transparent" strokeWidth={Math.max(10, a.strokeWidth + 6)} fill="none" />
      </g>
    );
  }
  return <AnnotationShape a={a} />;
}

/** A zig-zag under the text line, like Acrobat and WebViewer draw squiggly. */
export function squigglePath(r: Rect): string {
  const amp = Math.max(1, Math.min(3, r.h * 0.08));
  const step = amp * 2;
  const y = r.y + r.h - amp;
  let d = `M${r.x} ${y}`;
  for (let x = r.x + step, up = true; x <= r.x + r.w + 0.01; x += step, up = !up) d += `L${x} ${up ? y - amp : y + amp}`;
  return d;
}

const openPath = (pts: Pt[]) =>
  pts.length > 3 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y ? pts.slice(0, -1) : pts;

/** Scalloped outline: each edge split into half-circle bumps that bulge outwards. */
export function cloudPath(pts: Pt[], strokeWidth: number): string {
  if (pts.length < 2) return '';
  const size = Math.max(6, strokeWidth * 4);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  const sweep = area >= 0 ? 1 : 0; // clockwise on screen → bumps on the left of travel, i.e. outside
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(1, Math.round(len / size));
    for (let k = 1; k <= n; k++) {
      const x = p.x + ((q.x - p.x) * k) / n, y = p.y + ((q.y - p.y) * k) / n;
      const r = len / n / 2;
      d += `A${r} ${r} 0 0 ${sweep} ${x} ${y}`;
    }
  }
  return `${d}Z`;
}

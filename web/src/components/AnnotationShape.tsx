import { arrowHead, textBox, textLayoutBox, textOrigin } from '../sdk/geometry';
import { wrapRuns } from '../sdk/richtext';
import type { TextRun } from '../sdk/richtext';
import { labelAnchor, measureLabel } from '../sdk/measure';
import type { Annotation, Pt } from '../sdk/types';

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Width of `text` in Helvetica at `size` (canvas units = page units); a rough estimate where there is no canvas. */
function measureText(text: string, size: number, run: TextRun): number {
  if (measureCtx === undefined) {
    try { measureCtx = document.createElement('canvas').getContext('2d'); } catch { measureCtx = null; }
  }
  if (!measureCtx) return text.length * size * (run.bold ? 0.58 : 0.53);
  measureCtx.font = `${run.italic ? 'italic ' : ''}${run.bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

const pts = (list: Pt[]) => list.map((p) => `${p.x},${p.y}`).join(' ');

/** Interior colour of a rect or ellipse, at the annotation's opacity. */
const fillOf = (a: Annotation) => (a.fill ? { fill: a.fill, fillOpacity: a.opacity } : {});

/** The two strokes of an open arrow head at `b`, coming from `a`. */
const openArrow = (a: Pt, b: Pt, width: number): Pt[] => {
  const [tip, left, right] = arrowHead(a, b, width);
  return [left, tip, right];
};

/** Pure SVG rendering of one annotation in page units. */
export function AnnotationShape({ a }: { a: Annotation }) {
  const stroke = { stroke: a.color, strokeWidth: a.strokeWidth, strokeOpacity: a.opacity, fill: 'none' };
  switch (a.kind) {
    case 'highlight':
      return (
        <g style={{ mixBlendMode: 'multiply' }} fill={a.color} fillOpacity={a.opacity}>
          {a.rects?.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} />)}
        </g>
      );
    case 'underline':
    case 'strikeout':
      return (
        <g {...stroke} strokeWidth={Math.max(1, a.strokeWidth)}>
          {a.rects?.map((r, i) => {
            const y = a.kind === 'underline' ? r.y + r.h * 0.92 : r.y + r.h * 0.55;
            return <line key={i} x1={r.x} x2={r.x + r.w} y1={y} y2={y} />;
          })}
          {/* invisible hit area */}
          {a.rects?.map((r, i) => <rect key={`h${i}`} x={r.x} y={r.y} width={r.w} height={r.h} stroke="none" fill="transparent" />)}
        </g>
      );
    case 'rect':
      return a.rect ? <rect x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} {...stroke} {...fillOf(a)} /> : null;
    case 'ellipse':
      return a.rect ? (
        <ellipse cx={a.rect.x + a.rect.w / 2} cy={a.rect.y + a.rect.h / 2} rx={a.rect.w / 2} ry={a.rect.h / 2} {...stroke} {...fillOf(a)} />
      ) : null;
    case 'line':
    case 'arrow': {
      if (a.points?.length !== 2) return null;
      const [p, q] = a.points;
      return (
        <g>
          <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} {...stroke} strokeLinecap="round" />
          {a.kind === 'arrow' && (
            <polygon points={pts(arrowHead(p, q, a.strokeWidth))} fill={a.color} fillOpacity={a.opacity} />
          )}
          <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="transparent" strokeWidth={Math.max(10, a.strokeWidth + 6)} />
        </g>
      );
    }
    case 'ink':
      return (
        <g {...stroke} strokeLinecap="round" strokeLinejoin="round">
          {/* a one-point stroke is a pen tap (a dot, a decimal point): SVG draws nothing for it, so draw the dot */}
          {a.paths?.map((p, i) => p.length === 1
            ? <circle key={i} cx={p[0].x} cy={p[0].y} r={Math.max(0.5, a.strokeWidth / 2)} stroke="none" fill={a.color} fillOpacity={a.opacity} />
            : <polyline key={i} points={pts(p)} />)}
          {a.paths?.map((p, i) => (
            <polyline key={`h${i}`} points={pts(p)} stroke="transparent" strokeWidth={Math.max(10, a.strokeWidth + 6)} />
          ))}
        </g>
      );
    case 'freetext': {
      if (!a.rect) return null;
      const size = a.fontSize ?? 14;
      const box = textBox(a)!;
      const lay = textLayoutBox(box, a.rotation);
      // wrapped between words at the box's right edge, as WebViewer wraps typed comments
      const firstAt = textOrigin(lay, a.rotation, size, 1);
      const lines = wrapRuns(a.richText?.length ? a.richText : [{ text: a.text || ' ' }], lay.x + lay.w - firstAt.x, (t, r) => measureText(t, size, r));
      const at = textOrigin(lay, a.rotation, size, lines.length);
      // SVG turns clockwise for positive angles; `rotation` is counter-clockwise, as in PDF
      const turn = a.rotation ? `rotate(${-a.rotation} ${box.x + box.w / 2} ${box.y + box.h / 2})` : undefined;
      const callout = a.callout && a.callout.length >= 2 ? a.callout : null;
      return (
        <g>
          <rect x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} fill="transparent" />
          {(a.fill || callout) && (
            <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={a.fill ?? 'none'}
              stroke={callout ? a.color : 'none'} strokeWidth={callout ? a.strokeWidth : 0} />
          )}
          {callout && (
            <g stroke={a.color} strokeWidth={a.strokeWidth} fill="none" strokeLinejoin="round" strokeLinecap="round">
              <polyline points={pts(callout)} />
              {/Arrow/.test(a.calloutEnd ?? '') && (
                /Closed/.test(a.calloutEnd!)
                  ? <polygon points={pts(arrowHead(callout[1], callout[0], a.strokeWidth))} fill={a.color} />
                  : <polyline points={pts(openArrow(callout[1], callout[0], a.strokeWidth))} />
              )}
            </g>
          )}
          <text x={at.x} y={at.y} fontSize={size} fill={a.color} fillOpacity={a.opacity}
            fontFamily="Helvetica, Arial, sans-serif" transform={turn}>
            {/* each line starts at its first piece: SVG ignores x/dy on an empty tspan */}
            {lines.map((line, i) => (line.length ? line : [{ text: '\u00a0' } as TextRun]).map((r, j) => (
              <tspan key={`${i}-${j}`} x={j === 0 ? at.x : undefined} dy={j === 0 ? size : undefined}
                fontWeight={r.bold ? 700 : undefined} fontStyle={r.italic ? 'italic' : undefined}
                textDecoration={r.underline ? 'underline' : undefined} fill={r.color}>{r.text}</tspan>
            )))}
          </text>
        </g>
      );
    }
    case 'note':
      if (!a.rect) return null;
      return (
        <g>
          <title>{a.comment || 'Note'}</title>
          <rect x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} rx={3} fill={a.color} stroke="#0006" strokeWidth={0.75} />
          <path
            d={`M${a.rect.x + 5} ${a.rect.y + 7}h${a.rect.w - 10}M${a.rect.x + 5} ${a.rect.y + 12}h${a.rect.w - 10}M${a.rect.x + 5} ${a.rect.y + 17}h${(a.rect.w - 10) * 0.6}`}
            stroke="#0009" strokeWidth={1.4} strokeLinecap="round" />
        </g>
      );
    case 'stamp': {
      if (!a.rect) return null;
      return (
        <g opacity={a.opacity}>
          <rect x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} rx={4} fill="none" stroke={a.color} strokeWidth={a.strokeWidth} />
          <text x={a.rect.x + a.rect.w / 2} y={a.rect.y + a.rect.h / 2} fill={a.color} textAnchor="middle" dominantBaseline="central"
            fontWeight={700} fontFamily="Helvetica, Arial, sans-serif" textLength={a.rect.w * 0.85} lengthAdjust="spacingAndGlyphs"
            fontSize={a.rect.h * 0.55}>
            {a.text}
          </text>
        </g>
      );
    }
    case 'distance':
    case 'perimeter':
    case 'area': {
      const p = a.points ?? [];
      if (p.length < 2) return null;
      const label = measureLabel(a);
      const c = labelAnchor(a);
      const w = label.length * 5.6 + 8;
      let ticks = null;
      if (a.kind === 'distance') {
        const [s0, s1] = p;
        const len = Math.hypot(s1.x - s0.x, s1.y - s0.y) || 1;
        const nx = (-(s1.y - s0.y) / len) * 6;
        const ny = ((s1.x - s0.x) / len) * 6;
        ticks = [s0, s1].map((e, i) => <line key={i} x1={e.x - nx} y1={e.y - ny} x2={e.x + nx} y2={e.y + ny} />);
      }
      return (
        <g>
          {a.kind === 'area'
            ? <polygon points={pts(p)} {...stroke} fill={a.color} fillOpacity={0.15} strokeLinejoin="round" />
            : <polyline points={pts(p)} {...stroke} strokeLinejoin="round" strokeLinecap="round" />}
          <g {...stroke}>{ticks}</g>
          <polyline points={pts(p)} stroke="transparent" strokeWidth={Math.max(10, a.strokeWidth + 6)} fill="none" />
          <rect x={c.x - w / 2} y={c.y - 8} width={w} height={16} rx={3} fill="#fff" fillOpacity={0.9} stroke={a.color} strokeWidth={0.5} />
          <text x={c.x} y={c.y} fontSize={10} fill={a.color} textAnchor="middle" dominantBaseline="central"
            fontFamily="Helvetica, Arial, sans-serif">{label}</text>
        </g>
      );
    }
    case 'redact':
      return a.rect ? (
        <g>
          <defs>
            <pattern id={`rh-${a.id}`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={6} stroke="#e5484d" strokeWidth={1.5} strokeOpacity={0.5} />
            </pattern>
          </defs>
          <rect x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} fill={`url(#rh-${a.id})`} stroke="#e5484d" strokeWidth={1.2} strokeDasharray="4 2" />
        </g>
      ) : null;
    case 'signature':
      return a.rect && a.image ? (
        <image href={a.image} x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} opacity={a.opacity} preserveAspectRatio="none" />
      ) : null;
  }
}

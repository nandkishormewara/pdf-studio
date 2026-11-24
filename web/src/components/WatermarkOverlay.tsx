import { watermarkPlacement } from '../sdk/watermark';
import type { ResolvedWatermark } from '../sdk/watermark';

/**
 * The per-user watermark over one page, in page units (it zooms with the page). It ignores the pointer,
 * so text selection and annotation tools work through it, and is hidden from screen readers.
 */
export function WatermarkOverlay({ width, height, watermark: w }: { width: number; height: number; watermark: ResolvedWatermark }) {
  const { cx, cy, angle } = watermarkPlacement(width, height);
  return (
    <svg
      className="watermark-overlay"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5, userSelect: 'none' }}
    >
      <text
        x={cx}
        y={cy}
        transform={`rotate(${-angle} ${cx} ${cy})`}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="sans-serif"
        fontSize={w.fontSize}
        fill={w.color}
        fillOpacity={w.opacity}
      >
        {w.text}
      </text>
    </svg>
  );
}

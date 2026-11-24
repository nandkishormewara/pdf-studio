import { useT } from '../i18n';
import { useEffect, useRef, useState } from 'react';

interface Props {
  onSave: (png: string) => void;
  onClose: () => void;
}

const W = 520;
const H = 180;

/** Crops transparent margins so the placed signature hugs the ink. */
function trimmed(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
  if (x2 < 0) return null;
  const pad = 6;
  const out = document.createElement('canvas');
  out.width = x2 - x1 + pad * 2;
  out.height = y2 - y1 + pad * 2;
  out.getContext('2d')!.drawImage(canvas, x1 - pad, y1 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export function SignatureDialog({ onSave, onClose }: Props) {
  const t = useT();
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#1a2b6d');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const dpr = 2;

  const clear = () => {
    const c = canvasRef.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  };

  useEffect(() => {
    if (mode !== 'type') return;
    clear();
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.font = `${64 * dpr}px "Brush Script MT", "Segoe Script", "Snell Roundhand", cursive`;
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 20 * dpr, (H / 2) * dpr);
  }, [mode, name, color]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W * dpr, y: ((e.clientY - r.top) / r.height) * H * dpr };
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('Create signature')}>
        <h2>{t('Create signature')}</h2>
        <div className="tabs">
          <button className={mode === 'draw' ? 'on' : ''} onClick={() => { setMode('draw'); clear(); }}>{t('Draw')}</button>
          <button className={mode === 'type' ? 'on' : ''} onClick={() => setMode('type')}>{t('Type')}</button>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title={t('Ink colour')} />
        </div>
        {mode === 'type' && (
          <input className="sig-name" placeholder={t('Type your name')} value={name} autoFocus
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        )}
        <canvas
          ref={canvasRef}
          className="sig-pad"
          width={W * dpr}
          height={H * dpr}
          onPointerDown={(e) => {
            if (mode !== 'draw') return;
            e.currentTarget.setPointerCapture(e.pointerId);
            last.current = pos(e);
          }}
          onPointerMove={(e) => {
            if (!last.current) return;
            const p = pos(e);
            const ctx = canvasRef.current!.getContext('2d')!;
            ctx.strokeStyle = color;
            ctx.lineWidth = 2.5 * dpr * Math.max(0.6, e.pressure ? e.pressure * 1.6 : 1);
            ctx.lineCap = ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(last.current.x, last.current.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            last.current = p;
          }}
          onPointerUp={() => (last.current = null)}
        />
        <div className="modal-actions">
          <button onClick={clear}>{t('Clear')}</button>
          <span className="spacer" />
          <button onClick={onClose}>{t('Cancel')}</button>
          <button
            className="primary"
            onClick={() => {
              const png = trimmed(canvasRef.current!);
              if (png) onSave(png);
            }}
          >
            {t('Use signature')}
          </button>
        </div>
      </div>
    </div>
  );
}

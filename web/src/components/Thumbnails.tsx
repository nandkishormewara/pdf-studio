import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageSize } from '../sdk/types';
import { Icon } from './Icon';
import { useT } from '../i18n';
import type { LayerConfig } from '../sdk/layers';

const WIDTH = 120;

export interface PageActions {
  rotate: (page: number, cw: boolean) => void;
  remove: (page: number) => void;
  move: (from: number, to: number) => void;
  extract: (page: number) => void;
  insertBlank: (at: number) => void;
}

const Thumb = memo(function Thumb({ pdf, index, size, active, onClick, count, layerConfig, layerHash }: {
  pdf: PDFDocumentProxy; index: number; size: PageSize; active: boolean; onClick: () => void; count: number;
  layerConfig: LayerConfig | null; layerHash: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  const scale = WIDTH / size.width;

  useEffect(() => {
    const el = ref.current!;
    const obs = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: '300px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!seen) return;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    pdf.getPage(index + 1).then((page) => {
      const vp = page.getViewport({ scale: scale * 2 });
      const c = ref.current;
      if (!c) return;
      c.width = vp.width;
      c.height = vp.height;
      task = page.render({ canvas: c, viewport: vp, optionalContentConfigPromise: layerConfig ? Promise.resolve(layerConfig) : undefined });
      task.promise.catch(() => {});
    });
    return () => task?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layerHash stands for layerConfig's (mutable) state
  }, [seen, pdf, index, scale, layerHash]);

  return (
    <button className={`thumb ${active ? 'active' : ''}`} onClick={onClick} aria-label={`Page ${index + 1}`}>
      <canvas ref={ref} style={{ width: WIDTH, height: size.height * scale }} />
      <span>
        {index + 1}
        {count > 0 && <em title={`${count} annotations`}>{count}</em>}
      </span>
    </button>
  );
});

export function Thumbnails({ pdf, sizes, current, onSelect, counts, actions, busy, layerConfig, layerHash }: {
  pdf: PDFDocumentProxy; sizes: PageSize[]; current: number; onSelect: (i: number) => void;
  layerConfig: LayerConfig | null; layerHash: string;
  counts: Map<number, number>; actions: PageActions; busy: boolean;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    listRef.current?.querySelector('.thumb.active')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <div className={`thumbs ${busy ? 'busy' : ''}`} ref={listRef}>
      {sizes.map((s, i) => (
        <div
          key={i}
          className={`thumb-wrap ${dropAt === i && dragFrom !== null ? 'drop-before' : ''} ${dropAt === i + 1 && i === sizes.length - 1 && dragFrom !== null ? 'drop-after' : ''}`}
          draggable={!busy}
          onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
          onDragOver={(e) => {
            if (dragFrom === null) return;
            e.preventDefault();
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
          }}
          onDrop={(e) => {
            if (dragFrom === null || dropAt === null) return;
            e.preventDefault();
            e.stopPropagation();
            const to = dropAt > dragFrom ? dropAt - 1 : dropAt;
            if (to !== dragFrom) actions.move(dragFrom, to);
            setDragFrom(null);
            setDropAt(null);
          }}
          onDragEnd={() => { setDragFrom(null); setDropAt(null); }}
        >
          <Thumb pdf={pdf} index={i} size={s} active={i === current} onClick={() => onSelect(i)} count={counts.get(i) ?? 0} layerConfig={layerConfig} layerHash={layerHash} />
          <div className="thumb-actions" role="toolbar" aria-label={`Page ${i + 1} actions`}>
            <button className="icon" title={t('Rotate left')} disabled={busy} onClick={() => actions.rotate(i, false)}><Icon name="rotl" size={14} /></button>
            <button className="icon" title={t('Rotate right')} disabled={busy} onClick={() => actions.rotate(i, true)}><Icon name="rotr" size={14} /></button>
            <button className="icon" title={t('Insert blank page after')} disabled={busy} onClick={() => actions.insertBlank(i + 1)}><Icon name="plus" size={14} /></button>
            <button className="icon" title={t('Download this page as PDF')} disabled={busy} onClick={() => actions.extract(i)}><Icon name="download" size={14} /></button>
            <button className="icon danger" title={t('Delete page')} disabled={busy || sizes.length < 2} onClick={() => actions.remove(i)}><Icon name="trash" size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

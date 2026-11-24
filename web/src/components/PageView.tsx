import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { RenderingCancelledException, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { bbox, normRect, translate, uid } from '../sdk/geometry';
import { readPageInteractive } from '../sdk/forms';
import type { PageInteractive } from '../sdk/forms';
import type { Annotation, FormValues, MeasureScale, PageLink, PageSize, Pt, Rect, SearchHit, Tool, ToolStyle } from '../sdk/types';
import { FormLayer } from './FormLayer';
import { RichTextEditor } from './RichTextEditor';
import { isPlainRuns, plainText } from '../sdk/richtext';
import type { AnnotationStore } from '../state/store';
import { AnnotationShape } from './AnnotationShape';
import { LABELS } from './labels';
import type { LayerConfig } from '../sdk/layers';
import type { ResolvedWatermark } from '../sdk/watermark';
import { WatermarkOverlay } from './WatermarkOverlay';
import { useT } from '../i18n';

export interface PageContext {
  pdf: PDFDocumentProxy;
  scale: number;
  tool: Tool;
  style: ToolStyle;
  store: AnnotationStore;
  signature: string | null;
  author: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onNoteCreated: (id: string) => void;
  onToolDone: () => void;
  measure: MeasureScale;
  formValues: FormValues;
  setFormValue: (name: string, value: string | boolean | string[]) => void;
  onLink: (link: PageLink) => void;
  signedFields: string[];
  /** Layer visibility for rendering (null: the document has no layers) and its hash, which changes when a layer is switched. */
  layerConfig: LayerConfig | null;
  layerHash: string;
  /** per-user watermark over every page (null: none) */
  watermark?: ResolvedWatermark | null;
}

interface Props {
  ctx: PageContext;
  index: number;
  size: PageSize;
  visible: boolean;
  annotations: Annotation[];
  hits: SearchHit[];
  activeHit: SearchHit | null;
}

const BOX_KINDS = new Set(['rect', 'ellipse', 'freetext', 'note', 'stamp', 'signature', 'redact']);
const MARKUP_KINDS = new Set(['highlight', 'underline', 'strikeout']);
const POLY_KINDS = new Set(['perimeter', 'area']);

type Drag =
  | { mode: 'draw'; start: Pt; current: Pt; path: Pt[] }
  | { mode: 'move'; id: string; start: Pt; original: Annotation }
  | { mode: 'resize'; id: string; start: Pt; original: Annotation };

function PageViewImpl({ ctx, index, size, visible, annotations, hits, activeHit }: Props) {
  const t = useT();
  const annotationLabel = (a: Annotation) =>
    [t(LABELS[a.kind]), a.kind === 'freetext' || a.kind === 'stamp' ? a.text : '', a.comment, t('by {author}', { author: a.author })]
      .filter(Boolean).join(', ');
  const { pdf, scale, tool, style, store, layerConfig, layerHash } = ctx;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inter, setInter] = useState<PageInteractive | null>(null);
  const [poly, setPoly] = useState<Pt[] | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);

  // Abandon an unfinished polygon when the tool changes.
  useEffect(() => setPoly(null), [tool]);

  // Form fields and links (read once per page).
  useEffect(() => {
    if (!visible || inter) return;
    let cancelled = false;
    pdf.getPage(index + 1)
      .then((page) => readPageInteractive(pdf, page, index, page.getViewport({ scale: 1 })))
      .then((d) => !cancelled && setInter(d))
      .catch(() => !cancelled && setInter({ widgets: [], links: [] }));
    return () => { cancelled = true; };
  }, [pdf, index, visible, inter]);

  // --- Rendering: canvas + selectable text layer, only while near the viewport.
  useEffect(() => {
    const canvas = canvasRef.current;
    const textDiv = textRef.current;
    if (!canvas || !textDiv) return;
    if (!visible) {
      canvas.width = canvas.height = 0;
      textDiv.replaceChildren();
      return;
    }
    let task: ReturnType<Awaited<ReturnType<typeof pdf.getPage>>['render']> | null = null;
    let textLayer: TextLayer | null = null;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const off = document.createElement('canvas'); // render off-screen to avoid flashing blank on zoom
      off.width = Math.floor(vp.width * dpr);
      off.height = Math.floor(vp.height * dpr);
      task = page.render({
        canvas: off, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        optionalContentConfigPromise: layerConfig ? Promise.resolve(layerConfig) : undefined,
      });
      await task.promise;
      if (cancelled) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext('2d')!.drawImage(off, 0, 0);
      textDiv.replaceChildren();
      textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: vp });
      await textLayer.render();
      setError(null);
    })().catch((e) => {
      if (!(e instanceof RenderingCancelledException) && !cancelled) setError(String(e?.message ?? e));
    });
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layerHash stands for layerConfig's (mutable) state
  }, [pdf, index, scale, visible, layerHash]);

  // --- Pointer helpers
  const toPage = (e: { clientX: number; clientY: number }): Pt => {
    const r = pageRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(size.width, (e.clientX - r.left) / scale)),
      y: Math.max(0, Math.min(size.height, (e.clientY - r.top) / scale)),
    };
  };

  const base = (): Omit<Annotation, 'kind'> => {
    const now = new Date().toISOString();
    return {
      id: uid(), page: index, color: style.color, opacity: style.opacity, strokeWidth: style.strokeWidth,
      status: 'none', author: ctx.author, createdAt: now, modifiedAt: now,
    };
  };

  const drawing = tool !== 'select' && !MARKUP_KINDS.has(tool);

  function onSvgPointerDown(e: RPointerEvent<SVGSVGElement>) {
    if (!drawing || e.button !== 0) return;
    if (tool === 'signature' && !ctx.signature) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toPage(e);
    if (POLY_KINDS.has(tool)) {
      setPoly((cur) => (cur ? [...cur, p] : [p]));
      return;
    }
    setDrag({ mode: 'draw', start: p, current: p, path: [p] });
  }

  function finishPoly() {
    if (!poly) return;
    // a double-click adds the last point twice; drop near-duplicates
    const pts = poly.filter((p, i) => i === 0 || Math.hypot(p.x - poly[i - 1].x, p.y - poly[i - 1].y) > 2);
    setPoly(null);
    if (pts.length < (tool === 'area' ? 3 : 2)) return;
    store.add({ ...base(), kind: tool as 'area' | 'perimeter', points: pts, measure: ctx.measure, opacity: 1 });
  }

  function onShapePointerDown(e: RPointerEvent, a: Annotation, mode: 'move' | 'resize') {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    store.select(a.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    store.checkpoint();
    setDrag({ mode, id: a.id, start: toPage(e), original: a });
  }

  function onPointerMove(e: RPointerEvent) {
    if (poly) setHover(toPage(e));
    if (!drag) return;
    const p = toPage(e);
    if (drag.mode === 'draw') {
      setDrag({ ...drag, current: p, path: tool === 'ink' ? [...drag.path, p] : drag.path });
    } else if (drag.mode === 'move') {
      const moved = translate(drag.original, p.x - drag.start.x, p.y - drag.start.y);
      store.update(drag.id, moved, true);
    } else if (drag.original.rect) {
      const r = drag.original.rect;
      store.update(drag.id, {
        rect: { ...r, w: Math.max(8, r.w + p.x - drag.start.x), h: Math.max(8, r.h + p.y - drag.start.y) },
      }, true);
    }
  }

  function onPointerUp() {
    if (!drag) return;
    setDrag(null);
    if (drag.mode !== 'draw') return;
    const a = buildFromDrag(drag.start, drag.current, drag.path);
    if (a) {
      store.add(a);
      if (a.kind === 'freetext') ctx.setEditingId(a.id);
      if (a.kind === 'note') ctx.onNoteCreated(a.id);
      if (a.kind === 'signature' || a.kind === 'stamp' || a.kind === 'note') ctx.onToolDone();
    }
  }

  function buildFromDrag(start: Pt, end: Pt, path: Pt[]): Annotation | null {
    const r = normRect(start, end);
    const tiny = r.w < 4 && r.h < 4;
    const b = base();
    switch (tool) {
      case 'rect':
      case 'ellipse':
        return tiny ? null : { ...b, kind: tool, rect: r };
      case 'redact':
        return tiny ? null : { ...b, kind: 'redact', rect: r, color: '#e5484d', opacity: 1, strokeWidth: 1 };
      case 'line':
      case 'arrow':
        return tiny ? null : { ...b, kind: tool, points: [start, end] };
      case 'distance':
        return tiny ? null : { ...b, kind: 'distance', points: [start, end], measure: ctx.measure, opacity: 1 };
      case 'ink':
        // a tap is a dot (a decimal point, a full stop), as in Apryse WebViewer
        return path.length === 0 ? null : { ...b, kind: 'ink', paths: [path] };
      case 'freetext':
        return { ...b, kind: 'freetext', fontSize: style.fontSize, text: '', opacity: 1,
          rect: tiny ? { x: start.x, y: start.y, w: 180, h: style.fontSize * 1.6 + 8 } : r };
      case 'note':
        return { ...b, kind: 'note', color: '#ffd84d', opacity: 1, comment: '', rect: { x: start.x, y: start.y, w: 22, h: 22 } };
      case 'stamp': {
        const w = tiny ? Math.max(90, style.stampText.length * 13) : r.w;
        return { ...b, kind: 'stamp', text: style.stampText, strokeWidth: 2.5,
          rect: tiny ? { x: start.x, y: start.y, w, h: 34 } : r };
      }
      case 'signature':
        return { ...b, kind: 'signature', image: ctx.signature!, opacity: 1, color: '#000000',
          rect: tiny ? { x: start.x, y: start.y, w: 160, h: 60 } : r };
      default:
        return null;
    }
  }

  // --- Text markup from the browser's text selection
  function onPageMouseUp() {
    if (!MARKUP_KINDS.has(tool)) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const pr = pageRef.current!.getBoundingClientRect();
    const rects: Rect[] = [];
    for (const cr of Array.from(sel.getRangeAt(0).getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue;
      if (cr.right < pr.left || cr.left > pr.right || cr.bottom < pr.top || cr.top > pr.bottom) continue;
      const r = { x: (cr.left - pr.left) / scale, y: (cr.top - pr.top) / scale, w: cr.width / scale, h: cr.height / scale };
      // drop rects fully contained in one we already have (nested spans)
      if (!rects.some((o) => r.x >= o.x - 0.5 && r.y >= o.y - 0.5 && r.x + r.w <= o.x + o.w + 0.5 && r.y + r.h <= o.y + o.h + 0.5))
        rects.push(r);
    }
    sel.removeAllRanges();
    if (!rects.length) return;
    const b = base();
    store.add({
      ...b, kind: tool as Annotation['kind'], rects,
      opacity: tool === 'highlight' ? Math.min(style.opacity, 0.45) : style.opacity,
      strokeWidth: tool === 'highlight' ? 0 : Math.max(1, style.strokeWidth),
    });
  }

  const preview: Annotation | null =
    drag?.mode === 'draw' && !(drag.start.x === drag.current.x && drag.start.y === drag.current.y)
      ? buildFromDrag(drag.start, drag.current, drag.path)
      : null;

  const editing = annotations.find((a) => a.id === ctx.editingId && a.kind === 'freetext');

  return (
    <div
      ref={pageRef}
      className="page"
      data-page={index}
      style={{ width: size.width * scale, height: size.height * scale, ['--total-scale-factor' as string]: scale }}
      onMouseUp={onPageMouseUp}
      onPointerDown={(e) => {
        if (tool === 'select' && !(e.target as Element).closest('.annot, .handle')) store.select(null);
      }}
    >
      <canvas ref={canvasRef} className="page-canvas" />
      <div ref={textRef} className={`textLayer ${MARKUP_KINDS.has(tool) ? 'markup' : ''}`} />
      {error && <div className="page-error">{t('Couldn\'t render this page:')} {error}</div>}
      {inter && (inter.widgets.length > 0 || inter.links.length > 0) && (
        <FormLayer data={inter} signedFields={ctx.signedFields} scale={scale} values={ctx.formValues} interactive={tool === 'select'}
          onChange={ctx.setFormValue} onLink={ctx.onLink} />
      )}
      <div className="hit-layer">
        {hits.flatMap((h, i) =>
          h.rects.map((r, j) => (
            <div key={`${i}-${j}`} className={`hit ${h === activeHit ? 'active' : ''}`}
              style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }} />
          )),
        )}
      </div>
      {ctx.watermark && <WatermarkOverlay width={size.width} height={size.height} watermark={ctx.watermark} />}
      <svg
        ref={svgRef}
        className={`annot-layer tool-${tool}`}
        viewBox={`0 0 ${size.width} ${size.height}`}
        onPointerDown={onSvgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={finishPoly}
      >
        {annotations.map((a) => (
          <g
            key={a.id}
            className="annot"
            data-annot={a.id}
            // Keyboard: Tab reaches each annotation, arrows move it (Shift = 10×), Enter edits, Delete removes.
            tabIndex={tool === 'select' ? 0 : undefined}
            role={tool === 'select' ? 'button' : undefined}
            aria-label={annotationLabel(a)}
            aria-pressed={tool === 'select' ? store.selectedId === a.id : undefined}
            onFocus={() => tool === 'select' && store.select(a.id)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 10 : 1;
              const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
              if (d) {
                e.preventDefault();
                e.stopPropagation();
                store.update(a.id, translate(a, d[0], d[1]));
              } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (a.kind === 'freetext') ctx.setEditingId(a.id);
                else ctx.onNoteCreated(a.id); // opens its comment
              }
            }}
            onPointerDown={(e) => onShapePointerDown(e, a, 'move')}
            onDoubleClick={() => {
              if (a.kind === 'freetext') ctx.setEditingId(a.id);
              if (a.kind === 'note') ctx.onNoteCreated(a.id);
            }}
          >
            {a.id !== editing?.id && <AnnotationShape a={a} />}
          </g>
        ))}
        {preview && <g className="preview"><AnnotationShape a={preview} /></g>}
        {poly && (
          <g className="preview">
            <AnnotationShape a={{ ...base(), kind: tool as 'area', points: hover ? [...poly, hover] : poly, measure: ctx.measure, opacity: 1 }} />
            {poly.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={3 / scale} fill="#fff" stroke={style.color} />)}
          </g>
        )}
        {(() => {
          const sel = annotations.find((a) => a.id === store.selectedId);
          if (!sel || tool !== 'select') return null;
          const r = bbox(sel);
          const pad = 3 / scale;
          return (
            <g className="selection">
              <rect x={r.x - pad} y={r.y - pad} width={r.w + pad * 2} height={r.h + pad * 2} />
              {BOX_KINDS.has(sel.kind) && sel.kind !== 'note' && (
                <rect className="handle" x={r.x + r.w - 5 / scale} y={r.y + r.h - 5 / scale} width={10 / scale} height={10 / scale}
                  onPointerDown={(e) => onShapePointerDown(e, sel, 'resize')} />
              )}
            </g>
          );
        })()}
      </svg>
      {editing?.rect && (
        <RichTextEditor
          annotation={editing}
          scale={scale}
          onDone={(runs) => {
            ctx.setEditingId(null);
            if (!runs) { store.remove(editing.id); return; }
            const text = plainText(runs);
            const lines = text.split('\n');
            const size = editing.fontSize ?? 14;
            const longest = Math.max(...lines.map((l) => l.length), 4);
            store.update(editing.id, {
              text,
              richText: isPlainRuns(runs, editing.color) ? undefined : runs,
              rect: { ...editing.rect!, w: Math.max(editing.rect!.w, longest * size * 0.58 + 8), h: lines.length * size * 1.2 + 10 },
            });
          }}
        />
      )}
      <div className="page-number">{index + 1}</div>
    </div>
  );
}

export const PageView = memo(PageViewImpl);

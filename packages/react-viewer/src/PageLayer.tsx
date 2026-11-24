import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { RenderingCancelledException, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { bbox, normRect, translate, uid } from '../../../web/src/sdk/geometry';
import type { PageSize, Pt, Rect } from '../../../web/src/sdk/types';
import { ViewerShape } from './shapes';
import type { ViewerStore } from './store';
import { MARKUP_TOOLS, POLY_TOOLS } from './tools';
import type { ToolStyle, ViewerTool } from './tools';
import type { ViewerAnnotation } from './xfdfCompat';
import { WatermarkOverlay } from '../../../web/src/components/WatermarkOverlay';
import type { ResolvedWatermark } from '../../../web/src/sdk/watermark';

export interface PageShared {
  pdf: PDFDocumentProxy;
  scale: number;
  editable: boolean;
  tool: ViewerTool;
  style: ToolStyle;
  store: ViewerStore;
  author: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  noteId: string | null;
  setNoteId: (id: string | null) => void;
  watermark: ResolvedWatermark | null;
}

interface Props {
  ctx: PageShared;
  index: number;
  size: PageSize;
  visible: boolean;
  annotations: ViewerAnnotation[];
}

const NOTE_WIDTH = 220;
const BOX_KINDS = new Set(['rect', 'ellipse', 'freetext', 'stamp', 'signature']);

type Drag =
  | { mode: 'draw'; start: Pt; current: Pt; path: Pt[] }
  | { mode: 'move' | 'resize'; id: string; start: Pt; original: ViewerAnnotation }
  | { mode: 'erase' };

function PageLayerImpl({ ctx, index, size, visible, annotations }: Props) {
  const { pdf, scale, store, editable } = ctx;
  const tool: ViewerTool = editable ? ctx.tool : 'select';
  const style = ctx.style;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poly, setPoly] = useState<Pt[] | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);

  useEffect(() => setPoly(null), [tool]);

  // --- Canvas + selectable text, only while near the viewport.
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
      const off = document.createElement('canvas'); // off-screen, so zooming doesn't flash a blank page
      off.width = Math.floor(vp.width * dpr);
      off.height = Math.floor(vp.height * dpr);
      task = page.render({ canvas: off, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
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
  }, [pdf, index, scale, visible]);

  const toPage = (e: { clientX: number; clientY: number }): Pt => {
    const r = pageRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(size.width, (e.clientX - r.left) / scale)),
      y: Math.max(0, Math.min(size.height, (e.clientY - r.top) / scale)),
    };
  };

  const base = (): Omit<ViewerAnnotation, 'kind'> => {
    const now = new Date().toISOString();
    return {
      id: uid(), page: index, color: style.color, opacity: 1, strokeWidth: style.strokeWidth,
      status: 'none', author: ctx.author, createdAt: now, modifiedAt: now,
    };
  };

  const markup = (rects: Rect[]): ViewerAnnotation => ({
    ...base(),
    kind: tool === 'squiggly' ? 'underline' : (tool as 'highlight' | 'underline' | 'strikeout'),
    ...(tool === 'squiggly' ? { subtype: 'squiggly' as const } : {}),
    rects,
    opacity: tool === 'highlight' ? 0.45 : 1,
    strokeWidth: tool === 'highlight' ? 0 : Math.max(1, Math.min(2, style.strokeWidth)),
  });

  // --- The eraser deletes whatever annotation is under the pointer while the button is down.
  function eraseAt(e: { clientX: number; clientY: number }) {
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-annot]');
    const id = hit?.getAttribute('data-annot');
    if (id && pageRef.current?.contains(hit!)) store.remove(id, true);
  }

  function onSvgPointerDown(e: RPointerEvent<SVGSVGElement>) {
    if (!editable || e.button !== 0 || tool === 'select' || MARKUP_TOOLS.has(tool)) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (tool === 'eraser') {
      store.checkpoint();
      setDrag({ mode: 'erase' });
      eraseAt(e);
      return;
    }
    const p = toPage(e);
    if (POLY_TOOLS.has(tool)) {
      // Clicking the first point closes a polygon/cloud.
      if (poly && poly.length >= 3 && tool !== 'polyline' && Math.hypot(p.x - poly[0].x, p.y - poly[0].y) < 8 / scale) {
        finishPoly(poly);
        return;
      }
      setPoly((cur) => (cur ? [...cur, p] : [p]));
      return;
    }
    setDrag({ mode: 'draw', start: p, current: p, path: [p] });
  }

  // Markup tools: a drag that doesn't start on text draws a box (scanned pages have no text layer).
  function onPagePointerDown(e: RPointerEvent<HTMLDivElement>) {
    if (!editable && ctx.noteId && !(e.target as Element).closest('.psv-note, [data-annot]')) ctx.setNoteId(null);
    if (tool === 'select' && editable && !(e.target as Element).closest('[data-annot], .psv-handle')) store.select(null);
    if (!editable || e.button !== 0 || !MARKUP_TOOLS.has(tool)) return;
    if ((e.target as Element).closest('.textLayer span')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toPage(e);
    setDrag({ mode: 'draw', start: p, current: p, path: [p] });
  }

  function finishPoly(points = poly) {
    if (!points) return;
    // a double-click adds the last point twice; drop near-duplicates
    const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 2);
    setPoly(null);
    setHover(null);
    if (pts.length < (tool === 'polyline' ? 2 : 3)) return;
    store.add({ ...base(), kind: 'ink', subtype: tool as 'polyline' | 'polygon' | 'cloud', paths: [tool === 'polyline' ? pts : [...pts, pts[0]]] });
  }

  // Enter finishes and Escape cancels a polygon in progress.
  useEffect(() => {
    if (!poly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPoly(null);
      if (e.key === 'Enter') finishPoly();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function onShapePointerDown(e: RPointerEvent, a: ViewerAnnotation, mode: 'move' | 'resize') {
    if (a.kind === 'note' && tool === 'select') {
      e.stopPropagation();
      if (!editable) {
        ctx.setNoteId(a.id);
        return;
      }
    }
    if (!editable || tool !== 'select' || e.button !== 0) return;
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
    if (drag.mode === 'erase') {
      eraseAt(e);
      return;
    }
    const p = toPage(e);
    if (drag.mode === 'draw') {
      setDrag({ ...drag, current: p, path: tool === 'pen' ? [...drag.path, p] : drag.path });
    } else if (drag.mode === 'move') {
      store.update(drag.id, translate(drag.original, p.x - drag.start.x, p.y - drag.start.y), true);
    } else if (drag.original.rect) {
      const r = drag.original.rect;
      store.update(drag.id, { rect: { ...r, w: Math.max(8, r.w + p.x - drag.start.x), h: Math.max(8, r.h + p.y - drag.start.y) } }, true);
    }
  }

  function onPointerUp() {
    if (!drag) return;
    setDrag(null);
    if (drag.mode === 'move' && drag.original.kind === 'note') {
      // A click without movement opens the note.
      const cur = annotations.find((a) => a.id === drag.id);
      if (cur?.rect && drag.original.rect && cur.rect.x === drag.original.rect.x && cur.rect.y === drag.original.rect.y) ctx.setNoteId(drag.id);
    }
    if (drag.mode !== 'draw') return;
    const a = buildFromDrag(drag.start, drag.current, drag.path);
    if (!a) return;
    store.add(a);
    if (a.kind === 'freetext') ctx.setEditingId(a.id);
    if (a.kind === 'note') ctx.setNoteId(a.id);
  }

  function buildFromDrag(start: Pt, end: Pt, path: Pt[]): ViewerAnnotation | null {
    const r = normRect(start, end);
    const tiny = r.w < 4 && r.h < 4;
    const b = base();
    if (MARKUP_TOOLS.has(tool)) return tiny ? null : markup([r]);
    switch (tool) {
      case 'rect':
      case 'ellipse':
        return tiny ? null : { ...b, kind: tool, rect: r };
      case 'line':
      case 'arrow':
        return tiny ? null : { ...b, kind: tool, points: [start, end] };
      case 'pen':
        // a tap is a dot (a decimal point, a full stop), as in Apryse WebViewer
        return path.length === 0 ? null : { ...b, kind: 'ink', paths: [path] };
      case 'freetext':
        return { ...b, kind: 'freetext', fontSize: style.fontSize, text: '',
          rect: tiny ? { x: start.x, y: start.y, w: 180, h: style.fontSize * 1.6 + 8 } : r };
      case 'note':
        return { ...b, kind: 'note', comment: '', rect: { x: start.x, y: start.y, w: 22, h: 22 } };
      default:
        return null;
    }
  }

  // --- Text markup from the browser's text selection.
  function onPageMouseUp() {
    if (!editable || !MARKUP_TOOLS.has(tool) || drag) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const pr = pageRef.current!.getBoundingClientRect();
    const rects: Rect[] = [];
    for (const cr of Array.from(sel.getRangeAt(0).getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue;
      if (cr.right < pr.left || cr.left > pr.right || cr.bottom < pr.top || cr.top > pr.bottom) continue;
      const r = { x: (cr.left - pr.left) / scale, y: (cr.top - pr.top) / scale, w: cr.width / scale, h: cr.height / scale };
      if (!rects.some((o) => r.x >= o.x - 0.5 && r.y >= o.y - 0.5 && r.x + r.w <= o.x + o.w + 0.5 && r.y + r.h <= o.y + o.h + 0.5))
        rects.push(r);
    }
    sel.removeAllRanges();
    if (rects.length) store.add(markup(rects));
  }

  const preview = drag?.mode === 'draw' && !(drag.start.x === drag.current.x && drag.start.y === drag.current.y)
    ? buildFromDrag(drag.start, drag.current, drag.path)
    : null;
  const editing = annotations.find((a) => a.id === ctx.editingId && a.kind === 'freetext');
  const note = annotations.find((a) => a.id === ctx.noteId && a.kind === 'note');
  const selected = editable && tool === 'select' ? annotations.find((a) => a.id === store.selectedId) : undefined;
  const polyPreview: ViewerAnnotation | null = poly
    ? { ...base(), id: 'poly-preview', kind: 'ink', subtype: tool === 'cloud' ? 'cloud' : undefined,
        paths: [hover ? [...poly, hover] : poly] }
    : null;

  return (
    <div
      ref={pageRef}
      className="psv-page"
      data-page={index}
      style={{ width: size.width * scale, height: size.height * scale, ['--total-scale-factor' as string]: scale }}
      onMouseUp={onPageMouseUp}
      onPointerDown={onPagePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <canvas ref={canvasRef} className="psv-canvas" />
      <div ref={textRef} className={`textLayer ${MARKUP_TOOLS.has(tool) ? 'markup' : ''}`} />
      {error && <div className="psv-page-error">Couldn't render this page: {error}</div>}
      {ctx.watermark && <WatermarkOverlay width={size.width} height={size.height} watermark={ctx.watermark} />}
      <svg
        className={`psv-annots tool-${tool} ${editable ? 'editable' : 'readonly'}`}
        viewBox={`0 0 ${size.width} ${size.height}`}
        onPointerDown={onSvgPointerDown}
        onDoubleClick={() => finishPoly()}
      >
        {annotations.map((a) => (
          <g
            key={a.id}
            className={`psv-annot kind-${a.kind}`}
            data-annot={a.id}
            onPointerDown={(e) => onShapePointerDown(e, a, 'move')}
            onDoubleClick={() => {
              if (!editable) return;
              if (a.kind === 'freetext') ctx.setEditingId(a.id);
              if (a.kind === 'note') ctx.setNoteId(a.id);
            }}
          >
            {a.id !== editing?.id && <ViewerShape a={a} />}
          </g>
        ))}
        {preview && <g className="psv-preview"><ViewerShape a={preview} /></g>}
        {polyPreview && (
          <g className="psv-preview">
            <ViewerShape a={polyPreview} />
            {poly!.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={3 / scale} fill="#fff" stroke={style.color} strokeWidth={1 / scale} />)}
          </g>
        )}
        {selected && (() => {
          const r = bbox(selected);
          const pad = 3 / scale;
          return (
            <g className="psv-selection">
              <rect x={r.x - pad} y={r.y - pad} width={r.w + pad * 2} height={r.h + pad * 2} />
              {BOX_KINDS.has(selected.kind) && (
                <rect className="psv-handle" x={r.x + r.w - 5 / scale} y={r.y + r.h - 5 / scale} width={10 / scale} height={10 / scale}
                  onPointerDown={(e) => onShapePointerDown(e, selected, 'resize')} />
              )}
            </g>
          );
        })()}
      </svg>
      {editing?.rect && (
        <textarea
          className="psv-freetext-editor"
          autoFocus
          defaultValue={editing.text}
          style={{
            left: editing.rect.x * scale, top: editing.rect.y * scale,
            minWidth: editing.rect.w * scale, minHeight: editing.rect.h * scale,
            fontSize: (editing.fontSize ?? 14) * scale, color: editing.color,
          }}
          onBlur={(e) => {
            const text = e.currentTarget.value;
            const lines = text.split('\n');
            const fs = editing.fontSize ?? 14;
            const longest = Math.max(...lines.map((l) => l.length), 4);
            ctx.setEditingId(null);
            if (!text.trim()) store.remove(editing.id);
            else store.update(editing.id, {
              text,
              rect: { ...editing.rect!, w: Math.max(editing.rect!.w, longest * fs * 0.55 + 8), h: lines.length * fs * 1.2 + 10 },
            });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur();
            e.stopPropagation();
          }}
        />
      )}
      {note?.rect && (
        <NotePopup
          key={note.id}
          note={note}
          editable={editable}
          // beside the icon, or to its left when there's no room on the right
          left={(note.rect.x + note.rect.w + 4) * scale + NOTE_WIDTH <= size.width * scale
            ? (note.rect.x + note.rect.w + 4) * scale
            : Math.max(0, note.rect.x * scale - 4 - NOTE_WIDTH)}
          top={note.rect.y * scale}
          onClose={(text) => {
            ctx.setNoteId(null);
            if (editable && text !== undefined && text !== (note.comment ?? '')) store.update(note.id, { comment: text });
          }}
          onDelete={() => {
            ctx.setNoteId(null);
            store.remove(note.id);
          }}
        />
      )}
    </div>
  );
}

function NotePopup({ note, editable, left, top, onClose, onDelete }: {
  note: ViewerAnnotation;
  editable: boolean;
  left: number;
  top: number;
  onClose: (text?: string) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(note.comment ?? '');
  return (
    <div className="psv-note" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="psv-note-head">
        <span>{note.author}</span>
        <button type="button" aria-label="Close note" onClick={() => onClose(text)}>×</button>
      </div>
      {editable ? (
        <textarea
          autoFocus
          value={text}
          placeholder="Add a comment…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose(text);
            e.stopPropagation();
          }}
        />
      ) : (
        <p>{note.comment || 'No comment.'}</p>
      )}
      {editable && (
        <div className="psv-note-foot">
          <button type="button" onClick={onDelete}>Delete</button>
          <button type="button" className="primary" onClick={() => onClose(text)}>Done</button>
        </div>
      )}
    </div>
  );
}

export const PageLayer = memo(PageLayerImpl);

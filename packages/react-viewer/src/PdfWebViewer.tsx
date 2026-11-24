import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ForwardedRef, KeyboardEvent as RKeyboardEvent } from 'react';
import { loadPdf } from '../../../web/src/sdk/pdf';
import { resolveWatermark } from '../../../web/src/sdk/watermark';
import type { LoadedDoc } from '../../../web/src/sdk/pdf';
import type { FormValues } from '../../../web/src/sdk/types';
import { createPdfWebViewerHandle } from './handle';
import type { ViewerInstance } from './handle';
import { fetchBytes, toPdfBytes } from './loader';
import { PageLayer } from './PageLayer';
import type { PageShared } from './PageLayer';
import { useViewerStore } from './store';
import { injectStyles } from './styles';
import { Toolbar } from './Toolbar';
import { DEFAULT_COLOR, DEFAULT_COLORS } from './tools';
import type { ToolStyle, ViewerTool } from './tools';
import type { LoadDocumentOptions, PdfWebViewerHandle, PdfWebViewerProps } from './types';
import { importXfdf, mergeImport } from './xfdfCompat';
import type { ViewerAnnotation } from './xfdfCompat';

/**
 * No hard timeout — large scans on slow links must be allowed to finish. If no progress
 * arrives for this long, show a soft "still loading" note with a Reload link (not an error).
 */
const STALL_HINT_MS = 20_000;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : typeof err === 'string' && err.trim() ? err : fallback;

function PdfWebViewerInner(
  {
    documentUrl,
    mode,
    documentExtension,
    documentFilename,
    customHeaders,
    className,
    initialXfdf,
    watermark,
    author = 'Reviewer',
    onAnnotationsError,
    onReady,
    onLoad,
    onError,
  }: PdfWebViewerProps,
  ref: ForwardedRef<PdfWebViewerHandle>,
) {
  injectStyles();
  const editable = mode === 'edit';
  const wmText = typeof watermark === 'string' ? watermark : watermark?.text;
  const resolved = useMemo(() => resolveWatermark(watermark ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- compare by value: callers often pass a new object each render
    [wmText, typeof watermark === 'object' ? watermark?.color : '', typeof watermark === 'object' ? watermark?.opacity : 0, typeof watermark === 'object' ? watermark?.fontSize : 0]);
  const store = useViewerStore();
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Download progress 0–100 when the server reports a size; null = unknown. */
  const [progress, setProgress] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [tool, setTool] = useState<ViewerTool>('select');
  const [colors, setColors] = useState<Partial<Record<ViewerTool, string>>>(DEFAULT_COLORS);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [fontSize, setFontSize] = useState(16);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([0, 1]));

  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<LoadedDoc | null>(null);
  const annRef = useRef<ViewerAnnotation[]>([]);
  const fieldsRef = useRef<FormValues>({});
  const loadSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRequestRef = useRef<{ url: string; options: LoadDocumentOptions } | null>(null);
  const callbacks = useRef({ onReady, onLoad, onError, onAnnotationsError, initialXfdf });
  callbacks.current = { onReady, onLoad, onError, onAnnotationsError, initialXfdf };
  // The store is the source of truth for the UI; the ref lets the handle read it synchronously.
  annRef.current = store.annotations;

  const clearStall = () => {
    if (stallTimerRef.current != null) clearTimeout(stallTimerRef.current);
    stallTimerRef.current = null;
  };
  /** (Re)start the "no progress lately" timer — never fails the load, only hints. */
  const armStall = () => {
    clearStall();
    setStalled(false);
    stallTimerRef.current = setTimeout(() => setStalled(true), STALL_HINT_MS);
  };

  const { reset, replaceAll } = store;
  const load = useCallback(async (url: string, options: LoadDocumentOptions = {}) => {
    const seq = ++loadSeqRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    lastRequestRef.current = { url, options };
    setLoading(true);
    setError(null);
    setProgress(null);
    armStall();
    const current = () => seq === loadSeqRef.current;
    try {
      const raw = await fetchBytes(url, {
        headers: options.customHeaders,
        signal: abort.signal,
        onProgress: (fraction) => {
          if (!current()) return;
          options.onLoadingProgress?.(fraction);
          setProgress(Math.round(fraction * 100));
          armStall();
        },
      });
      if (!current()) return;
      const { pdf } = await toPdfBytes(raw, { extension: options.extension, filename: options.filename, url });
      const name = options.filename || decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || 'document.pdf');
      const loaded = await loadPdf(pdf, name, (retry) =>
        window.prompt(retry ? 'Wrong password. Enter the PDF password:' : 'This PDF is password protected. Enter the password:'));
      if (!current()) {
        void loaded.pdf.loadingTask.destroy();
        return;
      }
      // Saved marks go onto this freshly loaded document before onLoad, so they can't land on another one.
      let annotations: ViewerAnnotation[] = loaded.imported;
      let fields: FormValues = {};
      const xfdf = callbacks.current.initialXfdf?.trim();
      if (xfdf) {
        try {
          const imp = importXfdf(xfdf, loaded.viewports);
          annotations = mergeImport(annotations, imp);
          fields = imp.fields;
        } catch (err) {
          callbacks.current.onAnnotationsError?.(errorMessage(err, 'Could not load saved annotations.'));
        }
      }
      void docRef.current?.pdf.loadingTask.destroy();
      docRef.current = loaded;
      annRef.current = annotations;
      fieldsRef.current = fields;
      reset(annotations);
      setDoc(loaded);
      setVisible(new Set([0, 1]));
      setEditingId(null);
      setNoteId(null);
      clearStall();
      setStalled(false);
      setProgress(null);
      setLoading(false);
      callbacks.current.onLoad?.();
    } catch (err) {
      if (!current() || (err as Error)?.name === 'AbortError') return;
      clearStall();
      const message = errorMessage(err, 'Could not load this PDF.');
      setLoading(false);
      setStalled(false);
      setError(message);
      callbacks.current.onError?.(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, [reset]);

  const instance = useMemo<ViewerInstance>(() => ({
    getDocument: () => docRef.current && { bytes: docRef.current.bytes, viewports: docRef.current.viewports },
    getAnnotations: () => annRef.current,
    setAnnotations: (list) => {
      annRef.current = list;
      replaceAll(list);
    },
    getFormValues: () => fieldsRef.current,
    setFormValues: (values) => { fieldsRef.current = values; },
    loadDocument: (url, options) => load(url, options),
  }), [load, replaceAll]);
  const handle = useMemo(() => createPdfWebViewerHandle(instance), [instance]);
  useImperativeHandle(ref, () => handle, [handle]);

  useEffect(() => {
    callbacks.current.onReady?.(handle);
  }, [handle]);

  // Load when the document identity or headers change — never when parent callbacks change.
  const headersKey = customHeaders && Object.keys(customHeaders).length ? JSON.stringify(customHeaders) : '';
  useEffect(() => {
    const url = documentUrl?.trim();
    if (!url) {
      clearStall();
      setLoading(false);
      return;
    }
    load(url, {
      ...(documentExtension ? { extension: documentExtension } : {}),
      ...(documentFilename ? { filename: documentFilename } : {}),
      ...(headersKey ? { customHeaders: JSON.parse(headersKey) } : {}),
    }).catch(() => { /* shown in the error overlay and reported through onError */ });
  }, [documentUrl, documentExtension, documentFilename, headersKey, reloadToken, load]);

  useEffect(() => () => {
    clearStall();
    abortRef.current?.abort();
    loadSeqRef.current++;
    void docRef.current?.pdf.loadingTask.destroy();
    docRef.current = null;
  }, []);

  /** Reload the last request (from the prop or from handle.loadDocument). */
  const retry = () => {
    const last = lastRequestRef.current;
    if (last && last.url !== documentUrl?.trim()) load(last.url, last.options).catch(() => {});
    else setReloadToken((v) => v + 1);
  };

  // --- Layout: fit width until the user zooms.
  const maxPageWidth = doc ? Math.max(...doc.pageSizes.map((s) => s.width)) : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc || !fitWidth) return;
    const fit = () => {
      const w = el.clientWidth - 24;
      if (w > 0) setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, w / maxPageWidth)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc, fitWidth, maxPageWidth]);

  const zoom = (factor: number) => {
    setFitWidth(false);
    setScale((s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(s * factor * 100) / 100)));
  };

  // Render only pages near the viewport.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !doc) return;
    const obs = new IntersectionObserver((entries) => {
      setVisible((prev) => {
        const next = new Set(prev);
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) next.add(i);
          else next.delete(i);
        }
        return next;
      });
    }, { root, rootMargin: '150% 0px' });
    root.querySelectorAll('.psv-page').forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [doc]);

  // Keep the reading position when zooming.
  const prevScale = useRef(scale);
  useEffect(() => {
    const el = scrollRef.current;
    const ratio = scale / prevScale.current;
    prevScale.current = scale;
    if (el && ratio !== 1) el.scrollTop *= ratio;
  }, [scale]);

  // Leaving edit mode drops any tool in progress.
  useEffect(() => {
    if (!editable) {
      setTool('select');
      setEditingId(null);
      store.select(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  const style: ToolStyle = { color: colors[tool] ?? DEFAULT_COLOR, strokeWidth, fontSize };
  const selected = store.annotations.find((a) => a.id === store.selectedId);

  const onStyle = (patch: Partial<ToolStyle>) => {
    if (patch.color) setColors((c) => ({ ...c, [tool]: patch.color }));
    if (patch.strokeWidth) setStrokeWidth(patch.strokeWidth);
    if (patch.fontSize) setFontSize(patch.fontSize);
    if (selected && tool === 'select') {
      store.update(selected.id, {
        ...(patch.color ? { color: patch.color } : {}),
        ...(patch.strokeWidth && selected.kind !== 'highlight' ? { strokeWidth: patch.strokeWidth } : {}),
        ...(patch.fontSize && selected.kind === 'freetext' ? { fontSize: patch.fontSize } : {}),
      });
    }
  };

  const onKeyDown = (e: RKeyboardEvent) => {
    if (!editable || (e.target as Element).closest('textarea, input, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedId) {
      e.preventDefault();
      store.remove(store.selectedId);
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      store.redo();
    } else if (e.key === 'Escape') setTool('select');
  };

  const byPage = useMemo(() => {
    const m = new Map<number, ViewerAnnotation[]>();
    for (const a of store.annotations) m.set(a.page, [...(m.get(a.page) ?? []), a]);
    return m;
  }, [store.annotations]);

  const ctx: PageShared = useMemo(() => ({
    pdf: doc?.pdf as LoadedDoc['pdf'], scale, editable, tool, style, store, author,
    editingId, setEditingId, noteId, setNoteId, watermark: resolved,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [doc, scale, editable, tool, style.color, style.strokeWidth, style.fontSize, store, author, editingId, noteId, resolved]);

  return (
    <div className={`psv ${editable ? 'psv-edit' : 'psv-view'} ${className ?? ''}`} onKeyDown={onKeyDown} tabIndex={-1}>
      {editable && (
        <Toolbar
          tool={tool}
          onTool={(t) => { setTool(t); store.select(null); }}
          style={style}
          onStyle={onStyle}
          canUndo={store.canUndo}
          canRedo={store.canRedo}
          onUndo={store.undo}
          onRedo={store.redo}
          canDelete={!!selected}
          onDelete={() => selected && store.remove(selected.id)}
        />
      )}
      <div ref={scrollRef} className="psv-scroll" onContextMenu={editable ? undefined : (e) => e.preventDefault()}>
        {doc && (
          <div className="psv-pages">
            {doc.pageSizes.map((size, i) => (
              <PageLayer key={`${doc.key}-${i}`} ctx={ctx} index={i} size={size} visible={visible.has(i)} annotations={byPage.get(i) ?? EMPTY} />
            ))}
          </div>
        )}
      </div>
      {doc && (
        <div className="psv-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}>−</button>
          <button type="button" className="psv-zoom-value" title="Fit width" onClick={() => setFitWidth(true)}>{Math.round(scale * 100)}%</button>
          <button type="button" aria-label="Zoom in" onClick={() => zoom(1.2)}>+</button>
        </div>
      )}
      {loading && (
        <div className="psv-overlay" aria-live="polite">
          <span>{progress != null && progress > 0 ? `Loading PDF… ${progress}%` : 'Loading PDF…'}</span>
          {progress != null && progress > 0 && (
            <span className="psv-progress" aria-hidden><span style={{ width: `${progress}%` }} /></span>
          )}
          {stalled && (
            <span className="psv-stalled">
              Still loading — large files can take a while.{' '}
              <button type="button" className="psv-link" onClick={retry}>Reload</button>
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="psv-overlay psv-error" role="alert">
          <span>{error}</span>
          <button type="button" className="psv-retry" onClick={retry}>Retry</button>
        </div>
      )}
    </div>
  );
}

const EMPTY: ViewerAnnotation[] = [];

export const PdfWebViewer = forwardRef(PdfWebViewerInner);
PdfWebViewer.displayName = 'PdfWebViewer';

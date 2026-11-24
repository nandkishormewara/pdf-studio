import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommentsPanel } from './components/CommentsPanel';
import { Icon } from './components/Icon';
import { Menu } from './components/Menu';
import type { PageContext } from './components/PageView';
import { SearchPanel } from './components/SearchPanel';
import { SignatureDialog } from './components/SignatureDialog';
import { Thumbnails } from './components/Thumbnails';
import type { PageActions } from './components/Thumbnails';
import { Viewer } from './components/Viewer';
import type { PageLayout, ViewerApi } from './components/Viewer';
import { pageRows } from './components/Viewer';
import { annotationsFromJson, annotationsToJson, download, exportPdf } from './sdk/export';
import { collectFormData } from './sdk/forms';
import { bbox } from './sdk/geometry';
import { DEFAULT_SCALE, PAPER_UNITS, WORLD_UNITS, calibrate, describeScale, toMeasureScale } from './sdk/measure';
import type { ScaleSetting } from './sdk/measure';
import { deletePages, extractPages, insertBlankPage, insertImages, insertPdf, movePage, rotatePages } from './sdk/pages';
import type { PageOpResult } from './sdk/pages';
import { createSamplePdf, fileNameFromUrl, loadPdf, streamPdf } from './sdk/pdf';
import type { LoadedDoc } from './sdk/pdf';
import type { Annotation, FormValues, PageLink, SearchHit, Tool, ToolStyle } from './sdk/types';
import { fromXfdf, mergeXfdf, toXfdf } from './sdk/xfdf';
import { DEFAULT_SERVER, PdfServer } from './sdk/server';
import type { RedactRegion, ServerHealth } from './sdk/server';
import { readPageInteractive } from './sdk/forms';
import { dataUrlToBytes } from './sdk/textImage';
import { OcrDialog, RedactDialog, SignDialog, VerifyDialog } from './components/ServerDialogs';
import type { SignChoice } from './components/ServerDialogs';
import { useAnnotationStore } from './state/store';
import { LayersPanel } from './components/LayersPanel';
import { ExtractDialog } from './components/ExtractDialog';
import { applyByName, applyLayerState, layerState, readLayers, stateByName } from './sdk/layers';
import type { Layers } from './sdk/layers';
import './App.css';
import { LANGUAGES, useLanguage, useT } from './i18n';

const TOOLS: { id: Tool; label: string; key?: string }[] = [
  { id: 'select', label: 'Select', key: 'v' },
  { id: 'highlight', label: 'Highlight text', key: 'h' },
  { id: 'underline', label: 'Underline text', key: 'u' },
  { id: 'strikeout', label: 'Strikeout text', key: 'k' },
  { id: 'freetext', label: 'Text box', key: 't' },
  { id: 'note', label: 'Sticky note', key: 'n' },
  { id: 'ink', label: 'Freehand', key: 'p' },
  { id: 'rect', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', key: 'o' },
  { id: 'line', label: 'Line', key: 'l' },
  { id: 'arrow', label: 'Arrow', key: 'a' },
  { id: 'stamp', label: 'Stamp', key: 's' },
  { id: 'signature', label: 'Signature', key: 'g' },
  { id: 'distance', label: 'Measure distance', key: 'm' },
  { id: 'perimeter', label: 'Measure perimeter (double-click to finish)' },
  { id: 'area', label: 'Measure area (double-click to finish)' },
  { id: 'redact', label: 'Mark area for redaction', key: 'x' },
];

const MEASURE_TOOLS = new Set<Tool>(['distance', 'perimeter', 'area']);
const COLORS = ['#ffd84d', '#7ee081', '#5ab0ff', '#ff7aa8', '#e5484d', '#1f6feb', '#111111', '#7c3aed'];
const STAMPS = ['APPROVED', 'REJECTED', 'DRAFT', 'CONFIDENTIAL', 'REVIEWED', 'VOID', 'स्वीकृत'];
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const FILE_ORIGINS = ((import.meta.env.VITE_PDFSTUDIO_FILE_ORIGINS as string | undefined) ?? '').split(',').map((o) => o.trim()).filter(Boolean);
const allowedFileOrigin = (origin: string) => origin === location.origin || FILE_ORIGINS.includes(origin);
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const PDF_RE = /\.pdf$/i;

const store$ = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage full or unavailable */ } },
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function App() {
  const t = useT();
  const { lang, setLang } = useLanguage();
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [style, setStyle] = useState<ToolStyle>({ color: '#ffd84d', opacity: 0.4, strokeWidth: 2, fontSize: 14, stampText: 'APPROVED' });
  const [showThumbs, setShowThumbs] = useState(true);
  const [panel, setPanel] = useState<'comments' | 'search' | 'layers' | null>(null);
  const [layers, setLayers] = useState<Layers | null>(null);
  const [layerHash, setLayerHash] = useState('');
  const [keepLayers, setKeepLayers] = useState(() => store$.get('pdfstudio.layersKeep') === '1');
  const layersByName = useRef<Record<string, boolean> | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeHit, setActiveHit] = useState(0);
  const [signature, setSignature] = useState<string | null>(() => store$.get('pdfstudio.signature'));
  const [sigDialog, setSigDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusComment, setFocusComment] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({});
  const [flattenForms, setFlattenForms] = useState(false);
  const [scaleSetting, setScaleSetting] = useState<ScaleSetting>(() => {
    try { return { ...DEFAULT_SCALE, ...JSON.parse(store$.get('pdfstudio.scale') ?? '{}') }; } catch { return DEFAULT_SCALE; }
  });
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (store$.get('pdfstudio.theme') as 'light' | 'dark') ??
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [author, setAuthor] = useState(() => store$.get('pdfstudio.author') ?? 'Me');
  const [dragOver, setDragOver] = useState(false);
  const [layout, setLayout] = useState<PageLayout>(() => (store$.get('pdfstudio.layout') as PageLayout) || 'continuous');
  const [rtlPages, setRtlPages] = useState(() => store$.get('pdfstudio.rtlPages') === '1');
  const [coverPage, setCoverPage] = useState(() => store$.get('pdfstudio.cover') !== '0');
  const [serverUrl, setServerUrl] = useState(() => store$.get('pdfstudio.server') ?? DEFAULT_SERVER);
  const [health, setHealth] = useState<ServerHealth | null | 'offline'>(null);
  const [dialog, setDialog] = useState<'ocr' | 'redact' | 'sign' | 'verify' | 'extract' | null>(null);
  const [emptySigFields, setEmptySigFields] = useState<string[]>([]);
  const server = useMemo(() => new PdfServer(serverUrl), [serverUrl]);
  const online = health && health !== 'offline' ? health : null;
  const store = useAnnotationStore();
  const annotationsRef = useRef<Annotation[]>([]);
  const [downloaded, setDownloaded] = useState<number | null>(null);
  annotationsRef.current = store.annotations;
  const viewerApi = useRef<ViewerApi | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const annotInput = useRef<HTMLInputElement>(null);
  const formInput = useRef<HTMLInputElement>(null);
  const insertPdfInput = useRef<HTMLInputElement>(null);
  const insertImgInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store$.set('pdfstudio.theme', theme);
  }, [theme]);
  useEffect(() => store$.set('pdfstudio.scale', JSON.stringify(scaleSetting)), [scaleSetting]);
  const checkServer = useCallback(() => {
    // An empty address (e.g. the GitHub Pages demo, built with VITE_PDFSTUDIO_SERVER='') means no server.
    if (!serverUrl.trim()) return setHealth('offline');
    setHealth(null);
    server.health().then(setHealth, () => setHealth('offline'));
  }, [server, serverUrl]);
  useEffect(() => {
    store$.set('pdfstudio.server', serverUrl);
    checkServer();
  }, [serverUrl, checkServer]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // ------------------------------------------------------------ opening
  const showDoc = useCallback((loaded: LoadedDoc, annotations: Annotation[], keepView: boolean) => {
    doc?.pdf.loadingTask.destroy();
    setDoc(loaded);
    setHits([]);
    store.reset(annotations);
    if (!keepView) {
      setPage(0);
      const avail = (viewerApi.current?.containerWidth() ?? window.innerWidth - 400) - 48;
      setScale(Math.min(1.5, Math.max(0.5, avail / loaded.pageSizes[0].width)));
    }
  }, [doc, store]);

  const askPassword = (name: string) => (retry: boolean) =>
    window.prompt(retry ? t('Incorrect password. Try again:') : t('"{name}" is password protected. Enter password:', { name }));

  const openBytes = useCallback(async (bytes: Uint8Array, name: string) => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadPdf(bytes, name, askPassword(name));
      const saved = store$.get(`pdfstudio.annots.${loaded.key}`);
      const savedForm = store$.get(`pdfstudio.form.${loaded.key}`);
      setFormValues(savedForm ? JSON.parse(savedForm) : {});
      showDoc(loaded, saved ? (JSON.parse(saved) as Annotation[]) : loaded.imported, false);
      if (!saved && loaded.imported.length) setNotice(t('{n} existing annotation(s) imported and ready to edit.', { n: loaded.imported.length }));
    } catch (e) {
      const msg = errMsg(e);
      setError(/password/i.test(msg) ? t('The document could not be opened without its password.') : t('Couldn\'t open "{name}": {msg}', { name, msg }));
    } finally {
      setLoading(false);
    }
  }, [showDoc]);

  /** Large files from a URL: first pages show via range requests, the rest downloads behind. */
  const openUrl = useCallback(async (url: string) => {
    const name = fileNameFromUrl(url);
    setLoading(true);
    setError(null);
    try {
      setDownloaded(0);
      const s = await streamPdf(url, askPassword(name), name, setDownloaded);
      const empty = new Uint8Array();
      showDoc({ ...s, partial: true, original: empty, bytes: empty, signed: false, signedFields: [], imported: [], key: '' }, [], false);
      setLoading(false);
      const loaded = await loadPdf(await s.complete, name, askPassword(name));
      const saved = store$.get(`pdfstudio.annots.${loaded.key}`);
      const savedForm = store$.get(`pdfstudio.form.${loaded.key}`);
      if (savedForm) setFormValues(JSON.parse(savedForm));
      // keep anything drawn while the file was downloading
      showDoc(loaded, [...(saved ? (JSON.parse(saved) as Annotation[]) : loaded.imported), ...annotationsRef.current], true);
      s.pdf.loadingTask.destroy();
    } catch (e) {
      setError(t('Couldn\'t open "{name}": {msg}', { name, msg: errMsg(e) }));
    } finally {
      setLoading(false);
      setDownloaded(null);
    }
  }, [showDoc]);


  const openFiles = async (files: File[]) => {
    if (!files.length) return;
    const images = files.filter((f) => f.type.startsWith('image/') || IMAGE_RE.test(f.name));
    if (images.length === files.length) {
      setLoading(true);
      try {
        const { bytes } = await insertImages(null, images, 0, []);
        await openBytes(bytes, images.length === 1 ? images[0].name.replace(/\.[^.]+$/, '.pdf') : 'images.pdf');
      } catch (e) {
        setError(t('Couldn\'t convert images: {msg}', { msg: errMsg(e) }));
      } finally {
        setLoading(false);
      }
      return;
    }
    const pdf = files.find((f) => f.type === 'application/pdf' || PDF_RE.test(f.name));
    if (!pdf) {
      const office = files[0];
      const ext = office.name.slice(office.name.lastIndexOf('.')).toLowerCase();
      if (online?.features.convert && online.convertExtensions.includes(ext)) {
        setBusy(t('Converting {name}…', { name: office.name }));
        try {
          const { bytes } = await server.convert(office);
          await openBytes(bytes, office.name.replace(/\.[^.]+$/, '.pdf'));
        } catch (e) {
          setError(t('Couldn\'t convert "{name}": {msg}', { name: office.name, msg: errMsg(e) }));
        } finally {
          setBusy(null);
        }
        return;
      }
      return setError(online?.features.convert
        ? `"${office.name}" can't be converted (unsupported type).`
        : `"${office.name}" is not a PDF or image. Start the PDF Studio server to open Office documents.`);
    }
    openBytes(new Uint8Array(await pdf.arrayBuffer()), pdf.name);
  };

  // ?file=<url> opens a document by link (same origin, or an origin listed in VITE_PDFSTUDIO_FILE_ORIGINS).
  useEffect(() => {
    const file = new URLSearchParams(location.search).get('file');
    if (!file) return;
    const url = new URL(file, location.href);
    if (allowedFileOrigin(url.origin)) openUrl(url.href);
    else setError(t('Links from {origin} are not allowed.', { origin: url.origin }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Layers: read on every (re)load. Choices are kept per document version, and carried over by name
  // when the same document reloads after a page change or a finished download.
  useEffect(() => {
    if (!doc) { setLayers(null); return; }
    let cancelled = false;
    readLayers(doc.pdf).then((found) => {
      if (cancelled) return;
      if (found) {
        const saved = doc.key ? store$.get(`pdfstudio.layers.${doc.key}`) : null;
        if (saved) applyLayerState(found.config, JSON.parse(saved));
        else if (layersByName.current) applyByName(found, layersByName.current);
        layersByName.current = stateByName(found);
        setLayerHash(found.config.getHash());
      } else {
        layersByName.current = null;
        setPanel((p) => (p === 'layers' ? null : p));
      }
      setLayers(found);
    }, () => !cancelled && setLayers(null));
    return () => { cancelled = true; };
  }, [doc]);
  const layersChanged = (l: Layers) => {
    setLayerHash(l.config.getHash());
    layersByName.current = stateByName(l);
    if (doc?.key && !doc.partial) store$.set(`pdfstudio.layers.${doc.key}`, JSON.stringify(layerState(l.config)));
  };
  const toggleLayer = (id: string, visible: boolean) => {
    if (!layers) return;
    layers.config.setVisibility(id, visible); // radio groups switch their other members off
    layersChanged(layers);
  };
  const allLayers = (visible: boolean) => {
    if (!layers) return;
    for (const r of layers.rows) if (r.kind === 'layer' && r.id) layers.config.setVisibility(r.id, visible, false);
    layersChanged(layers);
  };
  const resetLayers = () => {
    if (!layers) return;
    applyLayerState(layers.config, layers.initial);
    layersChanged(layers);
  };

  // Autosave per document version.
  useEffect(() => {
    if (doc && !doc.partial) store$.set(`pdfstudio.annots.${doc.key}`, JSON.stringify(store.annotations));
  }, [doc, store.annotations]);
  useEffect(() => {
    if (doc && !doc.partial) store$.set(`pdfstudio.form.${doc.key}`, JSON.stringify(formValues));
  }, [doc, formValues]);

  // ------------------------------------------------------------ page operations
  /** Editing the file itself needs all of it; true (with a notice) while a URL is still downloading. */
  const stillLoading = () => {
    if (!doc?.partial) return false;
    setNotice(t('The document is still downloading. Try again in a moment.'));
    return true;
  };

  const runPageOp = async (label: string, op: () => Promise<PageOpResult>, goTo?: number) => {
    if (!doc || stillLoading()) return;
    setBusy(label);
    try {
      const res = await op();
      const loaded = await loadPdf(res.bytes, doc.name, askPassword(doc.name));
      showDoc(loaded, [...res.annotations, ...loaded.imported], true);
      if (goTo !== undefined) requestAnimationFrame(() => viewerApi.current?.scrollToPage(Math.min(goTo, loaded.pdf.numPages - 1)));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const pageActions: PageActions = {
    rotate: (i, cw) => runPageOp(t('Rotating…'), () => rotatePages(doc!.bytes, [i], cw, doc!.pageSizes, store.annotations)),
    remove: (i) => {
      const n = store.annotations.filter((a) => a.page === i).length;
      if (!window.confirm(n ? t('Delete page {page} and its {n} annotation(s)?', { page: i + 1, n }) : t('Delete page {page}?', { page: i + 1 }))) return;
      runPageOp(t('Deleting page…'), () => deletePages(doc!.bytes, [i], store.annotations));
    },
    move: (from, to) => runPageOp(t('Reordering…'), () => movePage(doc!.bytes, from, to, store.annotations), to),
    insertBlank: (at) => runPageOp(t('Inserting page…'), () =>
      insertBlankPage(doc!.bytes, at, doc!.pageSizes[Math.max(0, at - 1)], store.annotations), at),
    extract: async (i) => {
      try {
        const res = await extractPages(doc!.bytes, [i], store.annotations);
        const loaded = await loadPdf(res.bytes, 'page.pdf', () => null);
        const out = await exportPdf(loaded.bytes, loaded.viewports, res.annotations, { annotations: 'editable' });
        download(out.bytes, `${baseName}-page-${i + 1}.pdf`, 'application/pdf');
      } catch (e) {
        setError(errMsg(e));
      }
    },
  };

  // ------------------------------------------------------------ zoom & navigation
  const pagesPerRow = layout === 'spread' ? 2 : 1;
  const fitWidth = useCallback(() => {
    if (!doc) return;
    const w = (viewerApi.current?.containerWidth() ?? 800) - 48 - (pagesPerRow - 1) * 12;
    if (w > 50) setScale(Math.min(4, Math.max(0.1, w / (pagesPerRow * Math.max(...doc.pageSizes.map((s) => s.width))))));
  }, [doc, pagesPerRow]);
  const fitPage = useCallback(() => {
    if (!doc) return;
    const w = (viewerApi.current?.containerWidth() ?? 800) - 48 - (pagesPerRow - 1) * 12;
    const h = (viewerApi.current?.containerHeight() ?? 600) - 44;
    const size = doc.pageSizes[page] ?? doc.pageSizes[0];
    if (w > 50 && h > 50) setScale(Math.min(4, Math.max(0.1, Math.min(w / (pagesPerRow * size.width), h / size.height))));
  }, [doc, page, pagesPerRow]);

  /** Moves by one screen-full in the current layout: one page, or one spread. */
  const stepPage = useCallback((dir: 1 | -1) => {
    if (!doc) return;
    const rows = pageRows(doc.pdf.numPages, layout, coverPage);
    const r = rows.findIndex((row) => row.includes(page));
    const next = rows[Math.max(0, Math.min(rows.length - 1, r + dir))];
    if (next) viewerApi.current?.scrollToPage(next[0]);
  }, [doc, layout, coverPage, page]);

  const chooseLayout = (l: PageLayout) => {
    setLayout(l);
    store$.set('pdfstudio.layout', l);
    requestAnimationFrame(() => viewerApi.current?.scrollToPage(page));
  };
  const zoomStep = (dir: 1 | -1) =>
    setScale((s) => (dir > 0 ? ZOOMS.find((z) => z > s + 0.01) ?? 4 : [...ZOOMS].reverse().find((z) => z < s - 0.01) ?? 0.25));

  const activateHit = useCallback((i: number) => setActiveHit(i), []);
  useEffect(() => {
    const h = hits[activeHit];
    if (h) viewerApi.current?.scrollToPage(h.page, h.rects[0]?.y);
  }, [hits, activeHit]);

  const onLink = useCallback((l: PageLink) => {
    if (l.url) window.open(l.url, '_blank', 'noopener,noreferrer');
    else if (l.destPage !== undefined) viewerApi.current?.scrollToPage(l.destPage, l.destY);
  }, []);

  // ------------------------------------------------------------ tools & styles
  const chooseTool = (t: Tool) => {
    setTool(t);
    window.getSelection()?.removeAllRanges();
    if (t === 'signature' && !signature) setSigDialog(true);
    if (t === 'highlight') setStyle((s) => ({ ...s, color: '#ffd84d', opacity: 0.4 }));
    else if (t === 'underline' || t === 'strikeout') setStyle((s) => ({ ...s, color: '#e5484d', opacity: 1, strokeWidth: 1.5 }));
    else if (MEASURE_TOOLS.has(t)) setStyle((s) => ({ ...s, color: '#1f6feb', opacity: 1, strokeWidth: 1.5 }));
    else if (t !== 'select') setStyle((s) => ({ ...s, color: s.color === '#ffd84d' ? '#e5484d' : s.color, opacity: s.opacity < 0.6 ? 1 : s.opacity }));
  };

  const selected = store.annotations.find((a) => a.id === store.selectedId) ?? null;

  const applyStyle = (patch: Partial<ToolStyle>) => {
    setStyle((s) => ({ ...s, ...patch }));
    if (!selected) return;
    const p: Partial<Annotation> = {};
    if (patch.color) p.color = patch.color;
    if (patch.opacity !== undefined) p.opacity = patch.opacity;
    if (patch.strokeWidth !== undefined) p.strokeWidth = patch.strokeWidth;
    if (patch.fontSize !== undefined && selected.kind === 'freetext') p.fontSize = patch.fontSize;
    if (patch.stampText && selected.kind === 'stamp') p.text = patch.stampText;
    store.update(selected.id, p);
  };
  const shown = selected
    ? { ...style, color: selected.color, opacity: selected.opacity, strokeWidth: selected.strokeWidth, fontSize: selected.fontSize ?? style.fontSize }
    : style;

  const measure = useMemo(() => toMeasureScale(scaleSetting), [scaleSetting]);
  const updateScale = (patch: Partial<ScaleSetting>) => {
    const next = { ...scaleSetting, ...patch };
    setScaleSetting(next);
    if (selected?.measure) store.update(selected.id, { measure: toMeasureScale(next) });
  };
  const doCalibrate = () => {
    if (selected?.kind !== 'distance') return;
    const input = window.prompt(t('Real length of the selected line, in {unit}:', { unit: scaleSetting.worldUnit }));
    const real = Number(input);
    if (!input || !(real > 0)) return;
    const factor = calibrate(selected, real); // world units per point
    const next = { ...scaleSetting, paperValue: 1, paperUnit: 'in', worldValue: +(factor * PAPER_UNITS.in).toPrecision(6) };
    setScaleSetting(next);
    store.update(selected.id, { measure: { ...toMeasureScale(next), factor } });
    setNotice(t('Scale set to {scale}.', { scale: describeScale(next) }));
  };

  // ------------------------------------------------------------ export / import
  const baseName = doc?.name.replace(/\.pdf$/i, '') ?? 'document';
  const withBusy = async (label: string, fn: () => Promise<void>) => {
    if (stillLoading()) return;
    setBusy(label);
    try { await fn(); } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  };
  /** forPrint: the printout always shows the layers that are on screen. */
  const build = (mode: 'editable' | 'flatten', forPrint = false) =>
    exportPdf(doc!.bytes, doc!.viewports, store.annotations, {
      annotations: mode, formValues, flattenForms,
      layers: layers && (forPrint || keepLayers) ? layerState(layers.config) : undefined,
    });

  const optimizeForWeb = (shrink: boolean) => withBusy(t('Optimising…'), async () => {
    if (doc!.signed) throw new Error(t('Signed documents can\'t be optimised without breaking the signature.'));
    const { bytes } = await build('editable');
    const { bytes: out, report } = await server.optimize(bytes, shrink ? { maxImageDpi: 150 } : {});
    download(out, `${baseName}-web.pdf`, 'application/pdf');
    const mb = (n: number) => (n / 1048576).toFixed(1);
    setNotice(t('Optimised: {before} MB → {after} MB.', { before: mb(report.bytesBefore), after: mb(report.bytesAfter) }));
  });

  const doDownload = (mode: 'editable' | 'flatten') => withBusy(t('Preparing PDF…'), async () => {
    const { bytes, warnings } = await build(mode);
    download(bytes, `${baseName}${mode === 'flatten' ? '-flattened' : '-annotated'}.pdf`, 'application/pdf');
    if (warnings.length) setNotice(warnings.join(' '));
  });

  const doPrint = () => withBusy(t('Preparing print…'), async () => {
    const { bytes } = await build('flatten', true);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    frame.src = url;
    frame.onload = () => {
      frame.contentWindow?.print();
      setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
    };
    document.body.appendChild(frame);
  });

  const exportXfdf = () => withBusy(t('Exporting XFDF…'), async () => {
    const fields = await collectFormData(doc!.pdf, doc!.viewports, formValues);
    download(toXfdf(store.annotations, doc!.viewports, fields), `${baseName}.xfdf`, 'application/vnd.adobe.xfdf');
  });

  const importAnnotations = async (file: File) => {
    try {
      const text = await file.text();
      let list: Annotation[];
      if (/^\s*</.test(text)) {
        const res = fromXfdf(text, doc!.viewports);
        if (Object.keys(res.fields).length) setFormValues((v) => ({ ...v, ...res.fields }));
        // Apryse/Acrobat command files can modify or delete existing annotations.
        const before = store.annotations.length;
        store.replaceAll(mergeXfdf(store.annotations, { ...res, annotations: res.annotations.filter((a) => a.page < doc!.pdf.numPages) }));
        setNotice(t('Imported XFDF: {added} added, {updated} updated, {deleted} deleted ({before} → {after}).', {
          added: res.annotations.length - res.modifiedIds.length, updated: res.modifiedIds.length, deleted: res.deletedIds.length,
          before, after: before + res.annotations.length - res.modifiedIds.length - res.deletedIds.length,
        }));
        return;
      } else list = annotationsFromJson(text);
      const ids = new Set(store.annotations.map((a) => a.id));
      const fresh = list.filter((a) => a.page < doc!.pdf.numPages && !ids.has(a.id));
      store.importMany(fresh);
      setNotice(t('Imported {n} annotation(s).', { n: fresh.length }));
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const exportForm = () => withBusy(t('Exporting form data…'), async () => {
    const fields = await collectFormData(doc!.pdf, doc!.viewports, formValues);
    download(JSON.stringify({ format: 'pdf-studio-form', version: 1, file: doc!.name, fields }, null, 2), `${baseName}-form.json`, 'application/json');
  });

  const importForm = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const fields = data?.format === 'pdf-studio-form' ? data.fields : data;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Expected a JSON object of field names to values.');
      setFormValues((v) => ({ ...v, ...fields }));
      setNotice(t('Filled {n} field(s).', { n: Object.keys(fields).length }));
    } catch (e) {
      setError(t('Couldn\'t import form data: {msg}', { msg: errMsg(e) }));
    }
  };


  // ------------------------------------------------------------ server tools
  const toPdfBox = (pageIdx: number, r: { x: number; y: number; w: number; h: number }): [number, number, number, number] => {
    const vp = doc!.viewports[pageIdx];
    const [x1, y1] = vp.convertToPdfPoint(r.x, r.y);
    const [x2, y2] = vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  };

  const runOcr = (languages: string[], force: boolean) => withBusy(t('Recognising text… this can take a few seconds per page'), async () => {
    setDialog(null);
    const { bytes, report } = await server.ocr(doc!.bytes, languages, { force });
    const loaded = await loadPdf(bytes, doc!.name, askPassword(doc!.name));
    showDoc(loaded, [...store.annotations, ...loaded.imported], true);
    setNotice(report.ocrPages.length
      ? t('Text recognised on {n} page(s); {skipped} already had text. Search and highlighting now work there.', { n: report.ocrPages.length, skipped: report.skippedPages.length })
      : t('Every page already contains text; nothing to recognise.'));
  });

  const redactMarks = store.annotations.filter((a) => a.kind === 'redact' && a.rect);
  const runRedact = (opts: { sanitize: boolean; ocrLanguages: string[] }) => withBusy(t('Redacting…'), async () => {
    setDialog(null);
    const others = store.annotations.filter((a) => a.kind !== 'redact');
    const { bytes } = await exportPdf(doc!.bytes, doc!.viewports, others, { annotations: 'editable', formValues });
    const byPage = new Map<number, RedactRegion>();
    for (const m of redactMarks) {
      const region = byPage.get(m.page) ?? { page: m.page, rects: [], texts: [] };
      const box = toPdfBox(m.page, m.rect!);
      region.rects.push(box);
      if (m.text) region.texts!.push({ text: m.text, near: box });
      byPage.set(m.page, region);
    }
    const regions = [...byPage.values()];
    const res = await server.redact(bytes, regions, opts);
    const loaded = await loadPdf(res.bytes, doc!.name.replace(/(\.pdf)?$/i, '-redacted.pdf'), askPassword(doc!.name));
    setFormValues({}); // now stored in the document itself
    showDoc(loaded, loaded.imported, true);
    const r = res.report;
    setNotice(t('Redacted {regions} area(s) on {pages} page(s); removed {removed} overlapping annotation(s); hidden information cleaned: {cleaned}. Use Save to download the redacted file.', {
      regions: r.regions, pages: r.pages.length, removed: r.annotationsRemoved, cleaned: r.sanitized.join(', ') || '—',
    }));
  });

  const markHitsForRedaction = (list: SearchHit[]) => {
    const now = new Date().toISOString();
    const marks: Annotation[] = list.flatMap((h) => h.rects.map((r) => ({
      id: Math.random().toString(36).slice(2, 12), page: h.page, kind: 'redact' as const, rect: { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 },
      text: h.context.split('\u0001')[1]?.split('\u0002')[0],
      color: '#e5484d', opacity: 1, strokeWidth: 1, status: 'none' as const, author, createdAt: now, modifiedAt: now,
    })));
    store.importMany(marks);
    setNotice(t('Marked {n} area(s) for redaction. Review them, then choose Tools ▸ Apply redactions.', { n: marks.length }));
  };

  const openSignDialog = async () => {
    if (stillLoading()) return;
    const names: string[] = [];
    for (let i = 0; i < doc!.pdf.numPages; i++) {
      const page = await doc!.pdf.getPage(i + 1);
      const { widgets } = await readPageInteractive(doc!.pdf, page, i, doc!.viewports[i]);
      for (const w of widgets) if (w.type === 'signature' && !doc!.signedFields.includes(w.name) && !names.includes(w.name)) names.push(w.name);
    }
    setEmptySigFields(names);
    setDialog('sign');
  };

  // Unchanged documents are signed as opened, so existing signatures stay valid.
  const unchanged = !store.canUndo && Object.keys(formValues).length === 0;

  const runSign = (c: SignChoice) => withBusy(t('Signing…'), async () => {
    setDialog(null);
    const source = unchanged ? doc!.original : (await exportPdf(doc!.bytes, doc!.viewports, store.annotations,
      { annotations: 'editable', formValues, flattenForms })).bytes;
    const size = doc!.pageSizes[page];
    const box = c.placement === 'visible'
      ? toPdfBox(page, { x: size.width - 236, y: size.height - 96, w: 200, h: 64 })
      : undefined;
    const { bytes, report } = await server.sign(source, {
      signerName: c.signerName, reason: c.reason, location: c.location, certify: c.certify,
      fieldName: c.placement.startsWith('field:') ? c.placement.slice(6) : undefined,
      page, box,
      imagePng: c.useHandwritten && signature && c.placement !== 'invisible'
        ? new Blob([dataUrlToBytes(signature) as BlobPart], { type: 'image/png' }) : undefined,
    });
    const name = `${baseName}-signed.pdf`;
    download(bytes, name, 'application/pdf');
    await openBytes(bytes, name);
    setNotice(t(report.development ? 'Signed by {signer} (development certificate) and downloaded as {name}.' : 'Signed by {signer} and downloaded as {name}.', { signer: report.signer, name }));
  });

  const verifyLoad = useCallback(() => server.verify(doc!.original), [server, doc]);

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); store.redo(); return; }
      if (mod && k === 'f') { e.preventDefault(); setPanel('search'); return; }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
      if (mod && e.key === '-') { e.preventDefault(); zoomStep(-1); return; }
      if (mod) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedId) { store.remove(store.selectedId); return; }
      if (e.key === 'Escape') { setTool('select'); store.select(null); return; }
      // Page by page in single/spread layouts (and Page Up/Down everywhere).
      if (doc && !store.selectedId && (e.key === 'PageDown' || e.key === 'PageUp' || (layout !== 'continuous' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')))) {
        e.preventDefault();
        const forward = e.key === 'PageDown' || e.key === (document.documentElement.dir === 'rtl' || rtlPages ? 'ArrowLeft' : 'ArrowRight');
        stepPage(forward ? 1 : -1);
        return;
      }
      const t = TOOLS.find((x) => x.key === k);
      if (t && doc) chooseTool(t.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setFormValue = useCallback((name: string, value: string | boolean | string[]) =>
    setFormValues((v) => ({ ...v, [name]: value })), []);

  const ctx: PageContext | null = useMemo(() => doc && {
    pdf: doc.pdf, scale, tool, style, store, signature, author, editingId, setEditingId,
    onNoteCreated: (id: string) => { setPanel('comments'); setFocusComment(id); },
    onToolDone: () => setTool('select'),
    measure, formValues, setFormValue, onLink, signedFields: doc.signedFields,
    layerConfig: layers?.config ?? null, layerHash,
  }, [doc, scale, tool, style, store, signature, author, editingId, measure, formValues, setFormValue, onLink, layers, layerHash]);

  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of store.annotations) m.set(a.page, (m.get(a.page) ?? 0) + 1);
    return m;
  }, [store.annotations]);

  const jumpTo = (a: Annotation) => viewerApi.current?.scrollToPage(a.page, bbox(a).y);
  const onPageChange = useCallback((p: number) => setPage(p), []);
  const showMeasure = MEASURE_TOOLS.has(tool) || !!selected?.measure;
  const editedFields = Object.keys(formValues).length;

  const hint =
    tool === 'highlight' || tool === 'underline' || tool === 'strikeout' ? t('Select text on the page to mark it.')
      : tool === 'signature' ? (signature ? t('Click or drag on the page to place your signature.') : t('Create a signature first.'))
        : tool === 'perimeter' || tool === 'area' ? t('Click to add points, double-click to finish, Esc to cancel.')
          : tool === 'distance' ? t('Drag between two points to measure.')
            : tool === 'redact' ? t('Drag over content to remove. Nothing is removed until Tools ▸ Apply redactions.')
            : tool === 'select' ? '' : t('Click or drag on the page.');

  return (
    <div
      className={`app ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        openFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <a className="skip-link" href="#document" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLElement>('.viewer, .welcome .primary')?.focus(); }}>
        {t('Skip to document')}
      </a>
      <header className="topbar">
        <button className="icon" title={t('Toggle page panel')} onClick={() => setShowThumbs((v) => !v)} disabled={!doc}><Icon name="menu" /></button>
        <h1 className="brand">{t('PDF Studio')}</h1>
        <button onClick={() => fileInput.current?.click()} title={t('Open a PDF, or images to convert')}><Icon name="open" /> {t('Open')}</button>
        <input ref={fileInput} type="file" accept={["application/pdf", ".pdf", "image/*", ...(online?.convertExtensions ?? [])].join(",")} multiple hidden
          onChange={(e) => { openFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        {doc && <span className="filename" title={doc.name}>{doc.name}</span>}
        {doc?.partial && downloaded !== null && (
          <span className="download-progress" role="status">{t('Downloading {pct}%', { pct: Math.round(downloaded * 100) })}</span>
        )}
        <span className="spacer" />
        {doc && (
          <>
            <div className="group">
              <button className="icon" title={t('Zoom out (Ctrl -)')} onClick={() => zoomStep(-1)}><Icon name="minus" /></button>
              <select value={ZOOMS.includes(scale) ? scale : 'custom'} onChange={(e) => setScale(Number(e.target.value))} aria-label={t('Zoom')}>
                {!ZOOMS.includes(scale) && <option value="custom">{Math.round(scale * 100)}%</option>}
                {ZOOMS.map((z) => <option key={z} value={z}>{z * 100}%</option>)}
              </select>
              <button className="icon" title={t('Zoom in (Ctrl +)')} onClick={() => zoomStep(1)}><Icon name="plus" /></button>
              <button className="icon" title={t('Fit width')} onClick={fitWidth}><Icon name="fit" /></button>
              <button className="icon" title={t('Fit page')} onClick={fitPage}><Icon name="fitpage" /></button>
              <Menu title={t('Page layout')} label={<Icon name={layout === 'spread' ? 'spread' : layout === 'single' ? 'single' : 'continuous'} />}>
                {(close) => (
                  <>
                    <div className="menu-heading">{t('Page layout')}</div>
                    {([['continuous', t('Continuous scroll')], ['single', t('Single page')], ['spread', t('Two pages side by side')]] as const).map(([l, label]) => (
                      <button key={l} role="menuitemradio" aria-checked={layout === l} onClick={() => { close(); chooseLayout(l); }}>
                        <Icon name={l} size={16} /> {label}{layout === l ? ' ✓' : ''}
                      </button>
                    ))}
                    <label className="menu-check"><input type="checkbox" checked={coverPage} disabled={layout !== 'spread'}
                      onChange={(e) => { setCoverPage(e.target.checked); store$.set('pdfstudio.cover', e.target.checked ? '1' : '0'); }} /> {t('First page alone (cover)')}</label>
                    <label className="menu-check"><input type="checkbox" checked={rtlPages} disabled={layout !== 'spread'}
                      onChange={(e) => { setRtlPages(e.target.checked); store$.set('pdfstudio.rtlPages', e.target.checked ? '1' : '0'); }} /> {t('Right-to-left page order')}</label>
                  </>
                )}
              </Menu>
            </div>
            <div className="group pager">
              <button className="icon" title={t('Previous page (Page Up)')} disabled={page === 0} onClick={() => stepPage(-1)}><Icon name="prev" /></button>
              <input key={page} defaultValue={page + 1} aria-label={t('Page number')}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key !== 'Enter') return;
                  const n = Number(e.currentTarget.value);
                  if (n >= 1 && n <= doc.pdf.numPages) viewerApi.current?.scrollToPage(n - 1);
                }} />
              <span>/ {doc.pdf.numPages}</span>
              <button className="icon" title={t('Next page (Page Down)')} disabled={page >= doc.pdf.numPages - 1} onClick={() => stepPage(1)}><Icon name="next" /></button>
            </div>
            <div className="group">
              <button className="icon" title={t('Undo (Ctrl Z)')} disabled={!store.canUndo} onClick={store.undo}><Icon name="undo" /></button>
              <button className="icon" title={t('Redo (Ctrl Shift Z)')} disabled={!store.canRedo} onClick={store.redo}><Icon name="redo" /></button>
            </div>
            <div className="group">
              <button className={`icon ${panel === 'search' ? 'on' : ''}`} title={t('Search (Ctrl F)')} onClick={() => setPanel(panel === 'search' ? null : 'search')}><Icon name="search" /></button>
              <button className={`icon ${panel === 'comments' ? 'on' : ''}`} title={t('Annotations & comments')} onClick={() => setPanel(panel === 'comments' ? null : 'comments')}><Icon name="comments" /></button>
              {layers && (
                <button className={`icon ${panel === 'layers' ? 'on' : ''}`} title={t('Layers')} aria-label={t('Layers')} aria-pressed={panel === 'layers'}
                  onClick={() => setPanel(panel === 'layers' ? null : 'layers')}><Icon name="layers" /></button>
              )}
            </div>
            <div className="group">
              <Menu title={t('Insert pages')} disabled={!!busy} label={<><Icon name="insert" /> {t('Insert')} <Icon name="chevron" size={14} /></>}>
                {(close) => (
                  <>
                    <button role="menuitem" onClick={() => { close(); pageActions.insertBlank(page + 1); }}>{t('Blank page after page {n}', { n: page + 1 })}</button>
                    <button role="menuitem" onClick={() => { close(); insertPdfInput.current?.click(); }}>{t('Pages from another PDF…')}</button>
                    <button role="menuitem" onClick={() => { close(); insertImgInput.current?.click(); }}>{t('Images as pages…')}</button>
                  </>
                )}
              </Menu>
              <Menu title={t('Server tools: OCR, redaction, digital signatures')} label={<><Icon name="tools" /> {t('Tools')} <Icon name="chevron" size={14} /></>} disabled={!!busy}>
                {(close) => (
                  <>
                    <div className="menu-heading">
                      <span className={`status-dot ${online ? 'on' : health === 'offline' ? 'off' : ''}`} />
                      {online ? t('Server connected') : health === 'offline' ? t('Server not reachable') : t('Checking server…')}
                    </div>
                    <button role="menuitem" disabled={!online?.features.ocr} onClick={() => { close(); if (!stillLoading()) setDialog('ocr'); }}>{t('Recognise text (OCR)…')}</button>
                    <button role="menuitem" onClick={() => { close(); chooseTool('redact'); }}>{t('Mark areas for redaction (X)')}</button>
                    <button role="menuitem" disabled={!online || !redactMarks.length} onClick={() => { close(); if (!stillLoading()) setDialog('redact'); }}>
                      {redactMarks.length ? t('Apply {n} redaction(s)…', { n: redactMarks.length }) : t('Apply redactions…')}
                    </button>
                    <button role="menuitem" disabled={!online} onClick={() => { close(); openSignDialog(); }}>{t('Sign digitally…')}</button>
                    <button role="menuitem" disabled={!online} onClick={() => { close(); if (!stillLoading()) setDialog('verify'); }}>{t('Verify signatures')}</button>
                    <button role="menuitem" disabled={!online?.features.optimize} onClick={() => { close(); optimizeForWeb(false); }}>{t('Optimise for web (fast first page)')}</button>
                    <button role="menuitem" disabled={!online?.features.optimize} onClick={() => { close(); optimizeForWeb(true); }}>{t('Optimise and shrink images (150 dpi)')}</button>
                    <div className="menu-heading">{t('Server address')}</div>
                    <form className="server-url" onSubmit={(e) => {
                      e.preventDefault();
                      const v = new FormData(e.currentTarget).get('url');
                      if (typeof v === 'string' && v.trim()) setServerUrl(v.trim());
                    }}>
                      <input name="url" defaultValue={serverUrl} aria-label={t('Server address')} onKeyDown={(e) => e.stopPropagation()} />
                      <button type="submit">{t('Connect')}</button>
                    </form>
                    {online?.signer.development && <a className="menu-link" href={server.certificateUrl()}>{t('Download development signing certificate')}</a>}
                  </>
                )}
              </Menu>
              <Menu title={t('Save, print and exchange')} disabled={!!busy} label={<><Icon name="download" /> {t('Save')} <Icon name="chevron" size={14} /></>}>
                {(close) => (
                  <>
                    <div className="menu-heading">{t('PDF')}</div>
                    <button role="menuitem" onClick={() => { close(); doDownload('editable'); }}>{t('Download with editable annotations')}</button>
                    <button role="menuitem" onClick={() => { close(); doDownload('flatten'); }}>{t('Download flattened')}</button>
                    <label className="menu-check"><input type="checkbox" checked={flattenForms} onChange={(e) => setFlattenForms(e.target.checked)} /> {t('Flatten form fields')}</label>
                    <button role="menuitem" onClick={() => { close(); doPrint(); }}><Icon name="print" size={16} /> {t('Print')}</button>
                    <div className="menu-heading">{t('Annotations')}</div>
                    <button role="menuitem" onClick={() => { close(); if (!stillLoading()) setDialog('extract'); }}><Icon name="extract" size={16} /> {t('Extract text, tables, images and fonts…')}</button>
                    <button role="menuitem" onClick={() => { close(); exportXfdf(); }}>{t('Export XFDF')}</button>
                    <button role="menuitem" onClick={() => { close(); download(annotationsToJson(doc.name, store.annotations), `${baseName}-annotations.json`, 'application/json'); }}>{t('Export JSON')}</button>
                    <button role="menuitem" onClick={() => { close(); annotInput.current?.click(); }}>{t('Import XFDF or JSON…')}</button>
                    <div className="menu-heading">{t('Form data')}</div>
                    <button role="menuitem" onClick={() => { close(); exportForm(); }}>{t('Export form data (JSON)')}</button>
                    <button role="menuitem" onClick={() => { close(); formInput.current?.click(); }}>{t('Fill from JSON…')}</button>
                    {editedFields > 0 && <button role="menuitem" onClick={() => { close(); setFormValues({}); }}>{t('Reset {n} edited field(s)', { n: editedFields })}</button>}
                  </>
                )}
              </Menu>
              <input ref={annotInput} type="file" accept=".xfdf,.xml,.json,application/json" hidden
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importAnnotations(f); }} />
              <input ref={formInput} type="file" accept=".json,application/json" hidden
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importForm(f); }} />
              <input ref={insertPdfInput} type="file" accept="application/pdf,.pdf" hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) runPageOp(t('Merging PDF…'), async () => insertPdf(doc.bytes, new Uint8Array(await f.arrayBuffer()), page + 1, store.annotations), page + 1);
                }} />
              <input ref={insertImgInput} type="file" accept="image/*" multiple hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) runPageOp(t('Adding images…'), () => insertImages(doc.bytes, files, page + 1, store.annotations), page + 1);
                }} />
            </div>
          </>
        )}
        <select className="lang" value={lang.code} onChange={(e) => setLang(e.target.value)} aria-label={t('Language')} title={t('Language')}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
        </select>
        <button className="icon" title={t('Toggle theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </header>

      <div role="region" aria-label={t('Editing tools')}>
      {doc && (
        <div className="toolbar" role="toolbar" aria-label={t('Annotation tools')}>
          {TOOLS.map((tl, i) => (
            <span key={tl.id} className="tool-slot">
              {(i === 13 || i === 16) && <span className="divider" />}
              <button className={`icon tool ${tool === tl.id ? 'on' : ''}`} title={`${t(tl.label)}${tl.key ? ` (${tl.key.toUpperCase()})` : ''}`}
                aria-label={t(tl.label)} aria-pressed={tool === tl.id} onClick={() => chooseTool(tl.id)}>
                <Icon name={tl.id} />
              </button>
            </span>
          ))}
          <span className="divider" />
          <div className="swatches" role="radiogroup" aria-label={t('Colour')}>
            {COLORS.map((c) => (
              <button key={c} className={`swatch ${shown.color === c ? 'on' : ''}`} style={{ background: c }}
                aria-label={c} onClick={() => applyStyle({ color: c })} />
            ))}
            <input type="color" value={shown.color} onChange={(e) => applyStyle({ color: e.target.value })} title={t('Custom colour')} aria-label={t('Custom colour')} />
          </div>
          <label className="slider">{t('Opacity')}
            <input type="range" min={0.1} max={1} step={0.05} value={shown.opacity} onChange={(e) => applyStyle({ opacity: Number(e.target.value) })} />
          </label>
          <label className="slider">{t('Width')}
            <input type="range" min={0.5} max={12} step={0.5} value={shown.strokeWidth} onChange={(e) => applyStyle({ strokeWidth: Number(e.target.value) })} />
          </label>
          {(tool === 'freetext' || selected?.kind === 'freetext') && (
            <label className="slider">{t('Size')}
              <input type="number" min={6} max={72} value={shown.fontSize} onChange={(e) => applyStyle({ fontSize: Number(e.target.value) })} />
            </label>
          )}
          {(tool === 'stamp' || selected?.kind === 'stamp') && (
            <select value={selected?.kind === 'stamp' ? selected.text : style.stampText} onChange={(e) => applyStyle({ stampText: e.target.value })} aria-label={t('Stamp')}>
              {STAMPS.map((s) => <option key={s}>{s}</option>)}
            </select>
          )}
          {tool === 'signature' && <button onClick={() => setSigDialog(true)}>{signature ? t('Change signature') : t('Create signature')}</button>}
          {selected && <button className="icon danger" title={t('Delete selected (Del)')} onClick={() => store.remove(selected.id)}><Icon name="trash" /></button>}
          <span className="spacer" />
          <label className="author">{t('Author')}
            <input value={author} onChange={(e) => { setAuthor(e.target.value); store$.set('pdfstudio.author', e.target.value); }}
              onKeyDown={(e) => e.stopPropagation()} />
          </label>
        </div>
      )}

      {doc && showMeasure && (
        <div className="toolbar measurebar" aria-label={t('Measurement scale')}>
          <Icon name="ruler" />
          <span className="muted">{selected?.measure ? t('Scale (selected)') : t('Scale')}</span>
          <input type="number" min={0.0001} step="any" value={scaleSetting.paperValue} aria-label={t('Paper length')}
            onChange={(e) => Number(e.target.value) > 0 && updateScale({ paperValue: Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />
          <select value={scaleSetting.paperUnit} onChange={(e) => updateScale({ paperUnit: e.target.value })} aria-label={t('Paper unit')}>
            {Object.keys(PAPER_UNITS).map((u) => <option key={u}>{u}</option>)}
          </select>
          <span>=</span>
          <input type="number" min={0.0001} step="any" value={scaleSetting.worldValue} aria-label={t('Real-world length')}
            onChange={(e) => Number(e.target.value) > 0 && updateScale({ worldValue: Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />
          <select value={scaleSetting.worldUnit} onChange={(e) => updateScale({ worldUnit: e.target.value })} aria-label={t('Real-world unit')}>
            {WORLD_UNITS.map((u) => <option key={u}>{u}</option>)}
          </select>
          <label className="slider">{t('Precision')}
            <select value={scaleSetting.precision} onChange={(e) => updateScale({ precision: Number(e.target.value) })}>
              {[0, 1, 2, 3].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <button disabled={selected?.kind !== 'distance'} onClick={doCalibrate}
            title={t('Select a distance measurement drawn over a known length, then calibrate')}>{t('Calibrate…')}</button>
        </div>
      )}

      </div>

      <main className="body" id="document">
        {doc && showThumbs && (
          <aside className="left" aria-label={t('Pages')}>
            <Thumbnails pdf={doc.pdf} sizes={doc.pageSizes} current={page} counts={counts} actions={pageActions} busy={!!busy}
              layerConfig={layers?.config ?? null} layerHash={layerHash}
              onSelect={(i) => viewerApi.current?.scrollToPage(i)} />
          </aside>
        )}
        <section className="center">
          {doc && ctx ? (
            <Viewer doc={doc} ctx={ctx} layout={layout} rtlPages={rtlPages} coverPage={coverPage} currentPage={page} hits={panel === 'search' ? hits : []} activeHit={panel === 'search' ? hits[activeHit] ?? null : null}
              onPageChange={onPageChange} apiRef={viewerApi} />
          ) : (
            <div className="welcome">
              <h2>{t('Open a PDF to get started')}</h2>
              <p>{t('View, search, annotate, measure, fill forms, organise pages and sign. Everything runs in your browser — files never leave your device.')}</p>
              <div className="welcome-actions">
                <button className="primary" onClick={() => fileInput.current?.click()}>{t('Choose PDF or images')}</button>
                <button onClick={async () => openBytes(await createSamplePdf(), 'sample.pdf')}>{t('Try a sample document')}</button>
                <button onClick={() => {
                  const link = window.prompt(t('Link to a PDF (large files open page by page):'));
                  if (link) openUrl(new URL(link, location.href).href);
                }}>{t('Open from link…')}</button>
              </div>
              <p className="muted">{t('or drop files anywhere on this window')}</p>
              <p className="muted"><a href="THIRD-PARTY-NOTICES.txt" target="_blank" rel="noreferrer">{t('Open-source licences')}</a></p>
            </div>
          )}
          {doc?.signed && (
            <div className="signed-banner">
              <Icon name="shield" size={16} /> {t('This document is digitally signed. Saving changes creates a new, unsigned version.')}
              <button disabled={!online} onClick={() => setDialog('verify')}>{t('Verify signatures')}</button>
            </div>
          )}
          {doc && <div className="hint" aria-live="polite">{hint}</div>}
          {(loading || busy) && <div className="toast">{busy ?? t('Opening document…')}</div>}
          {!loading && !busy && notice && <div className="toast" role="status">{notice}<button className="icon" onClick={() => setNotice(null)}>✕</button></div>}
          {error && <div className="toast error" role="alert">{error}<button className="icon" onClick={() => setError(null)}>✕</button></div>}
        </section>
        {doc && panel && (
          <aside className="right" aria-label={panel === 'search' ? t('Search') : panel === 'layers' ? t('Layers') : t('Annotations & comments')}>
            {panel === 'search'
              ? <SearchPanel doc={doc} hits={hits} active={activeHit} onResults={setHits} onActivate={activateHit} onRedact={markHitsForRedaction} />
              : panel === 'layers' && layers
                ? <LayersPanel layers={layers} hash={layerHash} onToggle={toggleLayer} onAll={allLayers} onReset={resetLayers}
                    keepInFile={keepLayers} onKeepInFile={(k) => { setKeepLayers(k); store$.set('pdfstudio.layersKeep', k ? '1' : '0'); }} />
                : <CommentsPanel store={store} focusId={focusComment} onJump={jumpTo} />}
          </aside>
        )}
      </main>

      {doc && dialog === 'extract' && (
        <ExtractDialog pdf={doc.pdf} bytes={doc.bytes} baseName={baseName} pageCount={doc.pdf.numPages} currentPage={page}
          onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); setNotice(msg); }} />
      )}
      {doc && online && dialog === 'ocr' && (
        <OcrDialog health={online} pageCount={doc.pdf.numPages} onRun={runOcr} onClose={() => setDialog(null)} />
      )}
      {doc && online && dialog === 'redact' && (
        <RedactDialog health={online} marks={redactMarks.length} pages={[...new Set(redactMarks.map((m) => m.page))].sort((a, b) => a - b)}
          onRun={runRedact} onClose={() => setDialog(null)} />
      )}
      {doc && online && dialog === 'sign' && (
        <SignDialog health={online} author={author} emptyFields={emptySigFields} hasHandwritten={!!signature}
          willInvalidate={doc.signed && !unchanged} currentPage={page} onRun={runSign} onClose={() => setDialog(null)} />
      )}
      {doc && online && dialog === 'verify' && (
        <VerifyDialog load={verifyLoad} certificateUrl={server.certificateUrl()} development={online.signer.development} onClose={() => setDialog(null)} />
      )}
      {sigDialog && (
        <SignatureDialog
          onClose={() => { setSigDialog(false); if (!signature) setTool('select'); }}
          onSave={(png) => {
            setSignature(png);
            store$.set('pdfstudio.signature', png);
            setSigDialog(false);
            setTool('signature');
          }}
        />
      )}
    </div>
  );
}

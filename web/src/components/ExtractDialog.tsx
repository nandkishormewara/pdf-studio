import { useRef, useState } from 'react';
import { useT } from '../i18n';
import { download } from '../sdk/export';
import {
  ExtractCancelled, extractFonts, extractImages, extractTables, extractText, fontsToCsv, imagesToJson, openForExtraction, parsePageRange,
  tableName, tablesToJson, tablesToXlsx, tableToCsv, textToCsv, textToJson, textToPlain,
} from '../sdk/extract';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { makeZip } from '../sdk/zip';
import type { ZipEntry } from '../sdk/zip';
import { Modal } from './ServerDialogs';

type TextFormat = 'txt' | 'json' | 'csv';
type TableFormat = 'xlsx' | 'csv' | 'json';

interface Props {
  /** the document as shown (used when the bytes can't be opened again, e.g. password-protected) */
  pdf: PDFDocumentProxy;
  bytes: Uint8Array;
  baseName: string;
  pageCount: number;
  currentPage: number;
  onClose: () => void;
  /** summary for the notice bar after a successful extraction */
  onDone: (summary: string) => void;
}

const MIME: Record<string, string> = {
  txt: 'text/plain;charset=utf-8', json: 'application/json', csv: 'text/csv;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Extracts text (plain, with positions, or a word table), tables, images and fonts, as one file or a ZIP. */
export function ExtractDialog({ pdf, bytes, baseName: rawName, pageCount, currentPage, onClose, onDone }: Props) {
  const t = useT();
  // used for file and folder names: no path separators, reserved characters or leading dots (a name from a link can hold "../")
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must not reach file names
  const baseName = rawName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').trim() || 'document';
  const [scope, setScope] = useState<'all' | 'current' | 'range'>('all');
  const [range, setRange] = useState(`1-${pageCount}`);
  const [text, setText] = useState(true);
  const [textFormat, setTextFormat] = useState<TextFormat>('txt');
  const [markers, setMarkers] = useState(true);
  const [readingOrder, setReadingOrder] = useState(true);
  const [tables, setTables] = useState(false);
  const [tableFormat, setTableFormat] = useState<TableFormat>('xlsx');
  const [images, setImages] = useState(false);
  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg'>('png');
  const [minPixels, setMinPixels] = useState(32);
  const [fonts, setFonts] = useState(false);
  const [fontFiles, setFontFiles] = useState(false);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });

  const pages = scope === 'all' ? Array.from({ length: pageCount }, (_, i) => i) : scope === 'current' ? [currentPage] : parsePageRange(range, pageCount);
  const nothing = !text && !tables && !images && !fonts;

  const run = async () => {
    if (!pages) return;
    signal.current = { cancelled: false };
    setError(null);
    let doc = pdf;
    let own = false;
    try {
      setProgress({ label: t('Preparing…'), done: 0, total: pages.length });
      try {
        doc = await openForExtraction(bytes); // keeps real font names
        own = true;
      } catch {
        doc = pdf; // e.g. password-protected: use the open document (generic font names)
      }
      const files: ZipEntry[] = [];
      const summary: string[] = [];
      let emptyPages: number[] = [];
      let tableCount = 0;
      if (text) {
        const result = await extractText(doc, pages, {
          signal: signal.current, onProgress: (p) => setProgress({ label: t('Extracting text…'), ...p }),
        }, readingOrder ? 'reading' : 'drawn');
        const words = result.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.words.length, 0), 0);
        emptyPages = result.filter((p) => !p.lines.length).map((p) => p.page + 1);
        const body = textFormat === 'txt' ? textToPlain(result, markers) : textFormat === 'json' ? textToJson(result, `${baseName}.pdf`) : textToCsv(result);
        files.push({ name: `${baseName}-text.${textFormat}`, data: body });
        summary.push(t('{n} words', { n: words }));
      }
      if (tables) {
        const result = await extractTables(doc, pages, {
          signal: signal.current, onProgress: (p) => setProgress({ label: t('Finding tables…'), ...p }),
        });
        if (result.length) {
          // a lone CSV table goes in the ZIP's top level too, named after the document
          if (tableFormat === 'xlsx') files.push({ name: `${baseName}-tables.xlsx`, data: tablesToXlsx(result) });
          else if (tableFormat === 'json') files.push({ name: `${baseName}-tables.json`, data: tablesToJson(result, `${baseName}.pdf`) });
          else if (result.length === 1) files.push({ name: `${baseName}-table.csv`, data: tableToCsv(result[0]) });
          else for (const tb of result) files.push({ name: `tables/${tableName(result, tb)}.csv`, data: tableToCsv(tb) });
        }
        tableCount = result.length;
        summary.push(t('{n} tables', { n: result.length }));
      }
      if (images) {
        const result = await extractImages(doc, pages, { format: imageFormat, minPixels }, {
          signal: signal.current, onProgress: (p) => setProgress({ label: t('Extracting images…'), ...p }),
        });
        for (const img of result) files.push({ name: `images/${img.name}`, data: img.data });
        if (result.length) files.push({ name: 'images/images.json', data: imagesToJson(result, `${baseName}.pdf`) });
        summary.push(t('{n} images', { n: result.length }));
      }
      if (fonts) {
        setProgress({ label: t('Reading fonts…'), done: 0, total: 1 });
        const result = await extractFonts(bytes, pages, fontFiles);
        files.push({ name: 'fonts/fonts.csv', data: fontsToCsv(result) });
        for (const f of result) if (f.file) files.push({ name: `fonts/${f.file.name}`, data: f.file.data });
        summary.push(t('{n} fonts', { n: result.length }));
      }
      if (signal.current.cancelled) throw new ExtractCancelled();
      // one text or table file on its own downloads as is; anything else goes into a ZIP
      const ext = files[0]?.name.split('.').pop() ?? '';
      if (files.length === 1 && !files[0].name.includes('/') && MIME[ext]) download(files[0].data, files[0].name, MIME[ext]);
      else if (files.length) download(makeZip(files.map((f) => ({ ...f, name: `${baseName}-extracted/${f.name}` }))), `${baseName}-extracted.zip`, 'application/zip');
      let message = t('Extracted {what}.', { what: summary.join(', ') });
      if (text && emptyPages.length)
        message += ' ' + t('No text on page(s) {pages}: they may be scanned. Tools ▸ Recognise text (OCR) makes them extractable.', {
          pages: emptyPages.length > 8 ? `${emptyPages.slice(0, 8).join(', ')}…` : emptyPages.join(', '),
        });
      if (tables && !tableCount) message += ' ' + t('No tables found on these pages.');
      onDone(message);
    } catch (e) {
      if (e instanceof ExtractCancelled) setProgress(null);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own) doc.loadingTask.destroy();
      setProgress(null);
    }
  };

  const busy = progress !== null;
  return (
    <Modal title={t('Extract text, tables, images and fonts')} onClose={() => { signal.current.cancelled = true; onClose(); }} actions={<>
      <button onClick={() => { signal.current.cancelled = true; if (!busy) onClose(); }}>{busy ? t('Stop') : t('Cancel')}</button>
      <button className="primary" disabled={busy || nothing || !pages} onClick={run}>{t('Extract')}</button>
    </>}>
      <fieldset className="extract-group" disabled={busy}>
        <legend>{t('Pages')}</legend>
        <label className="check-row"><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /> {t('All pages ({n})', { n: pageCount })}</label>
        <label className="check-row"><input type="radio" name="scope" checked={scope === 'current'} onChange={() => setScope('current')} /> {t('Current page ({n})', { n: currentPage + 1 })}</label>
        <label className="check-row">
          <input type="radio" name="scope" checked={scope === 'range'} onChange={() => setScope('range')} /> {t('Pages')}
          <input className="range-input" value={range} aria-label={t('Page range, e.g. 1-3, 7')} placeholder="1-3, 7"
            aria-invalid={scope === 'range' && !pages} onChange={(e) => { setRange(e.target.value); setScope('range'); }} />
        </label>
        {scope === 'range' && !pages && <p className="warning">{t('Type pages like 1-3, 7 (between 1 and {n}).', { n: pageCount })}</p>}
      </fieldset>

      <fieldset className="extract-group" disabled={busy}>
        <legend><label><input type="checkbox" checked={text} onChange={(e) => setText(e.target.checked)} /> {t('Text')}</label></legend>
        <select value={textFormat} disabled={!text} onChange={(e) => setTextFormat(e.target.value as TextFormat)} aria-label={t('Text format')}>
          <option value="txt">{t('Plain text (.txt)')}</option>
          <option value="json">{t('Text with positions and fonts (.json)')}</option>
          <option value="csv">{t('Word list for Excel (.csv)')}</option>
        </select>
        <label className="check-row"><input type="checkbox" checked={readingOrder} disabled={!text} onChange={(e) => setReadingOrder(e.target.checked)} /> {t('Reading order (columns one after another, table rows on one line)')}</label>
        {textFormat === 'txt' && (
          <label className="check-row"><input type="checkbox" checked={markers} disabled={!text} onChange={(e) => setMarkers(e.target.checked)} /> {t('Page headings')}</label>
        )}
      </fieldset>

      <fieldset className="extract-group" disabled={busy}>
        <legend><label><input type="checkbox" checked={tables} onChange={(e) => setTables(e.target.checked)} /> {t('Tables')}</label></legend>
        <select value={tableFormat} disabled={!tables} onChange={(e) => setTableFormat(e.target.value as TableFormat)} aria-label={t('Table format')}>
          <option value="xlsx">{t('Excel workbook, one sheet per table (.xlsx)')}</option>
          <option value="csv">{t('CSV, one file per table (.csv)')}</option>
          <option value="json">{t('Rows, columns and positions (.json)')}</option>
        </select>
        <p className="muted">{t('Finds tables with or without lines. Check the result: merged and borderless cells can split differently.')}</p>
      </fieldset>

      <fieldset className="extract-group" disabled={busy}>
        <legend><label><input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} /> {t('Images')}</label></legend>
        <select value={imageFormat} disabled={!images} onChange={(e) => setImageFormat(e.target.value as 'png' | 'jpeg')} aria-label={t('Image format')}>
          <option value="png">{t('PNG (exact, keeps transparency)')}</option>
          <option value="jpeg">{t('JPEG (smaller files)')}</option>
        </select>
        <label className="check-row">
          {t('Skip images smaller than')}
          <input type="number" min={0} max={2000} value={minPixels} disabled={!images} className="px-input" aria-label={t('Minimum image size in pixels')}
            onChange={(e) => setMinPixels(Math.max(0, Number(e.target.value) || 0))} /> px
        </label>
      </fieldset>

      <fieldset className="extract-group" disabled={busy}>
        <legend><label><input type="checkbox" checked={fonts} onChange={(e) => setFonts(e.target.checked)} /> {t('Fonts')}</label></legend>
        <p className="muted">{t('A list of the fonts used (name, type, embedded, subset, pages).')}</p>
        <label className="check-row"><input type="checkbox" checked={fontFiles} disabled={!fonts} onChange={(e) => setFontFiles(e.target.checked)} /> {t('Include embedded font files')}</label>
        {fonts && fontFiles && <p className="warning">{t('Fonts are usually licensed. Reuse extracted font files only as their licence allows.')}</p>}
      </fieldset>

      {progress && (
        <div className="extract-progress" role="status">
          <span>{progress.label} {progress.total > 1 ? t('page {done} of {total}', { done: progress.done, total: progress.total }) : ''}</span>
          <progress max={progress.total || 1} value={progress.done} />
        </div>
      )}
      {error && <p className="warning" role="alert">{error}</p>}
    </Modal>
  );
}

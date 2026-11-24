import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createSamplePdf } from '../../../web/src/sdk/pdf';
import apryseAnnots from '../../../mobile/shared/xfdf/apryse-annots.xfdf?raw';
import apryseCommands from '../../../mobile/shared/xfdf/apryse-commands.xfdf?raw';
import { PdfWebViewer } from '../src';
import type { PdfWebViewerHandle } from '../src';

type Tab = 'edit' | 'view' | 'compare' | 'image' | 'error';

/** Blob URLs have no extension, like many streamed document URLs, so the viewer has to sniff the bytes. */
function useSampleUrls() {
  const [urls, setUrls] = useState<{ pdf: string; image: string } | null>(null);
  useEffect(() => {
    let pdf = '', image = '';
    (async () => {
      pdf = URL.createObjectURL(new Blob([(await createSamplePdf()) as BlobPart], { type: 'application/pdf' }));
      image = URL.createObjectURL(await sampleImage());
      setUrls({ pdf, image });
    })();
    return () => { URL.revokeObjectURL(pdf); URL.revokeObjectURL(image); };
  }, []);
  return urls;
}

async function sampleImage(): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fdfcf7'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#c9d6ea';
  for (let y = 120; y < c.height; y += 40) { g.beginPath(); g.moveTo(40, y); g.lineTo(860, y); g.stroke(); }
  g.fillStyle = '#23305a'; g.font = 'italic 34px Georgia, serif';
  const lines = ['Q4. Solve: 2x + 3 = 11', '2x = 11 - 3', '2x = 8', 'x = 4', '', 'Q5. Area of a circle, r = 7', 'A = πr² = 22/7 × 49 = 154 cm²'];
  lines.forEach((l, i) => g.fillText(l, 70, 150 + i * 80));
  return new Promise((ok) => c.toBlob((b) => ok(b!), 'image/png'));
}

function App() {
  const urls = useSampleUrls();
  const [tab, setTab] = useState<Tab>('edit');
  const [xfdf, setXfdf] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const editRef = useRef<PdfWebViewerHandle>(null);
  const note = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${s}`, ...l].slice(0, 30));

  const handle = () => editRef.current!;
  const run = (label: string, fn: () => Promise<unknown>) => fn().then(() => note(`${label}: ok`), (e) => note(`${label}: ${e.message}`));

  const callbacks = (name: string) => ({
    onReady: () => note(`${name}: onReady`),
    onLoad: () => note(`${name}: onLoad`),
    onError: (m: string) => note(`${name}: onError — ${m}`),
    onAnnotationsError: (m: string) => note(`${name}: onAnnotationsError — ${m}`),
  });

  if (!urls) return <p style={{ padding: 16 }}>Preparing sample files…</p>;

  const editable = tab === 'edit' || tab === 'image';
  return (
    <>
      <header>
        <h1>@pdf-studio/react-viewer</h1>
        <div className="tabs">
          {([['edit', 'Edit mode'], ['view', 'View mode'], ['compare', 'Side by side'], ['image', 'Image (sniffed)'], ['error', 'Error + retry']] as const).map(([t, label]) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="actions">
        {editable ? (
          <>
            <button onClick={() => run('import apryse-annots.xfdf', () => handle().importAnnotations(apryseAnnots))}>Import Apryse XFDF</button>
            <button onClick={() => run('import apryse-commands.xfdf', () => handle().importAnnotations(apryseCommands))}>Apply add/modify/delete</button>
            <button onClick={() => run('exportXfdf', async () => setXfdf(await handle().exportXfdf()))}>Export XFDF</button>
            <button onClick={() => run('importAnnotations(textarea)', () => handle().importAnnotations(xfdf))}>Import textarea</button>
            <button onClick={() => run('exportAnnotatedPdf', async () => {
              const blob = await handle().exportAnnotatedPdf();
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'annotated.pdf';
              a.click();
            })}>Download flattened PDF</button>
          </>
        ) : <small>{tab === 'compare' ? 'Question paper (view) next to the answer copy (edit), like the compare dialogs.' : tab === 'error' ? 'This URL returns a web page instead of a document — the overlay shows the error and offers Retry.' : 'Read-only: no tools, download, print or save. Click the sticky note to read it.'}</small>}
      </div>
      <main>
        {tab === 'edit' && (
          <>
            <section className="pane"><h2>Answer copy — edit</h2><div className="body">
              <PdfWebViewer ref={editRef} documentUrl={urls.pdf} mode="edit" initialXfdf={apryseAnnots} {...callbacks('edit')} />
            </div></section>
            <aside className="side">
              <textarea value={xfdf} onChange={(e) => setXfdf(e.target.value)} placeholder="Exported XFDF appears here" spellCheck={false} />
              <div className="log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
            </aside>
          </>
        )}
        {tab === 'view' && (
          <section className="pane"><h2>Study material — view</h2><div className="body">
            <PdfWebViewer documentUrl={urls.pdf} mode="view" licenseKey="ignored" assetPath="/ignored" initialXfdf={apryseAnnots} watermark="Jane Doe · 2401001 · 26 Oct 2026" {...callbacks('view')} />
          </div></section>
        )}
        {tab === 'compare' && (
          <>
            <section className="pane"><h2>Question paper — view</h2><div className="body">
              <PdfWebViewer documentUrl={urls.pdf} documentExtension="pdf" mode="view" {...callbacks('question')} />
            </div></section>
            <section className="pane"><h2>Answer copy — edit</h2><div className="body">
              <PdfWebViewer ref={editRef} documentUrl={urls.image} mode="edit" initialXfdf={apryseAnnots} {...callbacks('answer')} />
            </div></section>
          </>
        )}
        {tab === 'image' && (
          <>
            <section className="pane"><h2>Scanned answer (PNG, no extension) — edit</h2><div className="body">
              <PdfWebViewer ref={editRef} documentUrl={urls.image} mode="edit" {...callbacks('image')} />
            </div></section>
            <aside className="side">
              <textarea value={xfdf} onChange={(e) => setXfdf(e.target.value)} placeholder="Exported XFDF appears here" spellCheck={false} />
              <div className="log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
            </aside>
          </>
        )}
        {tab === 'error' && (
          <section className="pane"><h2>Missing document</h2><div className="body">
            <PdfWebViewer documentUrl="/does-not-exist/stream/42" customHeaders={{ Authorization: 'Bearer demo', 'session-id': 'demo' }} mode="view" {...callbacks('error')} />
          </div></section>
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

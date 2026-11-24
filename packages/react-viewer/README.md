# @pdf-studio/react-viewer

A React PDF viewer and annotator: view, search, highlight, draw, comment and export, with XFDF import and export
compatible with Acrobat and Apryse WebViewer. Built on [PDF Studio](https://github.com/nandkishormewara/pdf-studio)
(PDF.js + pdf-lib). MIT licensed, no licence key.

**[Live demo of PDF Studio](https://nandkishormewara.github.io/pdf-studio/)**

## Install

```bash
npm install @pdf-studio/react-viewer
```

React 19 (`react`, `react-dom`) is a peer dependency; `pdfjs-dist` and `pdf-lib` are installed with it.

**Vite:** add this to `vite.config.ts` so the PDF.js worker is emitted as a file:

```ts
optimizeDeps: { exclude: ['@pdf-studio/react-viewer'], include: ['pdf-lib', 'pdfjs-dist'] },
```

**Other bundlers** (webpack, Next.js and others): serve `pdfjs-dist/build/pdf.worker.min.mjs` and call
`setPdfWorkerSrc(url)` once, before the first viewer mounts.

## Use

```tsx
import { PdfWebViewer, type PdfWebViewerHandle } from '@pdf-studio/react-viewer';

export function Review({ url, savedXfdf }: { url: string; savedXfdf?: string }) {
  return (
    <div style={{ height: '100vh' }}>
      <PdfWebViewer
        documentUrl={url}
        mode="edit"                      // or "view" for read-only
        initialXfdf={savedXfdf}          // optional: annotations saved earlier
        onReady={(handle: PdfWebViewerHandle) => {
          // handle.exportXfdf(), handle.importAnnotations(xfdf), handle.exportAnnotatedPdf(), handle.loadDocument(url)
        }}
      />
    </div>
  );
}
```

- **Edit mode tools:** select, highlight, underline, strikeout, squiggly, free text, sticky note, rectangle,
  ellipse, line, arrow, polyline, polygon, cloud, pen and eraser, with colour, width, undo and redo.
- **Documents:** PDFs and images (png, jpg, webp, gif) by URL, with `customHeaders` for authenticated URLs.
- **Exchange:** `exportXfdf()` writes XFDF that Apryse WebViewer reads; `importAnnotations(xfdf)` applies
  `<add>/<modify>/<delete>`; `exportAnnotatedPdf()` returns the PDF with annotations drawn in.
- **Coming from `@pdftron/webviewer`?** The props and handle follow a typical WebViewer wrapper. See the
  [call mapping](https://github.com/nandkishormewara/pdf-studio/blob/main/docs/migrating-from-pdftron.md#web-webviewer--pdftronwebviewer).

## Develop

From a clone of the repository:

```bash
npm install
npm test          # Vitest: XFDF through the handle against mobile/shared/xfdf, loader
npm run build     # tsc (declarations) + Vite library build → dist/
npm run dev       # demo page: edit, view, side by side, image stream, error overlay
```

| File | What it does |
|---|---|
| `src/PdfWebViewer.tsx` | The component: loading (progress, 20 s stall hint, retry), `initialXfdf`, handle, toolbar, zoom |
| `src/handle.ts` | `PdfWebViewerHandle` on top of a `ViewerInstance` (what the tests drive) |
| `src/xfdfCompat.ts` | SDK `toXfdf`/`fromXfdf` plus Apryse squiggly/polyline/polygon/cloud, free-text attributes, replies |
| `src/loader.ts` | `fetch` with headers and progress, magic-byte sniffing, image → one-page PDF |
| `src/PageLayer.tsx` | One page: canvas, text layer, annotation SVG and the edit tools (incl. eraser) |
| `src/shapes.tsx` | SDK `AnnotationShape` plus squiggly and cloud rendering |
| `src/store.ts` | Annotation list with undo/redo |

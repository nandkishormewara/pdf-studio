# @pdf-studio/react-viewer (PDF Studio)

React component with a WebViewer-like API (`@pdftron/webviewer`-style props and handle), built on PDF Studio's web SDK (`../../web/src/sdk`: PDF.js + pdf-lib), which is
bundled into `dist/`.

Install notes, usage and known differences: [docs/migrating-from-pdftron.md](../../docs/migrating-from-pdftron.md).

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

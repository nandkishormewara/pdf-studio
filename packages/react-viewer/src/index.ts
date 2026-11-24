import { GlobalWorkerOptions } from 'pdfjs-dist';

export {
  createPdfWebViewerHandle,
  exportAnnotatedPdfFromInstance,
  exportXfdfFromInstance,
  importAnnotationsIntoInstance,
} from './handle';
export type { ViewerInstance } from './handle';
export type { LoadDocumentOptions, PdfViewerMode, PdfWebViewerHandle, PdfWebViewerProps } from './types';
export { PdfWebViewer } from './PdfWebViewer';
export { VIEW_MODE_DISABLED_ELEMENTS } from './constants';
export { exportXfdf, importXfdf } from './xfdfCompat';
export type { Subtype, ViewerAnnotation } from './xfdfCompat';
export { sniffType } from './loader';
export type { Watermark } from '../../../web/src/sdk/watermark';

/**
 * Overrides where the PDF.js worker is loaded from. Only needed when the host app's bundler does not
 * understand the `?url` import of `pdfjs-dist/build/pdf.worker.min.mjs` (Vite does).
 */
export function setPdfWorkerSrc(url: string) {
  GlobalWorkerOptions.workerSrc = url;
}

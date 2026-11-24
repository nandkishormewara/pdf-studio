import type { Watermark } from '../../../web/src/sdk/watermark';
// Public API — names and shapes follow a typical React wrapper around @pdftron/webviewer, so call sites barely change.

export type PdfViewerMode = 'view' | 'edit';

export interface LoadDocumentOptions {
  extension?: string;
  filename?: string;
  customHeaders?: Record<string, string>;
  /** Network download progress, 0–1 (only when the server reports a size). */
  onLoadingProgress?: (fraction: number) => void;
}

export interface PdfWebViewerHandle {
  /** Flatten annotations into a downloadable PDF blob. */
  exportAnnotatedPdf: () => Promise<Blob>;
  /** Export annotation XFDF (Apryse WebViewer reads it). */
  exportXfdf: () => Promise<string>;
  /** Import XFDF after the document has loaded. Merges; supports Apryse <add>/<modify>/<delete>. */
  importAnnotations: (xfdf: string) => Promise<void>;
  /** Load or reload a document URL. Resolves once the document is shown. */
  loadDocument: (url: string, options?: LoadDocumentOptions) => Promise<void>;
}

export interface PdfWebViewerProps {
  documentUrl: string | null | undefined;
  mode: PdfViewerMode;
  /** Accepted for compatibility with the PDFTron package; ignored. */
  licenseKey?: string;
  /** Accepted for compatibility with the PDFTron package; ignored. */
  assetPath?: string;
  /** File extension hint for stream URLs without a path suffix (the bytes are sniffed first). */
  documentExtension?: string;
  /** Optional filename (with extension), used as a type hint and as the document name. */
  documentFilename?: string;
  /** Headers sent with the document request (e.g. Authorization, session-id). */
  customHeaders?: Record<string, string>;
  className?: string;
  /** Saved annotations (XFDF) imported into this viewer's freshly loaded document, before `onLoad`. */
  initialXfdf?: string;
  /** XFDF import failed; the document stays usable but has no saved marks. */
  onAnnotationsError?: (message: string) => void;
  /**
   * Per-user watermark drawn diagonally over every page (on screen only), e.g. the viewer's name and ID.
   * A string uses WebViewer-style defaults (22 pt, red, 22% opacity).
   */
  watermark?: string | Watermark | null;
  /** Author name written on annotations created in this viewer (XFDF `title`). Default "Reviewer". */
  author?: string;
  onReady?: (handle: PdfWebViewerHandle) => void;
  onLoad?: () => void;
  onError?: (message: string) => void;
}

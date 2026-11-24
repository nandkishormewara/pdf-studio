import type { PageViewport } from 'pdfjs-dist';
import { exportPdf } from '../../../web/src/sdk/export';
import type { FormValues } from '../../../web/src/sdk/types';
import type { LoadDocumentOptions, PdfWebViewerHandle } from './types';
import { exportXfdf, importXfdf, mergeImport } from './xfdfCompat';
import type { ViewerAnnotation, ViewportLike } from './xfdfCompat';

/** What the handle needs from a viewer. `PdfWebViewer` implements it; tests can too. */
export interface ViewerInstance {
  /** The loaded document, or null before the first load / after a failed one. */
  getDocument: () => { bytes: Uint8Array; viewports: ViewportLike[] } | null;
  getAnnotations: () => ViewerAnnotation[];
  setAnnotations: (list: ViewerAnnotation[]) => void;
  /** Form field values carried in XFDF <fields> (kept so a round trip doesn't drop them). */
  getFormValues: () => FormValues;
  setFormValues: (values: FormValues) => void;
  loadDocument: (url: string, options?: LoadDocumentOptions) => Promise<void>;
}

const EMPTY_XFDF = '<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots /></xfdf>';

export async function exportAnnotatedPdfFromInstance(instance: ViewerInstance): Promise<Blob> {
  const doc = instance.getDocument();
  if (!doc) throw new Error('No document loaded.');
  const { bytes } = await exportPdf(doc.bytes, doc.viewports as PageViewport[], instance.getAnnotations(), {
    annotations: 'flatten',
    formValues: instance.getFormValues(),
  });
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

export async function exportXfdfFromInstance(instance: ViewerInstance): Promise<string> {
  const doc = instance.getDocument();
  if (!doc) return EMPTY_XFDF;
  return exportXfdf(instance.getAnnotations(), doc.viewports, instance.getFormValues());
}

export async function importAnnotationsIntoInstance(instance: ViewerInstance, xfdf: string): Promise<void> {
  const trimmed = xfdf.trim();
  if (!trimmed) return;
  const doc = instance.getDocument();
  if (!doc) throw new Error('No document loaded.');
  const imp = importXfdf(trimmed, doc.viewports);
  instance.setAnnotations(mergeImport(instance.getAnnotations(), imp));
  if (Object.keys(imp.fields).length) instance.setFormValues({ ...instance.getFormValues(), ...imp.fields });
}

export function createPdfWebViewerHandle(instance: ViewerInstance): PdfWebViewerHandle {
  return {
    exportAnnotatedPdf: () => exportAnnotatedPdfFromInstance(instance),
    exportXfdf: () => exportXfdfFromInstance(instance),
    importAnnotations: (xfdf: string) => importAnnotationsIntoInstance(instance, xfdf),
    loadDocument: (url, options) => instance.loadDocument(url, options),
  };
}

import { PDFDocument } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import { applyFormValues, markNeedAppearances } from './forms';
import { writeDefaultLayerState } from './layers';
import type { LayerState } from './layers';
import { writeAnnotations } from './pdfAnnots';
import { stampWatermark } from './watermark';
import type { ResolvedWatermark } from './watermark';
import type { Annotation, FormValues } from './types';

const FORMAT = 'pdf-studio-annotations';
const VERSION = 2;

export interface ExportOptions {
  /** 'editable' writes real PDF annotations; 'flatten' burns them into the page. */
  annotations: 'editable' | 'flatten';
  /** Form values changed by the user (unchanged fields keep their original appearance). */
  formValues?: FormValues;
  flattenForms?: boolean;
  /** Layer visibility to save as the file's default (printing and other readers then show the same layers). */
  layers?: LayerState;
  /** Per-user watermark drawn into every page (printing, flattened copies). */
  watermark?: ResolvedWatermark | null;
}

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
}

export async function exportPdf(
  original: Uint8Array,
  viewports: PageViewport[],
  annotations: Annotation[],
  opts: ExportOptions = { annotations: 'editable' },
): Promise<ExportResult> {
  const doc = await PDFDocument.load(original, { ignoreEncryption: true });
  if (doc.isEncrypted)
    throw new Error('This PDF is encrypted. Saving changes to encrypted PDFs is not supported yet; use Print instead.');
  const warnings: string[] = [];

  const formValues = opts.formValues ?? {};
  let canUpdateAppearances = true;
  if (Object.keys(formValues).length || opts.flattenForms) {
    const failed = applyFormValues(doc, formValues);
    if (failed.length) warnings.push(`Couldn't set ${failed.length} form field(s): ${failed.slice(0, 5).join(', ')}`);
    // Regenerate appearances field by field, so one field the built-in font can't draw
    // (e.g. Hindi text) doesn't stop the others from being updated.
    const form = doc.getForm();
    const font = form.getDefaultFont();
    const undrawable: string[] = [];
    for (const field of form.getFields()) {
      if (!form.fieldIsDirty(field.ref)) continue;
      try {
        field.defaultUpdateAppearances(font);
        form.markFieldAsClean(field.ref);
      } catch {
        undrawable.push(field.getName());
      }
    }
    if (undrawable.length) {
      canUpdateAppearances = false;
      markNeedAppearances(doc);
      warnings.push(`Field(s) ${undrawable.join(', ')} contain characters the built-in font can't draw; PDF viewers will render them instead.`);
    }
    if (opts.flattenForms) {
      if (canUpdateAppearances) doc.getForm().flatten();
      else warnings.push('Forms were not flattened because some values could not be drawn.');
    }
  }

  await writeAnnotations(doc, viewports, annotations, { mode: opts.annotations });
  if (opts.layers) writeDefaultLayerState(doc, opts.layers);
  if (opts.watermark) await stampWatermark(doc, viewports, opts.watermark);
  const bytes = await doc.save({ updateFieldAppearances: false });
  return { bytes, warnings };
}

export function annotationsToJson(fileName: string, annotations: Annotation[]): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, file: fileName, annotations }, null, 2);
}

export function annotationsFromJson(json: string): Annotation[] {
  const data = JSON.parse(json);
  if (data?.format !== FORMAT || !Array.isArray(data.annotations))
    throw new Error('This file is not a PDF Studio annotations export.');
  return data.annotations as Annotation[];
}

export function download(data: Uint8Array | string, name: string, type: string) {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

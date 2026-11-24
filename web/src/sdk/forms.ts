import { PDFBool, PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFSignature, PDFTextField } from 'pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { normRect } from './geometry';
import type { FormValues, FormWidget, PageLink } from './types';

export interface PageInteractive {
  widgets: (FormWidget & { initial: string | boolean | string[] })[];
  links: PageLink[];
}

/** Names of signature fields that already hold a signature (/V present). */
export async function signedFieldNames(bytes: Uint8Array): Promise<string[]> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getForm().getFields()
      .filter((f) => f instanceof PDFSignature && f.acroField.dict.has(PDFName.of('V')))
      .map((f) => f.getName());
  } catch {
    return [];
  }
}

/** Checkbox values may arrive as booleans or as XFDF/FDF strings ("On"/"Off"/"Yes"). */
export const isChecked = (v: unknown) => v === true || (typeof v === 'string' && v !== '' && v !== 'Off' && v !== 'false');

/** Reads form widgets and links of one page through pdf.js. */
export async function readPageInteractive(pdf: PDFDocumentProxy, page: PDFPageProxy, pageIndex: number, vp: PageViewport): Promise<PageInteractive> {
  const items = await page.getAnnotations({ intent: 'display' });
  const widgets: PageInteractive['widgets'] = [];
  const links: PageLink[] = [];
  const toRect = (r: number[]) => {
    const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
    const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
    return normRect({ x: x1, y: y1 }, { x: x2, y: y2 });
  };

  for (const it of items) {
    if (it.subtype === 'Link') {
      const link: PageLink = { page: pageIndex, rect: toRect(it.rect) };
      if (it.url) link.url = it.url;
      else if (it.dest) {
        try {
          const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
          if (dest && typeof dest[0] === 'object') {
            link.destPage = await pdf.getPageIndex(dest[0]);
            if (dest[1]?.name === 'XYZ' && typeof dest[3] === 'number') {
              const destVp = (await pdf.getPage(link.destPage + 1)).getViewport({ scale: 1 });
              link.destY = destVp.convertToViewportPoint(dest[2] ?? 0, dest[3])[1];
            }
          } else if (typeof dest?.[0] === 'number') link.destPage = dest[0];
        } catch { /* broken destination */ }
      }
      if (link.url || link.destPage !== undefined) links.push(link);
      continue;
    }
    if (it.subtype !== 'Widget' || !it.fieldName || it.hidden) continue;
    const base = {
      id: it.id, page: pageIndex, name: it.fieldName as string, rect: toRect(it.rect),
      readOnly: !!it.readOnly, required: !!it.required, fontSize: it.defaultAppearanceData?.fontSize || undefined,
      align: (['left', 'center', 'right'] as const)[it.textAlignment ?? 0],
    };
    switch (it.fieldType) {
      case 'Tx':
        widgets.push({
          ...base, type: 'text', multiline: !!it.multiLine, maxLen: it.maxLen || undefined, comb: !!it.comb,
          password: !!it.password, initial: typeof it.fieldValue === 'string' ? it.fieldValue : '',
        });
        break;
      case 'Btn':
        if (it.checkBox) widgets.push({ ...base, type: 'checkbox', exportValue: it.exportValue, initial: it.fieldValue === it.exportValue });
        else if (it.radioButton) widgets.push({ ...base, type: 'radio', exportValue: it.buttonValue, initial: it.fieldValue ?? '' });
        break;
      case 'Ch': {
        const options = (it.options ?? []).map((o: { exportValue: string; displayValue: string }) => ({ value: o.exportValue, label: o.displayValue }));
        const v = it.fieldValue;
        widgets.push({
          ...base, type: it.combo ? 'select' : 'listbox', options, multiSelect: !!it.multiSelect,
          initial: it.multiSelect ? (Array.isArray(v) ? v : v ? [v] : []) : Array.isArray(v) ? v[0] ?? '' : v ?? '',
        });
        break;
      }
      case 'Sig':
        widgets.push({ ...base, type: 'signature', initial: '' });
        break;
    }
  }
  return { widgets, links };
}

/** All field values (edited value if present, otherwise the document's). */
export async function collectFormData(pdf: PDFDocumentProxy, viewports: PageViewport[], edited: FormValues): Promise<FormValues> {
  const out: FormValues = {};
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const { widgets } = await readPageInteractive(pdf, page, i, viewports[i]);
    for (const w of widgets) {
      if (w.type === 'signature') continue;
      if (w.type === 'radio') {
        if (!(w.name in out) || (w.initial && !out[w.name])) out[w.name] = w.initial;
      } else out[w.name] = w.initial;
    }
  }
  return { ...out, ...edited };
}

/** Writes edited values into the AcroForm. Returns field names that could not be set. */
export function applyFormValues(doc: PDFDocument, values: FormValues): string[] {
  const failed: string[] = [];
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    try {
      const field = form.getFieldMaybe(name);
      if (!field) throw new Error('missing');
      if (field instanceof PDFTextField) field.setText(String(value ?? ''));
      else if (field instanceof PDFCheckBox) {
        if (isChecked(value)) field.check();
        else field.uncheck();
      }
      else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown) {
        if (value) field.select(String(value));
        else field.clear();
      }
      else if (field instanceof PDFOptionList) {
        const list = Array.isArray(value) ? value : value ? [String(value)] : [];
        if (list.length) field.select(list);
        else field.clear();
      }
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

export function markNeedAppearances(doc: PDFDocument) {
  doc.getForm().acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
}

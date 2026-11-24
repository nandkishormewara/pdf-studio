/**
 * XFDF in and out, kept compatible with Apryse (PDFTron) WebViewer.
 *
 * PDF Studio's SDK (web/src/sdk/xfdf.ts) has no squiggly, polyline, polygon or cloud kinds: it reads
 * squiggly as underline and polygon/polyline as ink. This layer remembers the original type in
 * `subtype` and writes it back on export, so marks made in WebViewer survive a round trip here, and
 * marks made here show up in WebViewer as the same tool.
 */
import type { PageViewport } from 'pdfjs-dist';
import { uid } from '../../../web/src/sdk/geometry';
import { fromXfdf, mergeXfdf, repairXfdf, toXfdf } from '../../../web/src/sdk/xfdf';
import type { XfdfImport } from '../../../web/src/sdk/xfdf';
import type { Annotation, FormValues } from '../../../web/src/sdk/types';

export type Subtype = 'squiggly' | 'polyline' | 'polygon' | 'cloud';

/** A PDF Studio annotation plus the Apryse type it stands for (underline → squiggly, ink → polygon …). */
export type ViewerAnnotation = Annotation & { subtype?: Subtype };

/** The two conversions XFDF needs; a pdf.js PageViewport at scale 1. */
export type ViewportLike = Pick<PageViewport, 'convertToPdfPoint' | 'convertToViewportPoint'>;

export interface ViewerXfdfImport extends XfdfImport {
  annotations: ViewerAnnotation[];
}

const XFDF_NS = 'http://ns.adobe.com/xfdf/';

/** WebViewer shows `subject` as the annotation's type name in its notes panel. */
const SUBJECT: Record<string, string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'Strikeout', squiggly: 'Squiggly', rect: 'Rectangle',
  ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', ink: 'Free Hand', polyline: 'Polyline', polygon: 'Polygon',
  cloud: 'Cloud', freetext: 'Free Text', note: 'Note', stamp: 'Stamp', signature: 'Signature',
};

export function exportXfdf(annotations: ViewerAnnotation[], viewports: ViewportLike[], fields?: FormValues): string {
  const xml = toXfdf(annotations, viewports as PageViewport[], fields);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const byId = new Map(annotations.map((a) => [a.id, a]));
  const annots = doc.getElementsByTagNameNS('*', 'annots')[0];
  for (const el of Array.from(annots?.children ?? [])) {
    const a = byId.get(el.getAttribute('name') ?? '');
    if (!a) continue;
    let out = el;
    if (a.subtype === 'squiggly' && el.localName === 'underline') out = rename(el, 'squiggly');
    else if (a.subtype && a.subtype !== 'squiggly' && el.localName === 'ink') {
      const gesture = el.getElementsByTagNameNS('*', 'gesture')[0]?.textContent ?? '';
      const pts = gesture.split(';').filter(Boolean);
      if (a.subtype !== 'polyline' && pts.length > 3 && pts[0] === pts[pts.length - 1]) pts.pop();
      out = rename(el, a.subtype === 'polyline' ? 'polyline' : 'polygon');
      for (const list of Array.from(out.getElementsByTagNameNS('*', 'inklist'))) list.remove();
      const vertices = doc.createElementNS(XFDF_NS, 'vertices');
      vertices.textContent = pts.join(';');
      out.appendChild(vertices);
      if (a.subtype === 'cloud') {
        out.setAttribute('style', 'cloudy');
        out.setAttribute('intensity', '2');
      }
    }
    // Free text (TextColor, FontSize, `color` as background) is already written the WebViewer way by the SDK.
    out.setAttribute('subject', SUBJECT[a.subtype ?? a.kind] ?? a.kind);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc.documentElement)}`;
}

export function importXfdf(xml: string, viewports: ViewportLike[]): ViewerXfdfImport {
  let doc = new DOMParser().parseFromString(xml, 'application/xml');
  let partial = false;
  if (doc.querySelector('parsererror')) {
    // Stored markup cut off mid-write: keep what was written completely (see repairXfdf).
    const repaired = repairXfdf(xml);
    const second = repaired ? new DOMParser().parseFromString(repaired, 'application/xml') : null;
    if (second && !second.querySelector('parsererror')) [doc, partial] = [second, true];
  }
  // Let the SDK report malformed input with its usual message.
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'xfdf') return fromXfdf(xml, viewports as PageViewport[]);

  const elements = Array.from(doc.documentElement.children)
    .filter((c) => ['annots', 'add', 'modify'].includes(c.localName))
    .flatMap((c) => Array.from(c.children));
  // Every annotation needs a name so we can attach its subtype (and replies) after the SDK parses it.
  for (const el of elements) if (!el.getAttribute('name')) el.setAttribute('name', uid());
  const names = new Set(elements.map((el) => el.getAttribute('name')!));

  const subtypes = new Map<string, Subtype>();
  const replies = new Map<string, string[]>();
  for (const el of elements) {
    const name = el.getAttribute('name')!;
    // WebViewer comment replies are <text inreplyto="…">; fold them into the parent's comment.
    // replyType="group" is different: marks grouped with another (lines, text, ink) and drawn like any other.
    const parent = el.getAttribute('inreplyto');
    if (parent && names.has(parent) && el.getAttribute('replyType') !== 'group') {
      const text = el.getElementsByTagNameNS('*', 'contents')[0]?.textContent?.trim();
      if (text) replies.set(parent, [...(replies.get(parent) ?? []), `${el.getAttribute('title') || 'Reply'}: ${text}`]);
      el.remove();
      continue;
    }
    const measured = el.hasAttribute('pdfstudio-measure');
    if (el.localName === 'squiggly') subtypes.set(name, 'squiggly');
    else if (el.localName === 'polyline' && !measured) subtypes.set(name, 'polyline');
    else if (el.localName === 'polygon' && !measured)
      subtypes.set(name, el.getAttribute('style') === 'cloudy' || Number(el.getAttribute('intensity')) > 0 ? 'cloud' : 'polygon');
  }

  const imp = fromXfdf(new XMLSerializer().serializeToString(doc), viewports as PageViewport[]);
  const annotations = imp.annotations.map((a): ViewerAnnotation => {
    const subtype = subtypes.get(a.id);
    const extra = replies.get(a.id);
    const comment = extra ? [a.comment, ...extra].filter(Boolean).join('\n') : a.comment;
    return { ...a, comment, ...(subtype ? { subtype } : {}) };
  });
  return { ...imp, annotations, ...(partial ? { partial } : {}) };
}

/** Applies an import to the current list: <delete>, then replace same-name, then append. */
export function mergeImport(existing: ViewerAnnotation[], imp: ViewerXfdfImport): ViewerAnnotation[] {
  return mergeXfdf(existing, imp);
}

function rename(el: Element, tag: string): Element {
  const next = el.ownerDocument.createElementNS(XFDF_NS, tag);
  for (const attr of Array.from(el.attributes)) next.setAttribute(attr.name, attr.value);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
  return next;
}

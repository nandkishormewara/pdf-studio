/**
 * XFDF (ISO 19444-1) — the XML annotation exchange format understood by Acrobat, Apryse,
 * Foxit and others. Coordinates are PDF user space (bottom-left origin).
 */
import type { PageViewport } from 'pdfjs-dist';
import { hexToRgb01, normRect, uid } from './geometry';
import { measureLabel } from './measure';
import { parsePdfDate, pdfDate } from './pdfAnnots';
import { isPlainRuns, plainText, relativeTo, runsToXhtml, xhtmlToRuns } from './richtext';
import type { Annotation, FormValues, Pt, Rect } from './types';

const TAG: Partial<Record<Annotation['kind'], string>> = {
  highlight: 'highlight', underline: 'underline', strikeout: 'strikeout', rect: 'square', ellipse: 'circle',
  line: 'line', arrow: 'line', distance: 'line', ink: 'ink', freetext: 'freetext', note: 'text',
  stamp: 'stamp', signature: 'stamp', perimeter: 'polyline', area: 'polygon', redact: 'redact',
};

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (v: number) => (Math.round(v * 100) / 100).toString();
const hexUpper = (hex: string) =>
  `#${hexToRgb01(hex).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

// not popup: it sits inside other annotations, so it can close inside one that was cut off
const ANNOT_TAGS = 'text|link|freetext|line|square|circle|polygon|polyline|highlight|underline|squiggly|strikeout|stamp|caret|ink|fileattachment|sound|redact';

/**
 * A file cut off mid-write (seen on stored Apryse markup) is not valid XML. Keeps every annotation that was written
 * completely and closes the document, so those still show instead of the whole file failing. Null when nothing is left.
 */
export function repairXfdf(xml: string): string | null {
  const ends = [...xml.matchAll(new RegExp(`</(?:\\w+:)?(?:${ANNOT_TAGS})>`, 'g'))];
  const annotsAt = xml.search(/<(?:\w+:)?annots[\s>]/);
  if (annotsAt < 0 || !ends.length) return null;
  const last = ends[ends.length - 1];
  const cut = last.index! + last[0].length;
  if (cut < annotsAt) return null;
  return `${xml.slice(0, cut)}</annots></xfdf>`;
}

export function toXfdf(annotations: Annotation[], viewports: PageViewport[], fields?: FormValues): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">'];
  if (fields && Object.keys(fields).length) {
    out.push('<fields>');
    for (const [name, value] of Object.entries(fields)) {
      const vals = Array.isArray(value) ? value : [typeof value === 'boolean' ? (value ? 'On' : 'Off') : value];
      out.push(`<field name="${esc(name)}">${vals.map((v) => `<value>${esc(String(v))}</value>`).join('')}</field>`);
    }
    out.push('</fields>');
  }
  out.push('<annots>');
  for (const a of annotations) {
    const tag = TAG[a.kind];
    const vp = viewports[a.page];
    if (!tag || !vp) continue;
    const pt = (p: Pt) => vp.convertToPdfPoint(p.x, p.y).map(n).join(',');
    const pdfRect = (r: Rect) => {
      const [x1, y1] = vp.convertToPdfPoint(r.x, r.y);
      const [x2, y2] = vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map(n).join(',');
    };
    const box = a.rect ?? (a.rects?.length ? unionRect(a.rects) : boundsOf([...(a.points ?? []), ...(a.paths?.flat() ?? [])]));
    const color = hexUpper(a.color);
    const attrs: Record<string, string> = {
      page: String(a.page), rect: pdfRect(box), color, opacity: n(a.opacity), width: n(a.strokeWidth),
      name: a.id, title: a.author, date: pdfDate(a.modifiedAt), creationdate: pdfDate(a.createdAt), flags: 'print',
    };
    if (a.status !== 'none') attrs['pdfstudio-status'] = a.status;
    let children = '';
    let contents = a.comment ?? '';
    switch (a.kind) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
        attrs.coords = (a.rects ?? []).map((rc) =>
          [{ x: rc.x, y: rc.y }, { x: rc.x + rc.w, y: rc.y }, { x: rc.x, y: rc.y + rc.h }, { x: rc.x + rc.w, y: rc.y + rc.h }].map(pt).join(',')).join(',');
        break;
      case 'line':
      case 'arrow':
      case 'distance':
        attrs.start = pt(a.points![0]);
        attrs.end = pt(a.points![1]);
        attrs.head = 'None';
        attrs.tail = a.kind === 'arrow' ? 'ClosedArrow' : 'None';
        if (a.kind === 'distance') {
          attrs.intent = 'LineDimension';
          contents = [measureLabel(a), a.comment].filter(Boolean).join('\n');
        }
        break;
      case 'perimeter':
      case 'area':
        children += `<vertices>${(a.points ?? []).map(pt).join(';')}</vertices>`;
        attrs.intent = a.kind === 'area' ? 'PolygonDimension' : 'PolyLineDimension';
        contents = [measureLabel(a), a.comment].filter(Boolean).join('\n');
        break;
      case 'rect':
      case 'ellipse':
        if (a.fill) attrs['interior-color'] = hexUpper(a.fill);
        break;
      case 'ink':
        children += `<inklist>${(a.paths ?? []).map((p) => `<gesture>${p.map(pt).join(';')}</gesture>`).join('')}</inklist>`;
        break;
      case 'freetext': {
        contents = a.text ?? '';
        const size = a.fontSize ?? 14;
        // Apryse's convention: TextColor and the default style carry the text colour, `color` the background.
        attrs.TextColor = color;
        attrs.FontSize = String(size);
        // no background → no `color`, or WebViewer would fill the box with the text colour
        if (a.fill) attrs.color = hexUpper(a.fill);
        else delete attrs.color;
        if (!a.callout) attrs.width = '0';
        if (a.intent) attrs.IT = a.intent;
        if (a.rotation) attrs.rotation = String((((a.rotation + (vp.rotation ?? 0)) % 360) + 360) % 360);
        if (a.inset && a.rect) {
          // fringe: insets in PDF space between rect and the text box, in Apryse WebViewer's order (left, bottom, right,
          // top; the PDF's /RD is left, top, right, bottom). WebViewer must read what we save, for switching back.
          const outer = pdfRect(a.rect).split(',').map(Number);
          const [l, t, rr, bb] = a.inset;
          const inner = pdfRect({ x: a.rect.x + l, y: a.rect.y + t, w: a.rect.w - l - rr, h: a.rect.h - t - bb }).split(',').map(Number);
          attrs.fringe = [inner[0] - outer[0], inner[1] - outer[1], outer[2] - inner[2], outer[3] - inner[3]].map(n).join(',');
        }
        if (a.callout?.length) {
          attrs.callout = a.callout.map(pt).join(',');
          attrs.head = a.calloutEnd ?? 'None';
        }
        children += `<defaultappearance>/Helv ${size} Tf ${hexToRgb01(a.color).map(n).join(' ')} rg</defaultappearance>`;
        children += `<defaultstyle>font: Helvetica ${size}pt; text-align: left; text-vertical-align: top; color: ${color}</defaultstyle>`;
        // XHTML body inline, as Acrobat and Apryse write it
        if (a.richText?.length) children += `<contents-richtext>${runsToXhtml(a.richText, a.color, size).replace(/^<\?xml[^>]*>/, '')}</contents-richtext>`;
        break;
      }
      case 'note':
        attrs.icon = 'Comment';
        break;
      case 'stamp':
        attrs.icon = (a.text ?? 'Approved').replace(/[^A-Za-z]/g, '') || 'Approved';
        contents = a.text ?? '';
        break;
      case 'signature':
        attrs.icon = 'Signature';
        if (a.image) children += `<imagedata>${esc(a.image)}</imagedata>`;
        break;
    }
    if (a.measure) attrs['pdfstudio-measure'] = JSON.stringify(a.measure);
    if (a.kind === 'freetext' && a.comment) attrs['pdfstudio-comment'] = a.comment;
    if (contents) children = `<contents>${esc(contents)}</contents>` + children;
    const attrText = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
    out.push(`<${tag} ${attrText}>${children}</${tag}>`);
  }
  out.push('</annots>', '</xfdf>');
  return out.join('\n');
}

export interface XfdfImport {
  annotations: Annotation[];
  fields: FormValues;
  /** ids from <modify>: replace existing annotations with the same id */
  modifiedIds: string[];
  /** ids from <delete> */
  deletedIds: string[];
  /** The file was cut off; only the annotations written completely were read. */
  partial?: boolean;
}

/**
 * Reads XFDF from Acrobat, PDF Studio or Apryse (PDFTron) WebViewer, including the command form
 * (<add>, <modify>, <delete>), TextColor/FontSize on free text and <imagedata> stamps.
 */
export function fromXfdf(xml: string, viewports: PageViewport[]): XfdfImport {
  let doc = new DOMParser().parseFromString(xml, 'application/xml');
  let partial = false;
  if (doc.querySelector('parsererror')) {
    const repaired = repairXfdf(xml);
    const second = repaired ? new DOMParser().parseFromString(repaired, 'application/xml') : null;
    if (second && !second.querySelector('parsererror')) [doc, partial] = [second, true];
  }
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'xfdf') throw new Error('This file is not valid XFDF.');
  const fields: FormValues = {};
  for (const f of Array.from(doc.getElementsByTagNameNS('*', 'field'))) {
    const name = fieldName(f);
    const values = Array.from(f.children).filter((c) => c.localName === 'value').map((v) => v.textContent ?? '');
    if (name && values.length) fields[name] = values.length > 1 ? values : values[0];
  }
  const annotations: Annotation[] = [];
  const modifiedIds: string[] = [];
  const deletedIds: string[] = [];
  const containers = Array.from(doc.documentElement.children);
  for (const c of containers.filter((c) => c.localName === 'delete'))
    for (const id of Array.from(c.children).filter((e) => e.localName === 'id')) deletedIds.push((id.textContent ?? '').trim());
  const elements = containers
    .filter((c) => ['annots', 'add', 'modify'].includes(c.localName))
    .flatMap((c) => Array.from(c.children).map((el) => ({ el, modify: c.localName === 'modify' })));
  for (const { el, modify } of elements) {
    const flags = (el.getAttribute('flags') ?? '').toLowerCase().split(',').map((f) => f.trim());
    if (flags.includes('hidden') || flags.includes('noview')) continue;
    const page = Number(el.getAttribute('page') ?? 0);
    const vp = viewports[page];
    if (!vp) continue;
    const pt = (x: number, y: number) => { const [vx, vy] = vp.convertToViewportPoint(x, y); return { x: vx, y: vy }; };
    const list = (s: string | null) => (s ?? '').split(/[,;\s]+/).filter(Boolean).map(Number);
    const pairs = (arr: number[]) => Array.from({ length: Math.floor(arr.length / 2) }, (_, i) => pt(arr[i * 2], arr[i * 2 + 1]));
    const r = list(el.getAttribute('rect'));
    const rect = r.length === 4 ? normRect(pt(r[0], r[1]), pt(r[2], r[3])) : { x: 0, y: 0, w: 0, h: 0 };
    const child = (tag: string) => Array.from(el.getElementsByTagNameNS('*', tag))[0];
    const contents = child('contents')?.textContent ?? child('contents-richtext')?.textContent ?? '';
    const date = parsePdfDate(el.getAttribute('date') ?? undefined);
    const measureAttr = el.getAttribute('pdfstudio-measure');
    if (modify && el.getAttribute('name')) modifiedIds.push(el.getAttribute('name')!);
    const base = {
      id: el.getAttribute('name') || uid(), page, color: el.getAttribute('color')?.toLowerCase() || '#e5484d',
      opacity: Number(el.getAttribute('opacity') ?? 1), strokeWidth: Number(el.getAttribute('width') ?? 1),
      status: (el.getAttribute('pdfstudio-status') as Annotation['status']) || 'none',
      author: el.getAttribute('title') || 'Unknown',
      // no creationdate: the mark is as old as its last change (as Android and iOS read it), not "now"
      createdAt: el.getAttribute('creationdate') ? parsePdfDate(el.getAttribute('creationdate')!) : date,
      modifiedAt: date, comment: contents || undefined,
      measure: measureAttr ? JSON.parse(measureAttr) : undefined,
    };
    switch (el.localName) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
      case 'squiggly': {
        const c = list(el.getAttribute('coords'));
        const rects: Rect[] = [];
        for (let i = 0; i + 7 < c.length; i += 8) {
          const ps = pairs(c.slice(i, i + 8));
          rects.push(boundsOf(ps));
        }
        const kind = el.localName === 'squiggly' ? 'underline' : (el.localName as 'highlight' | 'underline' | 'strikeout');
        annotations.push({ ...base, kind, rects: rects.length ? rects : [rect],
          opacity: el.localName === 'highlight' ? Math.min(base.opacity, 0.45) : base.opacity });
        break;
      }
      case 'square':
      case 'circle': {
        const fill = el.getAttribute('interior-color')?.toLowerCase();
        annotations.push({ ...base, kind: el.localName === 'square' ? 'rect' : 'ellipse', rect, ...(fill ? { fill } : {}) });
        break;
      }
      case 'line': {
        const s = list(el.getAttribute('start'));
        const e = list(el.getAttribute('end'));
        const intent = el.getAttribute('intent');
        const kind = intent === 'LineDimension' && base.measure ? 'distance' : /Arrow/.test(`${el.getAttribute('head')}${el.getAttribute('tail')}`) ? 'arrow' : 'line';
        annotations.push({ ...base, kind, points: [pt(s[0], s[1]), pt(e[0], e[1])], comment: kind === 'distance' ? undefined : base.comment });
        break;
      }
      case 'polyline':
      case 'polygon': {
        const pts = pairs(list(child('vertices')?.textContent ?? ''));
        if (base.measure) annotations.push({ ...base, kind: el.localName === 'polygon' ? 'area' : 'perimeter', points: pts, comment: undefined });
        else annotations.push({ ...base, kind: 'ink', paths: [el.localName === 'polygon' ? [...pts, pts[0]] : pts] });
        break;
      }
      case 'ink': {
        const paths = Array.from(el.getElementsByTagNameNS('*', 'gesture')).map((g) => pairs(list(g.textContent)));
        annotations.push({ ...base, kind: 'ink', paths });
        break;
      }
      case 'freetext': {
        const da = child('defaultappearance')?.textContent ?? '';
        const style = child('defaultstyle')?.textContent ?? '';
        const size = Number(el.getAttribute('FontSize')) || Number(da.match(/([\d.]+)\s+Tf/)?.[1]) || Number(style.match(/([\d.]+)pt/)?.[1]) || 12;
        const textColor = (el.getAttribute('TextColor') ?? style.match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? '#111111').toLowerCase();
        const rich = child('contents-richtext');
        const parsed = rich ? xhtmlToRuns(rich) : null;
        const runs = parsed && relativeTo(parsed, textColor);
        annotations.push({ ...base, kind: 'freetext', rect, text: child('contents')?.textContent ?? (runs ? plainText(runs) : contents),
          richText: runs && !isPlainRuns(runs, textColor) ? runs : undefined, fontSize: size, color: textColor, opacity: 1,
          comment: el.getAttribute('pdfstudio-comment') ?? undefined, ...freeTextExtras(el, vp, rect, textColor, pt) });
        break;
      }
      case 'redact':
        annotations.push({ ...base, kind: 'redact', rect, color: '#e5484d', opacity: 1 });
        break;
      case 'text':
        annotations.push({ ...base, kind: 'note', opacity: 1, rect: { x: rect.x, y: rect.y, w: 22, h: 22 },
          color: el.getAttribute('color')?.toLowerCase() ?? '#ffd84d' });
        break;
      case 'stamp': {
        const image = child('imagedata')?.textContent?.trim();
        if (image?.startsWith('data:image/')) annotations.push({ ...base, kind: 'signature', rect, image, color: '#000000', opacity: 1, comment: undefined });
        else annotations.push({ ...base, kind: 'stamp', rect, text: contents || el.getAttribute('icon')?.toUpperCase() || 'APPROVED', comment: undefined, strokeWidth: 2.5 });
        break;
      }
    }
  }
  return { annotations, fields, modifiedIds, deletedIds, ...(partial ? { partial } : {}) };
}

/** Background, rotation, callout and text-box insets of a <freetext>, as Apryse WebViewer and Acrobat write them. */
function freeTextExtras(el: Element, vp: PageViewport, rect: Rect, textColor: string, pt: (x: number, y: number) => Pt) {
  const out: Partial<Annotation> = {};
  const nums = (s: string | null) => (s ?? '').split(/[,;\s]+/).filter(Boolean).map(Number);
  const intent = el.getAttribute('IT') ?? el.getAttribute('intent');
  if (intent) out.intent = intent;
  // `color` is the box background when the text colour is carried separately (TextColor or the default style);
  // in PDF Studio's older files without those, `color` was the text colour. Apryse never fills typewriter text.
  const bg = el.getAttribute('color')?.toLowerCase();
  const separateText = el.hasAttribute('TextColor') || Array.from(el.children).some((c) => c.localName === 'defaultstyle');
  if (bg && separateText && intent !== 'FreeTextTypewriter' && bg !== textColor) out.fill = bg;
  const rotation = ((((Number(el.getAttribute('rotation')) || 0) - (vp.rotation ?? 0)) % 360) + 360) % 360;
  if (rotation) out.rotation = rotation;
  const rd = nums(el.getAttribute('fringe'));
  const r = nums(el.getAttribute('rect'));
  if (rd.length === 4 && r.length === 4 && rd.some((v) => v > 0.75)) {
    const [x1, y1, x2, y2] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    // Apryse order: left, bottom, right, top (the callout line then ends mid-box, as WebViewer draws it)
    const inner = normRect(pt(x1 + rd[0], y1 + rd[1]), pt(x2 - rd[2], y2 - rd[3]));
    if (inner.w > 0 && inner.h > 0)
      out.inset = [inner.x - rect.x, inner.y - rect.y, rect.x + rect.w - inner.x - inner.w, rect.y + rect.h - inner.y - inner.h];
  }
  const cl = nums(el.getAttribute('callout'));
  if (cl.length >= 4) {
    out.callout = Array.from({ length: Math.floor(cl.length / 2) }, (_, i) => pt(cl[i * 2], cl[i * 2 + 1]));
    const head = el.getAttribute('head');
    if (head && head !== 'None') out.calloutEnd = head;
  }
  return out;
}

/**
 * True when an imported mark is a copy of a mark already in the file. Marks made without a name (Apple Markup,
 * for one) get no /NM, and Apryse exports them to XFDF unnamed too, so they cannot be matched by id. PDFTron then
 * loads both and draws them on top of each other; drawn from two different appearances they would double.
 */
function sameMark(a: Annotation, b: Annotation): boolean {
  if (a.kind !== b.kind || a.page !== b.page || !a.rect || !b.rect) return false;
  if ((a.text ?? '').trim() !== (b.text ?? '').trim()) return false;
  const near = (p: number, q: number) => Math.abs(p - q) <= 1.5;
  return near(a.rect.x, b.rect.x) && near(a.rect.y, b.rect.y) && near(a.rect.x + a.rect.w, b.rect.x + b.rect.w) && near(a.rect.y + a.rect.h, b.rect.y + b.rect.h);
}

/** Applies an XFDF import to an existing list: deletes, replaces same-id (or same unnamed) annotations, appends new ones. */
export function mergeXfdf(existing: Annotation[], imp: XfdfImport): Annotation[] {
  const deleted = new Set(imp.deletedIds);
  const next = existing.filter((a) => !deleted.has(a.id));
  const fromFile = new Set(next.map((a) => a.id));
  for (const a of imp.annotations) {
    let i = next.findIndex((x) => x.id === a.id);
    if (i < 0) i = next.findIndex((x) => fromFile.has(x.id) && sameMark(x, a));
    if (i >= 0) { fromFile.delete(next[i].id); next[i] = a; }
    else next.push(a);
  }
  return next;
}

function fieldName(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e.localName === 'field'; e = e.parentElement) parts.unshift(e.getAttribute('name') ?? '');
  return parts.join('.');
}

function unionRect(rects: Rect[]): Rect {
  return boundsOf(rects.flatMap((r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }]));
}

function boundsOf(pts: Pt[]): Rect {
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

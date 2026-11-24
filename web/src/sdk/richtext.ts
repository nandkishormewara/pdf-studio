/**
 * Rich text for text boxes: a list of styled runs. Lines are separated by '\n' inside run text.
 *
 * Interchange: PDF /RC and XFDF <contents-richtext> both use an XHTML <body> of <p>/<span>
 * elements with CSS styles (font-weight, font-style, text-decoration, color) — the same
 * format Acrobat and Apryse WebViewer write.
 */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** #rrggbb; absent = the annotation's colour */
  color?: string;
}

/** Only #rrggbb survives: colours can come from imported files and end up in HTML attributes. */
const safeColor = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : undefined);

const same = (a: TextRun, b: TextRun) =>
  !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && (a.color ?? '') === (b.color ?? '');

/** Merges neighbouring runs with the same style and drops empty ones. */
export function normalizeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const clean: TextRun = { text: r.text };
    if (r.bold) clean.bold = true;
    if (r.italic) clean.italic = true;
    if (r.underline) clean.underline = true;
    const color = safeColor(r.color);
    if (color) clean.color = color;
    const last = out[out.length - 1];
    if (last && same(last, clean)) last.text += clean.text;
    else out.push(clean);
  }
  return out;
}

export const plainText = (runs: TextRun[]) => runs.map((r) => r.text).join('');

/** True when the runs carry no styling beyond the base colour (so plain `text` is enough). */
export const isPlainRuns = (runs: TextRun[], baseColor?: string) =>
  runs.every((r) => !r.bold && !r.italic && !r.underline && (!r.color || r.color === baseColor?.toLowerCase()));

/** Drops colours equal to the annotation colour (imported XHTML spells it out on every span). */
export const relativeTo = (runs: TextRun[], baseColor: string) =>
  normalizeRuns(runs.map((r) => (r.color === baseColor.toLowerCase() ? { ...r, color: undefined } : r)));

/**
 * Lines of runs as drawn in a box `maxWidth` wide: each paragraph ('\n') is wrapped between words, as Apryse
 * WebViewer wraps text in a free text box. A line breaks only when the next word would pass `maxWidth`; spaces at
 * a wrap are dropped; a word wider than the box stays whole on its own line. `measure` gives a piece's width in
 * the same units. Android (RichText.wrap) and iOS (RichText.wrap) do the same.
 */
export function wrapRuns(runs: TextRun[], maxWidth: number, measure: (text: string, run: TextRun) => number): TextRun[][] {
  const out: TextRun[][] = [];
  for (const para of runsToLines(runs)) {
    const tokens = para.flatMap((r) => r.text.split(/(\s+)/).filter(Boolean).map((t) => ({ ...r, text: t })));
    let line: TextRun[] = [];
    let width = 0;
    let wrapped = false;
    for (const t of tokens) {
      const space = /^\s+$/.test(t.text);
      if (space && wrapped && !line.length) continue; // no leading space on a wrapped line
      const w = measure(t.text, t);
      if (!space && line.some((x) => !/^\s+$/.test(x.text)) && width + w > maxWidth) {
        while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
        out.push(normalizeRuns(line));
        line = []; width = 0; wrapped = true;
      }
      line.push(t);
      width += w;
    }
    out.push(normalizeRuns(line));
  }
  return out;
}

/** Splits runs into lines of runs. */
export function runsToLines(runs: TextRun[]): TextRun[][] {
  const lines: TextRun[][] = [[]];
  for (const r of runs) {
    r.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ ...r, text: part });
    });
  }
  return lines;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** HTML for the in-place editor (contentEditable). */
export function runsToHtml(runs: TextRun[]): string {
  return runsToLines(runs).map((line) => {
    const inner = line.map((r) => {
      let h = escapeHtml(r.text);
      if (r.underline) h = `<u>${h}</u>`;
      if (r.italic) h = `<i>${h}</i>`;
      if (r.bold) h = `<b>${h}</b>`;
      const color = safeColor(r.color);
      if (color) h = `<font color="${color}">${h}</font>`;
      return h;
    }).join('');
    return `<div>${inner || '<br>'}</div>`;
  }).join('');
}

const BLOCK = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'BODY']);

/** Reads styled runs back from editor DOM (b/strong, i/em, u, font[color], span[style]). */
export function htmlToRuns(root: Node): TextRun[] {
  const runs: TextRun[] = [];
  const walk = (node: Node, style: Omit<TextRun, 'text'>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      runs.push({ ...style, text: node.textContent ?? '' });
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') { runs.push({ ...style, text: '\n' }); return; }
    const s = { ...style };
    if (tag === 'B' || tag === 'STRONG') s.bold = true;
    if (tag === 'I' || tag === 'EM') s.italic = true;
    if (tag === 'U') s.underline = true;
    if (tag === 'FONT' && node.getAttribute('color')) s.color = toHex(node.getAttribute('color')!);
    Object.assign(s, styleOf(node.getAttribute('style') ?? ''));
    const block = BLOCK.has(tag) && node !== root;
    if (block && runs.length && !runs[runs.length - 1].text.endsWith('\n')) runs.push({ text: '\n' });
    node.childNodes.forEach((c) => walk(c, s));
    // a <div><br></div> already produced its newline
    if (block && runs.length && !runs[runs.length - 1].text.endsWith('\n') && node.nextSibling) runs.push({ text: '\n' });
  };
  walk(root, {});
  const merged = normalizeRuns(runs);
  // drop a single trailing newline that browsers add after the last block
  const last = merged[merged.length - 1];
  if (last?.text.endsWith('\n')) last.text = last.text.replace(/\n$/, '');
  return normalizeRuns(merged);
}

function styleOf(css: string): Partial<TextRun> {
  const out: Partial<TextRun> = {};
  for (const decl of css.split(';')) {
    const [k, v] = decl.split(':').map((x) => x?.trim().toLowerCase());
    if (!k || !v) continue;
    if (k === 'font-weight' && (v === 'bold' || Number(v) >= 600)) out.bold = true;
    if (k === 'font-style' && v === 'italic') out.italic = true;
    if (k === 'text-decoration' && v.includes('underline')) out.underline = true;
    if (k === 'color') out.color = toHex(v);
  }
  return out;
}

function toHex(c: string): string {
  c = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c.slice(1).split('').map((x) => x + x).join('')).toLowerCase();
  const m = c.match(/rgba?\((\d+)\D+(\d+)\D+(\d+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return c;
}

/** XHTML body for PDF /RC and XFDF <contents-richtext>. */
export function runsToXhtml(runs: TextRun[], baseColor: string, fontSize: number): string {
  const paras = runsToLines(runs).map((line) => {
    const spans = line.map((r) => {
      const css = [
        r.bold ? 'font-weight:bold' : '', r.italic ? 'font-style:italic' : '',
        r.underline ? 'text-decoration:underline' : '', `color:${(safeColor(r.color) ?? safeColor(baseColor) ?? '#000000').toUpperCase()}`,
      ].filter(Boolean).join(';');
      return `<span style="${css}">${escapeHtml(r.text)}</span>`;
    }).join('');
    return `<p dir="ltr">${spans}</p>`;
  }).join('');
  return `<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:23.0.0" xfa:spec="2.0.2" style="font-size:${fontSize}pt;font-family:Helvetica">${paras}</body>`;
}

/** Parses an XHTML rich-text body (string or element) into runs. */
export function xhtmlToRuns(source: string | Element): TextRun[] | null {
  let body: Element | null;
  if (typeof source === 'string') {
    const doc = new DOMParser().parseFromString(source.replace(/^<\?xml[^>]*>/, ''), 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    body = doc.documentElement;
  } else {
    body = source.localName === 'body' ? source : Array.from(source.getElementsByTagNameNS('*', 'body'))[0] ?? source;
  }
  if (!body) return null;
  const runs = htmlToRunsNs(body);
  return runs.length ? runs : null;
}

/** Like htmlToRuns but for namespaced XHTML (localName-based). */
function htmlToRunsNs(root: Element): TextRun[] {
  const runs: TextRun[] = [];
  const walk = (node: Node, style: Omit<TextRun, 'text'>, first: { v: boolean }) => {
    if (node.nodeType === 3) { runs.push({ ...style, text: node.textContent ?? '' }); return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (tag === 'br') { runs.push({ ...style, text: '\n' }); return; }
    const s = { ...style };
    if (tag === 'b' || tag === 'strong') s.bold = true;
    if (tag === 'i' || tag === 'em') s.italic = true;
    if (tag === 'u') s.underline = true;
    Object.assign(s, styleOf(el.getAttribute('style') ?? ''));
    if (tag === 'p' || tag === 'div') {
      if (!first.v) runs.push({ text: '\n' });
      first.v = false;
    }
    el.childNodes.forEach((c) => walk(c, s, first));
  };
  const first = { v: true };
  const base = styleOf(root.getAttribute('style') ?? '');
  delete base.color; // the body colour is the annotation colour
  root.childNodes.forEach((c) => walk(c, base, first));
  return normalizeRuns(runs);
}

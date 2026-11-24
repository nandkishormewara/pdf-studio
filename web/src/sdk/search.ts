import { Util } from 'pdfjs-dist';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import type { Rect, SearchHit, SearchOptions } from './types';

interface Item {
  str: string;
  transform: number[];
  width: number;
}

interface PageText {
  text: string;
  /** for each char of `text`: index into items, or -1 for synthetic separators */
  owner: Int32Array;
  offset: Int32Array;
  items: Item[];
}

const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageText>>>();

export function getPageText(pdf: PDFDocumentProxy, pageIndex: number): Promise<PageText> {
  let map = cache.get(pdf);
  if (!map) cache.set(pdf, (map = new Map()));
  let p = map.get(pageIndex);
  if (!p) {
    p = (async () => {
      const page = await pdf.getPage(pageIndex + 1);
      const content = await page.getTextContent();
      const items: Item[] = [];
      let text = '';
      const owner: number[] = [];
      const offset: number[] = [];
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const idx = items.push({ str: raw.str, transform: raw.transform, width: raw.width }) - 1;
        for (let i = 0; i < raw.str.length; i++) {
          owner.push(idx);
          offset.push(i);
        }
        text += raw.str;
        // Treat line ends as spaces so phrases match across line breaks.
        if (raw.hasEOL && !text.endsWith(' ')) {
          text += ' ';
          owner.push(-1);
          offset.push(-1);
        }
      }
      return { text, items, owner: Int32Array.from(owner), offset: Int32Array.from(offset) };
    })();
    map.set(pageIndex, p);
  }
  return p;
}

function itemRect(item: Item, vp: PageViewport, from: number, to: number): Rect {
  const m = Util.transform(vp.transform, item.transform);
  const fontH = Math.hypot(m[2], m[3]);
  const w = item.width * vp.scale;
  const len = Math.max(1, item.str.length);
  return {
    x: m[4] + (w * from) / len,
    y: m[5] - fontH,
    w: (w * (to - from)) / len,
    h: fontH * 1.2,
  };
}

function buildRegex(query: string, o: SearchOptions): RegExp | null {
  let src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `\\b${src}\\b`;
  try {
    return new RegExp(src, o.caseSensitive ? 'gu' : 'giu');
  } catch {
    return null;
  }
}

export async function searchDocument(
  pdf: PDFDocumentProxy,
  viewports: PageViewport[],
  query: string,
  opts: SearchOptions,
  signal: { cancelled: boolean },
): Promise<SearchHit[]> {
  const re = buildRegex(query, opts);
  if (!query || !re) return [];
  const hits: SearchHit[] = [];
  for (let p = 0; p < pdf.numPages; p++) {
    if (signal.cancelled) return hits;
    const pt = await getPageText(pdf, p);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pt.text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      // Group consecutive characters by the text item they belong to.
      const rects: Rect[] = [];
      let i = start;
      while (i < end) {
        const item = pt.owner[i];
        if (item < 0) {
          i++;
          continue;
        }
        const from = pt.offset[i];
        let j = i;
        while (j < end && pt.owner[j] === item) j++;
        rects.push(itemRect(pt.items[item], viewports[p], from, pt.offset[j - 1] + 1));
        i = j;
      }
      const ctxStart = Math.max(0, start - 30);
      hits.push({
        page: p,
        rects,
        context:
          (ctxStart > 0 ? '…' : '') +
          pt.text.slice(ctxStart, start) +
          '\u0001' + m[0] + '\u0002' +
          pt.text.slice(end, end + 40),
      });
      if (hits.length >= 2000) return hits;
    }
  }
  return hits;
}

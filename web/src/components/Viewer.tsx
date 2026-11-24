import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LoadedDoc } from '../sdk/pdf';
import type { SearchHit } from '../sdk/types';
import { PageView } from './PageView';
import type { PageContext } from './PageView';
import { useT } from '../i18n';

export interface ViewerApi {
  scrollToPage: (page: number, y?: number) => void;
  containerWidth: () => number;
  containerHeight: () => number;
}

/** continuous: one long column · single: one page at a time · spread: two facing pages per row */
export type PageLayout = 'continuous' | 'single' | 'spread';

interface Props {
  doc: LoadedDoc;
  ctx: PageContext;
  hits: SearchHit[];
  activeHit: SearchHit | null;
  onPageChange: (page: number) => void;
  apiRef: RefObject<ViewerApi | null>;
  layout?: PageLayout;
  /** In spreads, put the first page of each pair on the right (Arabic, Urdu, Hebrew books). */
  rtlPages?: boolean;
  /** Spreads start with page 1 alone, like a book cover. */
  coverPage?: boolean;
  /** The page shown in single-page layout. */
  currentPage?: number;
}

/** Groups page indices into rows for the chosen layout. */
export function pageRows(count: number, layout: PageLayout, coverPage: boolean): number[][] {
  const all = Array.from({ length: count }, (_, i) => i);
  if (layout !== 'spread') return all.map((i) => [i]);
  const rows: number[][] = [];
  let i = 0;
  if (coverPage && count > 0) rows.push([i++]);
  for (; i < count; i += 2) rows.push(i + 1 < count ? [i, i + 1] : [i]);
  return rows;
}

export function Viewer({ doc, ctx, hits, activeHit, onPageChange, apiRef, layout = 'continuous', rtlPages = false, coverPage = true, currentPage = 0 }: Props) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([0, 1]));
  const ratios = useRef(new Map<number, number>());

  apiRef.current = {
    scrollToPage(page, y) {
      const root = scrollRef.current;
      if (!root) return;
      if (layout === 'single' && page !== currentPage) {
        onPageChange(Math.max(0, Math.min(doc.pageSizes.length - 1, page)));
        requestAnimationFrame(() => {
          const r = scrollRef.current;
          if (r) r.scrollTop = y !== undefined ? Math.max(0, y * ctx.scale - 80) : 0;
        });
        return;
      }
      const el = root.querySelector<HTMLElement>(`[data-page="${page}"]`);
      if (!el) return;
      // Measured against the scroll container, so it works for rows of two pages too.
      const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      const offset = y !== undefined ? Math.max(0, y * ctx.scale - 80) : -12;
      root.scrollTo({ top: top + offset });
    },
    containerWidth: () => scrollRef.current?.clientWidth ?? 800,
    containerHeight: () => scrollRef.current?.clientHeight ?? 600,
  };

  // Track which pages are near the viewport (to render) and which is most visible (current page).
  useEffect(() => {
    const root = scrollRef.current!;
    const nearObs = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        });
      },
      { root, rootMargin: '150% 0px' },
    );
    // Visibility ratios belong to the current set of page elements only.
    ratios.current.clear();
    const currentObs = new IntersectionObserver(
      (entries) => {
        // In single-page layout the page is chosen explicitly, never inferred from scrolling.
        if (layout === 'single') return;
        for (const e of entries) ratios.current.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRatio);
        let best = 0;
        let bestRatio = -1;
        for (const [i, r] of ratios.current) if (r > bestRatio || (r === bestRatio && i < best)) [best, bestRatio] = [i, r];
        onPageChange(best);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    root.querySelectorAll('.page').forEach((el) => {
      nearObs.observe(el);
      currentObs.observe(el);
    });
    return () => {
      nearObs.disconnect();
      currentObs.disconnect();
    };
  }, [doc, onPageChange, layout, coverPage, currentPage]);

  // Keep the reading position stable when zooming.
  const prevScale = useRef(ctx.scale);
  useEffect(() => {
    const el = scrollRef.current!;
    const ratio = ctx.scale / prevScale.current;
    prevScale.current = ctx.scale;
    if (ratio !== 1) el.scrollTop = el.scrollTop * ratio;
  }, [ctx.scale]);

  const byPage = useMemo(() => {
    const m = new Map<number, typeof ctx.store.annotations>();
    for (const a of ctx.store.annotations) m.set(a.page, [...(m.get(a.page) ?? []), a]);
    return m;
  }, [ctx.store.annotations]);

  const hitsByPage = useMemo(() => {
    const m = new Map<number, SearchHit[]>();
    for (const h of hits) m.set(h.page, [...(m.get(h.page) ?? []), h]);
    return m;
  }, [hits]);

  const rows = layout === 'single'
    ? [[Math.min(currentPage, doc.pageSizes.length - 1)]]
    : pageRows(doc.pageSizes.length, layout, coverPage);

  const renderPage = (i: number) => (
    <PageView
      key={`${doc.key}-${i}`}
      ctx={ctx}
      index={i}
      size={doc.pageSizes[i]}
      visible={layout === 'single' || visible.has(i)}
      annotations={byPage.get(i) ?? EMPTY}
      hits={hitsByPage.get(i) ?? EMPTY_HITS}
      activeHit={activeHit?.page === i ? activeHit : null}
    />
  );

  return (
    <div ref={scrollRef} className={`viewer layout-${layout}`} tabIndex={-1} role="document" aria-label={t('Document pages')}>
      <div className="pages">
        {layout === 'continuous'
          ? doc.pageSizes.map((_, i) => renderPage(i))
          : rows.map((row) => (
            <div key={row.join('-')} className={`page-row ${rtlPages ? 'rtl' : ''}`}>
              {row.map(renderPage)}
            </div>
          ))}
      </div>
    </div>
  );
}

const EMPTY: never[] = [];
const EMPTY_HITS: SearchHit[] = [];

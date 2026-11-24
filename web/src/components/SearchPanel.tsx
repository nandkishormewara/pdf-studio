import { useEffect, useRef, useState } from 'react';
import type { LoadedDoc } from '../sdk/pdf';
import { searchDocument } from '../sdk/search';
import type { SearchHit, SearchOptions } from '../sdk/types';
import { useT } from '../i18n';

interface Props {
  doc: LoadedDoc;
  hits: SearchHit[];
  active: number;
  onResults: (hits: SearchHit[]) => void;
  onActivate: (i: number) => void;
  onRedact?: (hits: SearchHit[]) => void;
}

export function SearchPanel({ doc, hits, active, onResults, onActivate, onRedact }: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [opts, setOpts] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, regex: false });
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const signal = { cancelled: false };
    const t = setTimeout(async () => {
      if (!query.trim()) return onResults([]);
      setBusy(true);
      const res = await searchDocument(doc.pdf, doc.viewports, query, opts, signal);
      if (!signal.cancelled) {
        onResults(res);
        setBusy(false);
        if (res.length) onActivate(0);
      }
    }, 200);
    return () => {
      signal.cancelled = true;
      clearTimeout(t);
    };
  }, [query, opts, doc, onResults, onActivate]);

  const step = (d: number) => hits.length && onActivate((active + d + hits.length) % hits.length);
  const toggle = (k: keyof SearchOptions) => setOpts((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div className="panel search-panel">
      <div className="search-row">
        <input
          ref={inputRef}
          value={query}
          placeholder={t('Search document')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
            e.stopPropagation();
          }}
        />
        <button onClick={() => step(-1)} disabled={!hits.length} title={t('Previous (Shift+Enter)')}>↑</button>
        <button onClick={() => step(1)} disabled={!hits.length} title={t('Next (Enter)')}>↓</button>
      </div>
      <div className="search-opts">
        <label><input type="checkbox" checked={opts.caseSensitive} onChange={() => toggle('caseSensitive')} /> {t('Match case')}</label>
        <label><input type="checkbox" checked={opts.wholeWord} onChange={() => toggle('wholeWord')} /> {t('Whole word')}</label>
        <label><input type="checkbox" checked={opts.regex} onChange={() => toggle('regex')} /> {t('Regex')}</label>
      </div>
      <div className="search-count">
        {busy ? t('Searching…') : query ? t('{current} of {total} results', { current: hits.length ? active + 1 : 0, total: `${hits.length}${hits.length >= 2000 ? '+' : ''}` }) : ''}
      </div>
      {onRedact && hits.length > 0 && (
        <button className="redact-all" onClick={() => onRedact(hits)} title={t('Add a redaction mark over every match')}>
          {t('Mark all {n} for redaction', { n: hits.length })}
        </button>
      )}
      <ol className="search-results">
        {hits.slice(0, 500).map((h, i) => {
          const [before, rest = ''] = h.context.split('\u0001');
          const [match, after] = rest.split('\u0002');
          return (
            <li key={i} className={i === active ? 'active' : ''} onClick={() => onActivate(i)}>
              <small>{t('Page {n}', { n: h.page + 1 })}</small>
              <span>{before}<mark>{match}</mark>{after}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { measureLabel } from '../sdk/measure';
import type { Annotation, ReviewStatus } from '../sdk/types';
import type { AnnotationStore } from '../state/store';
import { useT } from '../i18n';
import { LABELS } from './labels';

interface Props {
  store: AnnotationStore;
  focusId: string | null;
  onJump: (a: Annotation) => void;
}

export function CommentsPanel({ store, focusId, onJump }: Props) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = [...store.annotations].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt));

  useEffect(() => {
    if (!focusId) return;
    const el = listRef.current?.querySelector<HTMLTextAreaElement>(`[data-id="${focusId}"] textarea`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusId]);

  if (!sorted.length)
    return <div className="panel empty">{t('No annotations yet. Pick a tool from the toolbar to start marking up the document.')}</div>;

  return (
    <div className="panel comments" ref={listRef}>
      {sorted.map((a) => (
        <div
          key={a.id}
          data-id={a.id}
          className={`comment ${a.id === store.selectedId ? 'selected' : ''} status-${a.status}`}
          onClick={() => {
            store.select(a.id);
            onJump(a);
          }}
        >
          <div className="comment-head">
            <span className="swatch" style={{ background: a.color }} />
            <strong>{t(LABELS[a.kind])}</strong>
            <small>p.{a.page + 1} · {a.author} · {new Date(a.modifiedAt).toLocaleString()}</small>
            <button className="icon" title={t('Delete')} onClick={(e) => { e.stopPropagation(); store.remove(a.id); }}>✕</button>
          </div>
          {a.kind === 'freetext' && a.text && <p className="quote">{a.text}</p>}
          {a.measure && <p className="quote">{measureLabel(a)}</p>}
          <textarea
            placeholder={t('Add a comment…')}
            defaultValue={a.comment ?? ''}
            rows={a.comment ? 2 : 1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={(e) => e.currentTarget.value !== (a.comment ?? '') && store.update(a.id, { comment: e.currentTarget.value })}
          />
          <select
            value={a.status}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => store.update(a.id, { status: e.target.value as ReviewStatus })}
          >
            <option value="none">{t('No status')}</option>
            <option value="accepted">{t('Accepted')}</option>
            <option value="rejected">{t('Rejected')}</option>
            <option value="completed">{t('Completed')}</option>
          </select>
        </div>
      ))}
    </div>
  );
}

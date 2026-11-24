import type { CSSProperties } from 'react';
import { isChecked } from '../sdk/forms';
import type { PageInteractive } from '../sdk/forms';
import type { FormValues, PageLink } from '../sdk/types';
import { useT } from '../i18n';

interface Props {
  data: PageInteractive;
  scale: number;
  values: FormValues;
  interactive: boolean;
  onChange: (name: string, value: string | boolean | string[]) => void;
  onLink: (link: PageLink) => void;
  signedFields?: string[];
}

/** HTML form controls and link hot-spots positioned over the rendered page. */
export function FormLayer({ data, scale, values, interactive, onChange, onLink, signedFields = [] }: Props) {
  const t = useT();
  const box = (r: { x: number; y: number; w: number; h: number }): CSSProperties => ({
    left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale,
  });
  const stop = { onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation() };

  return (
    <div className={`form-layer ${interactive ? '' : 'passive'}`}>
      {data.links.map((l, i) => (
        <a key={`l${i}`} className="link-spot" style={box(l.rect)} href={l.url ?? '#'}
          title={l.url ?? t('Go to page {n}', { n: (l.destPage ?? 0) + 1 })} target="_blank" rel="noopener noreferrer"
          onClick={(e) => { if (!l.url) e.preventDefault(); onLink(l); if (l.url) e.preventDefault(); }} />
      ))}
      {data.widgets.map((w) => {
        const value = w.name in values ? values[w.name] : w.initial;
        // 0 / missing means "auto"; some writers also size multi-line fields to the full box height.
        const declared = w.fontSize && !(w.multiline && w.fontSize > 14) ? w.fontSize : 0;
        const fontSize = Math.min(declared || 12, w.rect.h * 0.75) * scale;
        const style: CSSProperties = { ...box(w.rect), fontSize, textAlign: w.align };
        const common = { title: w.name, disabled: w.readOnly, 'aria-label': w.name, required: w.required, ...stop };
        switch (w.type) {
          case 'text':
            return w.multiline ? (
              <textarea key={w.id} className="field" style={style} {...common} value={String(value ?? '')}
                maxLength={w.maxLen} onChange={(e) => onChange(w.name, e.target.value)} />
            ) : (
              <input key={w.id} className={`field ${w.comb ? 'comb' : ''}`} style={{ ...style, ...(w.comb && w.maxLen ? { letterSpacing: `calc(${(w.rect.w * scale) / w.maxLen}px - 0.6em)` } : {}) }}
                {...common} type={w.password ? 'password' : 'text'} value={String(value ?? '')} maxLength={w.maxLen}
                onChange={(e) => onChange(w.name, e.target.value)} />
            );
          case 'checkbox':
            return (
              <input key={w.id} className="field check" style={style} {...common} type="checkbox" checked={isChecked(value)}
                onChange={(e) => onChange(w.name, e.target.checked)} />
            );
          case 'radio':
            return (
              <input key={w.id} className="field check" style={style} {...common} type="radio" name={`r-${w.name}`}
                checked={value === w.exportValue} onChange={() => onChange(w.name, w.exportValue ?? '')} />
            );
          case 'select':
            return (
              <select key={w.id} className="field" style={style} {...common} value={String(value ?? '')}
                onChange={(e) => onChange(w.name, e.target.value)}>
                {!w.options?.some((o) => o.value === value) && <option value="">{''}</option>}
                {w.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
          case 'listbox':
            return (
              <select key={w.id} className="field" style={style} {...common} multiple={w.multiSelect} size={2}
                value={w.multiSelect ? (Array.isArray(value) ? value : []) : String(value ?? '')}
                onChange={(e) => onChange(w.name, w.multiSelect ? Array.from(e.target.selectedOptions, (o) => o.value) : e.target.value)}>
                {w.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
          case 'signature':
            if (signedFields.includes(w.name)) return null; // drawn by its own appearance
            return <div key={w.id} className="field sig-field" style={style} title={t('Signature field — use the Signature tool to sign here')} />;
        }
      })}
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { useT } from '../i18n';
import { htmlToRuns, runsToHtml } from '../sdk/richtext';
import type { TextRun } from '../sdk/richtext';
import type { Annotation } from '../sdk/types';

const COLORS = ['#111111', '#e5484d', '#1f6feb', '#2da44e', '#7c3aed'];

interface Props {
  annotation: Annotation;
  scale: number;
  /** runs = null when the box was left empty (the caller deletes it) */
  onDone: (runs: TextRun[] | null) => void;
}

/**
 * In-place editor for text boxes. Uses the browser's editing commands (Ctrl/⌘ B, I, U work too),
 * so selection, IME input (Hindi, Arabic…) and undo behave like any text field.
 */
export function RichTextEditor({ annotation: a, scale, onDone }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current!;
    el.innerHTML = a.richText?.length ? runsToHtml(a.richText) : runsToHtml([{ text: a.text ?? '' }]);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('styleWithCSS', false, 'false');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    const runs = htmlToRuns(ref.current!);
    onDone(runs.map((r) => r.text).join('').trim() ? runs : null);
  };

  const cmd = (name: string, value?: string) => (e: React.MouseEvent) => {
    e.preventDefault(); // keep the selection in the editor
    document.execCommand(name, false, value);
    ref.current?.focus();
  };

  const r = a.rect!;
  return (
    <div className="rte" style={{ left: r.x * scale, top: r.y * scale }}>
      <div className="rte-bar" role="toolbar" aria-label={t('Text formatting')} onMouseDown={(e) => e.preventDefault()}>
        <button type="button" className="icon" title={t('Bold (Ctrl B)')} aria-label={t('Bold (Ctrl B)')} onMouseDown={cmd('bold')}><b>B</b></button>
        <button type="button" className="icon" title={t('Italic (Ctrl I)')} aria-label={t('Italic (Ctrl I)')} onMouseDown={cmd('italic')}><i>I</i></button>
        <button type="button" className="icon" title={t('Underline (Ctrl U)')} aria-label={t('Underline (Ctrl U)')} onMouseDown={cmd('underline')}><u>U</u></button>
        <span className="rte-sep" />
        {COLORS.map((c) => (
          <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={c} onMouseDown={cmd('foreColor', c)} />
        ))}
        <button type="button" className="rte-done" onMouseDown={(e) => { e.preventDefault(); finish(); }}>{t('Done')}</button>
      </div>
      <div
        ref={ref}
        className="freetext-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={t('Text box')}
        style={{
          minWidth: r.w * scale, minHeight: r.h * scale,
          fontSize: (a.fontSize ?? 14) * scale, color: a.color,
        }}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); finish(); }
          e.stopPropagation();
        }}
      />
    </div>
  );
}

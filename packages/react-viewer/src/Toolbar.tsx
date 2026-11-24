import type { ReactNode } from 'react';
import { FONT_SIZES, PALETTE, TOOL_GROUPS, WIDTHS } from './tools';
import type { ToolStyle, ViewerTool } from './tools';

const I = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

const ICONS: Record<ViewerTool | 'undo' | 'redo' | 'delete', ReactNode> = {
  select: I(<path d="M5 3l12 8-5.5 1.2L9 18z" />),
  highlight: I(<><path d="M4 20h16" /><rect x="5" y="6" width="14" height="9" rx="1" fill="currentColor" fillOpacity=".25" /></>),
  underline: I(<><path d="M7 4v6a5 5 0 0010 0V4" /><path d="M5 20h14" /></>),
  strikeout: I(<><path d="M16 6.5C15 5 13.6 4.5 12 4.5c-2.5 0-4 1.3-4 3 0 4 8 2.5 8 6.5 0 1.8-1.7 3.5-4.2 3.5-1.8 0-3.3-.7-4.3-2" /><path d="M4 12h16" /></>),
  squiggly: I(<><path d="M7 4v5a5 5 0 0010 0V4" /><path d="M3 19l2-2 2 2 2-2 2 2 2-2 2 2 2-2 2 2 2-2" /></>),
  freetext: I(<><path d="M5 6V4h14v2" /><path d="M12 4v16" /><path d="M9 20h6" /></>),
  note: I(<><path d="M4 4h16v12H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>),
  rect: I(<rect x="4" y="6" width="16" height="12" rx="1" />),
  ellipse: I(<ellipse cx="12" cy="12" rx="8.5" ry="6.5" />),
  line: I(<path d="M5 19L19 5" />),
  arrow: I(<><path d="M5 19L19 5" /><path d="M10 5h9v9" /></>),
  polyline: I(<path d="M3 18l5-9 5 6 4-9 4 4" />),
  polygon: I(<path d="M12 3l8 6-3 10H7L4 9z" />),
  cloud: I(<path d="M7 18a4 4 0 01-.6-8 5.5 5.5 0 0110.7-1.4A4.5 4.5 0 0117.5 18z" />),
  pen: I(<><path d="M4 20l1-4L16 5l3 3L8 19z" /><path d="M14 7l3 3" /></>),
  eraser: I(<><path d="M8 20h12" /><path d="M4.5 14.5l9-9a2 2 0 012.8 0l3.2 3.2a2 2 0 010 2.8L12 19H8z" /><path d="M9 10l5 5" /></>),
  undo: I(<><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 010 12h-3" /></>),
  redo: I(<><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 000 12h3" /></>),
  delete: I(<><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>),
};

interface Props {
  tool: ViewerTool;
  onTool: (t: ViewerTool) => void;
  style: ToolStyle;
  onStyle: (patch: Partial<ToolStyle>) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canDelete: boolean;
  onDelete: () => void;
}

export function Toolbar({ tool, onTool, style, onStyle, canUndo, canRedo, onUndo, onRedo, canDelete, onDelete }: Props) {
  const showWidth = !['select', 'highlight', 'freetext', 'note', 'eraser'].includes(tool);
  return (
    <div className="psv-toolbar" role="toolbar" aria-label="Annotation tools">
      {TOOL_GROUPS.map((group, i) => (
        <div className="psv-group" key={i}>
          {group.map(({ tool: t, label }) => (
            <button key={t} type="button" title={label} aria-label={label} aria-pressed={tool === t}
              className={tool === t ? 'active' : ''} onClick={() => onTool(t)}>
              {ICONS[t]}
            </button>
          ))}
        </div>
      ))}
      <div className="psv-group psv-style">
        {tool !== 'eraser' && PALETTE.map((c) => (
          <button key={c} type="button" className={`psv-swatch ${style.color === c ? 'active' : ''}`} title={c} aria-label={`Colour ${c}`}
            style={{ ['--swatch' as string]: c }} onClick={() => onStyle({ color: c })} />
        ))}
        {showWidth && (
          <select aria-label="Line width" value={style.strokeWidth} onChange={(e) => onStyle({ strokeWidth: Number(e.target.value) })}>
            {WIDTHS.map((w) => <option key={w} value={w}>{w} pt</option>)}
          </select>
        )}
        {tool === 'freetext' && (
          <select aria-label="Font size" value={style.fontSize} onChange={(e) => onStyle({ fontSize: Number(e.target.value) })}>
            {FONT_SIZES.map((s) => <option key={s} value={s}>{s} pt</option>)}
          </select>
        )}
      </div>
      <div className="psv-group psv-end">
        <button type="button" title="Undo" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>{ICONS.undo}</button>
        <button type="button" title="Redo" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>{ICONS.redo}</button>
        <button type="button" title="Delete selected" aria-label="Delete selected" disabled={!canDelete} onClick={onDelete}>{ICONS.delete}</button>
      </div>
    </div>
  );
}

export type ViewerTool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'freetext'
  | 'note'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polyline'
  | 'polygon'
  | 'cloud'
  | 'pen'
  | 'eraser';

/** Text markup: select text, or drag a box on scanned pages that have no text. */
export const MARKUP_TOOLS = new Set<ViewerTool>(['highlight', 'underline', 'strikeout', 'squiggly']);
/** Click to add points, double-click (or click the first point, or Enter) to finish. */
export const POLY_TOOLS = new Set<ViewerTool>(['polyline', 'polygon', 'cloud']);

export interface ToolStyle {
  color: string;
  strokeWidth: number;
  fontSize: number;
}

export const DEFAULT_COLORS: Partial<Record<ViewerTool, string>> = {
  highlight: '#ffe14d',
  note: '#ffcd45',
};
export const DEFAULT_COLOR = '#e44234';

export const PALETTE = ['#e44234', '#1f6feb', '#00a35c', '#ffe14d', '#7c3aed', '#111111'];
export const WIDTHS = [1, 2, 4, 6];
export const FONT_SIZES = [12, 16, 20, 28];

export const TOOL_GROUPS: { tool: ViewerTool; label: string }[][] = [
  [{ tool: 'select', label: 'Select' }],
  [
    { tool: 'highlight', label: 'Highlight' },
    { tool: 'underline', label: 'Underline' },
    { tool: 'strikeout', label: 'Strikeout' },
    { tool: 'squiggly', label: 'Squiggly' },
  ],
  [
    { tool: 'freetext', label: 'Free text' },
    { tool: 'note', label: 'Sticky note' },
  ],
  [
    { tool: 'rect', label: 'Rectangle' },
    { tool: 'ellipse', label: 'Ellipse' },
    { tool: 'line', label: 'Line' },
    { tool: 'arrow', label: 'Arrow' },
    { tool: 'polyline', label: 'Polyline' },
    { tool: 'polygon', label: 'Polygon' },
    { tool: 'cloud', label: 'Cloud' },
  ],
  [
    { tool: 'pen', label: 'Pen' },
    { tool: 'eraser', label: 'Eraser' },
  ],
];

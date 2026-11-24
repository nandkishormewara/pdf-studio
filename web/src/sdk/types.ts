import type { TextRun } from './richtext';

// All coordinates are in "page units": the pdf.js viewport at scale 1,
// origin at the top-left of the page as displayed (page /Rotate applied).

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export type AnnotationKind =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'ink'
  | 'freetext'
  | 'note'
  | 'stamp'
  | 'signature'
  | 'distance'
  | 'perimeter'
  | 'area'
  | 'redact';

export interface MeasureScale {
  /** real-world units per PDF point (1/72 inch) */
  factor: number;
  unit: string;
  precision: number;
}

export type ReviewStatus = 'none' | 'accepted' | 'rejected' | 'completed';

export interface Annotation {
  id: string;
  page: number; // 0-based
  kind: AnnotationKind;
  color: string; // #rrggbb
  opacity: number; // 0..1
  strokeWidth: number;
  /** Box-shaped kinds: rect, ellipse, freetext, note, stamp, signature, redact */
  rect?: Rect;
  /** Text markup: highlight, underline, strikeout */
  rects?: Rect[];
  /** line, arrow, distance: [start, end]; perimeter, area: vertices */
  points?: Pt[];
  /** measurement kinds only */
  measure?: MeasureScale;
  /** ink: one array per stroke */
  paths?: Pt[][];
  /** freetext body, stamp label (plain text; always present for compatibility) */
  text?: string;
  /** freetext styling: bold/italic/underline/colour runs. `text` holds the same text unstyled. */
  richText?: TextRun[];
  fontSize?: number;
  /** Interior colour: rect, ellipse; background of a freetext box. Drawn at `opacity`. */
  fill?: string;
  /** freetext: text turned counter-clockwise by this many degrees as displayed (0, 90, 180, 270) */
  rotation?: number;
  /** freetext: text box inset from `rect` (left, top, right, bottom), e.g. to leave room for a callout line */
  inset?: [number, number, number, number];
  /** freetext callout leader: [tip at the target, optional knee, end at the text box] */
  callout?: Pt[];
  /** freetext callout tip ending as in PDF /LE: OpenArrow, ClosedArrow, None … */
  calloutEnd?: string;
  /** freetext intent kept for round trips: FreeTextTypewriter, FreeTextCallout */
  intent?: string;
  /** signature PNG data URL */
  image?: string;
  /** Reply / comment shown in the comments panel */
  comment?: string;
  status: ReviewStatus;
  author: string;
  createdAt: string;
  modifiedAt: string;
}

export type Tool = 'select' | AnnotationKind;

export interface ToolStyle {
  color: string;
  opacity: number;
  strokeWidth: number;
  fontSize: number;
  stampText: string;
}

export interface PageSize {
  width: number;
  height: number;
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchHit {
  page: number;
  rects: Rect[];
  context: string;
}

export type FieldType = 'text' | 'checkbox' | 'radio' | 'select' | 'listbox' | 'signature';

export interface FormWidget {
  id: string;
  page: number;
  name: string;
  type: FieldType;
  rect: Rect;
  /** checkbox/radio: the value this widget represents when on */
  exportValue?: string;
  options?: { value: string; label: string }[];
  multiline?: boolean;
  multiSelect?: boolean;
  readOnly?: boolean;
  required?: boolean;
  maxLen?: number;
  comb?: boolean;
  password?: boolean;
  fontSize?: number;
  align?: 'left' | 'center' | 'right';
}

/** field name -> value. checkbox: boolean; listbox(multi): string[]; others: string */
export type FormValues = Record<string, string | boolean | string[]>;

export interface PageLink {
  page: number;
  rect: Rect;
  url?: string;
  destPage?: number;
  destY?: number;
}

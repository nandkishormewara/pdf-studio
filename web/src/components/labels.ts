import type { Annotation } from '../sdk/types';

/** Annotation kind names shown in the comments panel and read by screen readers (English keys for t()). */
export const LABELS: Record<Annotation['kind'], string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'Strikeout', rect: 'Rectangle', ellipse: 'Ellipse',
  line: 'Line', arrow: 'Arrow', ink: 'Ink', freetext: 'Text', note: 'Note', stamp: 'Stamp', signature: 'Signature',
  distance: 'Distance', perimeter: 'Perimeter', area: 'Area', redact: 'Redaction mark',
};

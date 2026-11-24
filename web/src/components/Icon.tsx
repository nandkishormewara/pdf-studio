// Minimal stroke icon set (24x24 grid).
const PATHS: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  select: 'M5 3l6 16 2.5-6.5L20 10z',
  highlight: 'M9 15l-4 4h5l2-2M14 4l6 6-8 8-6-6z',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 21h14',
  strikeout: 'M4 12h16M16 6.5C15 5 13.6 4 12 4 9.5 4 8 5.5 8 7.3c0 3.4 8 2.7 8 6.9 0 2-1.8 3.8-4.3 3.8-2 0-3.5-1-4.3-2.5',
  rect: 'M4 5h16v14H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5M10 5h9v9',
  ink: 'M3 17c3-5 5-9 7-9s0 8 3 8 3-6 5-6 2 3 3 4',
  freetext: 'M5 6V4h14v2M12 4v16M9 20h6',
  note: 'M5 4h14v11l-5 5H5zM14 20v-5h5',
  stamp: 'M9 4h6l-1 7h4l1 4H5l1-4h4zM5 19h14',
  signature: 'M3 17c2-1 3-6 5-6s0 6 2 6 3-4 4-4 1 3 3 3M15 20h6M17 5l2 2-7 7-3 1 1-3z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  comments: 'M4 5h16v11H9l-5 4z',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5',
  extract: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 13h6M9 17h4',
  sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  print: 'M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  json: 'M8 4c-2 0-2 2-2 4s-2 4-2 4 2 0 2 4 0 4 2 4M16 4c2 0 2 2 2 4s2 4 2 4-2 0-2 4 0 4-2 4',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  rotl: 'M4 4v5h5M4.5 9A8 8 0 1 1 4 13',
  rotr: 'M20 4v5h-5M19.5 9A8 8 0 1 0 20 13',
  distance: 'M3 17L17 3M3 17l3-3M14 6l3-3M7 13l2 2M10 10l2 2M13 7l2 2',
  perimeter: 'M4 18L8 6l8 3 4 9M4 18h0M8 6h0M16 9h0M20 18h0',
  area: 'M4 18L7 6l10 2 3 10zM8 15l3-3M11 16l5-5',
  ruler: 'M3 15L15 3l6 6L9 21zM7 11l2 2M10 8l2 2M13 5l2 2',
  insert: 'M6 3h8l5 5v13H6zM14 3v5h5M12 11v6M9 14h6',
  chevron: 'M6 9l6 6 6-6',
  form: 'M4 5h16v4H4zM4 13h10M4 17h7M17 15l2 2 3-4',
  redact: 'M4 6h16v12H4zM7 9h10v2H7zM7 13h6v2H7z',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  fitpage: 'M7 3h10v18H7zM10 7h4M10 11h4',
  continuous: 'M7 2h10v8H7zM7 14h10v8H7z',
  single: 'M6 3h12v18H6z',
  spread: 'M2 5h9v14H2zM13 5h9v14h-9z',
  prev: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg className={`i-${name}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

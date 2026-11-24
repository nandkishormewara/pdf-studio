// A small TrueType subsetter for fonts embedded in PDFs (CIDFontType2 with a CIDToGIDMap).
//
// Glyph ids are kept ("retain gids"): glyphs the PDF doesn't use become empty in glyf/loca and get zero metrics, so the
// CIDToGIDMap and widths written for the full font stay valid, and the file shrinks to the used outlines plus small,
// highly compressible tables. Components of composite glyphs are kept too. Only the tables a PDF reader needs to draw
// glyphs by id are written (PDF 32000-1, 9.9: cmap is not needed when a CIDToGIDMap is given; OpenType layout tables
// such as GSUB/GPOS/GDEF only matter to shapers, and the shaping has already been done):
//   head hhea hmtx maxp loca glyf  - outlines and metrics
//   cvt  fpgm prep                  - hinting programs, when the font has them (glyph instructions refer to them)
//   OS/2                            - small; carries the embedding permissions
//   post                            - rewritten as version 3 (no glyph names)
// Dropped: cmap, name, GSUB, GPOS, GDEF, STAT, gasp, DSIG and anything else.

const KEEP = new Set(['head', 'hhea', 'hmtx', 'maxp', 'loca', 'glyf', 'cvt ', 'fpgm', 'prep', 'OS/2', 'post']);

interface Table { tag: string; data: Uint8Array }

function readTables(font: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const n = dv.getUint16(4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const rec = 12 + 16 * i;
    const tag = String.fromCharCode(font[rec], font[rec + 1], font[rec + 2], font[rec + 3]);
    const offset = dv.getUint32(rec + 8), length = dv.getUint32(rec + 12);
    if (offset + length > font.length) throw new Error(`ttfSubset: table ${tag} runs past the end of the file`);
    tables.set(tag, font.subarray(offset, offset + length));
  }
  return tables;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Glyph ids of the components of a composite glyph (empty for a simple glyph). */
function components(glyph: Uint8Array): number[] {
  if (glyph.length < 10) return [];
  const dv = view(glyph);
  if (dv.getInt16(0) >= 0) return [];
  const out: number[] = [];
  let p = 10;
  for (;;) {
    const flags = dv.getUint16(p);
    out.push(dv.getUint16(p + 2));
    p += 4 + (flags & 0x0001 ? 4 : 2); // ARG_1_AND_2_ARE_WORDS
    if (flags & 0x0008) p += 2; // WE_HAVE_A_SCALE
    else if (flags & 0x0040) p += 4; // WE_HAVE_AN_X_AND_Y_SCALE
    else if (flags & 0x0080) p += 8; // WE_HAVE_A_TWO_BY_TWO
    if (!(flags & 0x0020)) break; // MORE_COMPONENTS
  }
  return out;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const padded = data.length % 4 ? (() => { const b = new Uint8Array(data.length + 4 - (data.length % 4)); b.set(data); return b; })() : data;
  const dv = view(padded);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  return sum;
}

/**
 * The font [font] (a TrueType/glyf file) with only the glyphs [gids] (and .notdef and composite components) kept,
 * at their original ids. Returns the input unchanged if it isn't a glyf-based font.
 */
export function subsetTrueType(font: Uint8Array, gids: Iterable<number>): Uint8Array {
  const tables = readTables(font);
  const head = tables.get('head'), maxp = tables.get('maxp'), loca = tables.get('loca'), glyf = tables.get('glyf');
  const hhea = tables.get('hhea'), hmtx = tables.get('hmtx');
  if (!head || !maxp || !loca || !glyf || !hhea || !hmtx) return font;
  const numGlyphs = view(maxp).getUint16(4);
  const longLoca = view(head).getInt16(50) === 1;
  const lv = view(loca);
  const offset = (g: number) => (longLoca ? lv.getUint32(g * 4) : lv.getUint16(g * 2) * 2);
  const glyph = (g: number) => glyf.subarray(offset(g), offset(g + 1));

  // The glyphs to keep: .notdef, the ones asked for, and every component they're built from.
  const keep = new Set<number>();
  const todo = [0, ...gids].filter((g) => g >= 0 && g < numGlyphs);
  while (todo.length) {
    const g = todo.pop()!;
    if (keep.has(g)) continue;
    keep.add(g);
    for (const c of components(glyph(g))) if (c < numGlyphs) todo.push(c);
  }

  // glyf + loca: kept glyphs copied (each padded to 4 bytes), the rest empty.
  let size = 0;
  for (const g of keep) size += (glyph(g).length + 3) & ~3;
  const newGlyf = new Uint8Array(size);
  const offsets = new Uint32Array(numGlyphs + 1);
  let at = 0;
  for (let g = 0; g < numGlyphs; g++) {
    offsets[g] = at;
    if (!keep.has(g)) continue;
    const data = glyph(g);
    newGlyf.set(data, at);
    at += (data.length + 3) & ~3;
  }
  offsets[numGlyphs] = at;
  const short = at / 2 <= 0xffff;
  const newLoca = new Uint8Array((numGlyphs + 1) * (short ? 2 : 4));
  const nl = view(newLoca);
  offsets.forEach((o, i) => (short ? nl.setUint16(i * 2, o / 2) : nl.setUint32(i * 4, o)));

  // hmtx: metrics of unused glyphs zeroed; the long metrics end at the last kept glyph that needs one.
  const numberOfHMetrics = view(hhea).getUint16(34);
  const hv = view(hmtx);
  const maxKept = Math.max(...keep);
  const nh = Math.max(1, Math.min(numberOfHMetrics, maxKept + 1));
  const newHmtx = new Uint8Array(nh * 4 + (numGlyphs - nh) * 2);
  const nv = view(newHmtx);
  const advance = (g: number) => hv.getUint16(Math.min(g, numberOfHMetrics - 1) * 4);
  const lsb = (g: number) => (g < numberOfHMetrics ? hv.getInt16(g * 4 + 2) : hv.getInt16(numberOfHMetrics * 4 + (g - numberOfHMetrics) * 2));
  for (let g = 0; g < numGlyphs; g++) {
    if (!keep.has(g)) continue;
    if (g < nh) { nv.setUint16(g * 4, advance(g)); nv.setInt16(g * 4 + 2, lsb(g)); }
    else nv.setInt16(nh * 4 + (g - nh) * 2, lsb(g));
  }

  const newHead = head.slice();
  view(newHead).setUint32(8, 0); // checkSumAdjustment, set below
  view(newHead).setInt16(50, short ? 0 : 1);
  const newHhea = hhea.slice();
  view(newHhea).setUint16(34, nh);

  const out: Table[] = [];
  for (const [tag, data] of tables) {
    if (!KEEP.has(tag)) continue;
    if (tag === 'glyf') out.push({ tag, data: newGlyf });
    else if (tag === 'loca') out.push({ tag, data: newLoca });
    else if (tag === 'hmtx') out.push({ tag, data: newHmtx });
    else if (tag === 'head') out.push({ tag, data: newHead });
    else if (tag === 'hhea') out.push({ tag, data: newHhea });
    else if (tag === 'post') {
      const post = new Uint8Array(32);
      post.set(data.subarray(0, Math.min(32, data.length)));
      view(post).setUint32(0, 0x00030000);
      out.push({ tag, data: post });
    } else out.push({ tag, data });
  }
  return writeFont(out);
}

function writeFont(tables: Table[]): Uint8Array {
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = tables.length;
  let pow = 1, log = 0;
  while (pow * 2 <= n) { pow *= 2; log++; }
  let size = 12 + 16 * n;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const font = new Uint8Array(size);
  const dv = view(font);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, n);
  dv.setUint16(6, pow * 16);
  dv.setUint16(8, log);
  dv.setUint16(10, n * 16 - pow * 16);
  let at = 12 + 16 * n;
  let headAt = -1;
  tables.forEach((t, i) => {
    const rec = 12 + 16 * i;
    for (let j = 0; j < 4; j++) font[rec + j] = t.tag.charCodeAt(j);
    dv.setUint32(rec + 4, checksum(t.data));
    dv.setUint32(rec + 8, at);
    dv.setUint32(rec + 12, t.data.length);
    font.set(t.data, at);
    if (t.tag === 'head') headAt = at;
    at += (t.data.length + 3) & ~3;
  });
  if (headAt >= 0) dv.setUint32(headAt + 8, (0xb1b0afba - checksum(font)) >>> 0);
  return font;
}

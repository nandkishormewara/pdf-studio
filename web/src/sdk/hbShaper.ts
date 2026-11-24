// A TextShaper on HarfBuzz (harfbuzzjs, MIT) for unicodeText.ts. Loaded on demand: the wasm and the fonts are only
// fetched the first time a mark with non-Latin text is saved.
import type { ShapedGlyph, ShapingFont, TextShaper } from './unicodeText';

type HB = typeof import('harfbuzzjs');

async function shapingFont(hb: HB, bytes: Uint8Array, name: string): Promise<ShapingFont> {
  const face = new hb.Face(new hb.Blob(bytes));
  const font = new hb.Font(face);
  const upem = face.upem;
  const head = face.referenceTable('head');
  const i16 = (o: number) => (head ? new DataView(head.buffer, head.byteOffset).getInt16(o) : 0);
  const ext = font.hExtents();
  return {
    name,
    upem,
    ascender: ext.ascender,
    descender: ext.descender,
    bbox: head ? [i16(36), i16(38), i16(40), i16(42)] : [0, ext.descender, upem, ext.ascender],
    bytes,
    advance: (gid) => font.glyphHAdvance(gid),
    shape(text: string): ShapedGlyph[] {
      const buf = new hb.Buffer();
      try {
        buf.addText(text);
        buf.guessSegmentProperties();
        hb.shape(font, buf);
        const pos = buf.getGlyphPositions();
        return buf.getGlyphInfos().map((g, i) => ({
          gid: g.codepoint, cluster: g.cluster, xAdvance: pos[i].xAdvance, xOffset: pos[i].xOffset, yOffset: pos[i].yOffset,
        }));
      } finally {
        (buf as unknown as { destroy?: () => void }).destroy?.();
      }
    },
  };
}

/**
 * A HarfBuzz shaper over a regular and a bold TrueType font (e.g. Noto Sans Devanagari). [load] returns a font file's
 * bytes from its URL, so tests can read from disk.
 */
export function harfBuzzShaper(
  fonts: { regular: string; bold: string; name?: string },
  load: (url: string) => Promise<Uint8Array> = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()),
): () => Promise<TextShaper> {
  return async () => {
    const [hb, regular, bold] = await Promise.all([import('harfbuzzjs'), load(fonts.regular), load(fonts.bold)]);
    const base = fonts.name ?? 'NotoSansDevanagari';
    return {
      regular: await shapingFont(hb, regular, `${base}-Regular`),
      bold: await shapingFont(hb, bold, `${base}-Bold`),
    };
  };
}

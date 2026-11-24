// A TextShaper on HarfBuzz (harfbuzzjs, MIT) for unicodeText.ts. Loaded on demand: the wasm is only fetched the
// first time a mark with non-Latin text is saved, and each script's fonts only when that script is first saved.
import type { ScriptFonts, ShapedGlyph, ShapedScript, ShapingFont, TextShaper } from './unicodeText';

export type HarfBuzz = typeof import('harfbuzzjs');

const TAGS: Record<ShapedScript, string> = { devanagari: 'Deva', arabic: 'Arab', hebrew: 'Hebr' };

async function shapingFont(hb: HarfBuzz, bytes: Uint8Array, name: string): Promise<ShapingFont> {
  const face = new hb.Face(new hb.Blob(bytes));
  const font = new hb.Font(face);
  const upem = face.upem;
  const head = face.referenceTable('head');
  const i16 = (o: number) => (head ? new DataView(head.buffer, head.byteOffset).getInt16(o) : 0);
  const ext = font.hExtents();
  const outlines = new Map<number, string | null>();
  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  // an empty glyph with no advance (ZERO WIDTH SPACE's, or another invisible character's)
  const blank = [0x200b, 0xfeff, 0x034f, 0x2060].map((u) => font.nominalGlyph(u))
    .find((g) => g && font.glyphHAdvance(g) === 0 && !font.glyphToJson(g).length);
  return {
    name,
    upem,
    ascender: ext.ascender,
    descender: ext.descender,
    bbox: head ? [i16(36), i16(38), i16(40), i16(42)] : [0, ext.descender, upem, ext.ascender],
    bytes,
    advance: (gid) => font.glyphHAdvance(gid),
    blank,
    outline(gid) {
      let path = outlines.get(gid);
      if (path === undefined) {
        const ops: string[] = [];
        let cx = 0, cy = 0;
        for (const { type, values: v } of font.glyphToJson(gid)) {
          if (type === 'M' || type === 'L') ops.push(`${n(v[0])} ${n(v[1])} ${type === 'M' ? 'm' : 'l'}`);
          else if (type === 'C') ops.push(`${v.map(n).join(' ')} c`);
          else if (type === 'Q') {
            // TrueType curves are quadratic; PDF paths are cubic
            const [qx, qy, x, y] = v;
            ops.push(`${n(cx + (2 / 3) * (qx - cx))} ${n(cy + (2 / 3) * (qy - cy))} ${n(x + (2 / 3) * (qx - x))} ${n(y + (2 / 3) * (qy - y))} ${n(x)} ${n(y)} c`);
          } else if (type === 'Z') ops.push('h');
          if (v?.length) { cx = v[v.length - 2]; cy = v[v.length - 1]; }
        }
        path = ops.length ? ops.join(' ') : null;
        outlines.set(gid, path);
      }
      return path;
    },
    shape(text: string, rtl?: boolean, script?: ShapedScript): ShapedGlyph[] {
      const buf = new hb.Buffer();
      try {
        buf.addText(text);
        if (rtl !== undefined) buf.setDirection(rtl ? hb.Direction.RTL : hb.Direction.LTR);
        if (script) buf.setScript(TAGS[script]);
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

/** A script's regular and bold TrueType files (URLs, or paths for [load]) and its PostScript family name. */
export interface ScriptFontFiles {
  regular: string;
  bold: string;
  /** e.g. NotoSansArabic; the fonts are named <name>-Regular and <name>-Bold */
  name: string;
}

/**
 * A HarfBuzz shaper over one regular and bold TrueType pair per script (e.g. Noto Sans Devanagari, Arabic, Hebrew).
 * [load] returns a font file's bytes from its URL, so tests can read from disk. The first script listed writes the
 * punctuation Helvetica lacks (—, ₹) on lines with no other script.
 */
export function harfBuzzShaper(
  scripts: Partial<Record<ShapedScript, ScriptFontFiles>>,
  load: (url: string) => Promise<Uint8Array> = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()),
): () => Promise<TextShaper> {
  return async () => {
    const keys = Object.keys(scripts) as ShapedScript[];
    if (!keys.length) throw new Error('harfBuzzShaper: no fonts');
    const hb = await import('harfbuzzjs');
    const cache = new Map<ShapedScript, Promise<ScriptFonts | null>>();
    return {
      defaultScript: keys[0],
      fonts(script) {
        const files = scripts[script];
        if (!files) return Promise.resolve(null);
        let p = cache.get(script);
        if (!p) {
          p = (async () => {
            const [regular, bold] = await Promise.all([load(files.regular), load(files.bold)]);
            return {
              regular: await shapingFont(hb, regular, `${files.name}-Regular`),
              bold: await shapingFont(hb, bold, `${files.name}-Bold`),
            };
          })();
          // a failed download is tried again on the next save
          p.catch(() => cache.delete(script));
          cache.set(script, p);
        }
        return p;
      },
    };
  };
}

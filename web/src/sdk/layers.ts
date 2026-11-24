/**
 * PDF layers (optional content groups, OCGs): reading the list the document shows in its layers
 * panel, switching layers on and off for display, and writing the chosen visibility into a saved
 * file as its default.
 *
 * Rendering uses pdf.js: pass the same `config` to `page.render({ optionalContentConfigPromise })`
 * and re-render when `config.getHash()` changes. Radio-button groups (/RBGroups) are handled by
 * pdf.js: switching one on switches the others in its group off.
 */
import { PDFDict, PDFName, PDFRef } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type LayerConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>;

/** One row of the layers panel, in the document's own order (/Order). */
export interface LayerRow {
  kind: 'layer' | 'heading';
  /** pdf.js group id (`"12R"`), for layers only */
  id?: string;
  /** `null` = the document gave the layer no name */
  name: string | null;
  depth: number;
  /** part of a radio-button group: only one of its group can be on */
  radio?: boolean;
}

export interface Layers {
  config: LayerConfig;
  rows: LayerRow[];
  /** visibility as the document opens it, for "Reset" */
  initial: LayerState;
}

/** Visibility per group id. */
export type LayerState = Record<string, boolean>;

type OrderItem = string | { name: string | null; order: OrderItem[] };

/** Reads the document's layers, or null when it has none. */
export async function readLayers(pdf: PDFDocumentProxy): Promise<Layers | null> {
  const config = await pdf.getOptionalContentConfig();
  const order = config.getOrder() as OrderItem[] | null;
  if (!order?.length) return null;
  const rows: LayerRow[] = [];
  const listed = new Set<string>();
  const walk = (items: OrderItem[], depth: number) => {
    for (const item of items) {
      if (typeof item === 'string') {
        const group = config.getGroup(item);
        if (!group || listed.has(item)) continue;
        listed.add(item);
        rows.push({ kind: 'layer', id: item, name: group.name ?? null, depth, radio: (group.rbGroups?.length ?? 0) > 0 });
      } else if (item.name === null) {
        // pdf.js puts layers that are missing from /Order (or nested without a label) here; list them at this level
        walk(item.order, depth);
      } else {
        rows.push({ kind: 'heading', name: item.name, depth });
        walk(item.order, depth + 1);
      }
    }
  };
  walk(order, 0);
  if (!rows.some((r) => r.kind === 'layer')) return null;
  return { config, rows, initial: layerState(config) };
}

export function layerState(config: LayerConfig): LayerState {
  const state: LayerState = {};
  for (const [id, group] of config) state[id] = group.visible;
  return state;
}

/** Applies saved visibility (unknown ids are ignored). Radio groups are not re-balanced: the state is taken as saved. */
export function applyLayerState(config: LayerConfig, state: LayerState) {
  for (const [id] of config) if (id in state) config.setVisibility(id, state[id], false);
}

/** Visibility by layer name, to carry choices over when a document is reloaded with new object numbers. */
export function stateByName(layers: Layers): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of layers.rows) if (r.kind === 'layer' && r.name && r.id) out[r.name] = layers.config.getGroup(r.id)!.visible;
  return out;
}

export function applyByName(layers: Layers, byName: Record<string, boolean>) {
  for (const r of layers.rows) if (r.kind === 'layer' && r.name && r.id && r.name in byName) layers.config.setVisibility(r.id, byName[r.name], false);
}

/** pdf.js ids are `"<num>R"` or `"<num>R<gen>"`. */
function refFromId(id: string): PDFRef | null {
  const m = id.match(/^(\d+)R(\d*)$/);
  return m ? PDFRef.of(Number(m[1]), m[2] ? Number(m[2]) : 0) : null;
}

/**
 * Makes `state` the document's default layer visibility (/OCProperties /D: /BaseState /ON, /ON, /OFF),
 * so other readers (and printing) show the same layers. Ids must come from the same bytes `doc` was loaded from.
 */
export function writeDefaultLayerState(doc: PDFDocument, state: LayerState) {
  const props = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  const d = props?.lookupMaybe(PDFName.of('D'), PDFDict);
  if (!props || !d) return;
  const on: PDFRef[] = [];
  const off: PDFRef[] = [];
  for (const [id, visible] of Object.entries(state)) {
    const ref = refFromId(id);
    if (ref) (visible ? on : off).push(ref);
  }
  d.set(PDFName.of('BaseState'), PDFName.of('ON'));
  d.set(PDFName.of('ON'), doc.context.obj(on));
  d.set(PDFName.of('OFF'), doc.context.obj(off));
  // /AS entries could switch layers again on view or print; our choice is explicit, so drop them
  d.delete(PDFName.of('AS'));
}

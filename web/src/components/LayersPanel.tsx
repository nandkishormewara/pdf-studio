import { useT } from '../i18n';
import type { Layers } from '../sdk/layers';

interface Props {
  layers: Layers;
  /** changes whenever a layer is switched, so the list re-reads visibility */
  hash: string;
  onToggle: (id: string, visible: boolean) => void;
  onAll: (visible: boolean) => void;
  onReset: () => void;
  keepInFile: boolean;
  onKeepInFile: (keep: boolean) => void;
}

/** The document's layers (optional content), in its own order, with headings and radio groups. */
export function LayersPanel({ layers, hash, onToggle, onAll, onReset, keepInFile, onKeepInFile }: Props) {
  const t = useT();
  const count = layers.rows.filter((r) => r.kind === 'layer').length;
  return (
    <div className="panel layers-panel" data-hash={hash}>
      <div className="panel-head">
        <strong>{t('Layers')}</strong>
        <span className="muted">{t('{n} layer(s)', { n: count })}</span>
      </div>
      <div className="layers-actions">
        <button type="button" onClick={() => onAll(true)}>{t('Show all')}</button>
        <button type="button" onClick={() => onAll(false)}>{t('Hide all')}</button>
        <button type="button" onClick={onReset}>{t('Reset')}</button>
      </div>
      <ul className="layers-list" aria-label={t('Layers')}>
        {layers.rows.map((r, i) =>
          r.kind === 'heading' ? (
            <li key={`h${i}`} className="layer-heading" style={{ paddingInlineStart: r.depth * 16 }}>{r.name}</li>
          ) : (
            <li key={r.id} style={{ paddingInlineStart: r.depth * 16 }}>
              <label>
                <input
                  type="checkbox"
                  checked={layers.config.getGroup(r.id!)?.visible ?? true}
                  onChange={(e) => onToggle(r.id!, e.target.checked)}
                />
                <span>{r.name ?? t('Unnamed layer')}</span>
                {r.radio && <span className="muted layer-note">{t('one of a group')}</span>}
              </label>
            </li>
          ),
        )}
      </ul>
      <label className="layers-keep">
        <input type="checkbox" checked={keepInFile} onChange={(e) => onKeepInFile(e.target.checked)} />
        <span>{t('Save these choices in downloaded PDFs')}</span>
      </label>
      <p className="muted layers-hint">{t('Printing always uses the layers shown here. Search still finds text on hidden layers.')}</p>
    </div>
  );
}

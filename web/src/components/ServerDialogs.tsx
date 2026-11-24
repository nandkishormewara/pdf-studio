import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { defaultLanguages } from '../sdk/server';
import type { ServerHealth, SignatureCheck } from '../sdk/server';
import { useT } from '../i18n';

const LANG_NAMES: Record<string, string> = {
  eng: 'English', hin: 'Hindi', mar: 'Marathi', guj: 'Gujarati', ben: 'Bengali', tam: 'Tamil', tel: 'Telugu',
  kan: 'Kannada', mal: 'Malayalam', pan: 'Punjabi', urd: 'Urdu', san: 'Sanskrit', ori: 'Odia', asm: 'Assamese',
  nep: 'Nepali', ara: 'Arabic', fra: 'French', deu: 'German', spa: 'Spanish', chi_sim: 'Chinese (Simplified)',
  jpn: 'Japanese', kor: 'Korean', rus: 'Russian',
};
const FEATURED = ['eng', 'hin', 'mar', 'guj', 'ben', 'tam', 'tel', 'kan', 'mal', 'pan', 'urd', 'san'];

export function Modal({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose: () => void; actions: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions"><span className="spacer" />{actions}</div>
      </div>
    </div>
  );
}

function LanguagePicker({ health, value, onChange }: { health: ServerHealth; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const langs = health.ocrLanguages;
  const shown = showAll ? langs : langs.filter((l) => FEATURED.includes(l) || value.includes(l));
  return (
    <fieldset className="lang-picker">
      <legend>{t('Document languages')}</legend>
      <div className="lang-grid">
        {shown.map((l) => (
          <label key={l}>
            <input type="checkbox" checked={value.includes(l)}
              onChange={(e) => onChange(e.target.checked ? [...value, l] : value.filter((x) => x !== l))} />
            {LANG_NAMES[l] ?? l}
          </label>
        ))}
      </div>
      {!showAll && langs.length > shown.length && (
        <button className="linkish" onClick={() => setShowAll(true)}>{t('Show all {n} languages', { n: langs.length })}</button>
      )}
    </fieldset>
  );
}


// ------------------------------------------------------------------ OCR

export function OcrDialog({ health, pageCount, onRun, onClose }: {
  health: ServerHealth; pageCount: number; onClose: () => void;
  onRun: (languages: string[], force: boolean) => void;
}) {
  const t = useT();
  const [langs, setLangs] = useState(() => defaultLanguages(health));
  const [force, setForce] = useState(false);
  return (
    <Modal title={t('Recognise text (OCR)')} onClose={onClose} actions={<>
      <button onClick={onClose}>{t('Cancel')}</button>
      <button className="primary" disabled={!langs.length} onClick={() => onRun(langs, force)}>{t('Recognise text')}</button>
    </>}>
      <p>{t('Adds an invisible text layer to scanned pages so they can be searched, selected, highlighted and copied. The page images are not changed.')}</p>
      <LanguagePicker health={health} value={langs} onChange={setLangs} />
      <label className="check-row">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        {t('Also process pages that already contain text (all {n} pages)', { n: pageCount })}
      </label>
    </Modal>
  );
}

// ------------------------------------------------------------------ redaction

export function RedactDialog({ health, marks, pages, onRun, onClose }: {
  health: ServerHealth; marks: number; pages: number[]; onClose: () => void;
  onRun: (opts: { sanitize: boolean; ocrLanguages: string[] }) => void;
}) {
  const t = useT();
  const [sanitize, setSanitize] = useState(true);
  const [ocr, setOcr] = useState(health.features.ocr);
  const [langs, setLangs] = useState(() => defaultLanguages(health));
  return (
    <Modal title={t('Apply redactions')} onClose={onClose} actions={<>
      <button onClick={onClose}>{t('Cancel')}</button>
      <button className="primary danger-bg" onClick={() => onRun({ sanitize, ocrLanguages: ocr ? langs : [] })}>
        {t('Permanently redact')}
      </button>
    </>}>
      <p className="warning">
        {t('{n} marked area(s) on page(s) {pages} will be permanently removed: text, images and drawings underneath are deleted from the file, not just covered.', { n: marks, pages: pages.map((p) => p + 1).join(', ') })}
      </p>
      <p className="muted">{t('Redacted pages are converted to images. Annotations and form fields touching a marked area are removed.')}</p>
      <label className="check-row">
        <input type="checkbox" checked={sanitize} onChange={(e) => setSanitize(e.target.checked)} />
        {t('Also remove hidden information (document properties, metadata, scripts, attachments)')}
      </label>
      {health.features.ocr && (
        <>
          <label className="check-row">
            <input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />
            {t('Keep the rest of the redacted pages searchable (OCR)')}
          </label>
          {ocr && <LanguagePicker health={health} value={langs} onChange={setLangs} />}
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ digital signature

export interface SignChoice {
  signerName: string;
  reason: string;
  location: string;
  placement: 'visible' | 'invisible' | `field:${string}`;
  useHandwritten: boolean;
  certify: boolean;
}

export function SignDialog({ health, author, emptyFields, hasHandwritten, willInvalidate, currentPage, onRun, onClose }: {
  health: ServerHealth; author: string; emptyFields: string[]; hasHandwritten: boolean; willInvalidate: boolean;
  currentPage: number; onRun: (c: SignChoice) => void; onClose: () => void;
}) {
  const t = useT();
  const [c, setC] = useState<SignChoice>({
    signerName: author, reason: 'I approve this document', location: '',
    placement: emptyFields.length ? `field:${emptyFields[0]}` : 'visible', useHandwritten: hasHandwritten, certify: false,
  });
  const set = (p: Partial<SignChoice>) => setC((v) => ({ ...v, ...p }));
  return (
    <Modal title={t('Sign digitally')} onClose={onClose} actions={<>
      <button onClick={onClose}>{t('Cancel')}</button>
      <button className="primary" onClick={() => onRun(c)}>{t('Sign and download')}</button>
    </>}>
      <p>{t('Creates a tamper-evident PAdES signature with the server\'s certificate. Any later change to the file is detected.')}</p>
      {health.signer.development && (
        <p className="warning">{t('The server is using a development certificate ({subject}). Other people\'s PDF readers will show the signature as "not trusted" until an organisation certificate is configured.', { subject: health.signer.subject })}</p>
      )}
      {willInvalidate && (
        <p className="warning">{t('This document already has a digital signature and has been changed. Saving creates a new file, so the existing signatures won\'t validate. Sign the original, unchanged file to keep them.')}</p>
      )}
      <div className="form-grid">
        <label>{t('Name')}<input value={c.signerName} onChange={(e) => set({ signerName: e.target.value })} /></label>
        <label>{t('Reason')}<input value={c.reason} onChange={(e) => set({ reason: e.target.value })} /></label>
        <label>{t('Location')}<input value={c.location} placeholder={t('e.g. London')} onChange={(e) => set({ location: e.target.value })} /></label>
        <label>{t('Placement')}
          <select value={c.placement} onChange={(e) => set({ placement: e.target.value as SignChoice['placement'] })}>
            {emptyFields.map((f) => <option key={f} value={`field:${f}`}>{t('In signature field "{name}"', { name: f })}</option>)}
            <option value="visible">{t('Visible box, bottom-right of page {n}', { n: currentPage + 1 })}</option>
            <option value="invisible">{t('Invisible (signature panel only)')}</option>
          </select>
        </label>
      </div>
      {c.placement !== 'invisible' && (
        <label className="check-row">
          <input type="checkbox" disabled={!hasHandwritten} checked={c.useHandwritten && hasHandwritten}
            onChange={(e) => set({ useHandwritten: e.target.checked })} />
          {hasHandwritten ? t('Show my handwritten signature in the box') : t('Show my handwritten signature in the box (create one with the Signature tool first)')}
        </label>
      )}
      <label className="check-row">
        <input type="checkbox" checked={c.certify} onChange={(e) => set({ certify: e.target.checked })} />
        {t('Certify: lock the document (only form filling stays allowed)')}
      </label>
      {health.signer.timestamping && <p className="muted">{t('A trusted timestamp is added (PAdES B-T).')}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ verification

export function VerifyDialog({ load, certificateUrl, development, onClose }: {
  load: () => Promise<SignatureCheck[]>; certificateUrl: string; development: boolean; onClose: () => void;
}) {
  const t = useT();
  const [result, setResult] = useState<SignatureCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load().then(setResult, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  return (
    <Modal title={t('Signatures')} onClose={onClose} actions={<button className="primary" onClick={onClose}>{t('Close')}</button>}>
      {error && <p className="warning">{error}</p>}
      {!result && !error && <p className="muted">{t('Checking signatures…')}</p>}
      {result?.length === 0 && <p>{t('This document has no digital signatures.')}</p>}
      <ol className="sig-list">
        {result?.map((s) => {
          const state = !s.intact || !s.valid ? 'bad' : !s.trusted ? 'warn' : s.coverage === 'ENTIRE_FILE' ? 'good' : 'warn';
          const headline = t(!s.intact ? 'Document was altered after signing — signature is broken'
            : !s.valid ? 'Signature is not valid'
              : !s.trusted ? 'Valid, but the signer\'s certificate is not trusted'
                : s.coverage === 'ENTIRE_FILE' ? 'Valid and trusted'
                  : 'Valid; the document was changed after this signature');
          return (
            <li key={s.field} className={`sig ${state}`}>
              <div className="sig-head"><span className="dot" />{headline}</div>
              <dl>
                {s.signer && <><dt>{t('Signed by')}</dt><dd>{s.signer}</dd></>}
                {s.signed_at && <><dt>{t('Time')}</dt><dd>{new Date(s.signed_at).toLocaleString()}{s.timestamped ? ` (${t('timestamped')})` : ''}</dd></>}
                {s.reason && <><dt>{t('Reason')}</dt><dd>{s.reason}</dd></>}
                {s.location && <><dt>{t('Location')}</dt><dd>{s.location}</dd></>}
                {s.modification_level && s.coverage !== 'ENTIRE_FILE' && <><dt>{t('Later changes')}</dt><dd>{s.modification_level.toLowerCase().replace(/_/g, ' ')}</dd></>}
                <dt>{t('Field')}</dt><dd>{s.field}</dd>
                {s.error && <><dt>{t('Error')}</dt><dd>{s.error}</dd></>}
              </dl>
            </li>
          );
        })}
      </ol>
      {development && !!result?.length && (
        <p className="muted">{t('"Trusted" means trusted by this server, which trusts its own development certificate. Acrobat and other readers will not trust it unless you')} <a href={certificateUrl}>{t('add the certificate')}</a> {t('to their trusted list.')}</p>
      )}
      {!development && result?.some((s) => !s.trusted) && (
        <p className="muted">{t('Testing with the development certificate?')} <a href={certificateUrl}>{t('Download it')}</a> {t('and add it as a trusted certificate in your PDF reader.')}</p>
      )}
    </Modal>
  );
}

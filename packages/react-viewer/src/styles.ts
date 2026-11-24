import css from './styles.css?inline';

let injected = false;

/** Adds the viewer's stylesheet once per page, so host apps don't need a CSS import. */
export function injectStyles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.dataset.pdfStudioViewer = '';
  el.textContent = css;
  document.head.appendChild(el);
}

/**
 * Kept for compatibility with the PDFTron package. PDF Studio's viewer has no such UI elements:
 * `mode="view"` already hides tools, download, print and save.
 */
export const VIEW_MODE_DISABLED_ELEMENTS = [
  'toolbarGroup-Annotate',
  'toolbarGroup-Shapes',
  'toolbarGroup-Insert',
  'toolbarGroup-Edit',
  'toolbarGroup-FillAndSign',
  'toolbarGroup-Forms',
  'toolbarGroup-Redact',
  'toolbarGroup-Measure',
  'ribbons',
  'toolsHeader',
  'annotationPopup',
  'annotationStylePopup',
  'textPopup',
  'contextMenuPopup',
  'downloadButton',
  'printButton',
  'saveAsButton',
  'filePickerButton',
  'menuButton',
] as const;

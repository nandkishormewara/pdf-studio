# User guide

**For people using PDF Studio** (reviewers, office staff, readers) and anyone training them. The web app is described first; apps that embed the iPhone / iPad and Android SDKs are at the end.

## Opening documents

- Click **Open** and choose a PDF, or drag a file anywhere onto the window.
- **Word, Excel, PowerPoint, OpenDocument, RTF, HTML and text files** are converted to PDF on the
  PDF Studio server, and then opened. This needs the server; see *Tools* below.
- Choosing **one or more images** (JPG, PNG, WebP, GIF, BMP…) converts them into a new PDF, one image per page.
- Password-protected PDFs ask for the password when opened.
- **Try a sample document** opens a built-in four-page file with text, a floor-plan box, links and a form.
- **Open from link…** opens a PDF from a web address. Large files show their first pages within seconds while the rest
  downloads; *Downloading N%* appears next to the file name until it is complete. You can read and draw meanwhile.
  Saving, page changes and the Tools menu wait until the download is complete. Only links from your organisation's
  own sites are accepted.

If the PDF already contains annotations made in Acrobat, Chrome, Preview or PDF Studio, they are
imported and become editable. A message tells you how many were found.

Your work is saved automatically in the browser for each document. Reopening the same file restores
its annotations and form entries. Nothing is uploaded anywhere.

## Viewing

| Action | How |
|---|---|
| Zoom | **−** / **+**, the zoom menu, or Ctrl/⌘ + / − |
| Fit to window width / whole page | The fit-width and fit-page buttons |
| Go to a page | Type the number in the page box and press Enter, click a thumbnail, or use the ‹ › buttons |
| Next / previous page | Page Down / Page Up; in single and two-page layouts also → / ← |
| Page layout | **Page layout** menu: *Continuous scroll*, *Single page*, *Two pages side by side*; *First page alone (cover)*; *Right-to-left page order* (for Arabic and Urdu books). Remembered in this browser |
| Screen language | The language list in the top bar: English, हिन्दी, العربية, Bahasa Melayu. Arabic mirrors the screen; pages are never mirrored |
| Show or hide thumbnails | ☰ button at the top left |
| Light / dark theme | Sun / moon button at the top right |
| Follow a link | Click it (Select tool). Internal links jump to their page; web links open in a new tab |

## Layers

Some PDFs (drawings, maps, worksheets with an answer key) have **layers**: parts of the page that can be shown or hidden. When a
document has layers, a stack button appears next to the comments button.

- Tick or untick a layer to show or hide it on the pages and thumbnails. Headings (such as *Dimensions*) group layers.
- Layers marked *one of a group* work like radio buttons: switching one on switches the others in its group off.
- **Show all**, **Hide all**, and **Reset** (back to how the document opens).
- Your choices are remembered for that document in this browser.
- **Printing** always prints the layers you see.
- Tick **Save these choices in downloaded PDFs** to make your choice the downloaded file's default, so Acrobat and other
  readers open it the same way. Without it, downloads keep the document's own defaults.
- Search still finds words on hidden layers.

Try it: open the sample document; page 1 has a floor plan with Walls, Furniture, Electrical and Metric / Imperial
dimension layers.

## Searching

Press **Ctrl/⌘ F** or click the magnifier. Options:

- **Match case** — `PDF` won't match `pdf`.
- **Whole word** — `form` won't match `format`.
- **Regex** — regular expressions, e.g. `\d{10}` for 10-digit numbers.

Phrases are found even when they wrap onto the next line. Enter / Shift+Enter step through results;
clicking a result jumps to it.

## Annotating

Pick a tool from the second toolbar row (or press its shortcut), then work on the page.

| Tool | Key | How to use |
|---|---|---|
| Select | V | Click an annotation to select it; drag to move; drag the corner handle to resize boxes |
| Highlight / Underline / Strikeout | H / U / K | Select text on the page with the mouse |
| Text box | T | Click (or drag a box), type, click outside or **Done** to finish. Double-click later to edit |
| Sticky note | N | Click to drop a note; the comment box opens on the right |
| Freehand | P | Draw |
| Rectangle / Ellipse / Line / Arrow | R / O / L / A | Drag |
| Stamp | S | Pick a label (APPROVED, REJECTED, DRAFT, स्वीकृत…) then click or drag |
| Signature | G | First time: draw or type your signature. Then click or drag to place it |

**Styling:** choose a colour, opacity and line width before drawing, or select an existing annotation
and change them. Text boxes also have a font size; stamps can switch label.

### Bold, italic, underline and colour in a text box

While typing in a text box (or after double-clicking one), a small bar appears above it. Select some words and click
**B**, **I** or **U**, or one of the colour swatches, or press Ctrl/⌘ B, I or U. Click **Done** or press Esc to finish.
The styling is saved in the PDF in the format Acrobat and Apryse use, and in XFDF exports.

**Delete:** select and press Delete/Backspace, or use the bin button. **Undo/Redo:** Ctrl/⌘ Z and
Ctrl/⌘ Shift Z.

**Author name:** set it in the *Author* box on the right of the toolbar; it is stored with each annotation.

### Comments and review

Click the speech-bubble button to open the annotations panel. For each annotation you can:

- add or edit a comment,
- set a review status — *Accepted*, *Rejected* or *Completed* (shown as a coloured edge),
- jump to it on the page, or delete it.

## Measuring

Measurement tools sit at the right end of the tool row.

| Tool | Key | How to use |
|---|---|---|
| Distance | M | Drag from one point to another |
| Perimeter | — | Click each corner; **double-click** to finish; Esc cancels |
| Area | — | Click each corner; **double-click** to close the shape |

**Setting the scale.** When a measurement tool or measurement is selected, a scale bar appears:
`1 in = 10 ft` means one inch on paper equals ten feet in reality. Choose paper units (in, cm, mm, pt),
real units (in, ft, yd, mi, mm, cm, m, km) and decimal places. Changing the scale while a measurement
is selected updates that measurement.

**Calibrating from a drawing.** If the drawing shows a known length (e.g. a 5 m wall):

1. Measure that wall with **Distance**.
2. With it selected, click **Calibrate…** and type `5` (the real length in the current real unit).
3. The scale is set so later measurements are correct.

## Filling forms

Form fields in a PDF appear as light-blue boxes. Use the **Select** tool and simply type, tick or choose.

- Text fields (single and multi-line), checkboxes, radio buttons, dropdowns and list boxes are supported.
- Hindi and other scripts can be typed.
- **Save ▸ Fill from JSON…** fills fields from a file such as `{"applicant.name": "Priya"}`.
- **Save ▸ Export form data (JSON)** saves all current values.
- **Save ▸ Reset edited fields** returns fields to the document's original values.
- Tick **Save ▸ Flatten form fields** before downloading if the result should no longer be editable.

## Organising pages

Hover a thumbnail to reveal its page buttons:

| Button | Action |
|---|---|
| ↺ / ↻ | Rotate the page left or right (annotations rotate with it) |
| + | Insert a blank page after this one |
| ⤓ | Download this single page as a PDF (with its annotations) |
| 🗑 | Delete the page (asks for confirmation; its annotations are deleted too) |

**Reorder** by dragging a thumbnail up or down; a blue line shows where it will land.

The **Insert** menu adds a blank page, all pages of another PDF, or images as new pages, after the
page you are currently viewing.

> Page changes can't be undone with Ctrl Z yet. To go back, reopen the original file.

## Saving, printing and sharing

Everything is under **Save**:

| Item | Result |
|---|---|
| Download with editable annotations | A PDF whose annotations can still be edited in Acrobat, Chrome, Preview or PDF Studio |
| Download flattened | Annotations are burned into the page and can no longer be changed |
| Print | Prints the document with annotations |
| Export XFDF | Annotations (and form data) in the standard exchange format used by Acrobat, Apryse and Foxit |
| Export JSON | PDF Studio's own lossless annotation format |
| Import XFDF or JSON… | Adds annotations (and XFDF form values) from a file |

## Extracting text, tables, images and fonts

*Save ▸ Extract text, tables, images and fonts…* opens a dialog:

1. **Pages:** all, the current page, or a range such as `1-3, 7`.
2. **Text:** *Plain text (.txt)* (with or without page headings), *Text with positions and fonts (.json)* for
   developers, or *Word list for Excel (.csv)*, one row per word with its page, line and position. *Reading order*
   (ticked by default) puts the text in the order you would read it: columns one after another, and each table row
   on one line with its cells separated by tabs. Untick it to get the order the file stores the text in.
3. **Tables:** finds the tables on the chosen pages and gives them as an *Excel workbook* (one sheet per table, merged
   cells kept), as *CSV* (one file per table) or as *JSON* for developers. It works for tables with lines and for
   tables whose columns are only lined up. Check the result: a cell whose text wraps onto two lines in a table without
   lines comes out as two rows.
4. **Images:** every picture in the file at its own resolution, as PNG (exact, keeps transparency) or JPEG (smaller).
   Tiny images such as bullets are skipped (the size limit can be changed).
5. **Fonts:** a list of the fonts used and, if ticked, the embedded font files. Fonts are usually licensed: reuse them
   only as their licence allows.
6. Click **Extract**. A single text or table file downloads directly; anything else comes as one ZIP file. **Stop** cancels.

Everything happens in your browser. If a page has no text, it is probably a scan: run *Tools ▸ Recognise text (OCR)*
first, then extract again. For Hindi and other Indian scripts in PDFs made by office programs, the text can come out
with broken words. The server's extraction reads those better (ask your administrator; see [API testing](api-testing.md#post-extract)).

## Tools (needs the PDF Studio server)

The **Tools** menu shows a green dot when the server is connected. If it says *not reachable*,
start the server (see [Server and deployment](server-and-deployment.md)) or enter its address under *Server address*.

### Optimise for the web

*Tools ▸ Optimise for web (fast first page)* downloads a copy arranged so its first page shows sooner when opened
from a link (a *linearized* PDF). *Optimise and shrink images (150 dpi)* also makes large scans much smaller.
Digitally signed documents are refused, because rewriting them would break the signature.

### Make scanned documents searchable (OCR)

*Tools ▸ Recognise text (OCR)…* adds an invisible text layer to scanned pages, so search, text
selection, highlighting and copying work there. Pick the languages used in the document. English
and Hindi are pre-selected; *Show all languages* lists 160+. Pages that already contain text are
skipped unless you tick *Also process pages that already contain text*. The page images are not
changed.

### Redaction (permanently removing content)

1. Choose the **Redact** tool (X, last tool in the row), or *Tools ▸ Mark areas for redaction*, and
   drag over what must be removed. Marks appear as red hatched boxes, and you can still move,
   resize or delete them.
2. To remove every occurrence of a word or number, search for it and click **Mark all N for redaction**
   in the search panel. These marks are matched to the exact letters, so the whole word is always
   covered.
3. Choose *Tools ▸ Apply redactions…*, review the options and click **Permanently redact**.

What happens:

- The content under each mark is **deleted from the file**. It is not just covered with a box, so it
  can't be copied, searched or recovered.
- Pages with marks are turned into images. With *Keep the rest of the redacted pages searchable* on,
  their remaining text is recognised again.
- Annotations and form fields touching a mark are removed.
- *Also remove hidden information* clears the title, author and other properties, metadata,
  scripts and attachments.

The redacted document opens in place as *name-redacted.pdf*. Use **Save** to download it. Keep the
original if you may need it, because redaction can't be undone.

### Digital signatures

*Tools ▸ Sign digitally…* creates a tamper-evident signature using the server's certificate:

- **Name, reason, location** are recorded in the signature.
- **Placement:** in an empty signature field of the form, as a visible box at the bottom-right of the
  current page, or invisible (listed only in the reader's signature panel).
- **Show my handwritten signature:** puts the signature you drew with the Signature tool into the box.
- **Certify:** locks the document; only form filling stays allowed.

The signed file is downloaded as *name-signed.pdf* and opened. A green banner shows that the document
is signed.

*Tools ▸ Verify signatures* (or the banner's button) checks every signature:

| Result | Meaning |
|---|---|
| Valid and trusted | Unchanged since signing, by a certificate the server trusts |
| Valid, but not trusted | Unchanged, but the certificate isn't from a trusted authority (e.g. the development certificate) |
| Valid; changed after this signature | Something was added later, e.g. another signature or form filling. The details say what kind |
| Altered after signing | **The signed content was modified.** Don't rely on this document |

> Editing a signed document (annotations, forms, pages) and saving creates a new file, which breaks
> the earlier signatures. To add another signature without breaking them, sign the document without
> changing it. PDF Studio then appends the new signature to the original file.

> While the server uses its **development certificate**, Acrobat and other readers will show
> signatures as "not trusted". See [Server and deployment](server-and-deployment.md#7-signing-certificates).

## Keyboard shortcuts

Everything can be done without a mouse. Press **Tab** once on a new page to see *Skip to document*.

| Keys | Action |
|---|---|
| Tab / Shift Tab | Move between controls and, with the Select tool, between annotations on the page |
| ← → ↑ ↓ (annotation focused) | Move it by one step; with Shift by ten |
| Enter (annotation focused) | Edit a text box, or open its comment |
| Enter / ↓ on a menu button, then ↑ ↓ Home End | Open a menu and move through it; Esc closes it |
| V H U K T N P R O L A S G M X | Select tools (see tables above; X = redact) |
| Esc | Back to Select / cancel a shape in progress |
| Delete, Backspace | Delete selected annotation |
| Ctrl/⌘ Z, Ctrl/⌘ Shift Z (or Ctrl Y) | Undo, redo |
| Ctrl/⌘ F | Search |
| Ctrl/⌘ +, Ctrl/⌘ − | Zoom |
| Page Down, Page Up | Next / previous page |
| Ctrl/⌘ B, I, U (editing a text box) | Bold, italic, underline |

## Troubleshooting

| Problem | What to do |
|---|---|
| The whole screen is mirrored or in another language | Choose the language in the top bar's language list |
| Only one page shows at a time | *Page layout ▸ Continuous scroll* |
| "Saving changes to encrypted PDFs is not supported" | Use **Print**, or remove the password with the owner's permission first |
| A form field shows a warning about characters the built-in font can't draw | The value is saved; PDF viewers draw it themselves. Flattening is skipped for that document |
| Annotations disappeared after clearing browser data | Autosave lives in the browser. Export JSON/XFDF or download the PDF to keep a copy |
| Text can't be highlighted | The page is a scanned image without a text layer. Run *Tools ▸ Recognise text (OCR)* first |
| Tools menu items are greyed out | The server isn't running or reachable. Check *Tools ▸ Server address* |
| "Couldn't convert" when opening a Word file | The file may be password-protected or damaged. Try opening and re-saving it in Word or LibreOffice |

## iPhone and iPad (apps using PDFStudioKit)

Apps that embed PDF Studio's iOS SDK use its viewer. It looks like the system's PDF viewer: scroll, pinch to zoom, rotate the device.

- **Read-only copies** show saved marks (for example a reviewer's marks on an answer sheet) on top of the document.
- In apps that allow editing, the tool bar offers highlight, underline, strikeout (select text first), text, note, pen,
  rectangle, ellipse, line, arrow, stamp, signature and redaction marks, with colour, undo and redo. Tap an annotation
  with *Select* to move it, comment on it, set its review status or delete it.
- Measurements made on the web are shown and kept, but can't be drawn on iOS yet.

## Android (apps using the pdfstudio library)

Apps that embed PDF Studio's Android SDK use its viewer.

- **Search** in the top bar: type, then ‹ › to step through results; the count shows how many.
- **Pages** opens thumbnails; tap one to jump.
- Where editing is allowed: long-press and drag over text to highlight, underline or strike it out; pen, highlighter
  pen and box tools draw on the page.
- Scanned pages can't be searched on Android; make them searchable on the web first (*Tools ▸ Recognise text*).

package com.pdfstudio.sdk

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.pdfstudio.sdk.pdf.AnnotationReader
import com.pdfstudio.sdk.pdf.AnnotationWriter
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.graphics.image.JPEGFactory
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.min

/**
 * Entry points that replace the PDFTron core calls used by apps:
 *
 * | PDFTron                                                            | PDF Studio                         |
 * |--------------------------------------------------------------------|------------------------------------|
 * | `PDFDoc(path).fdfMerge(FDFDoc.createFromXFDF(x)); save(out, …)`    | `PdfStudio.mergeXfdf(src, x, out)` |
 * | `PDFDoc(path).initSecurityHandler() && pageCount > 0`              | `PdfStudio.isValidPdf(file)`       |
 * | `Image.create` + `ElementBuilder.createImage` + `pageCreate(A4)`   | `PdfStudio.imagesToPdf(imgs, out)` |
 * | `DocumentActivity.openDocument(ctx, uri, ViewerConfig)`            | `PdfStudioViewer.open(ctx, uri, config)` |
 */
object PdfStudio {
    @Volatile private var initialised = false

    /** Call once (e.g. in Application.onCreate). Safe to call again. */
    fun init(context: Context) {
        if (initialised) return
        PDFBoxResourceLoader.init(context.applicationContext)
        assets = context.applicationContext.assets
        initialised = true
    }

    private var assets: android.content.res.AssetManager? = null

    /**
     * Liberation Sans (bundled with PdfBox-Android): the same letter widths as Helvetica / Arial, which Apryse
     * WebViewer, the web and iOS draw typed comments with. Android's default (Roboto) is narrower, so text would
     * end short of where teachers placed arrows and marks. Null before [init].
     */
    internal val helvetica: android.graphics.Typeface? by lazy {
        assets?.let { runCatching { android.graphics.Typeface.createFromAsset(it, "com/tom_roush/pdfbox/resources/ttf/LiberationSans-Regular.ttf") }.getOrNull() }
    }

    /** A readable, unencrypted-or-openable PDF with at least one page. */
    fun isValidPdf(file: File): Boolean {
        if (!file.isFile || file.length() < 8) return false
        val header = file.inputStream().use { s -> ByteArray(1024).let { b -> val n = s.read(b); String(b, 0, max(0, n), Charsets.ISO_8859_1) } }
        if ("%PDF-" !in header) return false
        return runCatching { PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly()).use { it.numberOfPages > 0 } }.getOrDefault(false)
    }

    /** Each page's text with a box per character, in page units (what the viewer searches and selects). */
    fun extractText(file: File): List<PageText> = com.pdfstudio.sdk.pdf.TextExtractor.extract(file)

    /**
     * The text as plain text, with "===== Page n =====" headings (same as the web SDK and the server).
     * [readingOrder]: columns one after another (default); false keeps the order the file draws the text.
     */
    fun extractPlainText(file: File, pageMarkers: Boolean = true, readingOrder: Boolean = true): String =
        TextExport.plain(extractText(file), pageMarkers, readingOrder)

    /** The text as lines and words with boxes and fonts, in the web SDK's `pdf-studio-text` JSON. */
    fun extractTextJson(file: File, fileName: String = file.name, readingOrder: Boolean = true): String =
        TextExport.json(extractText(file), fileName, readingOrder)

    /** Case-insensitive search over the whole document; each hit carries one rect per line, in page units. */
    fun search(file: File, query: String): List<SearchHit> = TextSearch.find(extractText(file), query)

    /**
     * Merges XFDF (e.g. reviewer markup from Apryse WebViewer or the web SDK) into a copy of the PDF.
     *
     * @param flatten false (default) writes real, editable PDF annotations — like PDFTron's fdfMerge;
     *                true draws them into the page content (permanent, shows in any viewer).
     * @return the number of annotations written. On a malformed XFDF this throws; callers that
     *         previously fell back to the plain PDF on failure can keep doing so.
     */
    fun mergeXfdf(source: File, xfdf: String, output: File, flatten: Boolean = false): Int {
        PDDocument.load(source, MemoryUsageSetting.setupTempFileOnly()).use { doc ->
            val geometries = (0 until doc.numberOfPages).map { AnnotationWriter.geometry(doc.getPage(it)) }
            val imp = Xfdf.parse(xfdf) { geometries.getOrNull(it) }
            // Annotations already in the file that the XFDF modifies or deletes are replaced.
            val existing = AnnotationReader.extract(doc, remove = true)
            val merged = Xfdf.merge(existing, imp)
            AnnotationWriter.write(doc, merged, if (flatten) AnnotationWriter.Mode.FLATTEN else AnnotationWriter.Mode.EDITABLE)
            output.parentFile?.mkdirs()
            FileOutputStream(output).use { doc.save(it) }
            return merged.size
        }
    }

    /** Annotations in a PDF (ours and other apps'), without modifying the file. */
    fun readAnnotations(file: File): List<Annotation> =
        PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly()).use { AnnotationReader.extract(it, remove = false) }

    /** Writes a copy of `source` with `annotations` added (editable or flattened). */
    fun writeAnnotations(source: File, annotations: List<Annotation>, output: File, flatten: Boolean = false) {
        PDDocument.load(source, MemoryUsageSetting.setupTempFileOnly()).use { doc ->
            AnnotationWriter.write(doc, annotations, if (flatten) AnnotationWriter.Mode.FLATTEN else AnnotationWriter.Mode.EDITABLE)
            FileOutputStream(output).use { doc.save(it) }
        }
    }

    /**
     * Writes a copy of `source` with its pages rotated, deleted and moved by [ops] (applied in order; see [PageOp]),
     * and returns the document's annotations as they now stand. The annotations PDF Studio can edit (its own and other
     * apps' markup) are read from the file, re-mapped to the new page order and orientation, and written back editable;
     * pass [annotations] to write those instead (for example marks kept outside the file). Links and form fields stay
     * on their pages. The model side alone is [PageEdits.apply].
     *
     * @throws IllegalArgumentException for a page number out of range, or deleting every page.
     */
    fun editPages(source: File, output: File, ops: List<PageOp>, annotations: List<Annotation>? = null): List<Annotation> {
        PDDocument.load(source, MemoryUsageSetting.setupTempFileOnly()).use { doc ->
            val geometries = (0 until doc.numberOfPages).map { AnnotationWriter.geometry(doc.getPage(it)) }
            val inFile = AnnotationReader.extract(doc, remove = true)
            val result = PageEdits.apply(geometries, annotations ?: inFile, ops)
            com.pdfstudio.sdk.pdf.PageWriter.apply(doc, result.pages)
            AnnotationWriter.write(doc, result.annotations, AnnotationWriter.Mode.EDITABLE)
            output.parentFile?.mkdirs()
            FileOutputStream(output).use { doc.save(it) }
            return result.annotations
        }
    }

    /** The PDF's fillable form fields (text, checkbox, radio, dropdown, list) with their current values. */
    fun readFormFields(file: File): List<FormField> = com.pdfstudio.sdk.pdf.FormFields.read(file)

    /**
     * Writes a copy of `source` with form `values` (field name → value) filled in; see [FormField] for the value of each
     * kind. Read-only and unknown fields are skipped. Returns how many fields changed. With `flatten`, the filled fields
     * become page content and can no longer be edited.
     */
    fun fillForm(source: File, values: Map<String, String>, output: File, flatten: Boolean = false): Int =
        com.pdfstudio.sdk.pdf.FormFields.fill(source, values, output, flatten)

    /** Exports a PDF's annotations as XFDF. */
    fun exportXfdf(file: File): String = PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly()).use { doc ->
        val geometries = (0 until doc.numberOfPages).map { AnnotationWriter.geometry(doc.getPage(it)) }
        Xfdf.export(AnnotationReader.extract(doc, remove = false), { geometries.getOrNull(it) })
    }

    data class PageSpec(val width: Float = PDRectangle.A4.width, val height: Float = PDRectangle.A4.height, val margin: Float = 20f)

    /**
     * One page per image, image centred inside the margin keeping its aspect ratio.
     * Images are downsampled to `maxEdgePx` and stored as JPEG (`quality` 0–1) to keep uploads small.
     * Defaults match the homework upload flow (A4, 20 pt margin, 2048 px, q≈0.84).
     */
    fun imagesToPdf(images: List<File>, output: File, page: PageSpec = PageSpec(), maxEdgePx: Int = 2048, quality: Float = 0.84f): File {
        require(images.isNotEmpty()) { "No images" }
        PDDocument().use { doc ->
            for (file in images) {
                val bmp = decodeDownsampled(file, maxEdgePx) ?: error("Can't read image ${file.name}")
                val img = JPEGFactory.createFromImage(doc, bmp, quality)
                bmp.recycle()
                val p = PDPage(PDRectangle(page.width, page.height))
                doc.addPage(p)
                val boxW = page.width - 2 * page.margin; val boxH = page.height - 2 * page.margin
                val scale = min(boxW / img.width, boxH / img.height)
                val w = img.width * scale; val h = img.height * scale
                PDPageContentStream(doc, p).use { it.drawImage(img, (page.width - w) / 2, (page.height - h) / 2, w, h) }
            }
            output.parentFile?.mkdirs()
            FileOutputStream(output).use { doc.save(it) }
        }
        return output
    }

    private fun decodeDownsampled(file: File, maxEdge: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
        val bmp = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val longest = max(bmp.width, bmp.height)
        if (longest <= maxEdge) return bmp
        val f = maxEdge.toFloat() / longest
        return Bitmap.createScaledBitmap(bmp, (bmp.width * f).toInt(), (bmp.height * f).toInt(), true).also { if (it !== bmp) bmp.recycle() }
    }
}

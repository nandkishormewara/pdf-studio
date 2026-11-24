package com.pdfstudio.sdk

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs

/** Runs on a device/emulator: real PdfBox-Android writing and Android's PdfRenderer reading. */
@RunWith(AndroidJUnit4::class)
class PdfStudioDeviceTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val assets = InstrumentationRegistry.getInstrumentation().context.assets
    private val dir = File(ctx.cacheDir, "test").apply { mkdirs() }

    @Before fun setUp() = PdfStudio.init(ctx)

    private fun asset(name: String) = assets.open(name).bufferedReader().readText()

    private fun samplePdf(pages: Int = 2, rotation: Int = 0): File {
        val f = File(dir, "plain-$pages-$rotation.pdf")
        PDDocument().use { doc ->
            repeat(pages) { i ->
                val p = PDPage(PDRectangle(612f, 792f)).apply { this.rotation = rotation }
                doc.addPage(p)
                PDPageContentStream(doc, p).use { cs ->
                    cs.beginText(); cs.setFont(PDType1Font.HELVETICA, 14f); cs.newLineAtOffset(72f, 700f)
                    cs.showText("Sample page ${i + 1}"); cs.endText()
                }
            }
            doc.save(f)
        }
        return f
    }

    private fun close(a: Double, b: Double, what: String, tol: Double = 0.05) = assertTrue("$what: $a != $b", abs(a - b) <= tol)

    @Test fun mergeApryseXfdfIntoPdf() {
        val out = File(dir, "merged.pdf")
        val n = PdfStudio.mergeXfdf(samplePdf(), asset("xfdf/apryse-annots.xfdf"), out)
        assertEquals(11, n)
        assertTrue(PdfStudio.isValidPdf(out))
        val back = PdfStudio.readAnnotations(out).associateBy { it.id }
        assertEquals(11, back.size)
        assertEquals("Good work! अच्छा", back.getValue("f-ft-1").text)
        assertEquals(AnnotationKind.SIGNATURE, back.getValue("f-sig-1").kind)
        val ink = back.getValue("f-ink-1").paths!!.first().first()
        close(ink.x, 100.0, "ink x"); close(ink.y, 192.0, "ink y")
        // Every written annotation carries an appearance stream, so any PDF viewer shows it.
        PDDocument.load(out).use { doc ->
            doc.getPage(0).annotations.forEach { assertTrue(it.subtype, it.cosObject.containsKey(COSName.AP)) }
        }
        // Command-format XFDF applied on top of the merged file.
        val out2 = File(dir, "merged2.pdf")
        PdfStudio.mergeXfdf(out, asset("xfdf/apryse-commands.xfdf"), out2)
        val ids = PdfStudio.readAnnotations(out2).map { it.id }.toSet()
        assertTrue("c-box-1" in ids); assertFalse("f-oval-1" in ids)
    }

    @Test fun editableRoundTripIsLossless() {
        val sample = AnnotationJson.decodeFile(asset("annotations.sample.json"))
        val out = File(dir, "editable.pdf")
        PdfStudio.writeAnnotations(samplePdf(), sample, out)
        val back = PdfStudio.readAnnotations(out).associateBy { it.id }
        for (a in sample) assertEquals(a.kind.json, a, back[a.id])
    }

    @Test fun importsAnnotationsWrittenByOtherApps() {
        val sample = AnnotationJson.decodeFile(asset("annotations.sample.json"))
        val written = File(dir, "foreign-src.pdf")
        PdfStudio.writeAnnotations(samplePdf(rotation = 90), sample, written)
        val foreign = File(dir, "foreign.pdf")
        PDDocument.load(written).use { doc ->
            doc.pages.forEach { p -> p.annotations.forEach { it.cosObject.removeItem(COSName.getPDFName("PDFStudio")) } }
            doc.save(foreign)
        }
        val back = PdfStudio.readAnnotations(foreign)
        val kinds = back.map { it.kind }.toSet()
        for (k in listOf(AnnotationKind.HIGHLIGHT, AnnotationKind.UNDERLINE, AnnotationKind.STRIKEOUT, AnnotationKind.RECT,
            AnnotationKind.ELLIPSE, AnnotationKind.LINE, AnnotationKind.ARROW, AnnotationKind.INK, AnnotationKind.FREETEXT, AnnotationKind.NOTE))
            assertTrue("missing $k", k in kinds)
        val orig = sample.associateBy { it.id }
        back.filter { it.kind in setOf(AnnotationKind.RECT, AnnotationKind.HIGHLIGHT, AnnotationKind.ARROW, AnnotationKind.INK) }.forEach { a ->
            val o = orig.getValue(a.id)
            close(a.bounds.x, o.bounds.x, "${a.kind} x", 1.5); close(a.bounds.y, o.bounds.y, "${a.kind} y", 1.5)
        }
        assertEquals("Reviewed by User3\nशुल्क जमा", back.first { it.kind == AnnotationKind.FREETEXT }.text)
    }

    @Test fun flattenedMarkupIsVisibleToPdfRenderer() {
        val out = File(dir, "flat.pdf")
        PdfStudio.mergeXfdf(samplePdf(), asset("xfdf/apryse-annots.xfdf"), out, flatten = true)
        assertEquals(0, PdfStudio.readAnnotations(out).size)
        val bmp = renderPage(out, 0)
        // The red box f-box-1 (PDF 300,500–420,560) — check a pixel on its left edge is red-ish.
        val scale = bmp.width / 612f
        val px = bmp.getPixel((300 * scale).toInt(), ((792 - 530) * scale).toInt())
        assertTrue("expected red, got #${Integer.toHexString(px)}", Color.red(px) > 150 && Color.green(px) < 120)
    }

    @Test fun imagesToPdfMatchesHomeworkLayout() {
        val img = File(dir, "photo.jpg")
        Bitmap.createBitmap(3000, 2000, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
            .compress(Bitmap.CompressFormat.JPEG, 90, img.outputStream())
        val out = PdfStudio.imagesToPdf(listOf(img, img), File(dir, "hw.pdf"))
        PDDocument.load(out).use { doc ->
            assertEquals(2, doc.numberOfPages)
            assertEquals(PDRectangle.A4.width, doc.getPage(0).mediaBox.width, 0.01f)
        }
        val bmp = renderPage(out, 0)
        assertEquals(Color.WHITE, bmp.getPixel(2, 2))                    // margin stays white
        assertTrue(Color.blue(bmp.getPixel(bmp.width / 2, bmp.height / 2)) > 200) // image centred
        assertTrue("downsampled + JPEG: ${out.length()} bytes", out.length() < 400_000)
    }

    @Test fun validity() {
        assertTrue(PdfStudio.isValidPdf(samplePdf()))
        val html = File(dir, "expired.pdf").apply { writeText("<html>token expired</html>") }
        assertFalse(PdfStudio.isValidPdf(html))
        assertFalse(PdfStudio.isValidPdf(File(dir, "missing.pdf")))
    }

    /** "Sample page 1" in 14pt Helvetica at user-space (72, 700), optionally rotated and cropped. */
    private fun textPdf(rotation: Int, crop: PDRectangle? = null): File {
        val f = File(dir, "text-$rotation-${crop != null}.pdf")
        PDDocument().use { doc ->
            val p = PDPage(PDRectangle(612f, 792f)).apply { this.rotation = rotation; crop?.let { cropBox = it } }
            doc.addPage(p)
            PDPageContentStream(doc, p).use { cs ->
                cs.beginText(); cs.setFont(PDType1Font.HELVETICA, 14f); cs.newLineAtOffset(72f, 700f); cs.showText("Sample page 1"); cs.endText()
            }
            doc.save(f)
        }
        return f
    }

    // Helvetica AFM: ascender 718, descender -207; "Sample page 1" advances 6726/1000 em.
    private val textW = 6.726 * 14; private val ascent = 0.718 * 14; private val descent = 0.207 * 14

    private fun assertBox(expected: Box, actual: Box, tol: Double = 0.1) {
        close(actual.x, expected.x, "x", tol); close(actual.y, expected.y, "y", tol)
        close(actual.w, expected.w, "w", tol); close(actual.h, expected.h, "h", tol)
    }

    /** The rendered ink of the page (non-white pixels), in page units, must sit inside the hit rect. */
    private fun assertInkInside(file: File, rect: Box) {
        val bmp = renderPage(file, 0)
        val g = PDDocument.load(file).use { com.pdfstudio.sdk.pdf.AnnotationWriter.geometry(it.getPage(0)) }
        assertEquals("render aspect", g.width / g.height, bmp.width.toDouble() / bmp.height, 0.01)
        val s = bmp.width / g.width
        var x0 = Int.MAX_VALUE; var y0 = Int.MAX_VALUE; var x1 = -1; var y1 = -1
        for (y in 0 until bmp.height) for (x in 0 until bmp.width) if (Color.red(bmp.getPixel(x, y)) < 128) {
            x0 = minOf(x0, x); y0 = minOf(y0, y); x1 = maxOf(x1, x); y1 = maxOf(y1, y)
        }
        assertTrue("no ink rendered", x1 >= 0)
        val ink = Box(x0 / s, y0 / s, (x1 + 1 - x0) / s, (y1 + 1 - y0) / s)
        val r = rect.inset(-1.5)
        assertTrue("ink $ink outside hit $rect", ink.x >= r.x && ink.y >= r.y && ink.maxX <= r.maxX && ink.maxY <= r.maxY)
        // …and the hit hugs the ink along the reading direction.
        assertTrue("hit $rect much larger than ink $ink", rect.w * rect.h < ink.w * ink.h * 2.5)
    }

    @Test fun searchHitOnUnrotatedPage() {
        val f = textPdf(0)
        assertEquals("Sample page 1", PdfStudio.extractText(f).single().text)
        val hits = PdfStudio.search(f, "sample PAGE 1")
        assertEquals(1, hits.size)
        val r = hits.single().rects.single()
        assertBox(Box(72.0, 92 - ascent, textW, ascent + descent), r)
        assertInkInside(f, r)
        assertEquals(2, PdfStudio.search(f, "a").size)
        assertTrue(PdfStudio.search(f, "missing").isEmpty())
    }

    @Test fun extractTextLinesWordsAndFonts() {
        val f = textPdf(0)
        val line = PdfStudio.extractText(f).single().lines().single()
        assertEquals("Sample page 1", line.text)
        assertEquals("Helvetica" to 14.0, line.font to line.size)
        assertEquals(listOf("Sample", "page", "1"), line.words.map { it.text })
        assertBox(Box(72.0, 92 - ascent, textW, ascent + descent), line.box)
        assertEquals("===== Page 1 =====\nSample page 1\n", PdfStudio.extractPlainText(f))
        val json = kotlinx.serialization.json.Json.parseToJsonElement(PdfStudio.extractTextJson(f)).jsonObject
        val page = json["pages"]!!.jsonArray.single().jsonObject
        assertEquals(612.0, page["width"]!!.jsonPrimitive.double, 0.01)
        assertEquals(3, page["lines"]!!.jsonArray.single().jsonObject["words"]!!.jsonArray.size)
    }

    @Test fun extractTextInReadingOrder() {
        // mobile/shared/reading-order/columns.pdf: a newsletter drawn in a muddled order; each line starts with its place
        val f = File(ctx.cacheDir, "columns.pdf").apply { assets.open("reading-order/columns.pdf").use { i -> outputStream().use { i.copyTo(it) } } }
        val lines = PdfStudio.extractPlainText(f, pageMarkers = false).lines()
        assertEquals((1..16).map { "%02d".format(it) }, lines.mapNotNull { Regex("^(\\d\\d) ").find(it)?.groupValues?.get(1) })
        assertTrue(lines.toString(), "User1\t88\t91\t79" in lines)
        val drawn = PdfStudio.extractPlainText(f, pageMarkers = false, readingOrder = false).lines()
        // PdfBox sorts by position itself, so without reading order both columns run together on each row
        assertTrue(drawn.toString(), "02 Admissions open in May for 05 Sports day is on the second" in drawn)
    }

    @Test fun extractTextOnRotatedPageUsesDisplayedSize() {
        val f = textPdf(90)
        val p = PdfStudio.extractText(f).single()
        assertEquals(792.0 to 612.0, p.width to p.height)
        val box = p.lines().single().box
        assertTrue("runs downwards: $box", box.h > box.w)
    }

    @Test fun searchHitOnRotatedCroppedPage() {
        val f = textPdf(90, PDRectangle(36f, 36f, 540f, 720f))
        val hit = PdfStudio.search(f, "page").single()
        // Rotate 90: page x = user y - crop.bottom, page y = user x - crop.left; the line now runs downwards.
        val r = hit.rects.single()
        val before = (0.667 + 0.556 + 0.833 + 0.556 + 0.222 + 0.556 + 0.278) * 14 // "Sample "
        val word = (0.556 * 4) * 14
        assertBox(Box(700 - descent - 36, 72 + before - 36, ascent + descent, word), r)
        assertInkInside(f, PdfStudio.search(f, "sample page 1").single().rects.single())
    }

    @Test fun textHighlightIsSavedAndReadBack() {
        val f = textPdf(90, PDRectangle(36f, 36f, 540f, 720f))
        val rects = PdfStudio.search(f, "sample page").single().rects
        val marks = listOf(AnnotationKind.HIGHLIGHT, AnnotationKind.UNDERLINE, AnnotationKind.STRIKEOUT).map {
            Annotation(page = 0, kind = it, color = "#ffd84d", opacity = 0.45, strokeWidth = 1.5, rects = rects, author = "Student")
        }
        val out = File(dir, "text-markup.pdf")
        PdfStudio.writeAnnotations(f, marks, out)
        val back = PdfStudio.readAnnotations(out).associateBy { it.id }
        for (a in marks) assertEquals(a, back[a.id])
        // Other viewers only see /QuadPoints: those must land on the same text.
        val foreign = File(dir, "text-markup-foreign.pdf")
        PDDocument.load(out).use { doc ->
            doc.getPage(0).annotations.forEach { it.cosObject.removeItem(COSName.getPDFName("PDFStudio")) }
            doc.save(foreign)
        }
        PdfStudio.readAnnotations(foreign).forEach { a -> assertBox(rects.single(), a.rects!!.single(), 0.05) }
    }

    @Test fun readsFormFieldsOfEveryKind() {
        val fields = PdfStudio.readFormFields(FormSample.write(File(dir, "form.pdf"))).associateBy { it.name }
        assertEquals(setOf("name", "course", "mode", "agree"), fields.keys)
        assertEquals(FormFieldKind.TEXT, fields.getValue("name").kind)
        assertEquals(FormFieldKind.DROPDOWN, fields.getValue("course").kind)
        assertEquals(listOf("Science", "Commerce", "Arts"), fields.getValue("course").options)
        assertEquals(FormFieldKind.RADIO, fields.getValue("mode").kind)
        assertEquals(listOf("Classroom", "Online"), fields.getValue("mode").options)
        assertEquals(FormFieldKind.CHECKBOX, fields.getValue("agree").kind)
        assertEquals("false", fields.getValue("agree").value)
        assertTrue(fields.values.all { it.page == 0 && !it.readOnly })
    }

    @Test fun fillsFormFieldsAndShowsTheValues() {
        val src = FormSample.write(File(dir, "form-src.pdf"))
        val out = File(dir, "form-filled.pdf")
        val changed = PdfStudio.fillForm(src, mapOf("name" to "Jane Doe", "course" to "Commerce", "mode" to "Online", "agree" to "true", "nope" to "x"), out)
        assertEquals(4, changed)
        val back = PdfStudio.readFormFields(out).associate { it.name to it.value }
        assertEquals(mapOf("name" to "Jane Doe", "course" to "Commerce", "mode" to "Online", "agree" to "true"), back)

        // the typed name is drawn: PdfRenderer shows dark pixels inside the empty-before field
        fun ink(f: File): Int {
            val bmp = renderPage(f, 0); val r = FormSample.NAME_RECT; val k = bmp.width / 612f
            var n = 0
            for (y in ((792 - r.upperRightY) * k).toInt() until ((792 - r.lowerLeftY) * k).toInt())
                for (x in (r.lowerLeftX * k).toInt() + 4 until (r.upperRightX * k).toInt() - 4)
                    if (Color.red(bmp.getPixel(x, y)) < 100) n++
            return n
        }
        assertTrue("filled name not drawn", ink(out) > ink(src) + 50)

        // options a field doesn't have are refused; clearing works
        assertEquals(0, PdfStudio.fillForm(out, mapOf("course" to "Painting", "mode" to "Distance"), File(dir, "form-bad.pdf")))
        val cleared = File(dir, "form-cleared.pdf")
        assertEquals(2, PdfStudio.fillForm(out, mapOf("agree" to "false", "name" to ""), cleared))
        assertEquals("false", PdfStudio.readFormFields(cleared).first { it.name == "agree" }.value)
    }

    @Test fun filledFormKeepsItsFieldsWhenAnnotationsAreSaved() {
        val filled = File(dir, "form-filled2.pdf")
        PdfStudio.fillForm(FormSample.write(File(dir, "form-src2.pdf")), mapOf("name" to "John Doe"), filled)
        val out = File(dir, "form-annotated.pdf")
        val note = Annotation(page = 0, kind = AnnotationKind.NOTE, color = "#ffcd45", rect = Box(400.0, 100.0, 22.0, 22.0), comment = "Check the name", author = "Reviewer")
        PdfStudio.writeAnnotations(filled, listOf(note), out)
        assertEquals("John Doe", PdfStudio.readFormFields(out).first { it.name == "name" }.value)
        assertEquals("Check the name", PdfStudio.readAnnotations(out).single { it.kind == AnnotationKind.NOTE }.comment)
    }

    private fun renderPage(file: File, page: Int): Bitmap =
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
            PdfRenderer(fd).use { r -> r.openPage(page).use { p ->
                Bitmap.createBitmap(p.width * 2, p.height * 2, Bitmap.Config.ARGB_8888).also {
                    it.eraseColor(Color.WHITE); p.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                }
            } }
        }
}

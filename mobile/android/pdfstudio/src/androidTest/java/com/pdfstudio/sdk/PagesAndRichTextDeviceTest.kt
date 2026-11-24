package com.pdfstudio.sdk

import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfstudio.sdk.pdf.AnnotationWriter
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSFloat
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs

/** Page edits and `/RC` rich text with real PdfBox-Android writing (and PdfRenderer reading the result). */
@RunWith(AndroidJUnit4::class)
class PagesAndRichTextDeviceTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val dir = File(ctx.cacheDir, "test-pages").apply { mkdirs() }

    @Before fun setUp() = PdfStudio.init(ctx)

    /** Three Letter pages with "Sample page n" on each; the middle one is landscape A4. */
    private fun threePages(): File {
        val f = File(dir, "three.pdf")
        PDDocument().use { doc ->
            for (i in 0 until 3) {
                val p = PDPage(if (i == 1) PDRectangle(842f, 595f) else PDRectangle(612f, 792f))
                doc.addPage(p)
                PDPageContentStream(doc, p).use { cs ->
                    cs.beginText(); cs.setFont(PDType1Font.HELVETICA, 14f); cs.newLineAtOffset(72f, 500f)
                    cs.showText("Sample page ${i + 1}"); cs.endText()
                }
            }
            doc.save(f)
        }
        return f
    }

    private fun mark(page: Int) = Annotation(id = "box-$page", page = page, kind = AnnotationKind.RECT, color = "#e5484d",
        rect = Box(70.0, 70.0, 100.0, 40.0), author = "User 1")

    private fun rendererSizes(f: File) = ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        PdfRenderer(fd).use { r -> (0 until r.pageCount).map { i -> r.openPage(i).use { it.width to it.height } } }
    }

    @Test fun editPagesRotatesDeletesAndMovesWithTheMarks() {
        val src = File(dir, "three-marked.pdf")
        PdfStudio.writeAnnotations(threePages(), listOf(mark(0), mark(1), mark(2)), src)
        val out = File(dir, "three-edited.pdf")
        // turn page 1, drop page 2, then move the last page first
        val ops = listOf(PageOp.Rotate(0), PageOp.Delete(1), PageOp.Move(1, 0))
        val returned = PdfStudio.editPages(src, out, ops)

        assertEquals(listOf("Sample page 3", "Sample page 1"), PdfStudio.extractText(out).map { it.text.trim() })
        PDDocument.load(out).use { doc ->
            assertEquals(2, doc.numberOfPages)
            assertEquals(listOf(0, 90), (0 until 2).map { doc.getPage(it).rotation })
        }
        // PdfRenderer (what the viewer draws with) sees the turned page as landscape
        assertEquals(listOf(612 to 792, 792 to 612), rendererSizes(out))

        val back = PdfStudio.readAnnotations(out).associateBy { it.id }
        assertEquals(setOf("box-0", "box-2"), back.keys)
        assertEquals(0, back.getValue("box-2").page); assertEquals(1, back.getValue("box-0").page)
        assertEquals(Box(70.0, 70.0, 100.0, 40.0), back.getValue("box-2").rect)
        // page 1 turned clockwise: the box sits at x = 792 - 110, y = 70, 40 × 100
        val turned = back.getValue("box-0").rect!!
        listOf(turned.x to 682.0, turned.y to 70.0, turned.w to 40.0, turned.h to 100.0).forEach { (a, e) -> assertTrue("$turned", abs(a - e) < 0.05) }
        assertEquals(returned.associate { it.id to it.rect }, back.mapValues { it.value.rect })
        // and the box is drawn there: its appearance lies inside the turned page at the turned place
        PDDocument.load(out).use { doc ->
            val g = AnnotationWriter.geometry(doc.getPage(1))
            val r = doc.getPage(1).annotations.single().rectangle
            val box = g.toPage(PdfRect(r.lowerLeftX.toDouble(), r.lowerLeftY.toDouble(), r.upperRightX.toDouble(), r.upperRightY.toDouble()))
            assertTrue("$box", box.contains(Pt(682.0 + 20, 70.0 + 50)))
        }

        assertThrows(IllegalArgumentException::class.java) { PdfStudio.editPages(out, File(dir, "x.pdf"), listOf(PageOp.Delete(0), PageOp.Delete(0))) }
    }

    @Test fun editPagesCanWriteMarksKeptOutsideTheFile() {
        val out = File(dir, "three-outside.pdf")
        val r = PdfStudio.editPages(threePages(), out, listOf(PageOp.Move(0, 2)), annotations = listOf(mark(0)))
        assertEquals(2, r.single().page)
        assertEquals(2, PdfStudio.readAnnotations(out).single().page)
        assertEquals("Sample page 1", PdfStudio.extractText(out)[2].text.trim())
    }

    private val runs = listOf(TextRun("Due "), TextRun("Friday", bold = true), TextRun(" - "), TextRun("late", italic = true, underline = true, color = "#1f6feb"))

    @Test fun richTextIsWrittenAsRcAndDrawnStyled() {
        val ft = Annotation(id = "rt-1", page = 0, kind = AnnotationKind.FREETEXT, color = "#e5484d", strokeWidth = 0.0,
            rect = Box(72.0, 100.0, 260.0, 30.0), text = RichText.plainText(runs), fontSize = 14.0, richText = runs, author = "John Doe")
        val out = File(dir, "rich.pdf")
        PdfStudio.writeAnnotations(threePages(), listOf(ft), out)
        PDDocument.load(out).use { doc ->
            val d = doc.getPage(0).annotations.single().cosObject
            val rc = d.getString(COSName.getPDFName("RC"))
            assertTrue(rc, rc.startsWith("<body xmlns=\"http://www.w3.org/1999/xhtml\"") && "font-weight:bold" in rc && "text-decoration:underline" in rc)
            assertEquals(RichText.plainText(runs), d.getString(COSName.CONTENTS))
            // the appearance uses bold and oblique Helvetica for those words
            val ap = doc.getPage(0).annotations.single().appearance.normalAppearance.appearanceStream
            val fonts = ap.resources.fontNames.map { ap.resources.getFont(it).name }.toSet()
            assertTrue("$fonts", "Helvetica-Bold" in fonts && "Helvetica-Oblique" in fonts)
        }
        // lossless through our own JSON
        assertEquals(runs, PdfStudio.readAnnotations(out).single().richText)

        // Another app's copy (no PDF Studio JSON): the styling comes back from /RC
        val foreign = File(dir, "rich-foreign.pdf")
        PDDocument.load(out).use { doc ->
            doc.getPage(0).annotations.single().cosObject.apply { removeItem(AnnotationWriter.KEY); removeItem(AnnotationWriter.KEY_M) }
            doc.save(foreign)
        }
        val read = PdfStudio.readAnnotations(foreign).single()
        assertEquals(AnnotationKind.FREETEXT, read.kind); assertEquals("#e5484d", read.color)
        assertEquals(RichText.plainText(runs), read.text)
        assertEquals(RichText.normalize(runs), read.richText)
    }

    @Test fun readsAcrobatStyleRichTextAndIgnoresPlainRc() {
        val f = File(dir, "acrobat-rc.pdf")
        PDDocument.load(threePages()).use { doc ->
            fun freeText(rc: String, contents: String): PDAnnotation {
                val d = COSDictionary()
                d.setItem(COSName.TYPE, COSName.ANNOT); d.setName(COSName.SUBTYPE, "FreeText")
                d.setItem(COSName.RECT, COSArray().apply { listOf(72f, 600f, 300f, 640f).forEach { add(COSFloat(it)) } })
                d.setString(COSName.DA, "/Helv 12 Tf 0 0 0 rg"); d.setString(COSName.CONTENTS, contents)
                d.setString(COSName.getPDFName("RC"), rc); d.setString(COSName.T, "User 1")
                return PDAnnotation.createAnnotation(d)
            }
            val styled = """<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" style="font-size:12.0pt;color:#000000"><p dir="ltr"><span style="font-weight:bold">Well</span> done</p></body>"""
            val plain = """<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p><span style="color:#000000">Just text</span></p></body>"""
            doc.getPage(0).annotations = listOf(freeText(styled, "Well done"), freeText(plain, "Just text"))
            doc.save(f)
        }
        val (a, b) = PdfStudio.readAnnotations(f)
        assertEquals("Well done", a.text); assertEquals(listOf(TextRun("Well", bold = true), TextRun(" done")), a.richText)
        assertEquals("Just text", b.text); assertNull(b.richText)
    }

    /** The viewer renders with PdfRenderer and no transform: a turned page must come out turned, not stretched. */
    @Test fun viewerDrawsTurnedPagesTurned() {
        // a black square in the unturned page's top-left corner
        val f = File(dir, "corner.pdf")
        PDDocument().use { doc ->
            val p = PDPage(PDRectangle(612f, 792f)); doc.addPage(p)
            PDPageContentStream(doc, p).use { cs -> cs.addRect(0f, 692f, 100f, 100f); cs.fill() }
            doc.save(f)
        }
        // where the square shows, in displayed points, for each turn
        val expected = mapOf(0 to (50 to 50), 90 to (742 to 50), 180 to (562 to 742), 270 to (50 to 562))
        for ((turn, at) in expected) {
            val turned = File(dir, "corner-$turn.pdf")
            PdfStudio.editPages(f, turned, List(turn / 90) { PageOp.Rotate(0) })
            ParcelFileDescriptor.open(turned, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                PdfRenderer(fd).use { r -> r.openPage(0).use { p ->
                    val bmp = android.graphics.Bitmap.createBitmap(p.width, p.height, android.graphics.Bitmap.Config.ARGB_8888)
                    bmp.eraseColor(android.graphics.Color.WHITE)
                    p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    fun dark(x: Int, y: Int) = android.graphics.Color.red(bmp.getPixel(x, y)) < 60
                    var x0 = 9999; var y0 = 9999; var x1 = -1; var y1 = -1
                    for (y in 0 until p.height step 2) for (x in 0 until p.width step 2) if (dark(x, y)) { x0 = minOf(x0, x); y0 = minOf(y0, y); x1 = maxOf(x1, x); y1 = maxOf(y1, y) }
                    assertTrue("turn $turn: square at $at, dark in [$x0,$y0..$x1,$y1], page ${p.width}x${p.height}", dark(at.first, at.second))
                    assertTrue("turn $turn: nothing opposite", !dark(p.width - 1 - at.first, p.height - 1 - at.second))
                } }
            }
        }
    }
}

package com.pdfstudio.sdk.pdf

import com.pdfstudio.sdk.Box
import com.pdfstudio.sdk.GlyphStyle
import com.pdfstudio.sdk.PageGeometry
import com.pdfstudio.sdk.PageText
import com.pdfstudio.sdk.PdfPoint
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.text.PDFTextStripper
import com.tom_roush.pdfbox.text.TextPosition
import java.io.File
import java.io.Writer

/**
 * Extracts each page's text with a box per character, in page units — what search and text
 * selection run on.
 *
 * PdfBox's own `TextPosition.getX/getY` use a y-down space of its own (relative to the crop box,
 * rotation handled differently from PDF.js). Instead each glyph is taken from its text rendering
 * matrix (unrotated user space minus the crop box origin), spanning advance × descent..ascent, and
 * converted with [PageGeometry] like every other coordinate in the SDK.
 */
object TextExtractor {
    fun extract(file: File): List<PageText> =
        PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly()).use { extract(it) }

    fun extract(doc: PDDocument): List<PageText> {
        val out = ArrayList<PageText>(doc.numberOfPages)
        val stripper = Collector { out += it }
        stripper.sortByPosition = true
        stripper.writeText(doc, object : Writer() {
            override fun write(cbuf: CharArray, off: Int, len: Int) = Unit
            override fun flush() = Unit
            override fun close() = Unit
        })
        // Pages without content streams never reach endPage.
        val byPage = out.associateBy { it.page }
        return (0 until doc.numberOfPages).map { byPage[it] ?: PageText(it, "", emptyList()) }
    }

    private val SUBSET = Regex("^[A-Z]{6}\\+")

    private class Collector(val emit: (PageText) -> Unit) : PDFTextStripper() {
        private val text = StringBuilder()
        private val boxes = ArrayList<Box?>()
        private val styles = ArrayList<GlyphStyle?>()
        private var geometry: PageGeometry? = null

        override fun startPage(page: PDPage) {
            text.setLength(0); boxes.clear(); styles.clear()
            geometry = AnnotationWriter.geometry(page)
            super.startPage(page)
        }

        override fun endPage(page: PDPage) {
            while (text.isNotEmpty() && text.last().isWhitespace()) { text.setLength(text.length - 1); boxes.removeAt(boxes.lastIndex); styles.removeAt(styles.lastIndex) }
            val g = geometry
            emit(PageText(currentPageNo - 1, text.toString(), boxes.toList(), styles.toList(), g?.width ?: 0.0, g?.height ?: 0.0))
            super.endPage(page)
        }

        override fun writeString(string: String, textPositions: List<TextPosition>) {
            val g = geometry ?: return
            for (tp in textPositions) {
                val b = glyphBox(tp, g)
                val style = GlyphStyle(tp.font?.name?.replace(SUBSET, "") ?: "", Math.round(tp.fontSizeInPt * 100) / 100.0)
                for (c in tp.unicode) {
                    if (c.isISOControl() && c != '\n') continue // broken ToUnicode maps, never real text
                    text.append(c); boxes += b; styles += style
                }
            }
        }

        override fun writeWordSeparator() = separator(' ')
        override fun writeLineSeparator() = separator('\n')
        override fun writeParagraphStart() { separator('\n'); super.writeParagraphStart() }

        private fun separator(c: Char) {
            if (text.isEmpty()) return
            val last = text.last()
            if (last == '\n' || (last == ' ' && c == ' ')) return
            if (last == ' ') { text.setCharAt(text.length - 1, c); return }
            text.append(c); boxes += null; styles += null
        }

        private fun glyphBox(tp: TextPosition, g: PageGeometry): Box {
            val m = tp.textMatrix
            val sx = m.scalingFactorX.takeIf { it > 0f } ?: 1f
            val advance = tp.widthDirAdj / sx // in text space (1 = font size)
            val fd = tp.font?.fontDescriptor
            val ascent = (fd?.ascent?.div(1000f) ?: 0f).takeIf { it in 0.5f..1.2f } ?: 0.8f
            val descent = (fd?.descent?.div(1000f) ?: 0f).takeIf { it in -0.5f..0f && it != 0f } ?: -0.2f
            val corners = listOf(0f to descent, advance to descent, 0f to ascent, advance to ascent).map { (x, y) ->
                // text rendering matrix → crop-box-relative user space → user space → page units
                g.toPage(PdfPoint(
                    (m.getValue(0, 0) * x + m.getValue(1, 0) * y + m.getValue(2, 0)).toDouble() + g.crop.left,
                    (m.getValue(0, 1) * x + m.getValue(1, 1) * y + m.getValue(2, 1)).toDouble() + g.crop.bottom,
                ))
            }
            return Box.bounding(corners)!!
        }
    }
}

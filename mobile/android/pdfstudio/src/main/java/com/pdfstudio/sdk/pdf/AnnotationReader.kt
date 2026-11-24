package com.pdfstudio.sdk.pdf

import com.pdfstudio.sdk.Annotation
import com.pdfstudio.sdk.AnnotationJson
import com.pdfstudio.sdk.AnnotationKind
import com.pdfstudio.sdk.Box
import com.pdfstudio.sdk.PageGeometry
import com.pdfstudio.sdk.PdfPoint
import com.pdfstudio.sdk.PdfRect
import com.pdfstudio.sdk.Pt
import com.pdfstudio.sdk.Rgb
import com.pdfstudio.sdk.Xfdf
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.cos.COSNumber
import com.tom_roush.pdfbox.pdmodel.PDDocument

/**
 * Moves the annotations we can edit out of a PDF and into the model (same rules as web/iOS):
 * our `/PDFStudio` JSON when fresh, otherwise the standard keys. Links, widgets and unknown
 * annotation types stay in the document.
 */
object AnnotationReader {
    private val IMPORTABLE = setOf("Highlight", "Underline", "StrikeOut", "Squiggly", "Square", "Circle", "Line", "Ink",
        "FreeText", "Text", "PolyLine", "Polygon", "Redact")

    fun extract(doc: PDDocument, remove: Boolean = true): List<Annotation> {
        val out = mutableListOf<Annotation>()
        for (i in 0 until doc.numberOfPages) {
            val page = doc.getPage(i)
            val g = AnnotationWriter.geometry(page)
            val annots = page.annotations
            val keep = annots.toMutableList()
            for (annot in annots) {
                val d = annot.cosObject
                if ((d.getInt(COSName.F, 0) and 2) != 0) continue // hidden
                val a = fromDictionary(d, i, g) ?: continue
                if (out.any { it.id == a.id }) continue
                out += a
                keep.remove(annot)
                d.getCOSDictionary(COSName.getPDFName("Popup"))?.let { popup -> keep.removeAll { it.cosObject === popup } }
            }
            if (remove && keep.size != annots.size) page.annotations = keep
        }
        return out
    }

    internal fun fromDictionary(d: COSDictionary, page: Int, g: PageGeometry): Annotation? {
        val subtype = d.getNameAsString(COSName.SUBTYPE) ?: return null
        val json = d.getString(AnnotationWriter.KEY)
        if (json != null && d.getString(AnnotationWriter.KEY_M) == d.getString(COSName.M)) {
            AnnotationJson.decode(json)?.let { return it.copy(page = page) }
        }
        if (subtype !in IMPORTABLE) return null

        fun nums(key: String) = (d.getDictionaryObject(COSName.getPDFName(key)) as? COSArray)?.toList()?.mapNotNull { (it as? COSNumber)?.floatValue()?.toDouble() }
        fun pairs(v: List<Double>) = (0 until v.size / 2).map { g.toPage(PdfPoint(v[it * 2], v[it * 2 + 1])) }
        val r = nums("Rect") ?: return null
        val rect = Box.spanning(g.toPage(PdfPoint(r[0], r[1])), g.toPage(PdfPoint(r[2], r[3])))
        val color = nums("C")?.let { c ->
            when (c.size) {
                1 -> Rgb(c[0], c[0], c[0]); 3 -> Rgb(c[0], c[1], c[2])
                4 -> Rgb((1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])); else -> null
            }
        }?.hex
        val width = (d.getCOSDictionary(COSName.BS)?.getFloat(COSName.W, -1f)?.takeIf { it >= 0 }?.toDouble())
            ?: nums("Border")?.getOrNull(2) ?: 1.0
        val date = Xfdf.pdfDateToIso(d.getString(COSName.M)) ?: Annotation.now()
        val base = Annotation(
            id = d.getString(COSName.NM)?.takeIf { it.isNotEmpty() } ?: Annotation.newId(), page = page, kind = AnnotationKind.RECT,
            color = color ?: "#e5484d", opacity = d.getFloat(COSName.CA, 1f).toDouble(), strokeWidth = width,
            comment = d.getString(COSName.CONTENTS)?.ifEmpty { null }, author = d.getString(COSName.T) ?: "Unknown",
            createdAt = date, modifiedAt = date,
        )
        return when (subtype) {
            "Highlight", "Underline", "StrikeOut", "Squiggly" -> {
                val q = nums("QuadPoints").orEmpty()
                val rects = (0 until q.size / 8).mapNotNull { Box.bounding(pairs(q.subList(it * 8, it * 8 + 8))) }
                val kind = when (subtype) { "Highlight" -> AnnotationKind.HIGHLIGHT; "StrikeOut" -> AnnotationKind.STRIKEOUT; else -> AnnotationKind.UNDERLINE }
                base.copy(kind = kind, rects = rects.ifEmpty { listOf(rect) }, color = color ?: "#ffd84d",
                    opacity = if (kind == AnnotationKind.HIGHLIGHT) minOf(base.opacity, 0.45) else base.opacity)
            }
            "Square", "Circle" -> {
                // /RD = gap between /Rect and the outer edge of the border (PDF 32000 §12.5.6.8)
                val rd = nums("RD")?.takeIf { it.size == 4 }
                val outer = if (rd != null) g.toPage(PdfRect(r[0] + rd[0], r[1] + rd[1], r[2] - rd[2], r[3] - rd[3])) else rect
                base.copy(kind = if (subtype == "Square") AnnotationKind.RECT else AnnotationKind.ELLIPSE, rect = outer.inset(width / 2))
            }
            "Line" -> {
                val l = nums("L") ?: return null
                val le = (d.getDictionaryObject(COSName.LE) as? COSArray)?.toList()?.joinToString { (it as? COSName)?.name.orEmpty() }.orEmpty()
                base.copy(kind = if ("Arrow" in le) AnnotationKind.ARROW else AnnotationKind.LINE, points = pairs(l))
            }
            "Ink" -> {
                val list = (d.getDictionaryObject(COSName.getPDFName("InkList")) as? COSArray)?.toList()
                    ?.mapNotNull { s -> (s as? COSArray)?.toList()?.mapNotNull { (it as? COSNumber)?.floatValue()?.toDouble() } }
                    ?.map(::pairs)?.filter { it.isNotEmpty() } ?: return null
                base.copy(kind = AnnotationKind.INK, paths = list)
            }
            "PolyLine", "Polygon" -> {
                val v = pairs(nums("Vertices") ?: return null)
                if (v.size < 2) return null
                base.copy(kind = AnnotationKind.INK, paths = listOf(if (subtype == "Polygon") v + v[0] else v))
            }
            "FreeText" -> {
                val da = d.getString(COSName.DA).orEmpty()
                val size = Regex("""([\d.]+)\s+Tf""").find(da)?.groupValues?.get(1)?.toDoubleOrNull() ?: 12.0
                val rgb = Regex("""([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg""").find(da)?.groupValues
                base.copy(kind = AnnotationKind.FREETEXT, rect = rect, text = base.comment.orEmpty(), comment = null, fontSize = size,
                    color = rgb?.let { Rgb(it[1].toDouble(), it[2].toDouble(), it[3].toDouble()).hex } ?: color ?: "#111111", opacity = 1.0)
            }
            "Text" -> base.copy(kind = AnnotationKind.NOTE, rect = Box(rect.x, rect.y, 22.0, 22.0), color = color ?: "#ffd84d", opacity = 1.0)
            "Redact" -> base.copy(kind = AnnotationKind.REDACT, rect = rect, color = "#e5484d", opacity = 1.0)
            else -> null
        }
    }

    @Suppress("unused") private fun pt(x: Double, y: Double) = Pt(x, y)
}

package com.pdfstudio.sdk.pdf

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.util.Base64
import com.pdfstudio.sdk.Annotation
import com.pdfstudio.sdk.AnnotationJson
import com.pdfstudio.sdk.AnnotationKind
import com.pdfstudio.sdk.Box
import com.pdfstudio.sdk.Measure
import com.pdfstudio.sdk.PageGeometry
import com.pdfstudio.sdk.PdfPoint
import com.pdfstudio.sdk.PdfRect
import com.pdfstudio.sdk.Pt
import com.pdfstudio.sdk.Rgb
import com.pdfstudio.sdk.Xfdf
import com.pdfstudio.sdk.textLayoutBox
import com.pdfstudio.sdk.textOrigin
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSFloat
import com.tom_roush.pdfbox.cos.COSInteger
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.cos.COSString
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import com.tom_roush.pdfbox.pdmodel.graphics.blend.BlendMode
import com.tom_roush.pdfbox.pdmodel.graphics.image.LosslessFactory
import com.tom_roush.pdfbox.pdmodel.graphics.state.PDExtendedGraphicsState
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotation
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceDictionary
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream
import com.tom_roush.pdfbox.util.Matrix
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Writes model annotations into a PDF, either as real (editable) PDF annotations with appearance
 * streams, or flattened into the page content. Same rules as the web SDK (web/src/sdk/pdfAnnots.ts):
 * private `/PDFStudio` JSON for lossless round trips, `/PDFStudioM` = `/M`.
 */
object AnnotationWriter {
    enum class Mode { EDITABLE, FLATTEN }

    internal val KEY: COSName = COSName.getPDFName("PDFStudio")
    internal val KEY_M: COSName = COSName.getPDFName("PDFStudioM")

    fun geometry(page: PDPage): PageGeometry {
        val c = page.cropBox
        return PageGeometry(PdfRect(c.lowerLeftX.toDouble(), c.lowerLeftY.toDouble(), c.upperRightX.toDouble(), c.upperRightY.toDouble()), page.rotation)
    }

    fun write(doc: PDDocument, annotations: List<Annotation>, mode: Mode) {
        for (a in annotations) {
            if (a.page !in 0 until doc.numberOfPages) continue
            if (a.kind == AnnotationKind.REDACT && mode == Mode.FLATTEN) continue // instructions, never content
            val page = doc.getPage(a.page)
            val g = geometry(page)
            val ap = appearance(doc, a, g) ?: continue
            if (mode == Mode.FLATTEN) {
                PDPageContentStream(doc, page, PDPageContentStream.AppendMode.APPEND, true, true).use { it.drawForm(ap) }
            } else {
                page.annotations = page.annotations.apply { add(annotationFor(a, g, ap)) }
            }
        }
    }

    // ------------------------------------------------------------------ annotation dictionary

    private fun annotationFor(a: Annotation, g: PageGeometry, ap: PDAppearanceStream): PDAnnotation {
        val d = COSDictionary()
        val subtype = when (a.kind) {
            AnnotationKind.HIGHLIGHT -> "Highlight"; AnnotationKind.UNDERLINE -> "Underline"; AnnotationKind.STRIKEOUT -> "StrikeOut"
            AnnotationKind.RECT -> "Square"; AnnotationKind.ELLIPSE -> "Circle"
            AnnotationKind.LINE, AnnotationKind.ARROW, AnnotationKind.DISTANCE -> "Line"
            AnnotationKind.INK -> "Ink"; AnnotationKind.FREETEXT -> "FreeText"; AnnotationKind.NOTE -> "Text"
            AnnotationKind.STAMP, AnnotationKind.SIGNATURE -> "Stamp"
            AnnotationKind.PERIMETER -> "PolyLine"; AnnotationKind.AREA -> "Polygon"; AnnotationKind.REDACT -> "Redact"
        }
        val c = Rgb.of(a.color)
        val date = Xfdf.isoToPdfDate(a.modifiedAt)
        d.setItem(COSName.TYPE, COSName.ANNOT)
        d.setItem(COSName.SUBTYPE, COSName.getPDFName(subtype))
        d.setItem(COSName.RECT, ap.bBox.cosArray)
        d.setInt(COSName.F, 4)
        d.setString(COSName.NM, a.id)
        d.setString(COSName.T, a.author)
        d.setString(COSName.M, date)
        d.setString(COSName.getPDFName("CreationDate"), Xfdf.isoToPdfDate(a.createdAt))
        d.setItem(COSName.C, floats(c.r, c.g, c.b))
        d.setFloat(COSName.CA, a.opacity.toFloat())
        d.setItem(COSName.BORDER, floats(0.0, 0.0, a.strokeWidth))
        val contents = when (a.kind) {
            AnnotationKind.FREETEXT, AnnotationKind.STAMP -> a.text
            else -> listOfNotNull(Measure.label(a).ifEmpty { null }, a.comment).joinToString("\n").ifEmpty { null }
        }
        contents?.let { d.setString(COSName.CONTENTS, it) }
        d.setItem(KEY, COSString(AnnotationJson.encode(a)))
        d.setString(KEY_M, date)
        fun pts(list: List<Pt>) = floats(*list.flatMap { val p = g.toPdf(it); listOf(p.x, p.y) }.toDoubleArray())
        when (a.kind) {
            AnnotationKind.HIGHLIGHT, AnnotationKind.UNDERLINE, AnnotationKind.STRIKEOUT ->
                d.setItem(COSName.getPDFName("QuadPoints"), pts(a.rects.orEmpty().flatMap { r ->
                    listOf(Pt(r.x, r.y), Pt(r.maxX, r.y), Pt(r.x, r.maxY), Pt(r.maxX, r.maxY))
                }))
            AnnotationKind.LINE, AnnotationKind.ARROW, AnnotationKind.DISTANCE -> {
                d.setItem(COSName.L, pts(a.points.orEmpty()))
                d.setItem(COSName.LE, COSArray().apply {
                    add(COSName.getPDFName("None")); add(COSName.getPDFName(if (a.kind == AnnotationKind.ARROW) "ClosedArrow" else "None"))
                })
                if (a.kind == AnnotationKind.ARROW) d.setItem(COSName.IC, floats(c.r, c.g, c.b))
                if (a.kind == AnnotationKind.DISTANCE) d.setName(COSName.IT, "LineDimension")
            }
            AnnotationKind.PERIMETER, AnnotationKind.AREA -> {
                d.setItem(COSName.getPDFName("Vertices"), pts(a.points.orEmpty()))
                d.setName(COSName.IT, if (a.kind == AnnotationKind.AREA) "PolygonDimension" else "PolyLineDimension")
            }
            AnnotationKind.RECT, AnnotationKind.ELLIPSE -> {
                // /Rect is the appearance BBox (padded); /RD tells readers where the shape's outer edge is.
                val rd = ap.bBox.width / 2 - (g.toPdf(a.rect ?: a.bounds).width.toFloat() / 2 + a.strokeWidth.toFloat() / 2)
                d.setItem(COSName.getPDFName("RD"), floats(rd.toDouble(), rd.toDouble(), rd.toDouble(), rd.toDouble()))
            }
            AnnotationKind.INK -> d.setItem(COSName.getPDFName("InkList"), COSArray().apply { a.paths.orEmpty().forEach { add(pts(it)) } })
            AnnotationKind.FREETEXT -> d.setString(COSName.DA, "/Helv ${a.fontSize ?: 14.0} Tf ${c.r} ${c.g} ${c.b} rg")
            AnnotationKind.NOTE -> { d.setName(COSName.NAME, "Comment"); d.setBoolean(COSName.getPDFName("Open"), false) }
            AnnotationKind.STAMP -> d.setName(COSName.NAME, a.text.orEmpty().filter { it.isLetter() && it.code < 128 }.ifEmpty { "Approved" })
            AnnotationKind.SIGNATURE -> d.setName(COSName.NAME, "Signature")
            else -> {}
        }
        val annot = PDAnnotation.createAnnotation(d)
        annot.appearance = PDAppearanceDictionary().apply { setNormalAppearance(ap) }
        return annot
    }

    // ------------------------------------------------------------------ appearance

    private class Ctx(val doc: PDDocument, val g: PageGeometry, val cs: PDPageContentStream) {
        val points = mutableListOf<PdfPoint>()
        fun pdf(p: Pt) = g.toPdf(p).also { points += it }
    }

    /** Builds the appearance in PDF user space. BBox = bounds of everything drawn, so no matrix is needed. */
    fun appearance(doc: PDDocument, a: Annotation, g: PageGeometry): PDAppearanceStream? {
        val ap = PDAppearanceStream(doc)
        ap.resources = com.tom_roush.pdfbox.pdmodel.PDResources()
        // First pass collects geometry for the BBox; PDFBox needs the BBox before content is useful,
        // but the content stream doesn't depend on it, so we compute bounds from the model.
        val bounds = drawBounds(a, g)
        ap.bBox = PDRectangle(bounds.left.toFloat(), bounds.bottom.toFloat(), bounds.width.toFloat(), bounds.height.toFloat())
        PDPageContentStream(doc, ap).use { cs ->
            val ctx = Ctx(doc, g, cs)
            draw(ctx, a)
        }
        return ap
    }

    private fun drawBounds(a: Annotation, g: PageGeometry): PdfRect {
        var box = a.bounds
        if (a.kind.isMeasurement) {
            val c = Measure.labelAnchor(a); val w = Measure.label(a).length * 5.6 + 8
            box = Box.union(listOf(box, Box(c.x - w / 2, c.y - 8, w, 16.0)))!!
        }
        val pad = a.strokeWidth / 2 + 6 // arrow heads, ticks, line caps
        val r = g.toPdf(box)
        return PdfRect(r.left - pad, r.bottom - pad, r.right + pad, r.top + pad)
    }

    private fun gs(ctx: Ctx, opacity: Double, multiply: Boolean = false) {
        val s = PDExtendedGraphicsState()
        s.strokingAlphaConstant = opacity.toFloat()
        s.nonStrokingAlphaConstant = opacity.toFloat()
        if (multiply) s.blendMode = BlendMode.MULTIPLY
        ctx.cs.setGraphicsStateParameters(s)
    }

    private fun stroke(ctx: Ctx, pts: List<Pt>, color: String, width: Double, close: Boolean = false) {
        if (pts.size < 2) return
        val c = Rgb.of(color)
        ctx.cs.setStrokingColor(c.r.toFloat(), c.g.toFloat(), c.b.toFloat())
        ctx.cs.setLineWidth(width.toFloat())
        ctx.cs.setLineCapStyle(1); ctx.cs.setLineJoinStyle(1)
        path(ctx, pts, close)
        ctx.cs.stroke()
    }

    private fun fill(ctx: Ctx, pts: List<Pt>, color: String) {
        val c = Rgb.of(color)
        ctx.cs.setNonStrokingColor(c.r.toFloat(), c.g.toFloat(), c.b.toFloat())
        path(ctx, pts, true)
        ctx.cs.fill()
    }

    private fun path(ctx: Ctx, pts: List<Pt>, close: Boolean) {
        pts.forEachIndexed { i, p -> val q = ctx.pdf(p); if (i == 0) ctx.cs.moveTo(q.x.toFloat(), q.y.toFloat()) else ctx.cs.lineTo(q.x.toFloat(), q.y.toFloat()) }
        if (close) ctx.cs.closePath()
    }

    private fun corners(r: Box) = listOf(Pt(r.x, r.y), Pt(r.maxX, r.y), Pt(r.maxX, r.maxY), Pt(r.x, r.maxY))

    private fun ellipse(r: Box, n: Int = 64) = (0 until n).map {
        val t = it * 2 * Math.PI / n
        Pt(r.x + r.w / 2 + r.w / 2 * cos(t), r.y + r.h / 2 + r.h / 2 * sin(t))
    }

    private fun arrowHead(a: Pt, b: Pt, width: Double): List<Pt> {
        val len = max(8.0, width * 4); val ang = atan2(b.y - a.y, b.x - a.x); val s = Math.PI / 7
        return listOf(b, Pt(b.x - len * cos(ang - s), b.y - len * sin(ang - s)), Pt(b.x - len * cos(ang + s), b.y - len * sin(ang + s)))
    }

    private fun draw(ctx: Ctx, a: Annotation) {
        val cs = ctx.cs
        cs.saveGraphicsState()
        when (a.kind) {
            AnnotationKind.HIGHLIGHT -> { gs(ctx, a.opacity, true); a.rects.orEmpty().forEach { fill(ctx, corners(it), a.color) } }
            AnnotationKind.UNDERLINE, AnnotationKind.STRIKEOUT -> {
                gs(ctx, a.opacity)
                a.rects.orEmpty().forEach { r ->
                    val y = if (a.kind == AnnotationKind.UNDERLINE) r.y + r.h * 0.92 else r.y + r.h * 0.55
                    stroke(ctx, listOf(Pt(r.x, y), Pt(r.maxX, y)), a.color, max(1.0, a.strokeWidth))
                }
            }
            AnnotationKind.RECT, AnnotationKind.ELLIPSE -> {
                gs(ctx, a.opacity)
                a.rect?.let { r ->
                    val outline = if (a.kind == AnnotationKind.RECT) corners(r) else ellipse(r)
                    a.fill?.let { fill(ctx, outline, it) }
                    if (a.strokeWidth > 0) stroke(ctx, outline, a.color, a.strokeWidth, true) else outline.forEach { ctx.pdf(it) }
                }
            }
            AnnotationKind.LINE, AnnotationKind.ARROW -> {
                gs(ctx, a.opacity)
                val p = a.points.orEmpty()
                if (p.size == 2) {
                    stroke(ctx, p, a.color, a.strokeWidth)
                    if (a.kind == AnnotationKind.ARROW) fill(ctx, arrowHead(p[0], p[1], a.strokeWidth), a.color)
                }
            }
            AnnotationKind.INK -> {
                gs(ctx, a.opacity)
                a.paths.orEmpty().forEach { p ->
                    // pen tap: a dot the width of the pen
                    if (p.size == 1) { val r = max(0.5, a.strokeWidth / 2); fill(ctx, ellipse(Box(p[0].x - r, p[0].y - r, r * 2, r * 2), 16), a.color) }
                    else stroke(ctx, p, a.color, a.strokeWidth)
                }
            }
            AnnotationKind.DISTANCE, AnnotationKind.PERIMETER, AnnotationKind.AREA -> {
                val p = a.points.orEmpty()
                if (p.size >= 2) {
                    if (a.kind == AnnotationKind.AREA) { gs(ctx, 0.15); fill(ctx, p, a.color) }
                    gs(ctx, a.opacity)
                    stroke(ctx, p, a.color, a.strokeWidth, a.kind == AnnotationKind.AREA)
                    if (a.kind == AnnotationKind.DISTANCE) {
                        val len = max(hypot(p[1].x - p[0].x, p[1].y - p[0].y), 1.0)
                        val nx = -(p[1].y - p[0].y) / len * 6; val ny = (p[1].x - p[0].x) / len * 6
                        for (e in p.take(2)) stroke(ctx, listOf(Pt(e.x - nx, e.y - ny), Pt(e.x + nx, e.y + ny)), a.color, a.strokeWidth)
                    }
                    val label = Measure.label(a); val c = Measure.labelAnchor(a); val w = label.length * 5.6 + 8
                    val box = Box(c.x - w / 2, c.y - 8, w, 16.0)
                    gs(ctx, 0.9); fill(ctx, corners(box), "#ffffff")
                    gs(ctx, 1.0); text(ctx, label, Box(box.x + 3, box.y + 3, box.w - 6, 10.0), 10.0, a.color, bold = false)
                }
            }
            AnnotationKind.FREETEXT -> a.textBox?.let { box ->
                gs(ctx, a.opacity)
                a.fill?.let { fill(ctx, corners(box), it) }
                a.callout?.takeIf { it.size >= 2 }?.let { cl ->
                    stroke(ctx, corners(box), a.color, a.strokeWidth, true)
                    stroke(ctx, cl, a.color, a.strokeWidth)
                    val end = a.calloutEnd.orEmpty()
                    if ("Closed" in end) fill(ctx, arrowHead(cl[1], cl[0], a.strokeWidth), a.color)
                    else if ("Arrow" in end) arrowHead(cl[1], cl[0], a.strokeWidth).let { h -> stroke(ctx, listOf(h[1], h[0], h[2]), a.color, a.strokeWidth) }
                }
                // Rotated text: lay out upright in the turned box, then turn it about the box centre (counter-clockwise).
                val size = a.fontSize ?: 14.0
                val lay = textLayoutBox(box, a.rotation)
                val at = textOrigin(lay, a.rotation, size, a.text.orEmpty().lines().size)
                a.rotation?.let { deg ->
                    val c = ctx.g.toPdf(Pt(box.x + box.w / 2, box.y + box.h / 2)); val t = Math.toRadians(deg.toDouble())
                    val cs0 = cos(t); val sn = sin(t)
                    cs.transform(Matrix(cs0.toFloat(), sn.toFloat(), (-sn).toFloat(), cs0.toFloat(),
                        (c.x - cs0 * c.x + sn * c.y).toFloat(), (c.y - sn * c.x - cs0 * c.y).toFloat()))
                }
                text(ctx, a.text.orEmpty(), Box(at.x, at.y, lay.w - (at.x - lay.x) * 2, lay.h - (at.y - lay.y) * 2), size, a.color, bold = false)
                a.rect?.let { r -> corners(r).forEach { ctx.pdf(it) } }
            }
            AnnotationKind.NOTE -> a.rect?.let { r ->
                fill(ctx, corners(r), a.color)
                stroke(ctx, corners(r), "#4d4d4d", 0.75, true)
                for ((dy, frac) in listOf(7.0 to 1.0, 12.0 to 1.0, 17.0 to 0.6))
                    stroke(ctx, listOf(Pt(r.x + 5, r.y + dy), Pt(r.x + 5 + (r.w - 10) * frac, r.y + dy)), "#333333", 1.4)
            }
            AnnotationKind.STAMP -> a.rect?.let { r ->
                gs(ctx, a.opacity)
                stroke(ctx, corners(r), a.color, a.strokeWidth, true)
                text(ctx, a.text ?: "APPROVED", r, r.h * 0.55, a.color, bold = true, center = true)
            }
            AnnotationKind.SIGNATURE -> {
                val r = a.rect; val url = a.image
                if (r != null && url != null) decodeDataUrl(url)?.let { bmp -> image(ctx, bmp, r) }
            }
            AnnotationKind.REDACT -> a.rect?.let { r ->
                ctx.cs.setLineDashPattern(floatArrayOf(4f, 2f), 0f)
                stroke(ctx, corners(r), "#ff0000", 1.0, true)
            }
        }
        cs.restoreGraphicsState()
    }

    /** Text that reads upright on screen; non-Latin text is rendered by Android's shaper into an image. */
    private fun text(ctx: Ctx, text: String, box: Box, size: Double, color: String, bold: Boolean, center: Boolean = false) {
        if (text.isEmpty()) return
        val latin = text.all { it == '\n' || it.code in 0x20..0x7e || it.code in 0xa0..0xff }
        if (!latin) {
            image(ctx, renderText(text, size, color, bold), box.copy(h = min(box.h, size * 1.25 * text.lines().size)), keepAspect = true, center = center)
            return
        }
        val font = if (bold) PDType1Font.HELVETICA_BOLD else PDType1Font.HELVETICA
        val c = Rgb.of(color)
        var fs = size
        if (center) {
            val w = font.getStringWidth(text) / 1000 * fs
            if (w > box.w * 0.9) fs *= box.w * 0.9 / w
        }
        text.lines().forEachIndexed { i, line ->
            val lw = font.getStringWidth(line) / 1000 * fs
            val x = if (center) box.x + (box.w - lw) / 2 else box.x
            val baseline = if (center) box.y + box.h / 2 + fs * 0.35 else box.y + fs * (i + 0.85) + fs * 0.15 * i
            val m = basis(ctx.g, Pt(x, baseline))
            ctx.cs.beginText()
            ctx.cs.setFont(font, fs.toFloat())
            ctx.cs.setNonStrokingColor(c.r.toFloat(), c.g.toFloat(), c.b.toFloat())
            ctx.cs.setTextMatrix(m)
            ctx.cs.showText(line)
            ctx.cs.endText()
            ctx.points += ctx.g.toPdf(Pt(x, baseline))
        }
    }

    private fun image(ctx: Ctx, bmp: Bitmap, r: Box, keepAspect: Boolean = false, center: Boolean = false) {
        var box = r
        if (keepAspect) {
            val ratio = bmp.width.toDouble() / bmp.height
            val w = min(r.w, r.h * ratio); val h = w / ratio
            box = Box(if (center) r.x + (r.w - w) / 2 else r.x, r.y + (r.h - h) / 2, w, h)
        }
        val img = LosslessFactory.createFromImage(ctx.doc, bmp)
        // unit square → box, upright as displayed
        val o = ctx.g.toPdf(Pt(box.x, box.maxY)); val px = ctx.g.toPdf(Pt(box.maxX, box.maxY)); val py = ctx.g.toPdf(Pt(box.x, box.y))
        ctx.cs.drawImage(img, Matrix((px.x - o.x).toFloat(), (px.y - o.y).toFloat(), (py.x - o.x).toFloat(), (py.y - o.y).toFloat(), o.x.toFloat(), o.y.toFloat()))
    }

    /** Text matrix whose x axis points "right" and y axis "up" as displayed, origin at `origin` (page units). */
    private fun basis(g: PageGeometry, origin: Pt): Matrix {
        val o = g.toPdf(origin); val r = g.toPdf(Pt(origin.x + 1, origin.y)); val u = g.toPdf(Pt(origin.x, origin.y - 1))
        return Matrix((r.x - o.x).toFloat(), (r.y - o.y).toFloat(), (u.x - o.x).toFloat(), (u.y - o.y).toFloat(), o.x.toFloat(), o.y.toFloat())
    }

    private fun renderText(text: String, size: Double, color: String, bold: Boolean): Bitmap {
        val scale = 4f
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = (size * scale).toFloat()
            this.color = Rgb.of(color).argb()
            typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        }
        val lines = text.lines()
        val lineH = paint.fontSpacing
        val w = max(1, lines.maxOf { paint.measureText(it) }.toInt() + 4)
        val bmp = Bitmap.createBitmap(w, max(1, (lineH * lines.size).toInt() + 4), Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        lines.forEachIndexed { i, l -> canvas.drawText(l, 2f, -paint.ascent() + i * lineH, paint) }
        return bmp
    }

    internal fun decodeDataUrl(url: String): Bitmap? = runCatching {
        val bytes = Base64.decode(url.substringAfter(','), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()

    private fun floats(vararg v: Double) = COSArray().apply { v.forEach { add(COSFloat(it.toFloat())) } }

    @Suppress("unused") private fun ints(vararg v: Int) = COSArray().apply { v.forEach { add(COSInteger.get(it.toLong())) } }
}

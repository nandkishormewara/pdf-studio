package com.pdfstudio.sdk.viewer

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import com.pdfstudio.sdk.Annotation
import com.pdfstudio.sdk.AnnotationKind
import com.pdfstudio.sdk.Box
import com.pdfstudio.sdk.Measure
import com.pdfstudio.sdk.PdfStudio
import com.pdfstudio.sdk.Pt
import com.pdfstudio.sdk.RichText
import com.pdfstudio.sdk.TextRun
import com.pdfstudio.sdk.Rgb
import com.pdfstudio.sdk.textLayoutBox
import com.pdfstudio.sdk.textOrigin
import com.pdfstudio.sdk.pdf.AnnotationWriter
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

/** Draws model annotations onto an Android Canvas whose units are page units × `scale`. */
internal class AnnotationPainter {
    private val images = HashMap<String, Bitmap?>()
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG or Paint.LINEAR_TEXT_FLAG)
    // PorterDuff.Mode.MULTIPLY also multiplies alpha (a see-through hole); BlendMode.MULTIPLY is the PDF blend.
    // Before Android 10, darken is the closest alpha-correct mode: the same over white paper and black text.
    private val multiply = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.DARKEN)

    fun draw(canvas: Canvas, a: Annotation, scale: Float) {
        val alpha = (a.opacity.coerceIn(0.0, 1.0) * 255).toInt()
        val color = Rgb.of(a.color).argb()
        fun P(p: Pt) = floatArrayOf((p.x * scale).toFloat(), (p.y * scale).toFloat())
        fun R(b: Box) = RectF((b.x * scale).toFloat(), (b.y * scale).toFloat(), (b.maxX * scale).toFloat(), (b.maxY * scale).toFloat())
        fun path(points: List<Pt>, close: Boolean = false) = Path().apply {
            points.forEachIndexed { i, p -> val q = P(p); if (i == 0) moveTo(q[0], q[1]) else lineTo(q[0], q[1]) }
            if (close) close()
        }
        stroke.color = color; stroke.alpha = alpha; stroke.strokeWidth = (a.strokeWidth * scale).toFloat(); stroke.pathEffect = null
        fill.color = color; fill.alpha = alpha; fill.xfermode = null

        when (a.kind) {
            // Multiply, as PDFTron, Acrobat and PDFKit draw highlights: the text stays black under an opaque colour.
            // The page must already be on this canvas.
            AnnotationKind.HIGHLIGHT -> {
                if (android.os.Build.VERSION.SDK_INT >= 29) fill.blendMode = android.graphics.BlendMode.MULTIPLY else fill.xfermode = multiply
                a.rects.orEmpty().forEach { canvas.drawRect(R(it), fill) }
                if (android.os.Build.VERSION.SDK_INT >= 29) fill.blendMode = null else fill.xfermode = null
            }
            AnnotationKind.UNDERLINE, AnnotationKind.STRIKEOUT -> {
                stroke.strokeWidth = (max(1.0, a.strokeWidth) * scale).toFloat()
                a.rects.orEmpty().forEach { r ->
                    val y = (if (a.kind == AnnotationKind.UNDERLINE) r.y + r.h * 0.92 else r.y + r.h * 0.55) * scale
                    if (a.subtype == "squiggly") canvas.drawPath(wave(r.x * scale, r.maxX * scale, y, max(1.5, r.h * 0.08) * scale), stroke)
                    else canvas.drawLine((r.x * scale).toFloat(), y.toFloat(), (r.maxX * scale).toFloat(), y.toFloat(), stroke)
                }
            }
            AnnotationKind.RECT, AnnotationKind.ELLIPSE -> a.rect?.let { r ->
                a.fill?.let { fill.color = Rgb.of(it).argb(); fill.alpha = alpha
                    if (a.kind == AnnotationKind.RECT) canvas.drawRect(R(r), fill) else canvas.drawOval(R(r), fill) }
                if (a.strokeWidth > 0) { if (a.kind == AnnotationKind.RECT) canvas.drawRect(R(r), stroke) else canvas.drawOval(R(r), stroke) }
            }
            AnnotationKind.LINE, AnnotationKind.ARROW -> a.points?.takeIf { it.size == 2 }?.let { p ->
                canvas.drawPath(path(p), stroke)
                if (a.kind == AnnotationKind.ARROW) canvas.drawPath(path(arrowHead(p[0], p[1], a.strokeWidth), true), fill)
            }
            AnnotationKind.INK -> a.paths.orEmpty().forEach { p ->
                // a one-point stroke is a pen tap (a dot, a decimal point)
                if (p.size == 1) canvas.drawCircle((p[0].x * scale).toFloat(), (p[0].y * scale).toFloat(), (max(0.5, a.strokeWidth / 2) * scale).toFloat(), fill)
                else canvas.drawPath(path(p), stroke)
            }
            AnnotationKind.DISTANCE, AnnotationKind.PERIMETER, AnnotationKind.AREA -> {
                val p = a.points.orEmpty()
                if (p.size >= 2) {
                    if (a.kind == AnnotationKind.AREA) { fill.alpha = 38; canvas.drawPath(path(p, true), fill); fill.alpha = alpha }
                    canvas.drawPath(path(p, a.kind == AnnotationKind.AREA), stroke)
                    if (a.kind == AnnotationKind.DISTANCE) {
                        val len = max(hypot(p[1].x - p[0].x, p[1].y - p[0].y), 1.0)
                        val nx = -(p[1].y - p[0].y) / len * 6; val ny = (p[1].x - p[0].x) / len * 6
                        p.take(2).forEach { e -> canvas.drawPath(path(listOf(Pt(e.x - nx, e.y - ny), Pt(e.x + nx, e.y + ny))), stroke) }
                    }
                    val label = Measure.label(a); val c = Measure.labelAnchor(a); val w = label.length * 5.6 + 8
                    val box = R(Box(c.x - w / 2, c.y - 8, w, 16.0))
                    fill.color = 0xE6FFFFFF.toInt(); canvas.drawRoundRect(box, 3 * scale, 3 * scale, fill)
                    drawCentered(canvas, label, box, 10 * scale, color, false)
                }
            }
            AnnotationKind.FREETEXT -> a.textBox?.let { box ->
                val callout = a.callout?.takeIf { it.size >= 2 }
                a.fill?.let { fill.color = Rgb.of(it).argb(); fill.alpha = 255; canvas.drawRect(R(box), fill) }
                if (callout != null) {
                    canvas.drawRect(R(box), stroke)
                    canvas.drawPath(path(callout), stroke)
                    val end = a.calloutEnd.orEmpty()
                    if ("Closed" in end) { fill.color = color; fill.alpha = alpha; canvas.drawPath(path(arrowHead(callout[1], callout[0], a.strokeWidth), true), fill) }
                    else if ("Arrow" in end) arrowHead(callout[1], callout[0], a.strokeWidth).let { h -> canvas.drawPath(path(listOf(h[1], h[0], h[2])), stroke) }
                }
                val size = a.fontSize ?: 14.0
                val lay = textLayoutBox(box, a.rotation)
                // wrapped between words at the box's right edge, as WebViewer wraps typed comments
                val first = textOrigin(lay, a.rotation, size, 1)
                val face = PdfStudio.helvetica ?: Typeface.SANS_SERIF
                fun styled(run: TextRun) {
                    text.typeface = Typeface.create(face, when {
                        run.bold && run.italic -> Typeface.BOLD_ITALIC; run.bold -> Typeface.BOLD; run.italic -> Typeface.ITALIC; else -> Typeface.NORMAL
                    })
                    text.isUnderlineText = run.underline
                }
                // Measured at 100 px and scaled: at a 9 px size hinting rounds every glyph up, and lines wrap a word early.
                text.textSize = 100f
                val lines = RichText.wrap(a.richText?.takeIf { it.isNotEmpty() } ?: listOf(TextRun(a.text.orEmpty())), lay.x + lay.w - first.x) { s, run ->
                    styled(run); text.measureText(s) * size / 100.0
                }
                val at = textOrigin(lay, a.rotation, size, lines.size)
                text.textSize = (size * scale).toFloat()
                canvas.save()
                // `rotation` is counter-clockwise; Canvas turns clockwise for positive angles
                a.rotation?.let { canvas.rotate(-it.toFloat(), ((box.x + box.w / 2) * scale).toFloat(), ((box.y + box.h / 2) * scale).toFloat()) }
                text.typeface = face
                val baseline0 = (at.y * scale).toFloat() - text.ascent()
                val spacing = text.fontSpacing
                // bold / italic / underlined / coloured words, line by line, as the web draws them
                lines.forEachIndexed { i, line ->
                    var x = (at.x * scale).toFloat()
                    val y = baseline0 + i * spacing
                    for (run in line) {
                        styled(run)
                        text.color = run.color?.let { Rgb.of(it).argb() } ?: color
                        canvas.drawText(run.text, x, y, text)
                        x += text.measureText(run.text)
                    }
                }
                text.typeface = Typeface.DEFAULT; text.isUnderlineText = false; text.color = color
                canvas.restore()
            }
            AnnotationKind.NOTE -> a.rect?.let { r ->
                val rf = R(r)
                canvas.drawRoundRect(rf, 3 * scale, 3 * scale, fill)
                stroke.color = 0xFF555555.toInt(); stroke.strokeWidth = 0.75f * scale; canvas.drawRoundRect(rf, 3 * scale, 3 * scale, stroke)
                stroke.color = 0xFF333333.toInt(); stroke.strokeWidth = 1.4f * scale
                for ((dy, frac) in listOf(7.0 to 1.0, 12.0 to 1.0, 17.0 to 0.6))
                    canvas.drawLine(((r.x + 5) * scale).toFloat(), ((r.y + dy) * scale).toFloat(), ((r.x + 5 + (r.w - 10) * frac) * scale).toFloat(), ((r.y + dy) * scale).toFloat(), stroke)
            }
            AnnotationKind.STAMP -> a.rect?.let { r ->
                val rf = R(r)
                canvas.drawRoundRect(rf, 4 * scale, 4 * scale, stroke)
                drawCentered(canvas, a.text ?: "APPROVED", rf, (r.h * 0.55 * scale).toFloat(), color, true)
            }
            AnnotationKind.SIGNATURE -> {
                val r = a.rect ?: return
                val bmp = images.getOrPut(a.image.orEmpty()) { a.image?.let(AnnotationWriter::decodeDataUrl) } ?: return
                canvas.drawBitmap(bmp, null, R(r), Paint(Paint.FILTER_BITMAP_FLAG).apply { this.alpha = alpha })
            }
            AnnotationKind.REDACT -> a.rect?.let {
                stroke.color = 0xFFE5484D.toInt(); stroke.strokeWidth = 1.2f * scale
                stroke.pathEffect = DashPathEffect(floatArrayOf(4 * scale, 2 * scale), 0f)
                fill.color = 0x26E5484D; canvas.drawRect(R(it), fill); canvas.drawRect(R(it), stroke)
            }
        }
    }

    /** A squiggly underline from x0 to x1 at y, wave height `amp` (canvas units). */
    private fun wave(x0: Double, x1: Double, y: Double, amp: Double): Path = Path().apply {
        val step = amp * 2
        moveTo(x0.toFloat(), y.toFloat())
        var x = x0; var up = true
        while (x < x1) {
            val nx = minOf(x + step, x1)
            quadTo(((x + nx) / 2).toFloat(), (if (up) y - amp else y + amp).toFloat(), nx.toFloat(), y.toFloat())
            x = nx; up = !up
        }
    }

    private fun drawCentered(canvas: Canvas, s: String, box: RectF, size: Float, color: Int, bold: Boolean) {
        text.color = color; text.typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT; text.textSize = size
        val w = text.measureText(s)
        if (w > box.width() * 0.9f) text.textSize = size * box.width() * 0.9f / w
        canvas.drawText(s, box.centerX() - text.measureText(s) / 2, box.centerY() - (text.ascent() + text.descent()) / 2, text)
    }

    private fun arrowHead(a: Pt, b: Pt, width: Double): List<Pt> {
        val len = max(8.0, width * 4); val ang = atan2(b.y - a.y, b.x - a.x); val s = Math.PI / 7
        return listOf(b, Pt(b.x - len * cos(ang - s), b.y - len * sin(ang - s)), Pt(b.x - len * cos(ang + s), b.y - len * sin(ang + s)))
    }
}

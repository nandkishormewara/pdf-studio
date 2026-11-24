package com.pdfstudio.sdk

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min

/** A point in PDF user space (bottom-left origin, unrotated). */
data class PdfPoint(val x: Double, val y: Double)

/** A rectangle in PDF user space. */
data class PdfRect(val left: Double, val bottom: Double, val right: Double, val top: Double) {
    val width get() = right - left
    val height get() = top - bottom
}

/**
 * Converts between page units (top-left origin, rotation applied — the shared model) and PDF user
 * space. Mirrors PDF.js `PageViewport` at scale 1; verified against mobile/shared/geometry-vectors.json.
 */
class PageGeometry(val crop: PdfRect, rotation: Int) {
    val rotation: Int = ((rotation % 360) + 360) % 360

    /** Page size as displayed, in points. */
    val width get() = if (rotation % 180 == 0) crop.width else crop.height
    val height get() = if (rotation % 180 == 0) crop.height else crop.width

    fun toPage(p: PdfPoint): Pt = when (rotation) {
        90 -> Pt(p.y - crop.bottom, p.x - crop.left)
        180 -> Pt(crop.right - p.x, p.y - crop.bottom)
        270 -> Pt(crop.top - p.y, crop.right - p.x)
        else -> Pt(p.x - crop.left, crop.top - p.y)
    }

    fun toPdf(p: Pt): PdfPoint = when (rotation) {
        90 -> PdfPoint(p.y + crop.left, p.x + crop.bottom)
        180 -> PdfPoint(crop.right - p.x, p.y + crop.bottom)
        270 -> PdfPoint(crop.right - p.y, crop.top - p.x)
        else -> PdfPoint(p.x + crop.left, crop.top - p.y)
    }

    fun toPdf(b: Box): PdfRect {
        val a = toPdf(Pt(b.x, b.y)); val c = toPdf(Pt(b.maxX, b.maxY))
        return PdfRect(min(a.x, c.x), min(a.y, c.y), maxOf(a.x, c.x), maxOf(a.y, c.y))
    }

    fun toPage(r: PdfRect): Box = Box.spanning(toPage(PdfPoint(r.left, r.bottom)), toPage(PdfPoint(r.right, r.top)))
}

/**
 * A drawing scale: [paperValue] [paperUnit] on the page stands for [worldValue] [worldUnit] in the real world
 * ("1 cm = 2.5 m"). Same as the web SDK's `ScaleSetting` (web/src/sdk/measure.ts); the default is 1 in = 1 in.
 */
data class ScaleSetting(
    val paperValue: Double = 1.0,
    val paperUnit: String = "in",
    val worldValue: Double = 1.0,
    val worldUnit: String = "in",
    val precision: Int = 2,
) {
    /** The [MeasureScale] stored on new measurements: real-world units per PDF point. */
    fun toMeasureScale() = MeasureScale(
        factor = worldValue / (paperValue * (Measure.PAPER_UNITS[paperUnit] ?: 72.0)),
        unit = worldUnit, precision = precision,
    )

    /** "1 in = 1 in", as the web shows it. */
    fun describe(): String = "${num(paperValue)} $paperUnit = ${num(worldValue)} $worldUnit"

    private fun num(v: Double) = if (v % 1.0 == 0.0) v.toLong().toString() else v.toString()
}

/** Measurement maths shared with the web/iOS SDKs. */
object Measure {
    /** PDF points per unit of paper measurement. */
    val PAPER_UNITS = mapOf("in" to 72.0, "cm" to 72 / 2.54, "mm" to 72 / 25.4, "pt" to 1.0)
    val WORLD_UNITS = listOf("in", "ft", "yd", "mi", "mm", "cm", "m", "km", "pt")

    fun length(pts: List<Pt>, closed: Boolean = false): Double {
        var total = pts.zipWithNext { a, b -> hypot(b.x - a.x, b.y - a.y) }.sum()
        if (closed && pts.size > 2) total += hypot(pts.first().x - pts.last().x, pts.first().y - pts.last().y)
        return total
    }

    fun area(pts: List<Pt>): Double {
        if (pts.size < 3) return 0.0
        var s = 0.0
        for (i in pts.indices) { val a = pts[i]; val b = pts[(i + 1) % pts.size]; s += a.x * b.y - b.x * a.y }
        return abs(s) / 2
    }

    fun value(a: Annotation): Double {
        val m = a.measure ?: return 0.0
        val pts = a.points ?: emptyList()
        return if (a.kind == AnnotationKind.AREA) area(pts) * m.factor * m.factor else length(pts) * m.factor
    }

    fun label(a: Annotation): String {
        val m = a.measure ?: return ""
        val v = String.format(java.util.Locale.US, "%.${maxOf(0, m.precision)}f", value(a))
        return if (a.kind == AnnotationKind.AREA) "$v ${m.unit}²" else "$v ${m.unit}"
    }

    fun labelAnchor(a: Annotation): Pt {
        val pts = a.points ?: return Pt(0.0, 0.0)
        if (pts.isEmpty()) return Pt(0.0, 0.0)
        return when {
            a.kind == AnnotationKind.AREA -> Pt(pts.sumOf { it.x } / pts.size, pts.sumOf { it.y } / pts.size)
            a.kind == AnnotationKind.DISTANCE && pts.size >= 2 -> Pt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2 - 6)
            else -> Pt(pts.last().x, pts.last().y - 8)
        }
    }
}

/** `#rrggbb` <-> components (0..1). */
data class Rgb(val r: Double, val g: Double, val b: Double) {
    val hex: String
        get() = "#%02x%02x%02x".format((r.coerceIn(0.0, 1.0) * 255).toInt(), (g.coerceIn(0.0, 1.0) * 255).toInt(), (b.coerceIn(0.0, 1.0) * 255).toInt())

    /** 0xAARRGGBB for Android `Color`. */
    fun argb(alpha: Double = 1.0): Int =
        ((alpha.coerceIn(0.0, 1.0) * 255).toInt() shl 24) or ((r * 255).toInt() shl 16) or ((g * 255).toInt() shl 8) or (b * 255).toInt()

    companion object {
        fun of(hex: String): Rgb {
            val n = hex.trim().removePrefix("#").toLongOrNull(16) ?: 0
            return Rgb(((n shr 16) and 0xff) / 255.0, ((n shr 8) and 0xff) / 255.0, (n and 0xff) / 255.0)
        }
    }
}

package com.pdfstudio.sdk

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** A point in page units: PDF points, origin at the top-left of the page as displayed (rotation applied). */
data class Pt(val x: Double, val y: Double)

/** A rectangle in page units. Matches the web/iOS JSON keys `x`, `y`, `w`, `h`. */
data class Box(val x: Double, val y: Double, val w: Double, val h: Double) {
    val maxX get() = x + w
    val maxY get() = y + h
    fun inset(d: Double) = Box(x + d, y + d, max(0.0, w - 2 * d), max(0.0, h - 2 * d))
    fun contains(p: Pt) = p.x in x..maxX && p.y in y..maxY
    fun translated(dx: Double, dy: Double) = copy(x = x + dx, y = y + dy)

    companion object {
        fun spanning(a: Pt, b: Pt) = Box(min(a.x, b.x), min(a.y, b.y), abs(a.x - b.x), abs(a.y - b.y))
        fun bounding(points: List<Pt>): Box? {
            if (points.isEmpty()) return null
            val x0 = points.minOf { it.x }; val y0 = points.minOf { it.y }
            return Box(x0, y0, points.maxOf { it.x } - x0, points.maxOf { it.y } - y0)
        }
        fun union(boxes: List<Box>): Box? =
            bounding(boxes.flatMap { listOf(Pt(it.x, it.y), Pt(it.maxX, it.maxY)) })
    }
}

enum class AnnotationKind(val json: String) {
    HIGHLIGHT("highlight"), UNDERLINE("underline"), STRIKEOUT("strikeout"), RECT("rect"), ELLIPSE("ellipse"),
    LINE("line"), ARROW("arrow"), INK("ink"), FREETEXT("freetext"), NOTE("note"), STAMP("stamp"), SIGNATURE("signature"),
    DISTANCE("distance"), PERIMETER("perimeter"), AREA("area"), REDACT("redact");

    val isTextMarkup get() = this == HIGHLIGHT || this == UNDERLINE || this == STRIKEOUT
    val isMeasurement get() = this == DISTANCE || this == PERIMETER || this == AREA

    companion object {
        fun fromJson(s: String) = entries.firstOrNull { it.json == s }
    }
}

enum class ReviewStatus(val json: String) {
    NONE("none"), ACCEPTED("accepted"), REJECTED("rejected"), COMPLETED("completed");

    companion object {
        fun fromJson(s: String?) = entries.firstOrNull { it.json == s } ?: NONE
    }
}

/** Real-world units per PDF point. */
data class MeasureScale(val factor: Double, val unit: String, val precision: Int)

/** One annotation — field-for-field compatible with the web and iOS SDKs (docs/file-formats.md). */
data class Annotation(
    val id: String = newId(),
    val page: Int,
    val kind: AnnotationKind,
    val color: String,
    val opacity: Double = 1.0,
    val strokeWidth: Double = 2.0,
    val rect: Box? = null,
    val rects: List<Box>? = null,
    val points: List<Pt>? = null,
    val measure: MeasureScale? = null,
    val paths: List<List<Pt>>? = null,
    val text: String? = null,
    val fontSize: Double? = null,
    val image: String? = null,
    val comment: String? = null,
    /** Interior colour: rect, ellipse; background of a freetext box. Drawn at `opacity`. */
    val fill: String? = null,
    /** freetext: text turned counter-clockwise by this many degrees as displayed (0, 90, 180, 270) */
    val rotation: Int? = null,
    /** freetext: text box inset from `rect` (left, top, right, bottom), e.g. room for a callout line */
    val inset: List<Double>? = null,
    /** freetext callout leader: [tip at the target, optional knee, end at the text box] */
    val callout: List<Pt>? = null,
    /** freetext callout tip ending as in PDF /LE: OpenArrow, ClosedArrow, None … */
    val calloutEnd: String? = null,
    /** freetext intent kept for round trips: FreeTextTypewriter, FreeTextCallout */
    val intent: String? = null,
    /** freetext: styled runs (bold, italic, underline, colour per word); [text] keeps the plain text */
    val richText: List<TextRun>? = null,
    /** underline drawn as a wave: "squiggly" (XFDF `<squiggly>`, the web's ViewerAnnotation.subtype) */
    val subtype: String? = null,
    val status: ReviewStatus = ReviewStatus.NONE,
    val author: String,
    val createdAt: String = now(),
    val modifiedAt: String = createdAt,
) {
    /** Bounding box in page units. */
    val bounds: Box
        get() {
            rect?.let { return it }
            rects?.let { r -> Box.union(r)?.let { return it } }
            val all = (points ?: emptyList()) + (paths?.flatten() ?: emptyList())
            val b = Box.bounding(all) ?: return Box(0.0, 0.0, 0.0, 0.0)
            val pad = strokeWidth / 2
            return Box(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad)
        }

    fun translated(dx: Double, dy: Double) = copy(
        rect = rect?.translated(dx, dy),
        rects = rects?.map { it.translated(dx, dy) },
        points = points?.map { Pt(it.x + dx, it.y + dy) },
        paths = paths?.map { p -> p.map { Pt(it.x + dx, it.y + dy) } },
        callout = callout?.map { Pt(it.x + dx, it.y + dy) },
    )

    /** A freetext's text box: its rect less `inset` (room left for a callout line). */
    val textBox: Box?
        get() {
            val r = rect ?: return null
            val i = inset?.takeIf { it.size == 4 } ?: return r
            return Box(r.x + i[0], r.y + i[1], max(1.0, r.w - i[0] - i[2]), max(1.0, r.h - i[1] - i[3]))
        }

    companion object {
        fun newId() = UUID.randomUUID().toString().replace("-", "").take(12)
        fun now(): String = isoFormat().format(Date())

        fun isoFormat() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

        fun parseIso(s: String): Date? =
            runCatching { isoFormat().parse(s) }.getOrNull()
                ?: runCatching { SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).parse(s) }.getOrNull()
    }
}

/** Where to lay out text so that, turned by `rotation` about the box centre, it fills the box. */
fun textLayoutBox(box: Box, rotation: Int?): Box {
    if ((rotation ?: 0) % 180 == 0) return box
    val cx = box.x + box.w / 2; val cy = box.y + box.h / 2
    return Box(cx - box.h / 2, cy - box.w / 2, box.h, box.w)
}

/**
 * Top-left of the first line inside a layout box. Upright text keeps the 4-unit padding; turned text (Apryse sizes
 * those boxes tightly to the text) is padded only as far as the box allows, so it stays inside. Same as the web SDK.
 */
fun textOrigin(lay: Box, rotation: Int?, size: Double, lines: Int): Pt {
    if ((rotation ?: 0) == 0) return Pt(lay.x + 4, lay.y + 4)
    fun room(span: Double, used: Double) = min(4.0, max(0.0, (span - used) / 2))
    return Pt(lay.x + room(lay.w, size * 0.6), lay.y + room(lay.h, size * 1.15 * lines))
}

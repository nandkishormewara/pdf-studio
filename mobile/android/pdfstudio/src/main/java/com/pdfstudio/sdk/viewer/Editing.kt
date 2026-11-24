package com.pdfstudio.sdk.viewer

import com.pdfstudio.sdk.Annotation
import com.pdfstudio.sdk.AnnotationKind
import com.pdfstudio.sdk.Box
import com.pdfstudio.sdk.MeasureScale
import com.pdfstudio.sdk.Pt
import com.pdfstudio.sdk.ReviewStatus
import kotlin.math.max
import kotlin.math.min

/** Viewer tools. Drag tools draw while the finger moves; tap tools ask for text where the page is tapped. */
internal enum class Tool(val label: String, val drag: Boolean = true) {
    VIEW("Select", drag = false), PEN("Pen"), HIGHLIGHTER("Highlighter"), RECT("Box"), ELLIPSE("Oval"),
    LINE("Line"), ARROW("Arrow"), TEXT("Text", drag = false), NOTE("Note", drag = false),
    DISTANCE("Distance"), PERIMETER("Perimeter", drag = false), AREA("Area", drag = false);

    val asksForText get() = this == TEXT || this == NOTE
    /** Tap to add points, then finish (Done, or tap the first point). */
    val placesPoints get() = this == PERIMETER || this == AREA
    val measures get() = this == DISTANCE || placesPoints
}

/** The colours offered for new marks, as on the web toolbar. */
internal val MARK_COLORS = listOf("#e5484d", "#1f6feb", "#2f9e44", "#7c3aed", "#111111", "#ffd84d")

/** Pure editing rules for the Android viewer: what each tool makes, which mark a tap picks, undo. */
internal object Editing {
    const val NOTE_SIZE = 22.0
    const val TEXT_SIZE = 14.0

    /** The mark a drag with [tool] makes from [pts] (page units), or null when the drag is too small. */
    fun shape(tool: Tool, page: Int, pts: List<Pt>, color: String, author: String, measure: MeasureScale? = null): Annotation? {
        if (pts.size < 2) return null
        val a = pts.first(); val b = pts.last()
        val span = Box.spanning(a, b)
        return when (tool) {
            Tool.PEN -> Annotation(page = page, kind = AnnotationKind.INK, color = color, strokeWidth = 2.0, paths = listOf(pts), author = author)
            Tool.HIGHLIGHTER -> Annotation(page = page, kind = AnnotationKind.INK, color = "#ffd84d", opacity = 0.45, strokeWidth = 12.0, paths = listOf(pts), author = author)
            Tool.RECT, Tool.ELLIPSE -> if (span.w < 3 && span.h < 3) null else Annotation(
                page = page, kind = if (tool == Tool.RECT) AnnotationKind.RECT else AnnotationKind.ELLIPSE,
                color = color, strokeWidth = 2.0, rect = span, author = author,
            )
            Tool.LINE, Tool.ARROW -> if (kotlin.math.hypot(b.x - a.x, b.y - a.y) < 4) null else Annotation(
                page = page, kind = if (tool == Tool.LINE) AnnotationKind.LINE else AnnotationKind.ARROW,
                color = color, strokeWidth = 2.0, points = listOf(a, b), author = author,
            )
            Tool.DISTANCE -> if (measure == null || kotlin.math.hypot(b.x - a.x, b.y - a.y) < 4) null else Annotation(
                page = page, kind = AnnotationKind.DISTANCE, color = color, strokeWidth = 2.0, points = listOf(a, b), measure = measure, author = author,
            )
            Tool.VIEW, Tool.TEXT, Tool.NOTE, Tool.PERIMETER, Tool.AREA -> null
        }
    }

    /**
     * The perimeter or area measurement through the tapped [pts], or null with too few points (2 for a perimeter,
     * 3 for an area). Points within 2 units of the previous one (a double tap) count once. Same as the web viewer.
     */
    fun polygon(tool: Tool, page: Int, pts: List<Pt>, color: String, author: String, measure: MeasureScale): Annotation? {
        val clean = pts.filterIndexed { i, p -> i == 0 || kotlin.math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 2 }
        val kind = when (tool) { Tool.PERIMETER -> AnnotationKind.PERIMETER; Tool.AREA -> AnnotationKind.AREA; else -> return null }
        if (clean.size < (if (kind == AnnotationKind.AREA) 3 else 2)) return null
        return Annotation(page = page, kind = kind, color = color, strokeWidth = 2.0, points = clean, measure = measure, author = author)
    }

    /** True when a tap at [p] closes the shape: it lands within [slop] units of the first of at least 3 [pts]. */
    fun closesPolygon(pts: List<Pt>, p: Pt, slop: Double): Boolean =
        pts.size >= 3 && kotlin.math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= slop

    /**
     * A text box with its top-left at [at], sized to [text] (14 pt, about 0.55 em per character) and kept on a page
     * [pageWidth] × [pageHeight] units.
     */
    fun textBox(page: Int, at: Pt, text: String, color: String, author: String, pageWidth: Double, pageHeight: Double): Annotation? {
        val clean = text.trimEnd()
        if (clean.isBlank()) return null
        val lines = clean.lines()
        val w = min(pageWidth - 8, max(60.0, lines.maxOf { it.length } * TEXT_SIZE * 0.55 + 12))
        val h = lines.size * TEXT_SIZE * 1.2 + 8
        val x = at.x.coerceIn(4.0, max(4.0, pageWidth - w - 4))
        val y = at.y.coerceIn(4.0, max(4.0, pageHeight - h - 4))
        return Annotation(
            page = page, kind = AnnotationKind.FREETEXT, color = color, strokeWidth = 0.0,
            rect = Box(x, y, w, h), text = clean, fontSize = TEXT_SIZE, author = author,
        )
    }

    /** A sticky note centred on [at] carrying [comment]. */
    fun note(page: Int, at: Pt, comment: String, author: String, pageWidth: Double, pageHeight: Double): Annotation? {
        if (comment.isBlank()) return null
        val s = NOTE_SIZE
        val x = (at.x - s / 2).coerceIn(0.0, max(0.0, pageWidth - s))
        val y = (at.y - s / 2).coerceIn(0.0, max(0.0, pageHeight - s))
        return Annotation(page = page, kind = AnnotationKind.NOTE, color = "#ffcd45", rect = Box(x, y, s, s), comment = comment.trim(), author = author)
    }

    /**
     * The mark under [p] on [page]: of the marks whose bounds (grown by [slop] units, so thin lines can be hit) contain
     * the point, the one with the smallest area, so a small mark inside a big box stays reachable. Later marks win ties.
     */
    fun hit(annotations: List<Annotation>, page: Int, p: Pt, slop: Double = 8.0): Annotation? =
        annotations.withIndex()
            .filter { (_, a) -> a.page == page && a.bounds.inset(-slop).contains(p) }
            .minWithOrNull(compareBy<IndexedValue<Annotation>> { (_, a) -> a.bounds.w * a.bounds.h }.thenByDescending { it.index })
            ?.value

    /** [a] with a new comment and review status, stamped as modified now. Unchanged values return [a] itself. */
    fun annotate(a: Annotation, comment: String?, status: ReviewStatus): Annotation {
        val c = comment?.trim()?.ifEmpty { null }
        if (c == a.comment && status == a.status) return a
        return a.copy(comment = c, status = status, modifiedAt = Annotation.now())
    }

    /** Short name of a mark for the details sheet. */
    fun title(a: Annotation): String = when (a.kind) {
        AnnotationKind.HIGHLIGHT -> "Highlight"; AnnotationKind.UNDERLINE -> if (a.subtype == "squiggly") "Squiggly" else "Underline"
        AnnotationKind.STRIKEOUT -> "Strikeout"; AnnotationKind.RECT -> "Box"; AnnotationKind.ELLIPSE -> "Oval"
        AnnotationKind.LINE -> "Line"; AnnotationKind.ARROW -> "Arrow"; AnnotationKind.INK -> "Drawing"
        AnnotationKind.FREETEXT -> "Text"; AnnotationKind.NOTE -> "Note"; AnnotationKind.STAMP -> "Stamp"
        AnnotationKind.SIGNATURE -> "Signature"; AnnotationKind.DISTANCE -> "Distance"; AnnotationKind.PERIMETER -> "Perimeter"
        AnnotationKind.AREA -> "Area"; AnnotationKind.REDACT -> "Redaction mark"
    }
}

/** Undo for the viewer: snapshots (the mark list, and the pages when they change) taken before each change. */
internal class EditHistory<T>(private val limit: Int = 100) {
    private val past = ArrayDeque<T>()
    val canUndo get() = past.isNotEmpty()

    fun record(before: T) {
        past.addLast(before)
        while (past.size > limit) past.removeFirst()
    }

    /** The state to go back to, or null when there is nothing to undo. */
    fun undo(): T? = past.removeLastOrNull()
}

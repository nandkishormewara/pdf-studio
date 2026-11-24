package com.pdfstudio.sdk

import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.StringReader
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.math.round
import org.xml.sax.InputSource

/** Result of reading XFDF. */
data class XfdfImport(
    val annotations: List<Annotation>,
    /** ids from `<modify>`: replace existing annotations with the same id. */
    val modifiedIds: Set<String>,
    /** ids from `<delete>`. */
    val deletedIds: List<String>,
    /** form field values, by full field name */
    val fields: Map<String, List<String>>,
    /** The file was cut off; only the annotations written completely were read. */
    val partial: Boolean = false,
)

/**
 * XFDF import/export compatible with Acrobat, the web/iOS SDKs and Apryse (PDFTron) WebViewer —
 * including `<add>/<modify>/<delete>`, `TextColor`/`FontSize`, squiggly and `<imagedata>` stamps.
 */
object Xfdf {
    fun parse(xml: String, geometry: (Int) -> PageGeometry?): XfdfImport {
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            // No external entities: XFDF comes from the network.
            runCatching { setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
            isExpandEntityReferences = false
        }
        var partial = false
        val doc = runCatching { factory.newDocumentBuilder().parse(InputSource(StringReader(xml))) }.getOrElse { error ->
            // Stored markup cut off mid-write: keep the annotations written completely (see repair).
            val repaired = repair(xml) ?: throw error
            partial = true
            factory.newDocumentBuilder().parse(InputSource(StringReader(repaired)))
        }
        val root = doc.documentElement
        require(root.localName == "xfdf") { "Invalid XFDF: root element is <${root.localName}>" }

        val fields = mutableMapOf<String, List<String>>()
        root.descendants("fields").forEach { fs -> fs.childElements("field").forEach { collectField(it, "", fields) } }

        val annotations = mutableListOf<Annotation>()
        val modified = mutableSetOf<String>()
        val deleted = mutableListOf<String>()
        // Apryse comment replies (<text inreplyto="…">, not replyType="group") join the parent's comment.
        val all = root.childElements().filter { it.localName in setOf("annots", "add", "modify") }.flatMap { it.childElements() }
        val names = all.mapNotNull { it.attr("name") }.toSet()
        val replies = all.filter { it.attr("inreplyto") in names && it.attr("replyType") != "group" }
        val replyText = replies.groupBy { it.attr("inreplyto")!! }.mapValues { (_, rs) ->
            rs.mapNotNull { r -> r.firstDescendant("contents")?.textContent?.trim()?.takeIf { it.isNotEmpty() }?.let { "${r.attr("title") ?: "Reply"}: $it" } }
        }
        fun read(el: Element) = if (el in replies) null else annotation(el, geometry)?.let { a ->
            val extra = replyText[a.id].orEmpty()
            if (extra.isEmpty()) a else a.copy(comment = (listOfNotNull(a.comment) + extra).joinToString("\n"))
        }
        for (container in root.childElements()) {
            when (container.localName) {
                "annots", "add" -> annotations += container.childElements().mapNotNull(::read)
                "modify" -> container.childElements().mapNotNull(::read).also { mods ->
                    modified += mods.map { it.id }; annotations += mods
                }
                "delete" -> deleted += container.childElements("id").map { it.textContent.trim() }
            }
        }
        return XfdfImport(annotations, modified, deleted, fields, partial)
    }

    // not popup: it sits inside other annotations, so it can close inside one that was cut off
    private val annotEnd = Regex("""</(?:\w+:)?(?:text|link|freetext|line|square|circle|polygon|polyline|highlight|underline|squiggly|strikeout|stamp|caret|ink|fileattachment|sound|redact)>""")

    /**
     * A file cut off mid-write (seen on stored Apryse markup) is not valid XML. Keeps every annotation written
     * completely and closes the document. Null when nothing is left. Same as the web SDK's repairXfdf.
     */
    fun repair(xml: String): String? {
        val annotsAt = Regex("""<(?:\w+:)?annots[\s>]""").find(xml)?.range?.first ?: return null
        val last = annotEnd.findAll(xml).lastOrNull() ?: return null
        if (last.range.last < annotsAt) return null
        return xml.substring(0, last.range.last + 1) + "</annots></xfdf>"
    }

    /**
     * True when an imported mark is a copy of a mark already in the file: marks made without a name (Apple Markup,
     * for one) have no /NM and Apryse exports them unnamed, so they cannot be matched by id. Same as the web SDK.
     */
    private fun sameMark(a: Annotation, b: Annotation): Boolean {
        val r = a.rect ?: return false; val q = b.rect ?: return false
        if (a.kind != b.kind || a.page != b.page || (a.text ?: "").trim() != (b.text ?: "").trim()) return false
        fun near(p: Double, o: Double) = kotlin.math.abs(p - o) <= 1.5
        return near(r.x, q.x) && near(r.y, q.y) && near(r.maxX, q.maxX) && near(r.maxY, q.maxY)
    }

    /** Applies an import to an existing list (delete, replace by id or same unnamed mark, append). */
    fun merge(existing: List<Annotation>, imp: XfdfImport): List<Annotation> {
        val next = existing.filter { it.id !in imp.deletedIds }.toMutableList()
        val fromFile = next.map { it.id }.toMutableSet()
        for (a in imp.annotations) {
            var i = next.indexOfFirst { it.id == a.id }
            if (i < 0) i = next.indexOfFirst { it.id in fromFile && sameMark(it, a) }
            if (i >= 0) { fromFile -= next[i].id; next[i] = a } else next += a
        }
        return next
    }

    private fun collectField(node: Element, prefix: String, into: MutableMap<String, List<String>>) {
        val name = if (prefix.isEmpty()) node.getAttribute("name") else "$prefix.${node.getAttribute("name")}"
        val values = node.childElements("value").map { it.textContent }
        if (values.isNotEmpty()) into[name] = values
        node.childElements("field").forEach { collectField(it, name, into) }
    }

    private fun annotation(el: Element, geometry: (Int) -> PageGeometry?): Annotation? {
        val flags = el.attr("flags").orEmpty().lowercase().split(',').map { it.trim() }
        if ("hidden" in flags || "noview" in flags) return null
        val page = el.attr("page")?.toIntOrNull() ?: 0
        val g = geometry(page) ?: return null

        fun pt(x: Double, y: Double) = g.toPage(PdfPoint(x, y))
        fun numbers(s: String?) = s.orEmpty().split(',', ';', ' ', '\n', '\t').mapNotNull { it.trim().toDoubleOrNull() }
        fun pairs(v: List<Double>) = (0 until v.size / 2).map { pt(v[it * 2], v[it * 2 + 1]) }

        val r = numbers(el.attr("rect"))
        val rect = if (r.size == 4) Box.spanning(pt(r[0], r[1]), pt(r[2], r[3])) else Box(0.0, 0.0, 0.0, 0.0)
        val contents = el.firstDescendant("contents")?.textContent.orEmpty()
        val date = pdfDateToIso(el.attr("date")) ?: Annotation.now()
        var a = Annotation(
            id = el.attr("name")?.takeIf { it.isNotEmpty() } ?: Annotation.newId(),
            page = page, kind = AnnotationKind.RECT,
            color = (el.attr("color") ?: "#e5484d").lowercase(),
            opacity = el.attr("opacity")?.toDoubleOrNull() ?: 1.0,
            strokeWidth = el.attr("width")?.toDoubleOrNull() ?: 1.0,
            comment = contents.ifEmpty { null },
            status = ReviewStatus.fromJson(el.attr("pdfstudio-status")),
            author = el.attr("title")?.takeIf { it.isNotEmpty() } ?: "Unknown",
            createdAt = pdfDateToIso(el.attr("creationdate")) ?: date,
            modifiedAt = date,
            measure = el.attr("pdfstudio-measure")?.let { m ->
                AnnotationJson.decode("""{"id":"m","page":0,"kind":"distance","color":"#000000","status":"none","author":"x","measure":$m}""")?.measure
            },
        )

        when (el.localName) {
            "highlight", "underline", "strikeout", "squiggly" -> {
                val kind = when (el.localName) {
                    "highlight" -> AnnotationKind.HIGHLIGHT
                    "strikeout" -> AnnotationKind.STRIKEOUT
                    else -> AnnotationKind.UNDERLINE
                }
                val c = numbers(el.attr("coords"))
                val rects = (0 until c.size / 8).mapNotNull { Box.bounding(pairs(c.subList(it * 8, it * 8 + 8))) }
                a = a.copy(kind = kind, rects = rects.ifEmpty { listOf(rect) },
                    opacity = if (kind == AnnotationKind.HIGHLIGHT) minOf(a.opacity, 0.45) else a.opacity,
                    subtype = if (el.localName == "squiggly") "squiggly" else null)
            }
            "square", "circle" -> a = a.copy(kind = if (el.localName == "square") AnnotationKind.RECT else AnnotationKind.ELLIPSE, rect = rect,
                fill = el.attr("interior-color")?.lowercase())
            "line" -> {
                val s = numbers(el.attr("start")); val e = numbers(el.attr("end"))
                if (s.size < 2 || e.size < 2) return null
                val endings = el.attr("head").orEmpty() + el.attr("tail").orEmpty()
                a = when {
                    el.attr("intent") == "LineDimension" && a.measure != null ->
                        a.copy(kind = AnnotationKind.DISTANCE, points = listOf(pt(s[0], s[1]), pt(e[0], e[1])), comment = null)
                    else -> a.copy(kind = if ("Arrow" in endings) AnnotationKind.ARROW else AnnotationKind.LINE, points = listOf(pt(s[0], s[1]), pt(e[0], e[1])))
                }
            }
            "polyline", "polygon" -> {
                val pts = pairs(numbers(el.firstDescendant("vertices")?.textContent))
                if (pts.size < 2) return null
                a = if (a.measure != null) {
                    a.copy(kind = if (el.localName == "polygon") AnnotationKind.AREA else AnnotationKind.PERIMETER, points = pts, comment = null)
                } else {
                    a.copy(kind = AnnotationKind.INK, paths = listOf(if (el.localName == "polygon") pts + pts[0] else pts))
                }
            }
            "ink" -> {
                // keep one-point strokes: they are pen taps (dots, decimal points) and are drawn as dots
                val paths = el.descendants("gesture").map { pairs(numbers(it.textContent)) }.filter { it.isNotEmpty() }
                if (paths.isEmpty()) return null
                a = a.copy(kind = AnnotationKind.INK, paths = paths)
            }
            "freetext" -> {
                val da = el.firstDescendant("defaultappearance")?.textContent.orEmpty()
                val style = el.firstDescendant("defaultstyle")?.textContent.orEmpty()
                val size = el.attr("FontSize")?.toDoubleOrNull()
                    ?: Regex("""([\d.]+)\s*Tf""").find(da)?.groupValues?.get(1)?.toDoubleOrNull()
                    ?: Regex("""([\d.]+)pt""").find(style)?.groupValues?.get(1)?.toDoubleOrNull() ?: 12.0
                val color = el.attr("TextColor") ?: Regex("""color:\s*(#[0-9a-fA-F]{6})""").find(style)?.groupValues?.get(1) ?: "#111111"
                // Bold / italic / coloured words, as in the web SDK: kept only when they add styling to the plain text
                val runs = el.firstDescendant("contents-richtext")?.let { RichText.fromXhtml(it) }?.let { RichText.relativeTo(it, color.lowercase()) }
                val plain = el.firstDescendant("contents")?.textContent ?: runs?.let(RichText::plainText) ?: contents
                a = freeTextExtras(el, g, rect, color.lowercase(), a.copy(kind = AnnotationKind.FREETEXT, rect = rect, text = plain,
                    comment = el.attr("pdfstudio-comment"), fontSize = size, color = color.lowercase(), opacity = 1.0,
                    richText = runs?.takeUnless { RichText.isPlain(it, color) }))
            }
            "text" -> a = a.copy(kind = AnnotationKind.NOTE, rect = Box(rect.x, rect.y, 22.0, 22.0), opacity = 1.0,
                color = el.attr("color")?.lowercase() ?: "#ffd84d")
            "stamp" -> {
                val image = el.firstDescendant("imagedata")?.textContent?.trim()
                a = if (image != null && image.startsWith("data:image/")) {
                    a.copy(kind = AnnotationKind.SIGNATURE, rect = rect, image = image, color = "#000000", opacity = 1.0, comment = null)
                } else {
                    a.copy(kind = AnnotationKind.STAMP, rect = rect, comment = null, strokeWidth = 2.5,
                        text = contents.ifEmpty { (el.attr("icon") ?: el.attr("subject") ?: "Approved").uppercase() })
                }
            }
            "redact" -> a = a.copy(kind = AnnotationKind.REDACT, rect = rect, color = "#e5484d")
            else -> return null
        }
        return a
    }

    /** Background, rotation, callout and text-box insets of a <freetext>, as Apryse WebViewer and Acrobat write them. */
    private fun freeTextExtras(el: Element, g: PageGeometry, rect: Box, textColor: String, a: Annotation): Annotation {
        fun numbers(s: String?) = s.orEmpty().split(',', ';', ' ').mapNotNull { it.trim().toDoubleOrNull() }
        val intent = el.attr("IT") ?: el.attr("intent")
        // `color` is the box background when the text colour is carried separately (TextColor or the default style);
        // in PDF Studio's older files without those, `color` was the text colour. Apryse never fills typewriter text.
        val bg = el.attr("color")?.lowercase()
        val separateText = el.hasAttribute("TextColor") || el.childElements("defaultstyle").isNotEmpty()
        val fill = bg.takeIf { it != null && separateText && intent != "FreeTextTypewriter" && it != textColor }
        val rotation = ((((el.attr("rotation")?.toDoubleOrNull()?.toInt() ?: 0) - g.rotation) % 360) + 360) % 360
        var inset: List<Double>? = null
        val rd = numbers(el.attr("fringe")); val r = numbers(el.attr("rect"))
        if (rd.size == 4 && r.size == 4 && rd.any { it > 0.75 }) {
            val x1 = minOf(r[0], r[2]); val y1 = minOf(r[1], r[3]); val x2 = maxOf(r[0], r[2]); val y2 = maxOf(r[1], r[3])
            // fringe in Apryse WebViewer's order: left, bottom, right, top (the PDF's /RD is left, top, right, bottom)
            val inner = Box.spanning(g.toPage(PdfPoint(x1 + rd[0], y1 + rd[1])), g.toPage(PdfPoint(x2 - rd[2], y2 - rd[3])))
            if (inner.w > 0 && inner.h > 0) inset = listOf(inner.x - rect.x, inner.y - rect.y, rect.maxX - inner.maxX, rect.maxY - inner.maxY)
        }
        val cl = numbers(el.attr("callout"))
        val callout = if (cl.size >= 4) (0 until cl.size / 2).map { g.toPage(PdfPoint(cl[it * 2], cl[it * 2 + 1])) } else null
        return a.copy(fill = fill, rotation = rotation.takeIf { it != 0 }, inset = inset, callout = callout, intent = intent,
            calloutEnd = el.attr("head")?.takeIf { callout != null && it != "None" })
    }

    // ------------------------------------------------------------------ export

    fun export(annotations: List<Annotation>, geometry: (Int) -> PageGeometry?, fields: Map<String, List<String>> = emptyMap()): String {
        val out = StringBuilder("""<?xml version="1.0" encoding="UTF-8"?>""").append('\n')
            .append("""<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">""").append('\n')
        if (fields.isNotEmpty()) {
            out.append("<fields>\n")
            fields.toSortedMap().forEach { (n, vs) ->
                out.append("""<field name="${esc(n)}">""").append(vs.joinToString("") { "<value>${esc(it)}</value>" }).append("</field>\n")
            }
            out.append("</fields>\n")
        }
        out.append("<annots>\n")
        for (a in annotations) {
            val g = geometry(a.page) ?: continue
            fun pt(p: Pt) = g.toPdf(p).let { "${n(it.x)},${n(it.y)}" }
            fun rectAttr(r: PdfRect) = listOf(r.left, r.bottom, r.right, r.top).joinToString(",") { n(it) }
            val attrs = linkedMapOf(
                "page" to "${a.page}", "rect" to rectAttr(g.toPdf(a.bounds)), "color" to a.color.uppercase(),
                "opacity" to n(a.opacity), "width" to n(a.strokeWidth), "name" to a.id, "title" to a.author,
                "date" to isoToPdfDate(a.modifiedAt), "creationdate" to isoToPdfDate(a.createdAt), "flags" to "print",
            )
            if (a.status != ReviewStatus.NONE) attrs["pdfstudio-status"] = a.status.json
            a.measure?.let { m -> attrs["pdfstudio-measure"] = """{"factor":${m.factor},"unit":"${m.unit}","precision":${m.precision}}""" }
            var children = ""
            var contents = a.comment.orEmpty()
            val tag: String
            when (a.kind) {
                AnnotationKind.HIGHLIGHT, AnnotationKind.UNDERLINE, AnnotationKind.STRIKEOUT -> {
                    tag = if (a.kind == AnnotationKind.UNDERLINE && a.subtype == "squiggly") "squiggly" else a.kind.json
                    attrs["coords"] = a.rects.orEmpty().joinToString(",") { r ->
                        listOf(Pt(r.x, r.y), Pt(r.maxX, r.y), Pt(r.x, r.maxY), Pt(r.maxX, r.maxY)).joinToString(",") { pt(it) }
                    }
                }
                AnnotationKind.RECT, AnnotationKind.ELLIPSE -> {
                    tag = if (a.kind == AnnotationKind.RECT) "square" else "circle"
                    a.rect?.let { attrs["rect"] = rectAttr(g.toPdf(it)) }
                    a.fill?.let { attrs["interior-color"] = it.uppercase() }
                }
                AnnotationKind.LINE, AnnotationKind.ARROW, AnnotationKind.DISTANCE -> {
                    tag = "line"
                    a.points?.takeIf { it.size == 2 }?.let { attrs["start"] = pt(it[0]); attrs["end"] = pt(it[1]) }
                    attrs["head"] = "None"; attrs["tail"] = if (a.kind == AnnotationKind.ARROW) "ClosedArrow" else "None"
                    if (a.kind == AnnotationKind.DISTANCE) {
                        attrs["intent"] = "LineDimension"
                        contents = listOf(Measure.label(a), a.comment.orEmpty()).filter { it.isNotEmpty() }.joinToString("\n")
                    }
                }
                AnnotationKind.PERIMETER, AnnotationKind.AREA -> {
                    tag = if (a.kind == AnnotationKind.AREA) "polygon" else "polyline"
                    children += "<vertices>${a.points.orEmpty().joinToString(";") { pt(it) }}</vertices>"
                    attrs["intent"] = if (a.kind == AnnotationKind.AREA) "PolygonDimension" else "PolyLineDimension"
                    contents = listOf(Measure.label(a), a.comment.orEmpty()).filter { it.isNotEmpty() }.joinToString("\n")
                }
                AnnotationKind.INK -> {
                    tag = "ink"
                    children += "<inklist>" + a.paths.orEmpty().joinToString("") { p -> "<gesture>${p.joinToString(";") { pt(it) }}</gesture>" } + "</inklist>"
                }
                AnnotationKind.FREETEXT -> {
                    tag = "freetext"
                    contents = a.text.orEmpty()
                    a.comment?.let { attrs["pdfstudio-comment"] = it }
                    val c = Rgb.of(a.color)
                    val size = n(a.fontSize ?: 14.0)
                    children += "<defaultappearance>/Helv $size Tf ${n(c.r)} ${n(c.g)} ${n(c.b)} rg</defaultappearance>"
                    children += "<defaultstyle>font: Helvetica ${size}pt; text-align: left; text-vertical-align: top; color: ${a.color.uppercase()}</defaultstyle>"
                    a.richText?.takeIf { it.isNotEmpty() }?.let { children += "<contents-richtext>${RichText.toXhtml(it, a.color, a.fontSize ?: 14.0)}</contents-richtext>" }
                    // Apryse's convention: TextColor carries the text colour, `color` the background (absent = none).
                    attrs["TextColor"] = a.color.uppercase(); attrs["FontSize"] = size
                    if (a.fill != null) attrs["color"] = a.fill.uppercase() else attrs.remove("color")
                    if (a.callout == null) attrs["width"] = "0"
                    a.intent?.let { attrs["IT"] = it }
                    a.rotation?.takeIf { it != 0 }?.let { attrs["rotation"] = "${((it + g.rotation) % 360 + 360) % 360}" }
                    a.rect?.let { r ->
                        a.inset?.takeIf { it.size == 4 }?.let { i ->
                            val outer = g.toPdf(r); val inner = g.toPdf(Box(r.x + i[0], r.y + i[1], r.w - i[0] - i[2], r.h - i[1] - i[3]))
                            attrs["fringe"] = listOf(inner.left - outer.left, inner.bottom - outer.bottom, outer.right - inner.right, outer.top - inner.top).joinToString(",") { n(it) }
                        }
                        attrs["rect"] = rectAttr(g.toPdf(r))
                    }
                    a.callout?.let { cl -> attrs["callout"] = cl.joinToString(",") { pt(it) }; attrs["head"] = a.calloutEnd ?: "None" }
                }
                AnnotationKind.NOTE -> { tag = "text"; attrs["icon"] = "Comment" }
                AnnotationKind.STAMP -> {
                    tag = "stamp"; contents = a.text.orEmpty()
                    attrs["icon"] = a.text.orEmpty().filter { it.isLetter() && it.code < 128 }.ifEmpty { "Approved" }
                }
                AnnotationKind.SIGNATURE -> {
                    tag = "stamp"; attrs["icon"] = "Signature"
                    a.image?.let { children += "<imagedata>${esc(it)}</imagedata>" }
                }
                AnnotationKind.REDACT -> tag = "redact"
            }
            if (contents.isNotEmpty()) children = "<contents>${esc(contents)}</contents>$children"
            out.append('<').append(tag).append(' ').append(attrs.entries.joinToString(" ") { "${it.key}=\"${esc(it.value)}\"" })
                .append('>').append(children).append("</").append(tag).append(">\n")
        }
        return out.append("</annots>\n</xfdf>").toString()
    }

    // ------------------------------------------------------------------ dates & helpers

    /** `D:YYYYMMDDHHmmSS+05'30'` → ISO 8601 UTC. */
    fun pdfDateToIso(s: String?): String? {
        val m = Regex("""(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+\-])?(\d{2})?'?(\d{2})?""").find(s ?: return null) ?: return null
        val g = m.groupValues
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            clear()
            set(g[1].toInt(), (g[2].toIntOrNull() ?: 1) - 1, g[3].toIntOrNull() ?: 1, g[4].toIntOrNull() ?: 0, g[5].toIntOrNull() ?: 0, g[6].toIntOrNull() ?: 0)
        }
        val offset = ((g[8].toIntOrNull() ?: 0) * 3600 + (g[9].toIntOrNull() ?: 0) * 60) * when (g[7]) { "+" -> 1; "-" -> -1; else -> 0 }
        cal.add(Calendar.SECOND, -offset)
        return Annotation.isoFormat().format(cal.time)
    }

    fun isoToPdfDate(iso: String): String {
        val d = Annotation.parseIso(iso) ?: return ""
        return SimpleDateFormat("'D:'yyyyMMddHHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(d)
    }

    private fun n(v: Double): String {
        val r = round(v * 100) / 100
        return if (r == round(r)) r.toLong().toString() else r.toString()
    }

    private fun esc(s: String) = buildString {
        for (c in s) append(when (c) { '<' -> "&lt;"; '>' -> "&gt;"; '&' -> "&amp;"; '"' -> "&quot;"; '\'' -> "&apos;"; else -> c.toString() })
    }

    private fun Element.attr(name: String): String? = if (hasAttribute(name)) getAttribute(name) else null
    private fun Element.childElements(name: String? = null): List<Element> =
        (0 until childNodes.length).map { childNodes.item(it) }.filterIsInstance<Element>().filter { name == null || it.localName == name }
    private fun Element.descendants(name: String): List<Element> {
        val out = mutableListOf<Element>()
        fun walk(n: Node) {
            for (i in 0 until n.childNodes.length) {
                val c = n.childNodes.item(i)
                if (c is Element) { if (c.localName == name) out += c; walk(c) }
            }
        }
        walk(this)
        return out
    }
    private fun Element.firstDescendant(name: String) = descendants(name).firstOrNull()
}

package com.pdfstudio.sdk

import org.w3c.dom.Element
import org.w3c.dom.Node

/**
 * A styled piece of a text box's text. Lines are separated by '\n' inside [text]. [color] is #rrggbb;
 * null means the annotation's colour. Same model as the web SDK's `TextRun` (web/src/sdk/richtext.ts).
 */
data class TextRun(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val color: String? = null,
)

/**
 * Rich text for text boxes, read from and written to XFDF `<contents-richtext>`: an XHTML body of
 * `<p>`/`<span>` with CSS styles, as Acrobat and Apryse WebViewer write it. Mirrors the web SDK.
 */
object RichText {
    private val HEX6 = Regex("^#[0-9a-fA-F]{6}$")

    /** Only #rrggbb survives: colours come from imported files. */
    private fun safeColor(c: String?) = c?.takeIf { HEX6.matches(it) }?.lowercase()

    private fun same(a: TextRun, b: TextRun) =
        a.bold == b.bold && a.italic == b.italic && a.underline == b.underline && (a.color ?: "") == (b.color ?: "")

    /** Merges neighbouring runs with the same style and drops empty ones. */
    fun normalize(runs: List<TextRun>): List<TextRun> {
        val out = ArrayList<TextRun>()
        for (r in runs) {
            if (r.text.isEmpty()) continue
            val clean = r.copy(color = safeColor(r.color))
            val last = out.lastOrNull()
            if (last != null && same(last, clean)) out[out.size - 1] = last.copy(text = last.text + clean.text) else out += clean
        }
        return out
    }

    fun plainText(runs: List<TextRun>) = runs.joinToString("") { it.text }

    /** True when the runs carry no styling beyond the base colour (so plain text is enough). */
    fun isPlain(runs: List<TextRun>, baseColor: String?) =
        runs.all { !it.bold && !it.italic && !it.underline && (it.color == null || it.color == baseColor?.lowercase()) }

    /** Drops colours equal to the annotation colour (imported XHTML spells it out on every span). */
    fun relativeTo(runs: List<TextRun>, baseColor: String) =
        normalize(runs.map { if (it.color == baseColor.lowercase()) it.copy(color = null) else it })

    /** Splits runs into lines of runs. */
    fun lines(runs: List<TextRun>): List<List<TextRun>> {
        val lines = mutableListOf(mutableListOf<TextRun>())
        for (r in runs) r.text.split('\n').forEachIndexed { i, part ->
            if (i > 0) lines += mutableListOf<TextRun>()
            if (part.isNotEmpty()) lines.last() += r.copy(text = part)
        }
        return lines
    }

    private val SPACE = Regex("^\\s+$")

    /**
     * Lines of runs as drawn in a box [maxWidth] wide: each paragraph is wrapped between words, as Apryse WebViewer
     * wraps a free text box. A line breaks only when the next word would pass [maxWidth]; spaces at a wrap are
     * dropped; a word wider than the box stays whole. Same as the web SDK's `wrapRuns`.
     */
    fun wrap(runs: List<TextRun>, maxWidth: Double, measure: (String, TextRun) -> Double): List<List<TextRun>> {
        val out = ArrayList<List<TextRun>>()
        for (para in lines(runs)) {
            val tokens = para.flatMap { r -> Regex("\\s+|\\S+").findAll(r.text).map { r.copy(text = it.value) }.toList() }
            var line = ArrayList<TextRun>()
            var width = 0.0
            var wrapped = false
            for (t in tokens) {
                val space = SPACE.matches(t.text)
                if (space && wrapped && line.isEmpty()) continue
                val w = measure(t.text, t)
                if (!space && line.any { !SPACE.matches(it.text) } && width + w > maxWidth) {
                    while (line.isNotEmpty() && SPACE.matches(line.last().text)) line.removeAt(line.size - 1)
                    out += normalize(line)
                    line = ArrayList(); width = 0.0; wrapped = true
                }
                line += t
                width += w
            }
            out += normalize(line)
        }
        return out
    }

    private fun styleOf(css: String): Map<String, String> {
        val out = HashMap<String, String>()
        for (decl in css.split(';')) {
            val kv = decl.split(':', limit = 2).map { it.trim().lowercase() }
            if (kv.size < 2 || kv[0].isEmpty() || kv[1].isEmpty()) continue
            val (k, v) = kv
            if (k == "font-weight" && (v == "bold" || (v.toIntOrNull() ?: 0) >= 600)) out["bold"] = "1"
            if (k == "font-style" && v == "italic") out["italic"] = "1"
            if (k == "text-decoration" && "underline" in v) out["underline"] = "1"
            if (k == "color") out["color"] = toHex(v)
        }
        return out
    }

    private fun toHex(c: String): String {
        val s = c.trim()
        if (HEX6.matches(s)) return s.lowercase()
        if (Regex("^#[0-9a-fA-F]{3}$").matches(s)) return ("#" + s.drop(1).map { "$it$it" }.joinToString("")).lowercase()
        Regex("""rgba?\((\d+)\D+(\d+)\D+(\d+)""", RegexOption.IGNORE_CASE).find(s)?.let { m ->
            return "#" + m.groupValues.drop(1).joinToString("") { it.toInt().coerceIn(0, 255).toString(16).padStart(2, '0') }
        }
        return s
    }

    private data class Style(val bold: Boolean = false, val italic: Boolean = false, val underline: Boolean = false, val color: String? = null) {
        fun with(m: Map<String, String>) = Style(bold || "bold" in m, italic || "italic" in m, underline || "underline" in m, m["color"] ?: color)
    }

    /** Parses an XHTML rich-text body (or an element containing one) into runs; null when empty. */
    fun fromXhtml(source: Element): List<TextRun>? {
        val body = if (source.localName == "body") source else source.descendantNamed("body") ?: source
        val runs = ArrayList<TextRun>()
        var first = true
        fun walk(node: Node, style: Style) {
            when (node.nodeType) {
                Node.TEXT_NODE, Node.CDATA_SECTION_NODE -> { runs += TextRun(node.textContent.orEmpty(), style.bold, style.italic, style.underline, style.color); return }
                Node.ELEMENT_NODE -> Unit
                else -> return
            }
            val el = node as Element
            val tag = (el.localName ?: el.nodeName).lowercase()
            if (tag == "br") { runs += TextRun("\n", style.bold, style.italic, style.underline, style.color); return }
            var s = style
            if (tag == "b" || tag == "strong") s = s.copy(bold = true)
            if (tag == "i" || tag == "em") s = s.copy(italic = true)
            if (tag == "u") s = s.copy(underline = true)
            s = s.with(styleOf(el.getAttribute("style").orEmpty()))
            if (tag == "p" || tag == "div") {
                if (!first) runs += TextRun("\n")
                first = false
            }
            var c = el.firstChild
            while (c != null) { walk(c, s); c = c.nextSibling }
        }
        // the body colour is the annotation colour
        val base = Style().with(styleOf(body.getAttribute("style").orEmpty()).filterKeys { it != "color" })
        var c = body.firstChild
        while (c != null) { walk(c, base); c = c.nextSibling }
        return normalize(runs).ifEmpty { null }
    }

    /**
     * Parses a PDF `/RC` rich-text string (XHTML, optionally with an XML declaration, as Acrobat, Apryse and the web
     * SDK write it) into runs; null when it is empty or not well-formed.
     */
    fun fromXhtml(xml: String): List<TextRun>? {
        if (xml.isBlank()) return null
        val factory = javax.xml.parsers.DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            // No external entities: the string comes from a file.
            runCatching { setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
            isExpandEntityReferences = false
        }
        // Some writers leave HTML entities XML doesn't define.
        val text = xml.trim().replace("&nbsp;", "&#160;")
        val doc = runCatching {
            factory.newDocumentBuilder().apply { setErrorHandler(null) }.parse(org.xml.sax.InputSource(java.io.StringReader(text)))
        }.getOrNull() ?: return null
        return fromXhtml(doc.documentElement)
    }

    private fun Element.descendantNamed(name: String): Element? {
        val list = getElementsByTagNameNS("*", name)
        return if (list.length > 0) list.item(0) as Element else null
    }

    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    /** XHTML body for XFDF `<contents-richtext>`, as the web SDK writes it. */
    fun toXhtml(runs: List<TextRun>, baseColor: String, fontSize: Double): String {
        val paras = lines(runs).joinToString("") { line ->
            "<p dir=\"ltr\">" + line.joinToString("") { r ->
                val css = listOfNotNull(
                    "font-weight:bold".takeIf { r.bold }, "font-style:italic".takeIf { r.italic }, "text-decoration:underline".takeIf { r.underline },
                    "color:${(safeColor(r.color) ?: safeColor(baseColor) ?: "#000000").uppercase()}",
                ).joinToString(";")
                "<span style=\"$css\">${esc(r.text)}</span>"
            } + "</p>"
        }
        val size = if (fontSize % 1.0 == 0.0) fontSize.toInt().toString() else fontSize.toString()
        return "<body xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:xfa=\"http://www.xfa.org/schema/xfa-data/1.0/\" xfa:APIVersion=\"Acrobat:23.0.0\" xfa:spec=\"2.0.2\" style=\"font-size:${size}pt;font-family:Helvetica\">$paras</body>"
    }
}

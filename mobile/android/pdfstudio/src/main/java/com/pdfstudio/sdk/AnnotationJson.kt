package com.pdfstudio.sdk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * The PDF Studio annotation exchange format:
 * `{ "format": "pdf-studio-annotations", "version": 2, "file": ..., "annotations": [...] }`.
 */
object AnnotationJson {
    const val FORMAT = "pdf-studio-annotations"
    private val json = Json { prettyPrint = true }

    fun encodeFile(annotations: List<Annotation>, file: String? = null): String = json.encodeToString(
        JsonElement.serializer(),
        buildJsonObject {
            put("format", FORMAT)
            put("version", 2)
            file?.let { put("file", it) }
            put("annotations", JsonArray(annotations.map(::toJson)))
        },
    )

    /** Decodes a file; unknown annotation kinds from newer versions are skipped. */
    fun decodeFile(text: String): List<Annotation> {
        val root = Json.parseToJsonElement(text).jsonObject
        require(root["format"]?.jsonPrimitive?.content == FORMAT) { "Not a PDF Studio annotations file" }
        return root["annotations"]?.jsonArray?.mapNotNull { runCatching { fromJson(it.jsonObject) }.getOrNull() } ?: emptyList()
    }

    fun encode(a: Annotation): String = Json.encodeToString(JsonElement.serializer(), toJson(a))
    fun decode(text: String): Annotation? = runCatching { fromJson(Json.parseToJsonElement(text).jsonObject) }.getOrNull()

    fun toJson(a: Annotation): JsonObject = buildJsonObject {
        put("id", a.id); put("page", a.page); put("kind", a.kind.json); put("color", a.color)
        put("opacity", a.opacity); put("strokeWidth", a.strokeWidth)
        a.rect?.let { put("rect", box(it)) }
        a.rects?.let { r -> put("rects", JsonArray(r.map(::box))) }
        a.points?.let { p -> put("points", JsonArray(p.map(::pt))) }
        a.measure?.let { m -> put("measure", buildJsonObject { put("factor", m.factor); put("unit", m.unit); put("precision", m.precision) }) }
        a.paths?.let { ps -> put("paths", JsonArray(ps.map { p -> JsonArray(p.map(::pt)) })) }
        a.text?.let { put("text", it) }
        a.fontSize?.let { put("fontSize", it) }
        a.image?.let { put("image", it) }
        a.comment?.let { put("comment", it) }
        a.fill?.let { put("fill", it) }
        a.rotation?.let { put("rotation", it) }
        a.inset?.let { i -> put("inset", JsonArray(i.map { JsonPrimitive(it) })) }
        a.callout?.let { c -> put("callout", JsonArray(c.map(::pt))) }
        a.calloutEnd?.let { put("calloutEnd", it) }
        a.intent?.let { put("intent", it) }
        a.richText?.let { runs ->
            put("richText", JsonArray(runs.map { r ->
                buildJsonObject {
                    put("text", r.text)
                    if (r.bold) put("bold", true); if (r.italic) put("italic", true); if (r.underline) put("underline", true)
                    r.color?.let { put("color", it) }
                }
            }))
        }
        a.subtype?.let { put("subtype", it) }
        put("status", a.status.json); put("author", a.author)
        put("createdAt", a.createdAt); put("modifiedAt", a.modifiedAt)
    }

    fun fromJson(o: JsonObject): Annotation {
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content
        fun num(k: String) = (o[k] as? JsonPrimitive)?.doubleOrNull
        val kind = AnnotationKind.fromJson(str("kind") ?: "") ?: error("unknown kind")
        val created = str("createdAt") ?: Annotation.now()
        return Annotation(
            id = str("id") ?: Annotation.newId(),
            page = (o["page"] as? JsonPrimitive)?.intOrNull ?: 0,
            kind = kind,
            color = str("color") ?: "#e5484d",
            opacity = num("opacity") ?: 1.0,
            strokeWidth = num("strokeWidth") ?: 1.0,
            rect = (o["rect"] as? JsonObject)?.let(::box),
            rects = (o["rects"] as? JsonArray)?.map { box(it.jsonObject) },
            points = (o["points"] as? JsonArray)?.map { pt(it.jsonObject) },
            measure = (o["measure"] as? JsonObject)?.let {
                MeasureScale(it["factor"]!!.jsonPrimitive.doubleOrNull ?: 1.0, it["unit"]!!.jsonPrimitive.content, it["precision"]?.jsonPrimitive?.intOrNull ?: 2)
            },
            paths = (o["paths"] as? JsonArray)?.map { p -> p.jsonArray.map { pt(it.jsonObject) } },
            text = str("text"),
            fontSize = num("fontSize"),
            image = str("image"),
            comment = str("comment"),
            fill = str("fill"),
            rotation = (o["rotation"] as? JsonPrimitive)?.intOrNull,
            inset = (o["inset"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.doubleOrNull }?.takeIf { it.size == 4 },
            callout = (o["callout"] as? JsonArray)?.map { pt(it.jsonObject) },
            calloutEnd = str("calloutEnd"),
            intent = str("intent"),
            richText = (o["richText"] as? JsonArray)?.mapNotNull { e ->
                val r = e as? JsonObject ?: return@mapNotNull null
                fun flag(k: String) = (r[k] as? JsonPrimitive)?.booleanOrNull == true
                TextRun((r["text"] as? JsonPrimitive)?.content ?: return@mapNotNull null, flag("bold"), flag("italic"), flag("underline"),
                    (r["color"] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content)
            }?.takeIf { it.isNotEmpty() },
            subtype = str("subtype"),
            status = ReviewStatus.fromJson(str("status")),
            author = str("author") ?: "Unknown",
            createdAt = created,
            modifiedAt = str("modifiedAt") ?: created,
        )
    }

    private fun box(b: Box) = buildJsonObject { put("x", b.x); put("y", b.y); put("w", b.w); put("h", b.h) }
    private fun pt(p: Pt) = buildJsonObject { put("x", p.x); put("y", p.y) }
    private fun box(o: JsonObject) = Box(o.d("x"), o.d("y"), o.d("w"), o.d("h"))
    private fun pt(o: JsonObject) = Pt(o.d("x"), o.d("y"))
    private fun JsonObject.d(k: String) = this[k]?.jsonPrimitive?.doubleOrNull ?: 0.0
}

@Suppress("unused")
private fun JsonArray.Companion.of(vararg e: JsonElement) = buildJsonArray { e.forEach { add(it) } }

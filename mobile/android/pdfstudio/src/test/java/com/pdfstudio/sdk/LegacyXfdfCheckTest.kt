package com.pdfstudio.sdk

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import java.io.File

/**
 * Opt-in check of stored PDFTron markup: every XFDF under LEGACY_DIR through the Android reader, one JSON line per file
 * into LEGACY_OUT; scripts/compare_legacy_xfdf.py compares it with the web and iOS. Skipped unless both are set.
 */
class LegacyXfdfCheckTest {
    @Test fun readsEveryLegacyXfdf() {
        val dir = System.getenv("LEGACY_DIR") ?: return
        val out = File(System.getenv("LEGACY_OUT") ?: return)
        val geometry = PageGeometry(PdfRect(0.0, 0.0, 612.0, 792.0), 0)
        val files = File(dir).walkTopDown().filter { it.isFile && it.name.endsWith(".xfdf") }.sortedBy { it.relativeTo(File(dir)).path }.toList()
        out.bufferedWriter().use { w ->
            for (f in files) {
                val rel = f.relativeTo(File(dir)).path
                val line = runCatching {
                    val imp = Xfdf.parse(f.readText(), { geometry })
                    buildJsonObject {
                        put("file", rel); put("partial", imp.partial)
                        put("annotations", JsonArray(imp.annotations.map { AnnotationJson.toJson(it) }))
                    }
                }.getOrElse { e -> buildJsonObject { put("file", rel); put("error", JsonPrimitive(e.toString().take(200))) } }
                w.write(line.toString()); w.newLine()
            }
        }
        println("android: ${files.size} files")
    }
}

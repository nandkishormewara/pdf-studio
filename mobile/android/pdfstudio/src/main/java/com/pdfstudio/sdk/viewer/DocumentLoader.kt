package com.pdfstudio.sdk.viewer

import android.content.Context
import android.net.Uri
import com.pdfstudio.sdk.Annotation
import com.pdfstudio.sdk.PageGeometry
import com.pdfstudio.sdk.PdfStudio
import com.pdfstudio.sdk.Xfdf
import com.pdfstudio.sdk.pdf.AnnotationReader
import com.pdfstudio.sdk.pdf.AnnotationWriter
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/** A document ready to display: a PDF without the annotations we draw ourselves, plus those annotations. */
class LoadedDocument(
    val file: File,
    /** the original bytes on disk (for saving an annotated copy) */
    val original: File,
    val geometries: List<PageGeometry>,
    val annotations: List<Annotation>,
)

class DocumentLoadException(message: String) : IOException(message)

internal object DocumentLoader {
    private val OFFICE = setOf("doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf")
    private val IMAGES = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "heic")

    fun load(context: Context, uri: Uri, config: ViewerConfig): LoadedDocument {
        PdfStudio.init(context)
        val dir = File(context.cacheDir, "pdfstudio").apply { mkdirs() }
        val raw = File(dir, "src-${UUID.randomUUID()}")
        copy(context, uri, raw, config)

        val kind = sniff(raw) ?: config.extensionHint?.lowercase()?.trimStart('.') ?: uri.lastPathSegment?.substringAfterLast('.', "")?.lowercase()
        val pdf: File = when {
            kind == "pdf" -> raw
            kind in IMAGES -> PdfStudio.imagesToPdf(listOf(raw), File(dir, "img-${raw.name}.pdf"),
                PdfStudio.PageSpec(margin = 0f).let { imageSizedPage(raw) ?: it })
            kind in OFFICE || kind == "office" -> convertOffice(raw, kind ?: "docx", config, dir)
            else -> throw DocumentLoadException("This file isn't a PDF or a supported image.")
        }
        if (!PdfStudio.isValidPdf(pdf)) throw DocumentLoadException("This document is damaged or password-protected.")

        PDDocument.load(pdf, MemoryUsageSetting.setupTempFileOnly()).use { doc ->
            val geometries = (0 until doc.numberOfPages).map { AnnotationWriter.geometry(doc.getPage(it)) }
            var annotations = AnnotationReader.extract(doc, remove = true)
            for (layer in config.xfdfLayers.filter { it.isNotBlank() }) {
                runCatching { Xfdf.parse(layer) { geometries.getOrNull(it) } }.getOrNull()?.let { annotations = Xfdf.merge(annotations, it) }
            }
            val clean = File(dir, "view-${raw.name}.pdf")
            FileOutputStream(clean).use { doc.save(it) }
            return LoadedDocument(clean, pdf, geometries, annotations)
        }
    }

    private fun copy(context: Context, uri: Uri, target: File, config: ViewerConfig) {
        when (uri.scheme?.lowercase()) {
            "http", "https" -> {
                val conn = (URL(uri.toString()).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20_000; readTimeout = 60_000
                    config.headers.forEach { (k, v) -> setRequestProperty(k, v) }
                }
                try {
                    if (conn.responseCode !in 200..299) throw DocumentLoadException("The document could not be downloaded (HTTP ${conn.responseCode}).")
                    conn.inputStream.use { input -> FileOutputStream(target).use { out -> copyLimited(input, out, config.maxDownloadBytes) } }
                } finally { conn.disconnect() }
            }
            else -> (context.contentResolver.openInputStream(uri) ?: throw DocumentLoadException("Can't open $uri"))
                .use { input -> FileOutputStream(target).use { out -> copyLimited(input, out, config.maxDownloadBytes) } }
        }
    }

    private fun copyLimited(input: java.io.InputStream, out: java.io.OutputStream, limit: Long) {
        val buf = ByteArray(64 * 1024); var total = 0L
        while (true) {
            val n = input.read(buf); if (n < 0) break
            total += n
            if (total > limit) throw DocumentLoadException("The document is larger than ${limit / 1024 / 1024} MB.")
            out.write(buf, 0, n)
        }
    }

    /** Detects the real type from magic bytes (a secure stream often has no extension, or the wrong one). */
    fun sniff(file: File): String? {
        val b = file.inputStream().use { s -> ByteArray(16).also { s.read(it) } }
        fun starts(vararg x: Int) = x.indices.all { b[it].toInt() and 0xff == x[it] }
        return when {
            String(b, Charsets.ISO_8859_1).contains("%PDF") -> "pdf"
            starts(0x89, 0x50, 0x4E, 0x47) -> "png"
            starts(0xFF, 0xD8, 0xFF) -> "jpg"
            starts(0x47, 0x49, 0x46) -> "gif"
            starts(0x52, 0x49, 0x46, 0x46) -> "webp"
            starts(0x50, 0x4B, 0x03, 0x04) -> null // OOXML zip: keep the hint (docx/pptx/xlsx)
            starts(0xD0, 0xCF, 0x11, 0xE0) -> null // OLE2: doc/xls/ppt
            starts(0x3C) -> throw DocumentLoadException("The server returned a web page instead of the document (the link may have expired).")
            else -> null
        }
    }

    private fun imageSizedPage(image: File): PdfStudio.PageSpec? {
        val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(image.path, o)
        if (o.outWidth <= 0) return null
        val scale = 595f / maxOf(o.outWidth, o.outHeight) * 1.4f // ~A4-ish long edge
        return PdfStudio.PageSpec(o.outWidth * scale, o.outHeight * scale, 0f)
    }

    private fun convertOffice(file: File, ext: String, config: ViewerConfig, dir: File): File {
        val server = config.conversionServer
            ?: throw DocumentLoadException("Office documents need conversion. Configure ViewerConfig.conversionServer (PDF Studio server).")
        val boundary = "pdfstudio-${UUID.randomUUID()}"
        val conn = (URL(server.trimEnd('/') + "/convert").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; doOutput = true; connectTimeout = 20_000; readTimeout = 180_000
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        }
        try {
            conn.outputStream.use { out ->
                out.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"document.$ext\"\r\nContent-Type: application/octet-stream\r\n\r\n".toByteArray())
                file.inputStream().use { it.copyTo(out) }
                out.write("\r\n--$boundary--\r\n".toByteArray())
            }
            if (conn.responseCode !in 200..299) throw DocumentLoadException("The document could not be converted (HTTP ${conn.responseCode}).")
            val pdf = File(dir, "conv-${file.name}.pdf")
            conn.inputStream.use { input -> FileOutputStream(pdf).use { input.copyTo(it) } }
            return pdf
        } finally { conn.disconnect() }
    }
}

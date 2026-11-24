package com.pdfstudio.sdk.viewer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns

/**
 * The top-bar title when the app passes none, from the file name as PDFTron's `DocumentActivity` does, made readable:
 * no extension, no numeric parts (apps name cached copies `homework_annotated_1730000000000.pdf`), `_` as spaces.
 * Names that leave nothing (e.g. `viewer/stream?token=…`) stay "Document".
 */
internal object DocumentTitle {
    const val FALLBACK = "Document"

    fun of(context: Context, uri: Uri): String {
        val name = if (uri.scheme == "content") {
            runCatching {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0) else null
                }
            }.getOrNull()
        } else uri.lastPathSegment
        return fromFileName(name)
    }

    fun fromFileName(name: String?): String {
        val base = name?.substringAfterLast('/')?.trim().orEmpty()
        val dot = base.lastIndexOf('.')
        if (dot <= 0 || dot == base.length - 1) return FALLBACK
        val words = base.substring(0, dot).split('_', ' ').filter { it.isNotBlank() && !it.all(Char::isDigit) }
        return words.joinToString(" ").replaceFirstChar { it.uppercaseChar() }.ifEmpty { FALLBACK }
    }
}

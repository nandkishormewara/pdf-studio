package com.pdfstudio.sdk.viewer

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.io.Serializable

/**
 * Viewer options. Defaults reproduce the read-only PDFTron `ViewerConfig` used by a typical app
 * (documentEditingEnabled=false, no annotation/edit/forms toolbars, no save-copy, page indicator on).
 */
data class ViewerConfig(
    val title: String? = null,
    /** false enables the markup tools (pen, highlighter, shapes, arrows, text, notes), comments and a Save action. */
    val readOnly: Boolean = true,
    val showPageIndicator: Boolean = true,
    /** XFDF layers drawn on top of the document (e.g. reviewer markup) without modifying the file. */
    val xfdfLayers: List<String> = emptyList(),
    /** Blocks screenshots / screen recording (FLAG_SECURE). */
    val secure: Boolean = false,
    /** Extension hint when the URI doesn't carry one (e.g. `viewer/stream?token=`): "pdf", "png", … */
    val extensionHint: String? = null,
    /** Extra HTTP headers for http(s) URIs (e.g. Authorization). */
    val headers: Map<String, String> = emptyMap(),
    /** Max download size for http(s) URIs. */
    val maxDownloadBytes: Long = 50L * 1024 * 1024,
    /** Optional PDF Studio server used to convert Office files (docx/pptx/xlsx…) for display. */
    val conversionServer: String? = null,
    val author: String = "Me",
    /** Search in the top bar (PDFTron `DocumentActivity` default). Text is indexed once, in the background. */
    val searchEnabled: Boolean = true,
    /** Page thumbnails sheet, tap to jump (PDFTron `DocumentActivity` default). */
    val thumbnailsEnabled: Boolean = true,
    /** With `readOnly = false`: long-press-drag selects text to highlight, underline or strike out. */
    val textMarkupEnabled: Boolean = true,
    /** With `readOnly = false`: a Form button to fill the file's form fields (shown only when it has some). */
    val formsEnabled: Boolean = true,
) : Serializable

object PdfStudioViewer {
    internal const val EXTRA_URI = "com.pdfstudio.viewer.URI"
    internal const val EXTRA_CONFIG = "com.pdfstudio.viewer.CONFIG"

    /** Result extra (when `readOnly = false` and the user saved): URI of the annotated copy. */
    const val RESULT_SAVED_URI = "com.pdfstudio.viewer.SAVED_URI"

    /** Drop-in for `DocumentActivity.openDocument(context, uri, config)`. */
    fun open(context: Context, uri: Uri, config: ViewerConfig = ViewerConfig()) {
        context.startActivity(createIntent(context, uri, config).apply { if (context !is Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
    }

    /** For `startActivityForResult` / ActivityResult APIs. */
    fun createIntent(context: Context, uri: Uri, config: ViewerConfig = ViewerConfig()): Intent =
        Intent(context, PdfStudioViewerActivity::class.java).putExtra(EXTRA_URI, uri).putExtra(EXTRA_CONFIG, config)
}

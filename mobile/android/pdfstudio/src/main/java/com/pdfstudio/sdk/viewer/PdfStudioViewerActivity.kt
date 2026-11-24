package com.pdfstudio.sdk.viewer

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import com.pdfstudio.sdk.Annotation
import com.pdfstudio.sdk.AnnotationKind
import com.pdfstudio.sdk.Box
import com.pdfstudio.sdk.PdfStudio
import com.pdfstudio.sdk.Pt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.util.LruCache
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.ImeAction
import com.pdfstudio.sdk.PageText
import com.pdfstudio.sdk.SearchHit
import com.pdfstudio.sdk.TextSearch
import com.pdfstudio.sdk.pdf.TextExtractor
import kotlinx.coroutines.delay
import java.io.File
import java.util.concurrent.Executors
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.graphics.PathEffect
import com.pdfstudio.sdk.FormField
import com.pdfstudio.sdk.FormFieldKind
import com.pdfstudio.sdk.ReviewStatus

/** Full-screen document viewer — the PDF Studio counterpart of PDFTron's `DocumentActivity`. */
class PdfStudioViewerActivity : ComponentActivity() {
    private var renderer: PdfRenderer? = null
    private var descriptor: ParcelFileDescriptor? = null
    /** PdfRenderer is not thread-safe: all rendering goes through one thread. */
    private val renderThread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intentUri() ?: return finish()
        val config = intentConfig().let { if (it.title.isNullOrBlank()) it.copy(title = DocumentTitle.of(this, uri)) else it }
        if (config.secure) window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        setContent {
            val dark = isSystemInDarkTheme()
            MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                val state by produceState<LoadState>(LoadState.Loading, uri) {
                    value = withContext(Dispatchers.IO) {
                        runCatching { DocumentLoader.load(this@PdfStudioViewerActivity, uri, config) }
                            .fold({ LoadState.Ready(it) }, { LoadState.Failed(it.message ?: "The document could not be opened.") })
                    }
                }
                ViewerScreen(state, config, onBack = { finish() }, onRetry = { recreate() }, openRenderer = ::openRenderer,
                    render = ::render, onSave = { file, anns -> save(file, anns) }, workDir = File(cacheDir, "pdfstudio"))
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun intentUri(): Uri? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(PdfStudioViewer.EXTRA_URI, Uri::class.java) else intent.getParcelableExtra(PdfStudioViewer.EXTRA_URI)

    @Suppress("DEPRECATION")
    private fun intentConfig(): ViewerConfig =
        (if (Build.VERSION.SDK_INT >= 33) intent.getSerializableExtra(PdfStudioViewer.EXTRA_CONFIG, ViewerConfig::class.java)
        else intent.getSerializableExtra(PdfStudioViewer.EXTRA_CONFIG) as? ViewerConfig) ?: ViewerConfig()

    private suspend fun openRenderer(file: File): Int = withContext(renderThread) {
        renderer?.close(); descriptor?.close()
        descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        renderer = PdfRenderer(descriptor!!)
        renderer!!.pageCount
    }

    private suspend fun render(page: Int, widthPx: Int): Bitmap? = withContext(renderThread) {
        val r = renderer ?: return@withContext null
        r.openPage(page).use { p ->
            val w = widthPx.coerceIn(64, 4096)
            val h = (w.toFloat() * p.height / p.width).toInt().coerceAtLeast(1)
            Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also {
                it.eraseColor(android.graphics.Color.WHITE)
                p.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            }
        }
    }

    /** Writes [annotations] onto [base] (the loaded file, or its form-filled copy). */
    private suspend fun save(base: File, annotations: List<Annotation>) = withContext(Dispatchers.IO) {
        val out = File(cacheDir, "pdfstudio/annotated-${System.currentTimeMillis()}.pdf").also { it.parentFile?.mkdirs() }
        PdfStudio.writeAnnotations(base, annotations, out)
        setResult(Activity.RESULT_OK, Intent().putExtra(PdfStudioViewer.RESULT_SAVED_URI, Uri.fromFile(out)))
    }

    override fun onDestroy() {
        super.onDestroy()
        renderer?.close(); descriptor?.close(); renderThread.close()
    }
}

internal sealed interface LoadState {
    data object Loading : LoadState
    data class Ready(val doc: LoadedDocument) : LoadState
    data class Failed(val message: String) : LoadState
}


/** Search / thumbnails / text / form state shared by the top bar and the page list. */
private class ViewerUi {
    /** null while the background text index is being built. */
    var pageText by mutableStateOf<List<PageText>?>(null)
    var searchOpen by mutableStateOf(false)
    var query by mutableStateOf("")
    var hits by mutableStateOf<List<SearchHit>>(emptyList())
    var current by mutableStateOf(0)
    /** Bumped to make the page list scroll to `hits[current]`. */
    var jump by mutableStateOf(0)
    var thumbsOpen by mutableStateOf(false)
    /** The file's form fields; empty when it has none (or forms are off). */
    var formFields by mutableStateOf<List<FormField>>(emptyList())
    var formOpen by mutableStateOf(false)
    /** The form-filled copy shown and saved instead of the loaded file, once a form is filled. */
    var filled by mutableStateOf<File?>(null)

    fun step(d: Int) {
        if (hits.isEmpty()) return
        current = (current + d + hits.size) % hits.size; jump++
    }
}

/** A text selection on one page: characters `start until end`, grown from the long-pressed word. */
private data class TextSel(val page: Int, val anchorStart: Int, val anchorEnd: Int, val start: Int, val end: Int)

/** Waiting for the text of a text box or note tapped onto [page] at [at]. */
private data class TextPrompt(val tool: Tool, val page: Int, val at: Pt)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ViewerScreen(
    state: LoadState, config: ViewerConfig, onBack: () -> Unit, onRetry: () -> Unit,
    openRenderer: suspend (File) -> Int, render: suspend (Int, Int) -> Bitmap?, onSave: suspend (File, List<Annotation>) -> Unit,
    workDir: File,
) {
    val ui = remember { ViewerUi() }
    val doc = (state as? LoadState.Ready)?.doc
    val wantsText = config.searchEnabled || (!config.readOnly && config.textMarkupEnabled)
    LaunchedEffect(doc) {
        if (doc != null && wantsText) ui.pageText = withContext(Dispatchers.IO) { runCatching { TextExtractor.extract(doc.file) }.getOrDefault(emptyList()) }
    }
    LaunchedEffect(doc) {
        if (doc != null && !config.readOnly && config.formsEnabled)
            ui.formFields = withContext(Dispatchers.IO) { runCatching { PdfStudio.readFormFields(doc.file) }.getOrDefault(emptyList()) }
    }
    LaunchedEffect(ui.query, ui.pageText) {
        val pages = ui.pageText ?: return@LaunchedEffect
        delay(250)
        ui.hits = withContext(Dispatchers.Default) { TextSearch.find(pages, ui.query) }
        ui.current = 0
        if (ui.hits.isNotEmpty()) ui.jump++
    }

    Scaffold(topBar = {
        if (ui.searchOpen) SearchBar(ui) else TopAppBar(
            title = { Text(config.title ?: "Document", maxLines = 1) },
            navigationIcon = { TextButton(onClick = onBack) { Text("‹ Back") } },
            actions = {
                if (doc != null && ui.formFields.any { !it.readOnly }) TextButton(onClick = { ui.formOpen = true }) { Text("Form", maxLines = 1) }
                if (doc != null && config.searchEnabled) TextButton(onClick = { ui.searchOpen = true }) { Text("Search", maxLines = 1) }
                if (doc != null && config.thumbnailsEnabled) TextButton(onClick = { ui.thumbsOpen = true }) { Text("Pages", maxLines = 1) }
            },
        )
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).background(MaterialTheme.colorScheme.surfaceVariant)) {
            when (state) {
                LoadState.Loading -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(); Spacer(Modifier.size(8.dp)); Text("Loading document…")
                }
                is LoadState.Failed -> Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Couldn't load this document", style = MaterialTheme.typography.titleMedium)
                    Text(state.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(8.dp))
                    Button(onClick = onRetry) { Text("Retry") }
                }
                is LoadState.Ready -> DocumentPages(state.doc, config, ui, openRenderer, render, onSave, workDir)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DocumentPages(
    doc: LoadedDocument, config: ViewerConfig, ui: ViewerUi, openRenderer: suspend (File) -> Int,
    render: suspend (Int, Int) -> Bitmap?, onSave: suspend (File, List<Annotation>) -> Unit, workDir: File,
) {
    val file = ui.filled ?: doc.file
    val pageCount by produceState(0, doc, file) { value = openRenderer(file) }
    val annotations = remember(doc) { mutableStateListOf<Annotation>().apply { addAll(doc.annotations) } }
    val history = remember(doc) { EditHistory() }
    var undoCount by remember { mutableStateOf(0) }
    var tool by remember { mutableStateOf(Tool.VIEW) }
    var color by remember { mutableStateOf(MARK_COLORS.first()) }
    var saved by remember { mutableStateOf(false) }
    var zoom by remember { mutableStateOf(1f) }
    var pan by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    var widthPx by remember { mutableStateOf(0) }
    var heightPx by remember { mutableStateOf(0) }
    var selection by remember { mutableStateOf<TextSel?>(null) }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var prompt by remember { mutableStateOf<TextPrompt?>(null) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val painter = remember { AnnotationPainter() }
    val density = LocalDensity.current
    val clipboard = LocalClipboardManager.current
    val hitsByPage = remember(ui.hits) { ui.hits.withIndex().groupBy { it.value.page } }
    val canSelect = !config.readOnly && config.textMarkupEnabled
    val transform = rememberTransformableState { z, p, _ ->
        zoom = (zoom * z).coerceIn(1f, 5f)
        pan = if (zoom == 1f) androidx.compose.ui.geometry.Offset.Zero else pan + p
    }

    /** Every edit goes through here, so Undo can step back over it. */
    fun change(edit: MutableList<Annotation>.() -> Unit) {
        history.record(annotations.toList()); undoCount++
        annotations.edit(); saved = false
    }

    // Scroll so the current search hit sits in the upper third of the viewport.
    LaunchedEffect(ui.jump, pageCount) {
        val hit = ui.hits.getOrNull(ui.current) ?: return@LaunchedEffect
        if (hit.page >= pageCount) return@LaunchedEffect
        zoom = 1f; pan = androidx.compose.ui.geometry.Offset.Zero
        val pagePx = widthPx - with(density) { 24.dp.toPx() }
        val y = hit.rects.first().y * pagePx / doc.geometries[hit.page].width
        listState.animateScrollToItem(hit.page, (y - heightPx / 3.0).toInt().coerceAtLeast(0))
    }

    Box(Modifier.fillMaxSize().onSizeChanged { widthPx = it.width; heightPx = it.height }) {
        LazyColumn(
            state = listState,
            userScrollEnabled = !tool.drag,
            contentPadding = PaddingValues(start = 12.dp, top = 12.dp, end = 12.dp, bottom = if (config.readOnly) 12.dp else 120.dp),
            modifier = Modifier.fillMaxSize()
                .then(if (tool == Tool.VIEW) Modifier.transformable(transform) else Modifier)
                .graphicsLayer { scaleX = zoom; scaleY = zoom; translationX = pan.x; translationY = pan.y },
        ) {
            items(pageCount) { index ->
                val g = doc.geometries[index]
                val text = ui.pageText?.getOrNull(index)
                val bitmap by produceState<Bitmap?>(null, index, widthPx, pageCount, file) {
                    if (widthPx > 0 && pageCount > 0) value = render(index, (widthPx * 1.5f).toInt())
                }
                var current by remember { mutableStateOf<List<Pt>>(emptyList()) }
                fun toPage(o: androidx.compose.ui.geometry.Offset, w: Int) = Pt(o.x * g.width / w, o.y * g.width / w)
                val gestures = when {
                    tool.drag && !config.readOnly -> Modifier.pointerInput(tool, color, index) {
                        detectDragGestures(
                            onDragStart = { o -> current = listOf(toPage(o, size.width)) },
                            onDrag = { ch, _ -> current = current + toPage(ch.position, size.width) },
                            onDragEnd = {
                                Editing.shape(tool, index, current, color, config.author)?.let { a -> change { add(a) } }
                                current = emptyList()
                            },
                            onDragCancel = { current = emptyList() },
                        )
                    }
                    tool.asksForText && !config.readOnly -> Modifier.pointerInput(tool, index) {
                        detectTapGestures(onTap = { o -> prompt = TextPrompt(tool, index, toPage(o, size.width)) })
                    }
                    else -> Modifier
                        // tap a mark to see its details (read-only viewers can read comments too)
                        .pointerInput(index) {
                            detectTapGestures(onTap = { o ->
                                selectedId = Editing.hit(annotations, index, toPage(o, size.width), slop = 8.0 * g.width / size.width * density.density)?.id
                                selection = null
                            })
                        }
                        .then(if (canSelect && text != null) Modifier.pointerInput(text) {
                            fun at(o: androidx.compose.ui.geometry.Offset) = text.charAt(toPage(o, size.width))
                            detectDragGesturesAfterLongPress(
                                onDragStart = { o ->
                                    val i = at(o)
                                    selection = if (i < 0) null else wordAround(text.text, i).let { (s, e) -> TextSel(index, s, e, s, e) }
                                },
                                onDrag = { ch, _ ->
                                    val sel = selection?.takeIf { it.page == index } ?: return@detectDragGesturesAfterLongPress
                                    ch.consume()
                                    val i = at(ch.position)
                                    if (i >= 0) selection = if (i < sel.anchorStart) sel.copy(start = i, end = sel.anchorEnd)
                                        else sel.copy(start = sel.anchorStart, end = maxOf(sel.anchorEnd, i + 1))
                                },
                            )
                        } else Modifier)
                }
                Box(Modifier.fillMaxWidth().padding(bottom = 12.dp).aspectRatio((g.width / g.height).toFloat()).background(Color.White)) {
                    Canvas(Modifier.fillMaxSize().then(gestures)) {
                        val scale = size.width / g.width.toFloat()
                        // The page is drawn on the same canvas as the marks, so highlights can multiply with the text under them.
                        bitmap?.let { drawImage(it.asImageBitmap(), dstSize = androidx.compose.ui.unit.IntSize(size.width.toInt(), size.height.toInt())) }
                        fun rect(b: com.pdfstudio.sdk.Box) = Pair(
                            androidx.compose.ui.geometry.Offset((b.x * scale).toFloat(), (b.y * scale).toFloat()),
                            androidx.compose.ui.geometry.Size((b.w * scale).toFloat(), (b.h * scale).toFloat()),
                        )
                        val canvas = drawContext.canvas.nativeCanvas
                        annotations.filter { it.page == index }.forEach { painter.draw(canvas, it, scale) }
                        if (current.size > 1) Editing.shape(tool, index, current, color, config.author)?.let { painter.draw(canvas, it, scale) }
                        annotations.firstOrNull { it.id == selectedId && it.page == index }?.let { sel ->
                            val (o, s) = rect(sel.bounds.inset(-4.0))
                            drawRect(Color(0xFF1F6FEB), o, s, style = Stroke(1.5f * density.density, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f * density.density, 4f * density.density))))
                        }
                        hitsByPage[index]?.forEach { (i, hit) ->
                            hit.rects.forEach { b ->
                                val (o, s) = rect(b.inset(-1.0))
                                drawRect(if (i == ui.current) Color(0x88FF8A00) else Color(0x44FFB300), o, s)
                                if (i == ui.current) drawRect(Color(0xFFE56A00), o, s, style = Stroke(1.5f * density.density))
                            }
                        }
                        selection?.takeIf { it.page == index && text != null }?.let { sel ->
                            text!!.lineRects(sel.start, sel.end).forEach { b -> val (o, s) = rect(b); drawRect(Color(0x553B82F6), o, s) }
                        }
                    }
                }
            }
        }

        if (config.showPageIndicator && pageCount > 0) {
            val page by remember { derivedStateOf { listState.firstVisibleItemIndex + 1 } }
            Surface(Modifier.align(Alignment.BottomCenter).padding(bottom = if (config.readOnly) 16.dp else 124.dp), shape = RoundedCornerShape(50), tonalElevation = 3.dp, shadowElevation = 3.dp) {
                Text("$page / $pageCount", Modifier.padding(horizontal = 14.dp, vertical = 6.dp), style = MaterialTheme.typography.labelLarge)
            }
        }

        selection?.let { sel ->
            val text = ui.pageText?.getOrNull(sel.page)
            Surface(Modifier.align(Alignment.TopCenter).padding(8.dp), shape = RoundedCornerShape(50), tonalElevation = 3.dp, shadowElevation = 6.dp) {
                Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    for (kind in listOf(AnnotationKind.HIGHLIGHT, AnnotationKind.UNDERLINE, AnnotationKind.STRIKEOUT)) {
                        TextButton(onClick = {
                            text?.let { textMarkup(kind, sel.page, it.lineRects(sel.start, sel.end), config.author, color) }?.let { a -> change { add(a) } }
                            selection = null
                        }) { Text(kind.name.lowercase().replaceFirstChar { it.uppercase() }.replace("Strikeout", "Strike"), maxLines = 1) }
                    }
                    if (!config.secure && text != null) TextButton(onClick = {
                        clipboard.setText(AnnotatedString(text.text.substring(sel.start, sel.end))); selection = null
                    }) { Text("Copy", maxLines = 1) }
                    TextButton(onClick = { selection = null }) { Text("✕") }
                }
            }
        }

        if (!config.readOnly) {
            Surface(Modifier.align(Alignment.BottomCenter).fillMaxWidth(), tonalElevation = 3.dp, shadowElevation = 6.dp) {
                Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                        Tool.entries.forEach { t ->
                            FilterChip(selected = tool == t, onClick = { tool = t; selectedId = null }, label = { Text(t.label, maxLines = 1) }, modifier = Modifier.padding(horizontal = 3.dp))
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                            MARK_COLORS.forEach { c ->
                                val on = c == color
                                Box(Modifier.padding(horizontal = 4.dp).size(if (on) 30.dp else 26.dp).clip(CircleShape)
                                    .background(Color(android.graphics.Color.parseColor(c)))
                                    .border(if (on) 3.dp else 1.dp, if (on) MaterialTheme.colorScheme.primary else Color(0x33000000), CircleShape)
                                    .clickable { color = c })
                            }
                        }
                        TextButton(enabled = undoCount > 0 && history.canUndo, onClick = {
                            history.undo()?.let { before -> annotations.clear(); annotations.addAll(before); undoCount--; saved = false; selectedId = null }
                        }) { Text("Undo", maxLines = 1) }
                        Button(onClick = { scope.launch { onSave(file, annotations.toList()); saved = true } }) { Text(if (saved) "Saved" else "Save", maxLines = 1) }
                    }
                }
            }
        }

        annotations.firstOrNull { it.id == selectedId }?.let { a ->
            ModalBottomSheet(onDismissRequest = { selectedId = null }) {
                MarkDetails(a, editable = !config.readOnly,
                    onDone = { comment, status ->
                        val updated = Editing.annotate(a, comment, status)
                        if (updated !== a) change { set(indexOfFirst { it.id == a.id }, updated) }
                        selectedId = null
                    },
                    onDelete = { change { removeAll { it.id == a.id } }; selectedId = null })
            }
        }

        prompt?.let { p ->
            TextPromptDialog(p.tool, onDismiss = { prompt = null }) { value ->
                val g = doc.geometries[p.page]
                val a = if (p.tool == Tool.NOTE) Editing.note(p.page, p.at, value, config.author, g.width, g.height)
                    else Editing.textBox(p.page, p.at, value, color, config.author, g.width, g.height)
                a?.let { change { add(it) } }
                prompt = null
            }
        }

        if (ui.formOpen) {
            ModalBottomSheet(onDismissRequest = { ui.formOpen = false }) {
                FormSheet(ui.formFields, onCancel = { ui.formOpen = false }) { values ->
                    scope.launch {
                        val out = File(workDir, "filled-${System.currentTimeMillis()}.pdf").also { it.parentFile?.mkdirs() }
                        val fields = withContext(Dispatchers.IO) {
                            PdfStudio.fillForm(file, values, out)
                            PdfStudio.readFormFields(out)
                        }
                        ui.filled = out; ui.formFields = fields; saved = false
                        ui.formOpen = false
                    }
                }
            }
        }

        if (ui.thumbsOpen && pageCount > 0) {
            ModalBottomSheet(onDismissRequest = { ui.thumbsOpen = false }) {
                Thumbnails(doc, file, pageCount, listState.firstVisibleItemIndex, render) { page ->
                    ui.thumbsOpen = false
                    scope.launch { zoom = 1f; pan = androidx.compose.ui.geometry.Offset.Zero; listState.scrollToItem(page) }
                }
            }
        }
        LaunchedEffect(tool) { if (tool != Tool.VIEW) { zoom = 1f; pan = androidx.compose.ui.geometry.Offset.Zero; selection = null } }
    }
}

/** A mark's author, date, comment and review status; Delete and Done when the viewer is editable. */
@Composable
private fun MarkDetails(a: Annotation, editable: Boolean, onDone: (String?, ReviewStatus) -> Unit, onDelete: () -> Unit) {
    var comment by remember(a.id) { mutableStateOf(a.comment.orEmpty()) }
    var status by remember(a.id) { mutableStateOf(a.status) }
    val date = remember(a.modifiedAt) {
        Annotation.parseIso(a.modifiedAt)?.let { java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(it) }.orEmpty()
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
        Text(Editing.title(a), style = MaterialTheme.typography.titleLarge)
        Text(listOf(a.author, date).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (a.kind == AnnotationKind.FREETEXT && !a.text.isNullOrBlank())
            Text(a.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 12.dp))
        Spacer(Modifier.size(12.dp))
        if (editable) {
            OutlinedTextField(value = comment, onValueChange = { comment = it }, label = { Text("Comment") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            Text("Status", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
            Row(Modifier.horizontalScroll(rememberScrollState())) {
                ReviewStatus.entries.forEach { s ->
                    FilterChip(selected = status == s, onClick = { status = s },
                        label = { Text(if (s == ReviewStatus.NONE) "None" else s.json.replaceFirstChar { it.uppercase() }) }, modifier = Modifier.padding(end = 6.dp))
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDelete) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.weight(1f))
                Button(onClick = { onDone(comment, status) }) { Text("Done") }
            }
        } else {
            Text(a.comment?.takeIf { it.isNotBlank() } ?: "No comment", style = MaterialTheme.typography.bodyLarge)
            if (a.status != ReviewStatus.NONE) Text("Status: ${a.status.json}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
private fun TextPromptDialog(tool: Tool, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    var value by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (tool == Tool.NOTE) "Note" else "Text") },
        text = {
            OutlinedTextField(value = value, onValueChange = { value = it }, minLines = 2,
                placeholder = { Text(if (tool == Tool.NOTE) "Comment" else "Text on the page") },
                modifier = Modifier.fillMaxWidth().focusRequester(focus))
        },
        confirmButton = { Button(enabled = value.isNotBlank(), onClick = { onDone(value) }) { Text("Add") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Every fillable field with an editor for its kind; Apply fills them all at once. */
@Composable
private fun FormSheet(fields: List<FormField>, onCancel: () -> Unit, onApply: (Map<String, String>) -> Unit) {
    val values = remember(fields) { mutableStateMapOf<String, String>().apply { fields.forEach { put(it.name, it.value) } } }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
        Text("Form", style = MaterialTheme.typography.titleLarge)
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 460.dp).padding(vertical = 8.dp)) {
            items(fields.size) { i ->
                val f = fields[i]
                val label = f.name.substringAfterLast('.') + if (f.required) " *" else ""
                Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    when (f.kind) {
                        FormFieldKind.TEXT -> OutlinedTextField(
                            value = values[f.name].orEmpty(), enabled = !f.readOnly, label = { Text(label) },
                            onValueChange = { v -> values[f.name] = f.maxLength?.let { v.take(it) } ?: v },
                            singleLine = !f.multiline, modifier = Modifier.fillMaxWidth(),
                        )
                        FormFieldKind.CHECKBOX -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = values[f.name] == "true", enabled = !f.readOnly, onCheckedChange = { values[f.name] = it.toString() })
                            Text(label)
                        }
                        FormFieldKind.RADIO, FormFieldKind.DROPDOWN, FormFieldKind.LIST -> {
                            Text(label, style = MaterialTheme.typography.labelLarge)
                            Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp)) {
                                f.options.forEachIndexed { j, opt ->
                                    FilterChip(selected = values[f.name] == opt, enabled = !f.readOnly,
                                        onClick = { values[f.name] = if (values[f.name] == opt && f.kind != FormFieldKind.DROPDOWN) "" else opt },
                                        label = { Text(f.optionLabels.getOrElse(j) { opt }) }, modifier = Modifier.padding(end = 6.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onCancel) { Text("Cancel") }
            Button(onClick = { onApply(fields.filter { !it.readOnly && values[it.name] != it.value }.associate { it.name to values[it.name].orEmpty() }) }) { Text("Apply") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchBar(ui: ViewerUi) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    TopAppBar(
        navigationIcon = { TextButton(onClick = { ui.searchOpen = false; ui.query = "" }) { Text("✕") } },
        title = {
            TextField(
                value = ui.query, onValueChange = { ui.query = it }, singleLine = true,
                placeholder = { Text("Search document") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { ui.step(1) }),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
            )
        },
        actions = {
            val label = when {
                ui.pageText == null -> "Indexing…"
                ui.query.isBlank() -> ""
                ui.hits.isEmpty() -> "0 results"
                else -> "${ui.current + 1} / ${ui.hits.size}"
            }
            Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            TextButton(enabled = ui.hits.isNotEmpty(), onClick = { ui.step(-1) }) { Text("‹") }
            TextButton(enabled = ui.hits.isNotEmpty(), onClick = { ui.step(1) }) { Text("›") }
        },
    )
}

/** Page thumbnails; bitmaps are rendered once per document and kept in a small LRU cache. */
@Composable
private fun Thumbnails(doc: LoadedDocument, file: File, pageCount: Int, currentPage: Int, render: suspend (Int, Int) -> Bitmap?, onPick: (Int) -> Unit) {
    val cache = remember(doc, file) { LruCache<Int, Bitmap>(48) }
    val widthPx = with(LocalDensity.current) { 104.dp.roundToPx() }
    LazyVerticalGrid(
        columns = GridCells.Adaptive(104.dp), state = rememberLazyGridState(initialFirstVisibleItemIndex = currentPage),
        contentPadding = PaddingValues(12.dp), modifier = Modifier.fillMaxWidth().heightIn(max = 520.dp),
    ) {
        items(pageCount) { index ->
            val g = doc.geometries[index]
            val bitmap by produceState(cache.get(index), index, file) {
                if (value == null) value = render(index, widthPx)?.also { cache.put(index, it) }
            }
            Column(Modifier.padding(6.dp).clickable { onPick(index) }, horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.fillMaxWidth().aspectRatio((g.width / g.height).toFloat()).background(Color.White)
                    .border(if (index == currentPage) 2.dp else 1.dp, if (index == currentPage) MaterialTheme.colorScheme.primary else Color(0x22000000))) {
                    bitmap?.let { androidx.compose.foundation.Image(it.asImageBitmap(), "Page ${index + 1}", Modifier.fillMaxSize()) }
                }
                Text("${index + 1}", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

/** The run of non-whitespace characters around [i] as `start until end`. */
private fun wordAround(s: String, i: Int): Pair<Int, Int> {
    if (s[i].isWhitespace()) return i to i + 1
    var a = i; var b = i + 1
    while (a > 0 && !s[a - 1].isWhitespace()) a--
    while (b < s.length && !s[b].isWhitespace()) b++
    return a to b
}

private fun textMarkup(kind: AnnotationKind, page: Int, rects: List<com.pdfstudio.sdk.Box>, author: String, color: String): Annotation? {
    if (rects.isEmpty()) return null
    return if (kind == AnnotationKind.HIGHLIGHT) Annotation(page = page, kind = kind, color = "#ffd84d", opacity = 0.45, strokeWidth = 0.0, rects = rects, author = author)
    else Annotation(page = page, kind = kind, color = color, strokeWidth = 1.5, rects = rects, author = author)
}


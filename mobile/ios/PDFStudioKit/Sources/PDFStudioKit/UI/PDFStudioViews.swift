#if canImport(UIKit)
import PDFKit
import SwiftUI
import UIKit

/// Read-only document view: the PDFKit equivalent of a read-only `PTDocumentController`.
///
/// ```swift
/// let doc = StudioDocument(data: pdfData, name: "checked-copy.pdf")!
/// try doc.mergeXFDF(reviewerXFDF)            // markup from the web viewer / API
/// PDFStudioViewer(document: doc, allowsTextSelection: false)
/// ```
public struct PDFStudioViewer: UIViewRepresentable {
    @ObservedObject public var document: StudioDocument
    public var allowsTextSelection: Bool
    public var displayMode: PDFDisplayMode

    public init(document: StudioDocument, allowsTextSelection: Bool = true, displayMode: PDFDisplayMode = .singlePageContinuous) {
        self.document = document
        self.allowsTextSelection = allowsTextSelection
        self.displayMode = displayMode
    }

    public func makeUIView(context: Context) -> StudioPDFView {
        let v = StudioPDFView()
        v.isReadOnly = true
        v.pdfView.displayMode = displayMode
        v.setDocument(document)
        v.allowsTextSelection = allowsTextSelection
        return v
    }

    public func updateUIView(_ v: StudioPDFView, context: Context) {
        v.setDocument(document)
        v.allowsTextSelection = allowsTextSelection
    }
}

/// Bridges SwiftUI state to a `StudioPDFView`.
@MainActor
final class EditorController: ObservableObject {
    weak var view: StudioPDFView?
    @Published var hasTextSelection = false
    @Published var measureDraft: MeasureDraft?
}

struct StudioCanvas: UIViewRepresentable {
    @ObservedObject var document: StudioDocument
    var tool: StudioTool
    var style: StudioToolStyle
    var author: String
    var signature: String?
    var measureScale: MeasureScaleSetting
    let controller: EditorController
    var requestText: (String, String, @escaping (String?) -> Void) -> Void
    var onToolFinished: () -> Void

    func makeUIView(context: Context) -> StudioPDFView {
        let v = StudioPDFView()
        controller.view = v
        v.setDocument(document)
        v.onSelectionChanged = { [weak controller] has in controller?.hasTextSelection = has }
        v.onMeasureDraftChanged = { [weak controller] d in controller?.measureDraft = d }
        update(v)
        return v
    }

    func updateUIView(_ v: StudioPDFView, context: Context) { update(v) }

    private func update(_ v: StudioPDFView) {
        v.setDocument(document)
        if v.tool != tool { v.tool = tool }
        v.style = style
        v.author = author
        v.signatureImage = signature
        v.measureScale = measureScale
        v.requestText = requestText
        v.onToolFinished = onToolFinished
    }
}

/// A complete annotation editor: tools (including distance, perimeter and area measurements), colours, undo/redo,
/// search, comments, thumbnails, signatures and export (editable PDF, flattened PDF, XFDF, JSON).
///
/// With a `server`, redaction marks can be applied: the document goes to the PDF Studio server's `/redact` and the
/// editor switches to the redacted copy (also passed to `onDocumentChange`, e.g. to save it).
public struct PDFStudioEditor: View {
    @ObservedObject var document: StudioDocument
    let author: String
    let server: PDFStudioServer?
    let onDocumentChange: ((StudioDocument) -> Void)?
    @State private var replacement: StudioDocument?

    public init(document: StudioDocument, author: String = "Me", server: PDFStudioServer? = nil,
                onDocumentChange: ((StudioDocument) -> Void)? = nil) {
        self.document = document
        self.author = author
        self.server = server
        self.onDocumentChange = onDocumentChange
    }

    public var body: some View {
        EditorContent(document: replacement ?? document, author: author, server: server) { doc in
            replacement = doc
            onDocumentChange?(doc)
        }
    }
}

struct EditorContent: View {
    @ObservedObject var document: StudioDocument
    let author: String
    let server: PDFStudioServer?
    let onRedacted: (StudioDocument) -> Void

    @StateObject private var controller = EditorController()
    @State private var tool: StudioTool = .select
    @State private var style = StudioToolStyle()
    @State private var signature: String? = UserDefaults.standard.string(forKey: "pdfstudio.signature")
    @State private var showSignaturePad = false
    @State private var showSearch = false
    @State private var showComments = false
    @State private var showThumbnails = false
    @State private var textPrompt: TextPrompt?
    @State private var share: ShareItem?
    @State private var measureScale = EditorContent.savedScale()
    @State private var showScale = false
    @State private var confirmRedaction = false
    @State private var busy: String?
    @State private var notice: String?
    @State private var failure: String?

    static let colors = ["#ffd84d", "#7ee081", "#5ab0ff", "#ff7aa8", "#e5484d", "#1f6feb", "#111111", "#7c3aed"]
    static let stamps = ["APPROVED", "REJECTED", "DRAFT", "CONFIDENTIAL", "REVIEWED", "स्वीकृत"]

    static func savedScale() -> MeasureScaleSetting {
        UserDefaults.standard.data(forKey: "pdfstudio.scale").flatMap { try? JSONDecoder().decode(MeasureScaleSetting.self, from: $0) } ?? .default
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                StudioCanvas(document: document, tool: tool, style: style, author: author, signature: signature,
                             measureScale: measureScale, controller: controller, requestText: { title, initial, done in
                                 textPrompt = TextPrompt(title: title, text: initial, done: done)
                             }, onToolFinished: { tool = .select })
                    .ignoresSafeArea(edges: .bottom)
                if tool.isTextMarkup {
                    hintPill(controller.hasTextSelection ? nil : "Select text, then tap \(tool.title)") {
                        controller.view?.applyMarkupToSelection()
                    }
                }
                if tool.placesPoints { measurePill }
                if tool == .distance { notePill("Drag between two points to measure") }
                if tool == .redact || document.selectedID.flatMap(document.annotation(id:))?.kind == .redact {
                    if server != nil, !document.redactionMarks.isEmpty, busy == nil {
                        Button("Apply \(document.redactionMarks.count) redaction(s)…", systemImage: "eraser.line.dashed") { confirmRedaction = true }
                            .font(.footnote.bold()).buttonStyle(.borderedProminent).tint(.red).clipShape(Capsule()).padding(.top, 8)
                    } else if busy == nil {
                        notePill("Drag over content to remove. Nothing is removed until the marks are applied.")
                    }
                }
                if let busy {
                    ProgressView(busy).padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)).padding(.top, 80)
                } else if let notice {
                    notePill(notice).onTapGesture { self.notice = nil }
                }
            }
            if showThumbnails { ThumbnailStrip(pdfView: controller.view?.pdfView).frame(height: 96) }
            if let id = document.selectedID, let a = document.annotation(id: id) { selectionBar(a) }
            toolPalette
        }
        .toolbar { toolbar }
        .sheet(isPresented: $showSignaturePad) {
            SignaturePad { png in
                signature = png
                UserDefaults.standard.set(png, forKey: "pdfstudio.signature")
                tool = .signature
            }
        }
        .sheet(isPresented: $showSearch) { SearchSheet(document: document, pdfView: controller.view?.pdfView) }
        .sheet(isPresented: $showComments) { CommentsSheet(document: document, pdfView: controller.view?.pdfView) }
        .sheet(item: $share) { item in ActivityView(items: [item.url]) }
        .sheet(isPresented: $showScale) {
            ScaleSheet(scale: $measureScale, selected: document.selectedID.flatMap(document.annotation(id:))) { next, factor in
                // like the web: changing the scale re-scales the selected measurement too
                if let id = document.selectedID, document.annotation(id: id)?.measure != nil {
                    var m = next.measureScale
                    if let factor { m.factor = factor }
                    document.update(id) { $0.measure = m }
                }
            }
        }
        .onChange(of: measureScale) { _, s in
            if let d = try? JSONEncoder().encode(s) { UserDefaults.standard.set(d, forKey: "pdfstudio.scale") }
        }
        .confirmationDialog("Apply \(document.redactionMarks.count) redaction(s)?", isPresented: $confirmRedaction, titleVisibility: .visible) {
            Button("Apply redactions", role: .destructive) { applyRedactions() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The document is sent to the PDF Studio server, which permanently removes the text, images and drawings under the marks and cleans hidden information. You then get a redacted copy; this document is not changed.")
        }
        .alert("Redaction failed", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
        .alert(textPrompt?.title ?? "", isPresented: Binding(get: { textPrompt != nil }, set: { if !$0 { textPrompt = nil } })) {
            TextField("", text: Binding(get: { textPrompt?.text ?? "" }, set: { textPrompt?.text = $0 }), axis: .vertical)
            Button("Cancel", role: .cancel) { textPrompt?.done(nil); textPrompt = nil }
            Button("OK") { textPrompt?.done(textPrompt?.text ?? ""); textPrompt = nil }
        }
    }

    // MARK: pieces

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { document.undo() } label: { Image(systemName: "arrow.uturn.backward") }.disabled(!document.canUndo)
            Button { document.redo() } label: { Image(systemName: "arrow.uturn.forward") }.disabled(!document.canRedo)
            Button { showSearch = true } label: { Image(systemName: "magnifyingglass") }
            Button { showComments = true } label: { Image(systemName: "text.bubble") }
            Button { showThumbnails.toggle() } label: { Image(systemName: "square.grid.2x2") }
            Menu {
                // shown only with a server and marks to apply (in this menu so it stays reachable on narrow screens)
                if server != nil, !document.redactionMarks.isEmpty {
                    Button("Apply \(document.redactionMarks.count) redaction(s)…", systemImage: "eraser.line.dashed") { confirmRedaction = true }
                        .disabled(busy != nil)
                    Divider()
                }
                Button("Share PDF (editable annotations)", systemImage: "square.and.arrow.up") { export(.editable) }
                Button("Share flattened PDF", systemImage: "doc.richtext") { export(.flattened) }
                Button("Export XFDF", systemImage: "chevron.left.forwardslash.chevron.right") { exportText(document.exportXFDF(), ext: "xfdf") }
                Button("Export JSON", systemImage: "curlybraces") {
                    if let d = try? document.exportJSON() { exportText(String(decoding: d, as: UTF8.self), ext: "json") }
                }
            } label: { Image(systemName: "square.and.arrow.up") }
        }
    }

    private var toolPalette: some View {
        VStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(StudioTool.allCases) { t in
                        Button {
                            choose(t)
                        } label: {
                            Image(systemName: t.symbol)
                                .font(.system(size: 18))
                                .frame(width: 40, height: 36)
                                .background(tool == t ? Color.accentColor.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 8))
                        }
                        .accessibilityLabel(t.title)
                    }
                }
                .padding(.horizontal, 12)
            }
            ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 10) {
                ForEach(Self.colors, id: \.self) { c in
                    Circle().fill(Color(uiColor: UIColor(hex: c)))
                        .frame(width: 24, height: 24)
                        .overlay(Circle().stroke(Color.primary, lineWidth: style.color == c ? 2 : 0).padding(-3))
                        .onTapGesture { setColor(c) }
                        .accessibilityLabel("Colour \(c)")
                }
                Spacer(minLength: 12)
                if tool == .stamp {
                    Menu(style.stampText) { ForEach(Self.stamps, id: \.self) { s in Button(s) { style.stampText = s } } }
                        .font(.footnote.bold())
                }
                if tool == .signature {
                    Button(signature == nil ? "Create" : "Change") { showSignaturePad = true }.font(.footnote)
                }
                if tool.isMeasurement || document.selectedID.flatMap(document.annotation(id:))?.measure != nil {
                    Button { showScale = true } label: { Label(measureScale.summary, systemImage: "ruler") }
                        .font(.footnote).accessibilityLabel("Measurement scale \(measureScale.summary)")
                }
                if [.ink, .rect, .ellipse, .line, .arrow, .distance, .perimeter, .area].contains(tool) {
                    Stepper(value: $style.strokeWidth, in: 0.5...12, step: 0.5) { Text("\(style.strokeWidth, specifier: "%.1f")").font(.footnote.monospacedDigit()) }
                        .fixedSize()
                }
            }
            .padding(.horizontal, 16) }
        }
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func selectionBar(_ a: Annotation) -> some View {
        HStack {
            Text(a.kind.rawValue.capitalized).font(.footnote.bold())
            if a.kind.isMeasurement { Text(Measure.label(a)).font(.footnote.monospacedDigit()) }
            Text("p.\(a.page + 1) · \(a.author)").font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Button("Comment") {
                textPrompt = TextPrompt(title: "Comment", text: a.comment ?? "") { t in
                    guard let t else { return }
                    document.update(a.id) { $0.comment = t.isEmpty ? nil : t }
                }
            }
            Button(role: .destructive) { document.remove(a.id) } label: { Image(systemName: "trash") }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.thinMaterial)
    }

    private func hintPill(_ text: String?, action: @escaping () -> Void) -> some View {
        Group {
            if let text {
                Text(text).font(.footnote).padding(.horizontal, 12).padding(.vertical, 6).background(.thinMaterial, in: Capsule())
            } else {
                Button(tool.title, systemImage: tool.symbol, action: action)
                    .buttonStyle(.borderedProminent).clipShape(Capsule())
            }
        }
        .padding(.top, 8)
    }

    private var measurePill: some View {
        let d = controller.measureDraft
        return HStack(spacing: 8) {
            if let d, !d.points.isEmpty {
                Text(d.points.count >= 2 ? d.label(scale: measureScale.measureScale) : "Tap the next point").font(.footnote.monospacedDigit())
                Button { controller.view?.removeLastMeasurePoint() } label: { Image(systemName: "arrow.uturn.backward") }
                    .accessibilityLabel("Remove last point")
                Button("Cancel") { controller.view?.cancelMeasurement() }.font(.footnote)
                Button("Finish") { controller.view?.finishMeasurement() }
                    .font(.footnote.bold()).buttonStyle(.borderedProminent).disabled(!d.canFinish)
            } else {
                Text("Tap points to measure \(tool == .area ? "an area" : "a perimeter"), then Finish").font(.footnote)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.thinMaterial, in: Capsule())
        .padding(.top, 8)
    }

    private func notePill(_ text: String) -> some View {
        Text(text).font(.footnote).multilineTextAlignment(.center)
            .padding(.horizontal, 12).padding(.vertical, 6).background(.thinMaterial, in: Capsule()).padding(.top, 8)
    }

    private func applyRedactions() {
        guard let server else { return }
        busy = "Redacting…"
        Task {
            defer { busy = nil }
            do {
                let (doc, r) = try await document.applyRedactions(using: server)
                tool = .select
                onRedacted(doc)
                let cleaned = r.sanitized.isEmpty ? "—" : r.sanitized.joined(separator: ", ")
                notice = "Redacted \(r.regions) area(s) on \(r.pages.count) page(s); removed \(r.annotationsRemoved) overlapping annotation(s); hidden information cleaned: \(cleaned). Share to save the redacted file."
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func choose(_ t: StudioTool) {
        tool = t
        document.selectedID = nil
        switch t {
        case .highlight: style.color = "#ffd84d"
        case .underline, .strikeout: style.color = "#e5484d"
        case .signature where signature == nil: showSignaturePad = true
        default: if style.color == "#ffd84d" { style.color = "#e5484d" }
        }
    }

    private func setColor(_ c: String) {
        style.color = c
        if let id = document.selectedID { document.update(id) { $0.color = c } }
    }

    private func export(_ mode: StudioDocument.SaveMode) {
        guard let data = document.pdfData(mode) else { return }
        let base = (document.name as NSString).deletingPathExtension
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(base)-\(mode == .editable ? "annotated" : "flattened").pdf")
        try? data.write(to: url)
        share = ShareItem(url: url)
    }

    private func exportText(_ text: String, ext: String) {
        let base = (document.name as NSString).deletingPathExtension
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(base)-annotations.\(ext)")
        try? text.write(to: url, atomically: true, encoding: .utf8)
        share = ShareItem(url: url)
    }
}

/// Scale for new measurements (web measure bar): paper length = real-world length, precision, and calibrating
/// from a selected distance measurement drawn over a known length.
struct ScaleSheet: View {
    @Binding var scale: MeasureScaleSetting
    let selected: Annotation?
    /// The new setting, and the exact factor when calibrated.
    var onChange: (MeasureScaleSetting, Double?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var realLength = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("Paper", value: value(\.paperValue), format: .number).keyboardType(.decimalPad)
                        Picker("", selection: binding(\.paperUnit)) { ForEach(MeasureScaleSetting.paperUnitNames, id: \.self) { Text($0) } }.labelsHidden()
                    }
                    HStack {
                        Text("=")
                        TextField("Real world", value: value(\.worldValue), format: .number).keyboardType(.decimalPad)
                        Picker("", selection: binding(\.worldUnit)) { ForEach(MeasureScaleSetting.worldUnits, id: \.self) { Text($0) } }.labelsHidden()
                    }
                    Picker("Precision", selection: binding(\.precision)) { ForEach(0...3, id: \.self) { Text("\($0)") } }
                } header: {
                    Text(selected?.measure != nil ? "Scale (also applied to the selected measurement)" : "Scale")
                } footer: {
                    Text("Length on the page = length in the real world, e.g. 1 in = 10 ft.")
                }
                if let a = selected, a.kind == .distance {
                    Section {
                        HStack {
                            TextField("Real length in \(scale.worldUnit)", text: $realLength).keyboardType(.decimalPad)
                            Button("Calibrate") {
                                guard let v = Double(realLength.replacingOccurrences(of: ",", with: ".")),
                                      let (next, factor) = scale.calibrated(to: a, realLength: v) else { return }
                                scale = next
                                onChange(next, factor)
                                realLength = ""
                            }
                        }
                    } footer: {
                        Text("Enter the real length of the selected distance measurement to set the scale from it.")
                    }
                }
            }
            .navigationTitle("Measurement scale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Reset") { set(.default) } }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func set(_ next: MeasureScaleSetting) {
        scale = next
        onChange(next, nil)
    }

    private func binding<T>(_ key: WritableKeyPath<MeasureScaleSetting, T>) -> Binding<T> {
        Binding(get: { scale[keyPath: key] }, set: { var n = scale; n[keyPath: key] = $0; set(n) })
    }

    /// Positive numbers only, as the web's inputs.
    private func value(_ key: WritableKeyPath<MeasureScaleSetting, Double>) -> Binding<Double> {
        Binding(get: { scale[keyPath: key] }, set: { v in guard v > 0 else { return }; var n = scale; n[keyPath: key] = v; set(n) })
    }
}

struct TextPrompt {
    var title: String
    var text: String
    var done: (String?) -> Void
}

struct ShareItem: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ c: UIActivityViewController, context: Context) {}
}

struct ThumbnailStrip: UIViewRepresentable {
    weak var pdfView: PDFView?
    func makeUIView(context: Context) -> PDFThumbnailView {
        let v = PDFThumbnailView()
        v.layoutMode = .horizontal
        v.thumbnailSize = CGSize(width: 56, height: 76)
        v.backgroundColor = .secondarySystemBackground
        v.pdfView = pdfView
        return v
    }
    func updateUIView(_ v: PDFThumbnailView, context: Context) { v.pdfView = pdfView }
}

// MARK: - Sheets

struct SearchSheet: View {
    @ObservedObject var document: StudioDocument
    weak var pdfView: PDFView?
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [PDFSelection] = []

    var body: some View {
        NavigationStack {
            List(Array(results.enumerated()), id: \.offset) { _, sel in
                Button {
                    pdfView?.go(to: sel)
                    pdfView?.setCurrentSelection(sel, animate: true)
                    dismiss()
                } label: {
                    VStack(alignment: .leading) {
                        Text("Page \((sel.pages.first.map { document.pdf.index(for: $0) } ?? 0) + 1)").font(.caption).foregroundStyle(.secondary)
                        Text(context(sel)).lineLimit(2)
                    }
                }
            }
            .overlay { if !query.isEmpty && results.isEmpty { ContentUnavailableView.search(text: query) } }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .onChange(of: query) { _, q in
                results = q.count < 2 ? [] : document.pdf.findString(q, withOptions: [.caseInsensitive, .diacriticInsensitive])
                pdfView?.highlightedSelections = results
            }
            .navigationTitle("\(results.count) results")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
    }

    private func context(_ sel: PDFSelection) -> String {
        guard let s = sel.copy() as? PDFSelection else { return sel.string ?? "" }
        s.extend(atStart: 30)
        s.extend(atEnd: 40)
        return (s.string ?? "").replacingOccurrences(of: "\n", with: " ")
    }
}

struct CommentsSheet: View {
    @ObservedObject var document: StudioDocument
    weak var pdfView: PDFView?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(document.annotations.sorted { ($0.page, $0.createdAt) < ($1.page, $1.createdAt) }) { a in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Circle().fill(Color(uiColor: UIColor(hex: a.color))).frame(width: 10, height: 10)
                            Text(a.kind.rawValue.capitalized).bold()
                            Text("p.\(a.page + 1) · \(a.author)").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button { go(a) } label: { Image(systemName: "arrow.right.circle") }.buttonStyle(.borderless)
                        }
                        if let t = a.text, a.kind == .freetext { Text(t).font(.callout).foregroundStyle(.secondary) }
                        if a.kind.isMeasurement { Text(Measure.label(a)).font(.callout).foregroundStyle(.secondary) }
                        TextField("Add a comment", text: Binding(
                            get: { a.comment ?? "" },
                            set: { v in document.update(a.id) { $0.comment = v.isEmpty ? nil : v } }
                        ), axis: .vertical)
                        Picker("Status", selection: Binding(get: { a.status }, set: { s in document.update(a.id) { $0.status = s } })) {
                            ForEach(ReviewStatus.allCases, id: \.self) { Text($0 == .none ? "No status" : $0.rawValue.capitalized).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                    .padding(.vertical, 4)
                }
                .onDelete { idx in
                    let sorted = document.annotations.sorted { ($0.page, $0.createdAt) < ($1.page, $1.createdAt) }
                    idx.map { sorted[$0].id }.forEach(document.remove)
                }
            }
            .overlay { if document.annotations.isEmpty { ContentUnavailableView("No annotations", systemImage: "text.bubble") } }
            .navigationTitle("Annotations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
    }

    private func go(_ a: Annotation) {
        document.selectedID = a.id
        if let page = document.pdf.page(at: a.page) {
            pdfView?.go(to: document.geometry(page: a.page).toPDF(a.bounds), on: page)
        }
        dismiss()
    }
}

/// Draw a signature with a finger or Apple Pencil.
struct SignaturePad: View {
    var onDone: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var strokes: [[CGPoint]] = []
    @State private var current: [CGPoint] = []
    @State private var ink = Color(red: 0.1, green: 0.17, blue: 0.43)

    var body: some View {
        NavigationStack {
            VStack {
                Canvas { ctx, _ in
                    for s in strokes + [current] where s.count > 1 {
                        var p = Path(); p.addLines(s)
                        ctx.stroke(p, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                    }
                }
                .frame(height: 220)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [5])))
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { current.append($0.location) }
                    .onEnded { _ in strokes.append(current); current = [] })
                .padding()
                Text("Sign above").font(.footnote).foregroundStyle(.secondary)
                Spacer()
            }
            .navigationTitle("Signature")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .principal) { ColorPicker("Ink", selection: $ink).labelsHidden() }
                ToolbarItem(placement: .destructiveAction) { Button("Clear") { strokes = []; current = [] }.disabled(strokes.isEmpty) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use") { if let png = render() { onDone(png) }; dismiss() }.disabled(strokes.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    /// Renders the strokes cropped to their bounds, at 3x, as a PNG data URL.
    private func render() -> String? {
        let pts = strokes.flatMap { $0 }
        guard let minX = pts.map(\.x).min(), let maxX = pts.map(\.x).max(),
              let minY = pts.map(\.y).min(), let maxY = pts.map(\.y).max() else { return nil }
        let pad: CGFloat = 6
        let size = CGSize(width: maxX - minX + pad * 2, height: maxY - minY + pad * 2)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        format.opaque = false
        let img = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let c = ctx.cgContext
            c.setStrokeColor(UIColor(ink).cgColor)
            c.setLineWidth(3); c.setLineCap(.round); c.setLineJoin(.round)
            for s in strokes where s.count > 1 {
                c.addLines(between: s.map { CGPoint(x: $0.x - minX + pad, y: $0.y - minY + pad) })
                c.strokePath()
            }
        }
        return img.cgImage.flatMap(pngDataURL)
    }
}
#endif

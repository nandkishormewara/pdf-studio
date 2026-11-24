import PDFStudioKit
import SwiftUI
import UniformTypeIdentifiers

@main
struct PDFStudioDemoApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var opened: StudioDocument?
    @State private var importing = false
    @State private var error: String?
    @AppStorage("pdfstudio.serverURL") private var serverURL = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink("Sample document") { EditorScreen(document: Samples.editorDocument()) }
                    NavigationLink("Annotations from the web app (JSON)") { EditorScreen(document: Samples.webAnnotationsDocument()) }
                    NavigationLink("Rotated pages") { EditorScreen(document: Samples.rotatedDocument()) }
                    Button("Open a PDF…") { importing = true }
                } header: {
                    Text("Editor")
                } footer: {
                    Text("All tools, undo/redo, search, comments, thumbnails, signatures; share as editable or flattened PDF, XFDF or JSON.")
                }
                Section {
                    TextField("http://localhost:8787", text: $serverURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                } header: {
                    Text("PDF Studio server (optional)")
                } footer: {
                    Text("With a server, redaction marks can be applied from the editor (run server/run.sh on this Mac for the simulator).")
                }
                Section {
                    NavigationLink("Reviewer-checked copy") { CheckedCopyScreen() }
                } header: {
                    Text("Read-only viewer")
                } footer: {
                    Text("A typical checked-copy viewer: read-only, text selection off, reviewer markup merged from Apryse WebViewer XFDF.")
                }
            }
            .navigationTitle("PDF Studio")
            .navigationDestination(item: $opened) { EditorScreen(document: $0) }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf]) { result in
                guard case .success(let url) = result else { return }
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                if let doc = StudioDocument(url: url) { opened = doc } else { error = "Couldn't open \(url.lastPathComponent)." }
            }
            .alert("Error", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {} message: { Text(error ?? "") }
        }
    }
}

extension StudioDocument: @retroactive Hashable {
    public static func == (a: StudioDocument, b: StudioDocument) -> Bool { a === b }
    public func hash(into h: inout Hasher) { h.combine(ObjectIdentifier(self)) }
}

struct EditorScreen: View {
    @StateObject var document: StudioDocument
    @AppStorage("pdfstudio.serverURL") private var serverURL = ""
    var body: some View {
        PDFStudioEditor(document: document, author: "Demo user", server: PDFStudioServer(string: serverURL))
            .navigationTitle(document.name)
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// A read-only checked-copy viewer, with PDF Studio in place of PTDocumentController.
struct CheckedCopyScreen: View {
    @StateObject private var document = Samples.checkedCopy()
    var body: some View {
        PDFStudioViewer(document: document, allowsTextSelection: false)
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle("Checked copy")
            .navigationBarTitleDisplayMode(.inline)
            .overlay(alignment: .bottom) {
                Text("\(document.annotations.count) reviewer annotations · read-only")
                    .font(.footnote).padding(.horizontal, 12).padding(.vertical, 6)
                    .background(.thinMaterial, in: Capsule()).padding(.bottom, 24)
            }
    }
}

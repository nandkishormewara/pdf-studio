#if canImport(UIKit)
import Combine
import PDFKit
import UIKit

public enum StudioTool: String, CaseIterable, Identifiable, Sendable {
    case select, highlight, underline, strikeout, freetext, note, ink, rect, ellipse, line, arrow, stamp, signature
    case distance, perimeter, area, redact

    public var id: String { rawValue }
    var kind: AnnotationKind? { AnnotationKind(rawValue: rawValue) }
    /// Tools that draw on the page with touches (as opposed to text selection or tapping annotations).
    var drawsOnPage: Bool { self != .select && !isTextMarkup }
    var isTextMarkup: Bool { self == .highlight || self == .underline || self == .strikeout }
    /// Distance, perimeter and area: new marks get the viewer's measurement scale.
    public var isMeasurement: Bool { self == .distance || self == .perimeter || self == .area }
    /// Perimeter and area: placed by tapping points, then finished (`StudioPDFView.finishMeasurement()`).
    public var placesPoints: Bool { self == .perimeter || self == .area }

    public var title: String {
        switch self {
        case .select: "Select"; case .highlight: "Highlight"; case .underline: "Underline"; case .strikeout: "Strikeout"
        case .freetext: "Text"; case .note: "Note"; case .ink: "Pen"; case .rect: "Rectangle"; case .ellipse: "Ellipse"
        case .line: "Line"; case .arrow: "Arrow"; case .stamp: "Stamp"; case .signature: "Signature"; case .redact: "Redact"
        case .distance: "Distance"; case .perimeter: "Perimeter"; case .area: "Area"
        }
    }

    public var symbol: String {
        switch self {
        case .select: "hand.point.up.left"; case .highlight: "highlighter"; case .underline: "underline"; case .strikeout: "strikethrough"
        case .freetext: "textformat"; case .note: "note.text"; case .ink: "pencil.tip"; case .rect: "rectangle"; case .ellipse: "circle"
        case .line: "line.diagonal"; case .arrow: "arrow.up.right"; case .stamp: "seal"; case .signature: "signature"; case .redact: "rectangle.fill.badge.xmark"
        case .distance: "ruler"; case .perimeter: "point.3.connected.trianglepath.dotted"; case .area: "pentagon"
        }
    }
}

public struct StudioToolStyle: Equatable, Sendable {
    public var color = "#e5484d"
    public var opacity = 1.0
    public var strokeWidth = 2.0
    public var fontSize = 14.0
    public var stampText = "APPROVED"
    public init() {}
}

/// PDFView that adds Highlight / Underline / Strikeout to the text-selection menu and can
/// suppress copying for secure viewing.
public final class StudioPDFKitView: PDFView {
    var onMarkup: ((AnnotationKind) -> Void)?
    var markupEnabled = true
    var copyEnabled = true

    public override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        if !copyEnabled {
            builder.remove(menu: .standardEdit)
            builder.remove(menu: .share)
            builder.remove(menu: .lookup)
        }
        guard markupEnabled, currentSelection?.string?.isEmpty == false else { return }
        let items: [(String, String, AnnotationKind)] = [("Highlight", "highlighter", .highlight), ("Underline", "underline", .underline), ("Strikeout", "strikethrough", .strikeout)]
        let actions = items.map { title, symbol, kind in
            UIAction(title: title, image: UIImage(systemName: symbol)) { [weak self] _ in self?.onMarkup?(kind) }
        }
        builder.insertChild(UIMenu(options: .displayInline, children: actions), atStartOfMenu: .root)
    }

    public override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if !copyEnabled, [#selector(copy(_:)), #selector(selectAll(_:)), NSSelectorFromString("_share:"), NSSelectorFromString("_define:")].contains(action) {
            return false
        }
        return super.canPerformAction(action, withSender: sender)
    }
}

/// The interactive page surface: PDFKit for display plus an overlay for drawing tools.
public final class StudioPDFView: UIView, UIGestureRecognizerDelegate {
    public let pdfView = StudioPDFKitView()
    private let overlay = DrawingOverlay()
    private let selectionLayer = CAShapeLayer()
    private var bag = Set<AnyCancellable>()
    private var scrollObservation: NSKeyValueObservation?

    public private(set) var document: StudioDocument?
    public var tool: StudioTool = .select { didSet { toolChanged() } }
    public var style = StudioToolStyle()
    public var author = "Me"
    /// PNG data URL used by the Signature tool.
    public var signatureImage: String?
    /// Viewer-only: no tools, no selecting or moving annotations, no markup menu.
    public var isReadOnly = false { didSet { toolChanged() } }
    /// When false, text can't be selected or copied (for protected documents).
    public var allowsTextSelection = true { didSet { applyTextSelectionPolicy() } }
    /// Asks the host for text (free text, notes). Call the completion with nil to cancel.
    public var requestText: ((_ title: String, _ initial: String, _ completion: @escaping (String?) -> Void) -> Void)?
    /// Called when a tool that places one item (note, stamp, signature) has been used.
    public var onToolFinished: (() -> Void)?
    public var onSelectionChanged: ((Bool) -> Void)?
    /// Scale given to new distance, perimeter and area measurements.
    public var measureScale = MeasureScaleSetting.default
    /// The perimeter or area being placed (points tapped so far), or nil.
    public private(set) var measureDraft: MeasureDraft? {
        didSet { if measureDraft != oldValue { updateOverlays(); onMeasureDraftChanged?(measureDraft) } }
    }
    public var onMeasureDraftChanged: ((MeasureDraft?) -> Void)?
    private let pointTap = UITapGestureRecognizer()
    private let draftLayer = CAShapeLayer()
    private let draftLabel = CATextLayer()

    public override init(frame: CGRect) {
        super.init(frame: frame)
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.pageShadowsEnabled = true
        pdfView.backgroundColor = .secondarySystemBackground
        pdfView.translatesAutoresizingMaskIntoConstraints = false
        overlay.translatesAutoresizingMaskIntoConstraints = false
        addSubview(pdfView)
        addSubview(overlay)
        for v in [pdfView, overlay] {
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: leadingAnchor), v.trailingAnchor.constraint(equalTo: trailingAnchor),
                v.topAnchor.constraint(equalTo: topAnchor), v.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }
        selectionLayer.fillColor = UIColor.clear.cgColor
        selectionLayer.strokeColor = UIColor.systemBlue.cgColor
        selectionLayer.lineWidth = 1.5
        selectionLayer.lineDashPattern = [5, 3]
        overlay.layer.addSublayer(selectionLayer)
        draftLayer.fillColor = UIColor.clear.cgColor
        draftLayer.lineCap = .round
        draftLayer.lineJoin = .round
        overlay.layer.addSublayer(draftLayer)
        draftLabel.fontSize = 12
        draftLabel.alignmentMode = .center
        draftLabel.backgroundColor = UIColor.white.withAlphaComponent(0.9).cgColor
        draftLabel.cornerRadius = 3
        draftLabel.contentsScale = UIScreen.main.scale
        draftLabel.isHidden = true
        overlay.layer.addSublayer(draftLabel)
        overlay.host = self
        overlay.isUserInteractionEnabled = false
        // perimeter / area vertices: a recogniser also catches very quick taps that raw touches can lose
        pointTap.addTarget(self, action: #selector(handlePointTap(_:)))
        pointTap.isEnabled = false
        overlay.addGestureRecognizer(pointTap)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.delegate = self
        pdfView.addGestureRecognizer(tap)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.delegate = self
        pdfView.addGestureRecognizer(pan)
        movePan = pan
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.delegate = self
        pdfView.addGestureRecognizer(doubleTap)

        pdfView.onMarkup = { [weak self] kind in self?.applyMarkup(kind) }
        NotificationCenter.default.publisher(for: .PDFViewScaleChanged, object: pdfView)
            .merge(with: NotificationCenter.default.publisher(for: .PDFViewPageChanged, object: pdfView))
            .sink { [weak self] _ in self?.updateOverlays() }.store(in: &bag)
        NotificationCenter.default.publisher(for: .PDFViewSelectionChanged, object: pdfView)
            .sink { [weak self] _ in
                guard let self else { return }
                self.onSelectionChanged?(self.pdfView.currentSelection?.string?.isEmpty == false)
            }.store(in: &bag)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private weak var movePan: UIPanGestureRecognizer?

    public override func layoutSubviews() {
        super.layoutSubviews()
        if scrollObservation == nil, let scroll = pdfView.firstSubview(of: UIScrollView.self) {
            scrollObservation = scroll.observe(\.contentOffset) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.updateOverlays() }
            }
            if let movePan { scroll.panGestureRecognizer.require(toFail: movePan) }
        }
        updateOverlays()
    }

    public func setDocument(_ doc: StudioDocument?) {
        guard doc !== document else { return }
        document = doc
        measureDraft = nil
        pdfView.document = doc?.pdf
        bag.removeAll()
        doc?.$selectedID.sink { [weak self] _ in DispatchQueue.main.async { self?.updateOverlays() } }.store(in: &bag)
        doc?.$annotations.sink { [weak self] _ in DispatchQueue.main.async { self?.updateOverlays() } }.store(in: &bag)
        NotificationCenter.default.publisher(for: .PDFViewScaleChanged, object: pdfView)
            .merge(with: NotificationCenter.default.publisher(for: .PDFViewPageChanged, object: pdfView))
            .sink { [weak self] _ in self?.updateOverlays() }.store(in: &bag)
        NotificationCenter.default.publisher(for: .PDFViewSelectionChanged, object: pdfView)
            .sink { [weak self] _ in
                guard let self else { return }
                self.onSelectionChanged?(self.pdfView.currentSelection?.string?.isEmpty == false)
            }.store(in: &bag)
        applyTextSelectionPolicy()
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        updateBackGesture()
    }

    /// While drawing, a horizontal stroke must not trigger the navigation controller's swipe-back
    /// (on recent iOS versions it works from anywhere in the content, not just the screen edge).
    private func updateBackGesture() {
        var responder: UIResponder? = self
        while let r = responder, !(r is UIViewController) { responder = r.next }
        guard let nav = (responder as? UIViewController)?.navigationController else { return }
        let drawing = !isReadOnly && tool.drawsOnPage
        nav.interactivePopGestureRecognizer?.isEnabled = !drawing
        if #available(iOS 26.0, *) { nav.interactiveContentPopGestureRecognizer?.isEnabled = !drawing }
    }

    private func toolChanged() {
        let t = isReadOnly ? .select : tool
        if let d = measureDraft, d.kind.rawValue != t.rawValue { measureDraft = nil }
        updateBackGesture()
        overlay.isUserInteractionEnabled = t.drawsOnPage
        pointTap.isEnabled = t.placesPoints
        pdfView.markupEnabled = !isReadOnly
        if isReadOnly { document?.selectedID = nil }
        overlay.resetPreview()
    }

    private func applyTextSelectionPolicy() {
        pdfView.copyEnabled = allowsTextSelection
        pdfView.setLongPressEnabled(allowsTextSelection)
        if !allowsTextSelection { pdfView.clearSelection() }
    }

    // MARK: - Coordinates

    /// Page index and page-unit point under a point in this view.
    func pageLocation(_ viewPoint: CGPoint) -> (Int, Pt)? {
        let p = convert(viewPoint, to: pdfView)
        guard let doc = document, let page = pdfView.page(for: p, nearest: true) else { return nil }
        let index = doc.pdf.index(for: page)
        let pdfPoint = pdfView.convert(p, to: page)
        return (index, doc.geometry(page: index).toPage(pdfPoint))
    }

    /// Converts a page-unit box on `page` to this view's coordinates.
    func viewRect(_ box: Box, page index: Int) -> CGRect? {
        guard let doc = document, let page = doc.pdf.page(at: index) else { return nil }
        let r = pdfView.convert(doc.geometry(page: index).toPDF(box), from: page)
        return convert(r, from: pdfView)
    }

    /// Screen points per page unit at the current zoom.
    var zoom: CGFloat { pdfView.scaleFactor }

    // MARK: - Selecting, moving, editing

    private var dragStart: Pt?
    private var dragOriginal: Annotation?

    private func annotationID(at viewPoint: CGPoint) -> String? {
        let p = convert(viewPoint, to: pdfView)
        guard let doc = document, let page = pdfView.page(for: p, nearest: false) else { return nil }
        let pagePoint = pdfView.convert(p, to: page)
        if let hit = page.annotation(at: pagePoint), let id = doc.id(of: hit) { return id }
        // Thin shapes (lines, ink) are hard to hit exactly: fall back to a small radius around bounds.
        let index = doc.pdf.index(for: page)
        let pt = doc.geometry(page: index).toPage(pagePoint)
        let slop = 10 / max(zoom, 0.1)
        return doc.annotations.last { $0.page == index && $0.bounds.insetBy(-slop).contains(pt) }?.id
    }

    @objc private func handleTap(_ g: UITapGestureRecognizer) {
        guard !isReadOnly, tool == .select, let doc = document else { return }
        doc.selectedID = annotationID(at: g.location(in: self))
    }

    @objc private func handleDoubleTap(_ g: UITapGestureRecognizer) {
        guard !isReadOnly, tool == .select, let doc = document, let id = annotationID(at: g.location(in: self)),
              let a = doc.annotation(id: id) else { return }
        switch a.kind {
        case .freetext:
            requestText?("Edit text", a.text ?? "") { text in
                guard let text else { return }
                if text.isEmpty { doc.remove(id) } else { doc.update(id) { $0.text = text } }
            }
        default:
            requestText?("Comment", a.comment ?? "") { text in
                guard let text else { return }
                doc.update(id) { $0.comment = text.isEmpty ? nil : text }
            }
        }
    }

    @objc private func handlePan(_ g: UIPanGestureRecognizer) {
        guard let doc = document, let id = doc.selectedID, let loc = pageLocation(g.location(in: self)) else { return }
        switch g.state {
        case .began:
            dragStart = loc.1
            dragOriginal = doc.annotation(id: id)
            doc.checkpoint()
        case .changed:
            guard let s = dragStart, let o = dragOriginal, loc.0 == o.page else { return }
            doc.update(id, live: true) { $0 = o.translated(dx: loc.1.x - s.x, dy: loc.1.y - s.y) }
        default:
            dragStart = nil
            dragOriginal = nil
        }
    }

    public override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === movePan else { return true }
        guard !isReadOnly, tool == .select, let doc = document, let id = doc.selectedID else { return false }
        return annotationID(at: g.location(in: self)) == id
    }

    public func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        g !== movePan
    }

    private func updateOverlays() {
        updateDraftPreview()
        guard !isReadOnly, let doc = document, let id = doc.selectedID, let a = doc.annotation(id: id),
              let r = viewRect(a.bounds.insetBy(-3 / max(zoom, 0.1)), page: a.page) else {
            selectionLayer.path = nil
            return
        }
        selectionLayer.frame = overlay.bounds
        selectionLayer.path = UIBezierPath(roundedRect: overlay.convert(r, from: self), cornerRadius: 3).cgPath
    }

    // MARK: - Measurements placed point by point

    /// Adds a vertex to the perimeter or area being placed (starting one if needed). Points on another page than
    /// the first are ignored.
    func addMeasurePoint(page: Int, _ p: Pt) {
        guard tool.placesPoints, let kind = tool.kind else { return }
        var d = measureDraft ?? MeasureDraft(kind: kind, page: page)!
        guard d.page == page else { return }
        d.add(p)
        measureDraft = d
    }

    @objc private func handlePointTap(_ g: UITapGestureRecognizer) {
        guard let (page, p) = pageLocation(g.location(in: self)) else { return }
        addMeasurePoint(page: page, p)
    }

    /// Adds the perimeter or area being placed to the document (when it has enough points) and starts over.
    public func finishMeasurement() {
        guard let d = measureDraft, d.canFinish, let doc = document else { return }
        measureDraft = nil
        if let a = d.annotation(scale: measureScale.measureScale, color: style.color, strokeWidth: style.strokeWidth, author: author) {
            doc.add(a)
        }
    }

    public func cancelMeasurement() { measureDraft = nil }

    public func removeLastMeasurePoint() {
        guard var d = measureDraft else { return }
        d.removeLast()
        measureDraft = d.points.isEmpty ? nil : d
    }

    /// Page-unit point on `page` in this view's coordinates.
    func viewPoint(_ p: Pt, page index: Int) -> CGPoint? {
        guard let doc = document, let page = doc.pdf.page(at: index) else { return nil }
        return convert(pdfView.convert(doc.geometry(page: index).toPDF(p), from: page), from: pdfView)
    }

    private func updateDraftPreview() {
        guard let d = measureDraft, !d.points.isEmpty else {
            draftLayer.path = nil
            draftLabel.isHidden = true
            return
        }
        let pts = d.points.compactMap { viewPoint($0, page: d.page) }.map { overlay.convert($0, from: self) }
        let path = UIBezierPath()
        path.move(to: pts[0])
        pts.dropFirst().forEach { path.addLine(to: $0) }
        if d.kind == .area, pts.count > 2 { path.close() }
        for p in pts { path.append(UIBezierPath(ovalIn: CGRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6))) }
        let color = UIColor(hex: style.color)
        draftLayer.frame = overlay.bounds
        draftLayer.strokeColor = color.cgColor
        draftLayer.fillColor = d.kind == .area && pts.count > 2 ? color.withAlphaComponent(0.15).cgColor : UIColor.clear.cgColor
        draftLayer.lineWidth = max(1, style.strokeWidth * zoom)
        draftLayer.path = path.cgPath
        draftLabel.isHidden = d.points.count < 2
        guard d.points.count >= 2 else { return }
        let label = d.label(scale: measureScale.measureScale)
        draftLabel.string = label
        draftLabel.foregroundColor = color.cgColor
        let anchor = pts.last!
        let w = CGFloat(label.count) * 7 + 10
        CATransaction.begin(); CATransaction.setDisableActions(true)
        draftLabel.frame = CGRect(x: anchor.x - w / 2, y: anchor.y - 28, width: w, height: 17)
        CATransaction.commit()
    }

    // MARK: - Text markup

    func applyMarkup(_ kind: AnnotationKind) {
        guard let doc = document, let sel = pdfView.currentSelection else { return }
        for page in sel.pages {
            let index = doc.pdf.index(for: page)
            let g = doc.geometry(page: index)
            let rects = sel.selectionsByLine().filter { $0.pages.contains(page) }.map { g.toPage($0.bounds(for: page)) }
                .filter { $0.w > 0.5 && $0.h > 0.5 }
            guard !rects.isEmpty else { continue }
            let isHighlight = kind == .highlight
            doc.add(Annotation(page: index, kind: kind, color: isHighlight ? "#ffd84d" : style.color,
                               opacity: isHighlight ? 0.4 : 1, strokeWidth: isHighlight ? 0 : max(1, style.strokeWidth),
                               rects: rects, author: author))
        }
        pdfView.clearSelection()
    }

    /// Applies the active markup tool to the current text selection (used by a toolbar button).
    public func applyMarkupToSelection() {
        guard tool.isTextMarkup, let kind = tool.kind else { return }
        applyMarkup(kind)
    }

    // MARK: - Creating annotations from the overlay

    func makeAnnotation(page: Int, start: Pt, end: Pt, path: [Pt]) -> Annotation? {
        let r = Box.spanning(start, end)
        let tiny = r.w < 4 && r.h < 4
        var a = Annotation(page: page, kind: .rect, color: style.color, opacity: style.opacity, strokeWidth: style.strokeWidth, author: author)
        switch tool {
        case .rect, .ellipse:
            guard !tiny else { return nil }
            a.kind = tool == .rect ? .rect : .ellipse; a.rect = r
        case .line, .arrow:
            guard !tiny else { return nil }
            a.kind = tool == .line ? .line : .arrow; a.points = [start, end]
        case .ink:
            guard path.count > 1 else { return nil }
            a.kind = .ink; a.paths = [path]
        case .stamp:
            a.kind = .stamp; a.text = style.stampText; a.strokeWidth = 2.5
            a.rect = tiny ? Box(x: start.x, y: start.y, w: max(90, Double(style.stampText.count) * 13), h: 34) : r
        case .signature:
            guard let img = signatureImage else { return nil }
            a.kind = .signature; a.image = img; a.color = "#000000"; a.opacity = 1
            a.rect = tiny ? Box(x: start.x, y: start.y, w: 160, h: 60) : r
        case .distance:
            return Measure.distance(page: page, from: start, to: end, scale: measureScale.measureScale, color: style.color,
                                    strokeWidth: style.strokeWidth, author: author)
        case .redact:
            guard !tiny else { return nil }
            a.kind = .redact; a.rect = r; a.color = "#e5484d"; a.opacity = 1; a.strokeWidth = 1
        case .freetext:
            a.kind = .freetext; a.fontSize = style.fontSize; a.opacity = 1
            a.rect = tiny ? Box(x: start.x, y: start.y, w: 180, h: style.fontSize * 1.6 + 8) : r
        case .note:
            a.kind = .note; a.color = "#ffd84d"; a.opacity = 1; a.rect = Box(x: start.x, y: start.y, w: 22, h: 22)
        default:
            return nil
        }
        return a
    }

    func commit(_ a: Annotation) {
        guard let doc = document else { return }
        switch a.kind {
        case .freetext:
            requestText?("Text", "") { text in
                guard let text, !text.isEmpty else { return }
                var c = a
                c.text = text
                let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
                let longest = lines.map(\.count).max() ?? 4
                let size = a.fontSize ?? 14
                c.rect?.w = max(a.rect?.w ?? 0, Double(longest) * size * 0.55 + 8)
                c.rect?.h = Double(lines.count) * size * 1.2 + 10
                doc.add(c)
            }
        case .note:
            requestText?("Note", "") { [weak self] text in
                guard let text else { return }
                var c = a
                c.comment = text
                doc.add(c)
                self?.onToolFinished?()
            }
        default:
            doc.add(a)
            if a.kind == .stamp || a.kind == .signature { onToolFinished?() }
        }
    }
}

/// Transparent view that receives touches for drawing tools and shows a live preview.
final class DrawingOverlay: UIView {
    weak var host: StudioPDFView?
    private let preview = CAShapeLayer()
    private var page = 0
    private var start: Pt?
    private var path: [Pt] = []
    private var screenPath: [CGPoint] = []
    private var startScreen: CGPoint = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isMultipleTouchEnabled = false
        preview.fillColor = UIColor.clear.cgColor
        preview.lineCap = .round
        preview.lineJoin = .round
        layer.addSublayer(preview)
    }

    required init?(coder: NSCoder) { fatalError() }

    func resetPreview() { preview.path = nil; start = nil; path = []; screenPath = [] }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let host, let t = touches.first, let loc = host.pageLocation(t.location(in: host)) else { return }
        page = loc.0
        start = loc.1
        path = [loc.1]
        startScreen = t.location(in: self)
        screenPath = [startScreen]
        preview.strokeColor = UIColor(hex: host.style.color, alpha: host.style.opacity).cgColor
        preview.lineWidth = max(1, host.style.strokeWidth * host.zoom)
        preview.lineDashPattern = host.tool == .redact ? [6, 3] : nil
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let host, start != nil, let t = touches.first else { return }
        let all = (event?.coalescedTouches(for: t) ?? [t])
        for c in all {
            screenPath.append(c.location(in: self))
            if let loc = host.pageLocation(c.location(in: host)), loc.0 == page { path.append(loc.1) }
        }
        let cur = t.location(in: self)
        let p = UIBezierPath()
        switch host.tool {
        case .ink:
            p.move(to: screenPath[0]); screenPath.dropFirst().forEach { p.addLine(to: $0) }
        case .line, .arrow, .distance:
            p.move(to: startScreen); p.addLine(to: cur)
        case .perimeter, .area:
            return
        case .ellipse:
            p.append(UIBezierPath(ovalIn: CGRect(x: min(startScreen.x, cur.x), y: min(startScreen.y, cur.y), width: abs(cur.x - startScreen.x), height: abs(cur.y - startScreen.y))))
        default:
            p.append(UIBezierPath(rect: CGRect(x: min(startScreen.x, cur.x), y: min(startScreen.y, cur.y), width: abs(cur.x - startScreen.x), height: abs(cur.y - startScreen.y))))
        }
        preview.path = p.cgPath
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        defer { resetPreview() }
        guard let host, let s = start, let t = touches.first else { return }
        if host.tool.placesPoints { return } // points are placed by `pointTap`
        let end = host.pageLocation(t.location(in: host)).flatMap { $0.0 == page ? $0.1 : nil } ?? path.last ?? s
        if let a = host.makeAnnotation(page: page, start: s, end: end, path: path) { host.commit(a) }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { resetPreview() }
}

extension UIView {
    func firstSubview<T: UIView>(of type: T.Type) -> T? {
        for v in subviews {
            if let t = v as? T { return t }
            if let t = v.firstSubview(of: type) { return t }
        }
        return nil
    }

    /// Enables/disables long-press recognisers (text selection) in this view tree.
    func setLongPressEnabled(_ enabled: Bool) {
        gestureRecognizers?.filter { $0 is UILongPressGestureRecognizer }.forEach { $0.isEnabled = enabled }
        subviews.forEach { $0.setLongPressEnabled(enabled) }
    }
}
#endif

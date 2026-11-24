// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PDFStudioKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PDFStudioKit", targets: ["PDFStudioKit"]),
    ],
    targets: [
        .target(name: "PDFStudioKit"),
        .testTarget(name: "PDFStudioKitTests", dependencies: ["PDFStudioKit"]),
    ],
    swiftLanguageModes: [.v5]
)

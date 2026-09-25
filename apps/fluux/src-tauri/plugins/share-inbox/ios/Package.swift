// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-share-inbox",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-share-inbox", type: .static, targets: ["tauri-plugin-share-inbox"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-share-inbox", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)

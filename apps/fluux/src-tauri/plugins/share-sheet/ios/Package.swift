// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-share-sheet",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-share-sheet", type: .static, targets: ["tauri-plugin-share-sheet"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-share-sheet", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)

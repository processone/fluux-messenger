// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-widgets",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-widgets", type: .static, targets: ["tauri-plugin-widgets"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-widgets", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)

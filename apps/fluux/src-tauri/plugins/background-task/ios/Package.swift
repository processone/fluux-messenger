// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-background-task",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-background-task", type: .static, targets: ["tauri-plugin-background-task"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-background-task", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)

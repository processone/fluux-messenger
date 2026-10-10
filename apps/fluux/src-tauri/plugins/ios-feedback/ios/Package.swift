// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-ios-feedback",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-ios-feedback", type: .static, targets: ["tauri-plugin-ios-feedback"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-ios-feedback", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)

fn main() {
    // Expose git short hash as GIT_HASH env var for compile-time embedding
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output();
    let git_hash = output
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=GIT_HASH={}", git_hash);

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        for variable in ["TAURI_CONFIG", "APPLE_TEAM_ID", "APPLE_SIGNING_IDENTITY"] {
            println!("cargo:rerun-if-env-changed={variable}");
        }
        for path in [
            "../scripts/tauri-macos-share.mjs",
            "tauri.conf.json",
            "tauri.macos.conf.json",
            "Info.plist",
            "Entitlements.plist",
        ] {
            println!("cargo:rerun-if-changed={path}");
        }
        let status = std::process::Command::new("node")
            .args(["../scripts/tauri-macos-share.mjs", "--prepare"])
            .status()
            .expect("Node.js is required to prepare macOS sharing metadata");
        assert!(status.success(), "Could not prepare macOS sharing metadata");
    }
    tauri_build::build()
}

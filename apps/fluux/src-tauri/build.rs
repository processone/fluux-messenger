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
            "tauri.communication-prototype.conf.json",
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
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var_os("CARGO_FEATURE_MACOS_COMMUNICATION_PROTOTYPE").is_some()
    {
        use std::process::Command;
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            _ => panic!("unsupported macOS prototype architecture"),
        };
        for path in [
            "macos/CommunicationNotification.m",
            "macos/CommunicationNotification.h",
        ] {
            println!("cargo:rerun-if-changed={path}");
        }
        assert!(Command::new("xcrun")
            .args([
                "clang",
                "-fobjc-arc",
                "-fblocks",
                "-arch",
                arch,
                "-mmacosx-version-min=10.13",
                "-c",
                "macos/CommunicationNotification.m",
                "-o"
            ])
            .arg(out.join("communication.o"))
            .status()
            .unwrap()
            .success());
        assert!(Command::new("xcrun")
            .args(["ar", "crs"])
            .arg(out.join("libfluux_communication.a"))
            .arg(out.join("communication.o"))
            .status()
            .unwrap()
            .success());
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=fluux_communication");
        println!("cargo:rustc-link-lib=framework=Intents");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
    tauri_build::build()
}

fn main() {
    tauri_plugin::Builder::new(&[
        "set_unread_list",
        "set_sender_names",
        "set_notification_avatar",
    ])
    .ios_path("ios")
    .build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        use std::{path::PathBuf, process::Command};
        let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            _ => panic!("unsupported widget architecture"),
        };
        let sources = [
            "macos/WidgetsBridge.swift",
            "ios/Sources/UnreadList.swift",
            "../push/ios/Sources/NotificationAvatars/SharedNotificationStore.swift",
            "../push/ios/Sources/NotificationAvatars/ConversationDestination.swift",
        ];
        for source in sources {
            println!("cargo:rerun-if-changed={source}");
        }
        assert!(Command::new("xcrun")
            .args([
                "swiftc",
                "-swift-version",
                "5",
                "-parse-as-library",
                "-whole-module-optimization",
                "-emit-object",
                "-target",
                &format!("{arch}-apple-macos10.13")
            ])
            .args(sources)
            .arg("-o")
            .arg(out.join("widgets.o"))
            .status()
            .unwrap()
            .success());
        assert!(Command::new("xcrun")
            .args(["ar", "crs"])
            .arg(out.join("libfluux_widgets.a"))
            .arg(out.join("widgets.o"))
            .status()
            .unwrap()
            .success());
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-search=native=/usr/lib/swift");
        // Swift object autolink directives may refer to toolchain back-deployment libraries.
        let compiler = Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
            .unwrap();
        assert!(compiler.status.success());
        let compiler = PathBuf::from(String::from_utf8(compiler.stdout).unwrap().trim());
        println!(
            "cargo:rustc-link-search=native={}",
            compiler
                .parent()
                .unwrap()
                .join("../lib/swift/macosx")
                .display()
        );
        println!("cargo:rustc-link-lib=static=fluux_widgets");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=ImageIO");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
    }
}

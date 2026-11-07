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
        println!("cargo:rerun-if-changed=macos/WidgetLoader.m");
        assert!(Command::new("xcrun")
            .args([
                "clang",
                "-fobjc-arc",
                "-fblocks",
                "-arch",
                arch,
                "-mmacosx-version-min=10.13",
                "-c",
                "macos/WidgetLoader.m",
                "-o"
            ])
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
        println!("cargo:rustc-link-lib=static=fluux_widgets");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}

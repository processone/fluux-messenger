fn main() {
    tauri_plugin::Builder::new(&[
        "list",
        "read",
        "remove",
        "stage_photo",
        "probe_photo",
        "encode_photo",
        "read_photo",
        "discard_photo",
    ])
    .android_path("android")
    .ios_path("ios")
    .build();
}

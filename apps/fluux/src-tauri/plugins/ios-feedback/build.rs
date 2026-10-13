fn main() {
    tauri_plugin::Builder::new(&["haptic", "set_appearance"])
        .ios_path("ios")
        .build();
}

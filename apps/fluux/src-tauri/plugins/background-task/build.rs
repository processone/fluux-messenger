fn main() {
    tauri_plugin::Builder::new(&["begin", "end"]).ios_path("ios").build();
}

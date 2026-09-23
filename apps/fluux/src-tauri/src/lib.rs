//! Experimental iOS host. The desktop executable keeps its own entry point.
//!
//! XMPP uses the frontend's WebSocket transport. Desktop IPC commands and
//! plugins are deliberately absent, matching the mobile capability record.
#![cfg(target_os = "ios")]

#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running the iOS application");
}

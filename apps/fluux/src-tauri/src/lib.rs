//! Mobile host with the shared native XMPP proxy and mobile-safe plugins.
#![cfg(any(target_os = "ios", target_os = "android"))]

mod tls;
mod xmpp_proxy;

#[tauri::mobile_entry_point]
pub fn run() {
    tls::init_crypto_provider();
    xmpp_proxy::set_dangerous_insecure_tls(false);
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_share_inbox::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            xmpp_proxy::commands::start_xmpp_proxy,
            xmpp_proxy::commands::stop_xmpp_proxy
        ])
        .run(tauri::generate_context!())
        .expect("error while running the mobile application");
}

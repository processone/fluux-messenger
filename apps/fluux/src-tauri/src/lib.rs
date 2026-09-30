//! Mobile host with the shared native XMPP proxy and mobile-safe plugins.
#![cfg(any(target_os = "ios", target_os = "android"))]

mod tls;
mod xmpp_proxy;

/// Loads the Kotlin plugin that keeps the WebView above the soft keyboard. WKWebView
/// reports the keyboard through `visualViewport` on its own, so iOS needs no counterpart.
#[cfg(target_os = "android")]
fn keyboard_insets<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("keyboard-insets")
        .setup(|_app, api| {
            api.register_android_plugin("com.processone.fluux.keyboard", "KeyboardInsetsPlugin")?;
            Ok(())
        })
        .build()
}

#[tauri::mobile_entry_point]
pub fn run() {
    tls::init_crypto_provider();
    xmpp_proxy::set_dangerous_insecure_tls(false);
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(keyboard_insets());
    builder
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

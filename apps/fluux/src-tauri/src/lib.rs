//! Mobile host with the shared native XMPP proxy and mobile-safe plugins.
#![cfg(any(target_os = "ios", target_os = "android"))]

#[cfg(target_os = "ios")]
mod credentials;
#[cfg(target_os = "ios")]
mod download;
#[cfg(target_os = "ios")]
mod invoke_headers;
#[cfg(target_os = "ios")]
mod ios_keychain;
#[cfg(target_os = "ios")]
mod link_preview;
#[cfg(target_os = "ios")]
mod native_storage;
#[cfg(target_os = "ios")]
mod openpgp;
#[cfg(target_os = "ios")]
mod openpgp_backup;
#[cfg(target_os = "ios")]
mod openpgp_storage;
mod tls;
#[cfg(target_os = "ios")]
mod upload;
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

/// Keys live in the app data directory, unlocked by a passphrase in the
/// keychain, as on desktop. The remembered account's key starts unlocking at
/// launch so the Argon2id cost overlaps the XMPP login.
#[cfg(target_os = "ios")]
fn setup_openpgp(app: &mut tauri::App) {
    use credentials::SecretStore;
    use std::sync::Arc;
    use tauri::Manager;

    let data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            tracing::warn!("openpgp: could not resolve app data dir ({e}); persisted keys will not survive restart");
            std::env::temp_dir().join("fluux-openpgp-ephemeral")
        }
    };
    let state = Arc::new(openpgp::OpenpgpState::new(data_dir));
    app.manage(Arc::clone(&state));

    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(Some(jid)) = ios_keychain::IosKeychain.get("last_user") {
            // The XEP-0373 trust-anchor UID, as `accountUserId` builds it in
            // `src/e2ee/openpgpUserId.ts`.
            let user_id = format!("xmpp:{jid}");
            state.prewarm_if_persisted(jid, user_id);
        }
    });
}

/// Keeps the localStorage keys the webview may lose in the app data
/// directory. Without a data directory the commands stay unmanaged and the
/// app keeps those keys in the webview.
#[cfg(target_os = "ios")]
fn setup_native_storage(app: &mut tauri::App) {
    use std::sync::Arc;
    use tauri::Manager;

    match app.path().app_data_dir() {
        Ok(dir) => {
            app.manage(Arc::new(native_storage::NativeStorage::open(dir.join(native_storage::FILE_NAME))));
        }
        Err(e) => tracing::warn!("native storage: could not resolve app data dir ({e})"),
    }
}

#[tauri::mobile_entry_point]
pub fn run() {
    tls::init_crypto_provider();
    xmpp_proxy::set_dangerous_insecure_tls(false);
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(keyboard_insets());
    #[cfg(target_os = "ios")]
    let builder = builder
        .plugin(tauri_plugin_push::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_share_sheet::init())
        .plugin(tauri_plugin_background_task::init())
        .setup(|app| {
            setup_native_storage(app);
            setup_openpgp(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            xmpp_proxy::commands::start_xmpp_proxy,
            xmpp_proxy::commands::stop_xmpp_proxy,
            credentials::commands::save_credentials,
            credentials::commands::get_credentials,
            credentials::commands::delete_credentials,
            credentials::commands::get_secret,
            credentials::commands::set_secret,
            credentials::commands::delete_secret,
            native_storage::commands::native_storage_load,
            native_storage::commands::native_storage_apply,
            openpgp::openpgp_ensure_key,
            openpgp::openpgp_prewarm,
            openpgp::openpgp_encrypt,
            openpgp::openpgp_decrypt,
            openpgp::openpgp_fingerprint,
            openpgp::openpgp_validate_cert,
            openpgp::openpgp_forget_account,
            openpgp::openpgp_has_persisted_key,
            openpgp::openpgp_backup_encrypt,
            openpgp::openpgp_backup_import,
            openpgp::openpgp_backup_import_all,
            openpgp::openpgp_backup_import_selected,
            openpgp::openpgp_rotate_encryption_subkey,
            upload::upload_file,
            download::download_file,
            link_preview::fetch_url_metadata
        ]);
    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        xmpp_proxy::commands::start_xmpp_proxy,
        xmpp_proxy::commands::stop_xmpp_proxy
    ]);
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_share_inbox::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running the mobile application");
}

// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Linux: Apply WebKitGTK GPU workaround env vars BEFORE main() runs.
// This uses ctor to run a static constructor before any other code,
// ensuring the env vars are set before WebKitGTK initializes.
//
// WEBKIT_DISABLE_DMABUF_RENDERER is always set to work around a Wayland crash:
// "Error 71 (Protocol error) dispatching to Wayland display."
// See: https://github.com/tauri-apps/tauri/issues/10702
//
// WEBKIT_DISABLE_COMPOSITING_MODE is additionally set when FLUUX_DISABLE_GPU
// is defined, for NVIDIA EGL display issues (grey screen / EGL_BAD_PARAMETER).
#[cfg(target_os = "linux")]
#[ctor::ctor(unsafe)]
fn set_linux_webkit_env() {
    // Work around WebKitGTK dmabuf renderer crash on Wayland
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    // Full GPU disable on request (for NVIDIA EGL issues)
    if std::env::var("FLUUX_DISABLE_GPU").is_ok() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }

    // Keep the loopback hop to the local XMPP bridge off any system-wide proxy.
    // Must run before WebKitGTK/libsoup initializes its proxy resolver.
    ensure_loopback_no_proxy();
}

/// Ensure the loopback hop to Fluux's local XMPP bridge is never routed through a
/// system-wide HTTP/SOCKS proxy.
///
/// The webview connects to a loopback WebSocket bridge (`ws://127.0.0.1` or
/// `ws://[::1]`). On hosts with a system-wide proxy — especially auto/PAC setups —
/// GLib/libsoup can fail the proxy lookup for *every* host, loopback included
/// ("Unspecified proxy lookup failure"), so the webview never reaches the bridge
/// and connecting fails outright. Merging the loopback hosts into `no_proxy`/
/// `NO_PROXY` keeps the local hop direct while leaving the user's proxy in place
/// for real hosts. Existing entries are preserved; we only append what's missing.
///
/// NOTE: `no_proxy`/`NO_PROXY` is *not* a documented contract of GIO's
/// `GProxyResolver` — it is only honored by libproxy's env-var module, and only
/// when that resolver wins. A desktop that configures a proxy via KDE/gsettings
/// (e.g. a SOCKS5 proxy on KDE) hands WebKitGTK a different resolver, so this
/// env-var write is a no-op there. This function therefore stays as a cheap
/// belt-and-suspenders layer; the authoritative loopback bypass is applied via
/// the documented WebKit API in [`apply_loopback_proxy_bypass`].
fn ensure_loopback_no_proxy() {
    const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

    for var in ["no_proxy", "NO_PROXY"] {
        let existing = std::env::var(var).unwrap_or_default();
        if let Some(merged) = merge_no_proxy(&existing, &LOOPBACK) {
            std::env::set_var(var, merged);
        }
    }
}

/// Merge `hosts` into a comma-separated `no_proxy` value, preserving existing
/// entries and appending only those that are missing (case-insensitive).
/// Returns the new value when something was added, or `None` if every host was
/// already present (so the caller can skip a redundant env write).
fn merge_no_proxy(existing: &str, hosts: &[&str]) -> Option<String> {
    let mut entries: Vec<String> = existing
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mut appended = false;
    for host in hosts {
        if !entries.iter().any(|e| e.eq_ignore_ascii_case(host)) {
            entries.push((*host).to_string());
            appended = true;
        }
    }

    appended.then(|| entries.join(","))
}

/// Pick the first usable proxy URI from an ordered list of candidate values
/// (typically the SOCKS/HTTPS/HTTP proxy environment variables). Empty or
/// whitespace-only candidates are skipped. The result is handed to WebKit as
/// the *default* proxy for non-loopback traffic so the user's declared proxy
/// keeps working for real hosts (avatars, media) while loopback stays direct.
///
/// Compiled in test builds on every platform so the ordering logic is unit
/// tested even on the macOS dev machine, where the Linux WebKit wiring below
/// is `#[cfg]`-ed out.
#[cfg(any(target_os = "linux", test))]
fn pick_proxy_uri(candidates: &[Option<String>]) -> Option<String> {
    candidates
        .iter()
        .flatten()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Read the system proxy URI from the conventional environment variables, most
/// specific first. Returns `None` when none are set (so non-loopback traffic
/// goes direct — consistent with the XMPP bridge, which always connects
/// directly and never proxies its upstream TCP socket).
#[cfg(target_os = "linux")]
fn system_proxy_uri_from_env() -> Option<String> {
    let candidates: Vec<Option<String>> = [
        "all_proxy",
        "ALL_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "http_proxy",
        "HTTP_PROXY",
    ]
    .iter()
    .map(|k| std::env::var(k).ok())
    .collect();
    pick_proxy_uri(&candidates)
}

/// Force the WebView to connect *directly* to Fluux's loopback XMPP bridge,
/// regardless of any system-wide proxy.
///
/// This is the authoritative companion to [`ensure_loopback_no_proxy`]. Where
/// the env-var approach depends on libproxy winning the resolver lottery, this
/// uses WebKit's documented `WebKitNetworkProxySettings.ignore_hosts` API: we
/// switch the context's website data manager to CUSTOM proxy mode, list the
/// loopback addresses as direct-connect hosts, and preserve any env-declared
/// proxy as the default for real hosts. The loopback URL is advertised as the
/// IPv4 literal `ws://127.0.0.1:PORT` (see `LOOPBACK_BIND_ORDER`), so the
/// `127.0.0.1` entry matches per WebKit's IP-vs-hostname exclusion rules;
/// `localhost` and `::1` cover the fallback bind.
///
/// Best-effort: failures are logged, not fatal — the env-var layer and the
/// platform's own loopback bypass still apply.
#[cfg(target_os = "linux")]
fn apply_loopback_proxy_bypass(window: &tauri::WebviewWindow) {
    use webkit2gtk::{
        NetworkProxyMode, NetworkProxySettings, WebContextExt, WebViewExt, WebsiteDataManagerExt,
    };

    let default_proxy = system_proxy_uri_from_env();
    let result = window.with_webview(move |webview| {
        // On the webkit2gtk-4.1 (GTK3/libsoup3) stack wry targets, proxy
        // settings live on the WebsiteDataManager, not the deprecated
        // WebContext setter.
        let manager = webview
            .inner()
            .web_context()
            .and_then(|ctx| ctx.website_data_manager());
        match manager {
            Some(manager) => {
                let mut settings = NetworkProxySettings::new(
                    default_proxy.as_deref(),
                    &["localhost", "127.0.0.1", "::1"],
                );
                manager
                    .set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut settings));
                tracing::info!(
                    default_proxy = default_proxy.as_deref().unwrap_or("(direct)"),
                    "Applied loopback proxy bypass to WebView website data manager"
                );
            }
            None => {
                tracing::warn!(
                    "WebView has no website data manager; loopback proxy bypass not applied"
                );
            }
        }
    });
    if let Err(e) = result {
        tracing::warn!(error = %e, "with_webview failed; loopback proxy bypass not applied");
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tauri::WindowEvent;
use tauri::{Emitter, Manager, RunEvent};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
// Menu support
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
// System tray support for Linux and Windows
use keyring::Entry;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri_plugin_deep_link::DeepLinkExt;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_opener::OpenerExt;

mod download;
mod upload;
mod xmpp_proxy;
mod openpgp;
mod openpgp_backup;
mod openpgp_storage;
mod notifications;
mod mcp;

// Linux tray-functionality detection (pure combiner compiled everywhere; the
// DBus probe inside is Linux-only).
mod linux_tray;

#[cfg(target_os = "macos")]
mod idle {
    use std::process::Command;

    /// Get system idle time using IOKit via ioreg command
    pub fn get_idle_seconds() -> Result<u64, String> {
        let output = Command::new("ioreg")
            .args(["-c", "IOHIDSystem"])
            .output()
            .map_err(|e| {
                tracing::warn!("Idle: failed to run ioreg: {}", e);
                format!("Failed to run ioreg: {}", e)
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Find HIDIdleTime in output
        for line in stdout.lines() {
            if line.contains("HIDIdleTime") {
                // Format: "HIDIdleTime" = 1234567890 (nanoseconds)
                if let Some(pos) = line.rfind('=') {
                    let num_str = line[pos + 1..].trim();
                    if let Ok(nanos) = num_str.parse::<u64>() {
                        return Ok(nanos / 1_000_000_000);
                    }
                }
            }
        }

        tracing::warn!("Idle: HIDIdleTime not found in ioreg output");
        Err("HIDIdleTime not found".to_string())
    }
}

#[cfg(target_os = "windows")]
mod idle {
    use user_idle::UserIdle;

    pub fn get_idle_seconds() -> Result<u64, String> {
        UserIdle::get_time()
            .map(|idle| idle.as_seconds())
            .map_err(|e| {
                tracing::warn!("Idle: failed to get user idle time: {}", e);
                e.to_string()
            })
    }
}

#[cfg(target_os = "linux")]
mod idle {
    use std::ffi::CString;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use x11::xlib;
    use x11::xss;

    const UNSUPPORTED_IDLE_REASON: &str =
        "Linux idle detection unavailable (MIT-SCREEN-SAVER extension missing)";
    const QUERY_FAILED_IDLE_REASON: &str =
        "Linux idle detection unavailable (XScreenSaver query failed)";

    /// Cache XScreenSaver support so we avoid repeatedly probing an unsupported
    /// display and flooding logs.
    static HAS_XSCREENSAVER_EXTENSION: OnceLock<bool> = OnceLock::new();
    static IDLE_BACKEND_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

    fn has_xscreensaver_extension() -> bool {
        *HAS_XSCREENSAVER_EXTENSION.get_or_init(|| unsafe {
            let display = xlib::XOpenDisplay(ptr::null());
            if display.is_null() {
                tracing::info!(
                    "Idle: no X11 display available, falling back to DOM idle detection"
                );
                return false;
            }

            let extension_name = CString::new("MIT-SCREEN-SAVER")
                .expect("MIT-SCREEN-SAVER extension name must not contain interior NUL bytes");
            let mut major_opcode = 0;
            let mut event_base = 0;
            let mut error_base = 0;
            // Query through Xlib directly to avoid XScreenSaver's missing-extension
            // stderr spam on desktops that do not expose MIT-SCREEN-SAVER.
            let has_extension = xlib::XQueryExtension(
                display,
                extension_name.as_ptr(),
                &mut major_opcode,
                &mut event_base,
                &mut error_base,
            ) != 0;
            xlib::XCloseDisplay(display);

            if !has_extension {
                tracing::info!(
                    "Idle: MIT-SCREEN-SAVER extension missing, falling back to DOM idle detection"
                );
            }

            has_extension
        })
    }

    pub fn get_idle_seconds() -> Result<u64, String> {
        if IDLE_BACKEND_UNAVAILABLE.load(Ordering::Relaxed) {
            return Err(UNSUPPORTED_IDLE_REASON.to_string());
        }

        if !has_xscreensaver_extension() {
            IDLE_BACKEND_UNAVAILABLE.store(true, Ordering::Relaxed);
            return Err(UNSUPPORTED_IDLE_REASON.to_string());
        }

        unsafe {
            let display = xlib::XOpenDisplay(ptr::null());
            if display.is_null() {
                IDLE_BACKEND_UNAVAILABLE.store(true, Ordering::Relaxed);
                tracing::info!(
                    "Idle: failed to open X11 display, falling back to DOM idle detection"
                );
                return Err(
                    "Linux idle detection unavailable (failed to open X11 display)".to_string(),
                );
            }

            let root = xlib::XDefaultRootWindow(display);
            let info = xss::XScreenSaverAllocInfo();
            if info.is_null() {
                xlib::XCloseDisplay(display);
                IDLE_BACKEND_UNAVAILABLE.store(true, Ordering::Relaxed);
                tracing::info!(
                    "Idle: could not allocate XScreenSaverInfo, falling back to DOM idle detection"
                );
                return Err(
                    "Linux idle detection failed (could not allocate XScreenSaverInfo)".to_string(),
                );
            }

            let status = xss::XScreenSaverQueryInfo(display, root, info);
            let idle_seconds = if status == 0 {
                IDLE_BACKEND_UNAVAILABLE.store(true, Ordering::Relaxed);
                tracing::info!("Idle: XScreenSaverQueryInfo returned status 0, falling back to DOM idle detection");
                Err(QUERY_FAILED_IDLE_REASON.to_string())
            } else {
                Ok((*info).idle as u64 / 1000)
            };

            xlib::XFree(info as *mut _);
            xlib::XCloseDisplay(display);
            idle_seconds
        }
    }
}

/// Get the system idle time in seconds
#[tauri::command]
fn get_idle_time() -> Result<u64, String> {
    idle::get_idle_seconds()
}

// Keyring service name for storing credentials
const KEYRING_SERVICE: &str = "com.processone.fluux";

/// Credentials stored in the OS keychain
#[derive(Serialize, Deserialize)]
pub struct StoredCredentials {
    pub jid: String,
    pub password: String,
    pub server: Option<String>,
}

/// Classify a keyring error into a user-friendly description.
/// macOS wraps most keychain errors as PlatformFailure with the raw Security
/// framework message (e.g., "User canceled the operation", "The specified item
/// already exists in the keychain"). This function checks the error string to
/// provide a clearer diagnosis.
fn classify_keyring_error(e: &keyring::Error, operation: &str) -> String {
    let msg = e.to_string();
    if msg.contains("User canceled") || msg.contains("user canceled") {
        format!("Keychain access denied by user during {}", operation)
    } else if msg.contains("already exists") {
        // This can also surface when access is denied on some macOS versions
        format!(
            "Keychain access conflict during {} (item may exist or access was denied)",
            operation
        )
    } else {
        match e {
            keyring::Error::NoStorageAccess(_) => {
                format!(
                    "Keychain locked or inaccessible during {}: {}",
                    operation, msg
                )
            }
            keyring::Error::PlatformFailure(_) => {
                format!("Keychain platform error during {}: {}", operation, msg)
            }
            _ => format!("Keychain error during {}: {}", operation, msg),
        }
    }
}

/// Save credentials to OS keychain.
/// Runs on a background thread to avoid blocking the main thread when
/// macOS shows a keychain authorization dialog.
#[tauri::command]
async fn save_credentials(
    jid: String,
    password: String,
    server: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let entry = Entry::new(KEYRING_SERVICE, &jid).map_err(|e| {
            tracing::error!("Keychain: failed to create entry for {}: {}", jid, e);
            format!("Failed to create keyring entry: {}", e)
        })?;

        let credentials = StoredCredentials {
            jid: jid.clone(),
            password,
            server,
        };
        let json = serde_json::to_string(&credentials).map_err(|e| {
            tracing::error!(
                "Keychain: failed to serialize credentials for {}: {}",
                jid,
                e
            );
            format!("Failed to serialize credentials: {}", e)
        })?;

        entry.set_password(&json).map_err(|e| {
            let desc = classify_keyring_error(&e, "save");
            tracing::error!("Keychain: {} for {}", desc, jid);
            desc
        })?;

        // Also store the JID as the "last user" so we know which account to load
        let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user").map_err(|e| {
            tracing::error!("Keychain: failed to create last_user entry: {}", e);
            format!("Failed to create last_user entry: {}", e)
        })?;
        last_user_entry
            .set_password(&credentials.jid)
            .map_err(|e| {
                let desc = classify_keyring_error(&e, "save last_user");
                tracing::error!("Keychain: {} for {}", desc, jid);
                desc
            })?;

        tracing::info!("Keychain: saved credentials for {}", jid);
        Ok(())
    })
    .await
    .map_err(|e| format!("Keychain task panicked: {}", e))?
}

/// Get credentials from OS keychain.
/// Runs on a background thread to avoid blocking the main thread when
/// macOS shows a keychain authorization dialog.
#[tauri::command]
async fn get_credentials() -> Result<Option<StoredCredentials>, String> {
    tokio::task::spawn_blocking(move || {
        // First get the last used JID
        let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user").map_err(|e| {
            tracing::error!("Keychain: failed to create last_user entry: {}", e);
            format!("Failed to create last_user entry: {}", e)
        })?;

        let jid = match last_user_entry.get_password() {
            Ok(jid) => jid,
            Err(keyring::Error::NoEntry) => {
                tracing::debug!("Keychain: no last_user entry found");
                return Ok(None);
            }
            Err(e) => {
                let desc = classify_keyring_error(&e, "read last_user");
                tracing::error!("Keychain: {}", desc);
                return Err(desc);
            }
        };

        // Now get the credentials for that JID
        let entry = Entry::new(KEYRING_SERVICE, &jid).map_err(|e| {
            tracing::error!("Keychain: failed to create entry for {}: {}", jid, e);
            format!("Failed to create keyring entry: {}", e)
        })?;

        match entry.get_password() {
            Ok(json) => {
                let credentials: StoredCredentials = serde_json::from_str(&json).map_err(|e| {
                    tracing::error!("Keychain: failed to parse credentials for {}: {}", jid, e);
                    format!("Failed to parse credentials: {}", e)
                })?;
                tracing::info!("Keychain: loaded credentials for {}", jid);
                Ok(Some(credentials))
            }
            Err(keyring::Error::NoEntry) => {
                tracing::debug!("Keychain: no credentials found for {}", jid);
                Ok(None)
            }
            Err(e) => {
                let desc = classify_keyring_error(&e, &format!("read credentials for {}", jid));
                tracing::error!("Keychain: {}", desc);
                Err(desc)
            }
        }
    })
    .await
    .map_err(|e| format!("Keychain task panicked: {}", e))?
}

/// Delete credentials from OS keychain.
/// Runs on a background thread to avoid blocking the main thread when
/// macOS shows a keychain authorization dialog.
#[tauri::command]
async fn delete_credentials() -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Get the last used JID
        let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user").map_err(|e| {
            tracing::error!("Keychain: failed to create last_user entry: {}", e);
            format!("Failed to create last_user entry: {}", e)
        })?;

        if let Ok(jid) = last_user_entry.get_password() {
            // Delete the credentials entry
            let entry = Entry::new(KEYRING_SERVICE, &jid).map_err(|e| {
                tracing::error!("Keychain: failed to create entry for {}: {}", jid, e);
                format!("Failed to create keyring entry: {}", e)
            })?;
            match entry.delete_credential() {
                Ok(()) => tracing::info!("Keychain: deleted credentials for {}", jid),
                Err(keyring::Error::NoEntry) => {
                    tracing::debug!("Keychain: no credentials to delete for {}", jid)
                }
                Err(e) => {
                    let desc =
                        classify_keyring_error(&e, &format!("delete credentials for {}", jid));
                    tracing::warn!("Keychain: {}", desc);
                }
            }
        } else {
            tracing::debug!("Keychain: no last_user entry to look up for deletion");
        }

        // Delete the last_user entry
        match last_user_entry.delete_credential() {
            Ok(()) => tracing::debug!("Keychain: deleted last_user entry"),
            Err(keyring::Error::NoEntry) => {
                tracing::debug!("Keychain: no last_user entry to delete")
            }
            Err(e) => {
                let desc = classify_keyring_error(&e, "delete last_user");
                tracing::warn!("Keychain: {}", desc);
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Keychain task panicked: {}", e))?
}

/// Exit the app (called by frontend after graceful disconnect)
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Upper bound for one start/stop proxy IPC command.
///
/// Normal operation is expected to complete quickly; these are circuit breakers
/// so a wedged proxy command cannot block the frontend indefinitely.
const START_XMPP_PROXY_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const STOP_XMPP_PROXY_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Start XMPP WebSocket-to-TCP proxy.
/// The `server` parameter supports: `tls://host:port`, `tcp://host:port`, `host:port`, or bare `domain`.
#[tauri::command]
async fn start_xmpp_proxy(
    app: tauri::AppHandle,
    server: String,
) -> Result<xmpp_proxy::ProxyStartResult, String> {
    tokio::time::timeout(
        START_XMPP_PROXY_COMMAND_TIMEOUT,
        xmpp_proxy::start_proxy(server, Some(app)),
    )
    .await
    .map_err(|_| {
        tracing::warn!(
            timeout_secs = START_XMPP_PROXY_COMMAND_TIMEOUT.as_secs(),
            "start_xmpp_proxy command timed out"
        );
        format!(
            "start_xmpp_proxy timed out after {}s",
            START_XMPP_PROXY_COMMAND_TIMEOUT.as_secs()
        )
    })?
}

/// Stop XMPP WebSocket-to-TCP proxy
#[tauri::command]
async fn stop_xmpp_proxy() -> Result<(), String> {
    tokio::time::timeout(STOP_XMPP_PROXY_COMMAND_TIMEOUT, xmpp_proxy::stop_proxy())
        .await
        .map_err(|_| {
            tracing::warn!(
                timeout_secs = STOP_XMPP_PROXY_COMMAND_TIMEOUT.as_secs(),
                "stop_xmpp_proxy command timed out"
            );
            format!(
                "stop_xmpp_proxy timed out after {}s",
                STOP_XMPP_PROXY_COMMAND_TIMEOUT.as_secs()
            )
        })?
}

/// Keychain slot for the MCP bearer token. Persisting it (instead of minting
/// one per launch) keeps the user's MCP client config working across app
/// restarts without ever writing a plaintext token file to disk.
const MCP_TOKEN_KEYRING_USER: &str = "mcp-token";

/// Load the persisted MCP token, creating one on first use. `regenerate`
/// discards any existing token (the Settings "reset token" action, revoking
/// access for previously configured clients).
async fn mcp_load_or_create_token(regenerate: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let entry = Entry::new(KEYRING_SERVICE, MCP_TOKEN_KEYRING_USER)
            .map_err(|e| format!("Failed to create keyring entry for MCP token: {e}"))?;
        if !regenerate {
            match entry.get_password() {
                Ok(token) if !token.is_empty() => return Ok(token),
                _ => {}
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        entry.set_password(&token).map_err(|e| {
            let desc = classify_keyring_error(&e, "save MCP token");
            tracing::error!("Keychain: {}", desc);
            desc
        })?;
        Ok(token)
    })
    .await
    .map_err(|e| format!("Keychain task panicked: {e}"))?
}

/// Start the local MCP server (Model Context Protocol) for Claude
/// Desktop/Code to read history and send messages through Fluux.
/// `preferred_port` is the last port we served on (persisted by the webview);
/// the server tries to rebind it so existing client configs keep working.
#[tauri::command]
async fn mcp_start_server(
    app: tauri::AppHandle,
    pending: tauri::State<'_, Arc<mcp::bridge::PendingRequests>>,
    preferred_port: Option<u16>,
) -> Result<mcp::server::McpServerInfo, String> {
    let token = mcp_load_or_create_token(false).await?;
    let executor = Arc::new(mcp::bridge::TauriBridgeExecutor::new(app, pending.inner().clone()));
    mcp::server::start(executor, preferred_port, token).await
}

/// Regenerate the MCP bearer token (revoking previously configured clients)
/// and restart the server with it.
#[tauri::command]
async fn mcp_reset_token(
    app: tauri::AppHandle,
    pending: tauri::State<'_, Arc<mcp::bridge::PendingRequests>>,
    preferred_port: Option<u16>,
) -> Result<mcp::server::McpServerInfo, String> {
    let token = mcp_load_or_create_token(true).await?;
    let executor = Arc::new(mcp::bridge::TauriBridgeExecutor::new(app, pending.inner().clone()));
    mcp::server::start(executor, preferred_port, token).await
}

/// Stop the local MCP server.
#[tauri::command]
async fn mcp_stop_server() -> Result<(), String> {
    mcp::server::stop().await
}

/// Open Graph metadata extracted from a URL
#[derive(Serialize, Deserialize, Default)]
pub struct UrlMetadata {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
}

/// Fetch URL and extract Open Graph metadata for link previews.
///
/// The actual work (a blocking HTTP request with a multi-second timeout plus a
/// synchronous HTML parse) runs on the blocking thread pool via
/// [`tauri::async_runtime::spawn_blocking`] so the main thread stays free. A
/// synchronous command would run this on the main thread and freeze the UI for
/// the duration of the fetch — most visibly on Linux/WebKitGTK, where the
/// webview renders on that same thread.
#[tauri::command]
async fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_url_metadata_blocking(url))
        .await
        .unwrap_or_else(|join_err| Err(format!("Link preview task panicked: {join_err}")))
}

/// Blocking implementation of [`fetch_url_metadata`]. Runs off the main thread.
/// Uses `reqwest::blocking` and `scraper` (whose parsed document is `!Send`, so
/// it must live entirely within this synchronous function).
fn fetch_url_metadata_blocking(url: String) -> Result<UrlMetadata, String> {
    // Validate URL
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Invalid URL: must start with http:// or https://".to_string());
    }

    // Create HTTP client with reasonable timeout and user agent
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (compatible; FluuxBot/1.0; +https://fluux.io)")
        .build()
        .map_err(|e| {
            tracing::warn!(url = %url, "Link preview: failed to create HTTP client: {}", e);
            format!("Failed to create HTTP client: {}", e)
        })?;

    // Fetch the URL
    let response = client.get(&url).send().map_err(|e| {
        tracing::warn!(url = %url, "Link preview: failed to fetch URL: {}", e);
        format!("Failed to fetch URL: {}", e)
    })?;

    // Check content type - only process HTML
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !content_type.contains("text/html") {
        tracing::debug!(url = %url, content_type, "Link preview: non-HTML content type, skipping");
        return Err("URL does not return HTML content".to_string());
    }

    let html = response.text().map_err(|e| {
        tracing::warn!(url = %url, "Link preview: failed to read response body: {}", e);
        format!("Failed to read response: {}", e)
    })?;

    let metadata = parse_og_metadata(&url, &html);

    // Only return success if we got at least a title
    if metadata.title.is_some() {
        Ok(metadata)
    } else {
        tracing::debug!(url = %url, "Link preview: no title found in page metadata");
        Err("Could not extract metadata from URL".to_string())
    }
}

/// Extract Open Graph (and fallback) metadata from an HTML document.
///
/// Pure function over `(request_url, html)` — no I/O — so it is unit-testable.
/// `og:*` tags win, with `<title>` and `<meta name="description">` as fallbacks;
/// `og:url` overrides the canonical url when present. Never fails: an empty
/// document yields a `UrlMetadata` with only `url` set (the caller enforces the
/// "must have a title" business rule).
fn parse_og_metadata(url: &str, html: &str) -> UrlMetadata {
    let document = Html::parse_document(html);

    // Selectors for Open Graph meta tags
    let og_title = Selector::parse(r#"meta[property="og:title"]"#).ok();
    let og_desc = Selector::parse(r#"meta[property="og:description"]"#).ok();
    let og_image = Selector::parse(r#"meta[property="og:image"]"#).ok();
    let og_site = Selector::parse(r#"meta[property="og:site_name"]"#).ok();
    let og_url = Selector::parse(r#"meta[property="og:url"]"#).ok();

    // Fallback selectors
    let title_tag = Selector::parse("title").ok();
    let meta_desc = Selector::parse(r#"meta[name="description"]"#).ok();

    let mut metadata = UrlMetadata {
        url: url.to_string(),
        ..Default::default()
    };

    // Extract og:title or fallback to <title>
    if let Some(sel) = og_title {
        metadata.title = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());
    }
    if metadata.title.is_none() {
        if let Some(sel) = title_tag {
            metadata.title = document
                .select(&sel)
                .next()
                .map(|el| el.text().collect::<String>().trim().to_string())
                .filter(|s| !s.is_empty());
        }
    }

    // Extract og:description or fallback to meta description
    if let Some(sel) = og_desc {
        metadata.description = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());
    }
    if metadata.description.is_none() {
        if let Some(sel) = meta_desc {
            metadata.description = document
                .select(&sel)
                .next()
                .and_then(|el| el.value().attr("content"))
                .map(|s| s.to_string());
        }
    }

    // Extract og:image
    if let Some(sel) = og_image {
        metadata.image = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());
    }

    // Extract og:site_name
    if let Some(sel) = og_site {
        metadata.site_name = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());
    }

    // Use og:url if available
    if let Some(sel) = og_url {
        if let Some(canonical_url) = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
        {
            metadata.url = canonical_url.to_string();
        }
    }

    metadata
}

/// Check if window is visible on any monitor, reset to center if off-screen
fn ensure_window_visible(window: &tauri::WebviewWindow) {
    use tauri::PhysicalPosition;

    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };

    // Check if any part of the window's title bar (top 50px) is visible on any monitor
    // We check the title bar area specifically so the user can always drag the window
    let window_left = position.x;
    let window_right = position.x + size.width as i32;
    let window_top = position.y;
    let window_title_bar_bottom = position.y + 50; // Title bar height

    let is_visible = monitors.iter().any(|monitor| {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();

        let mon_left = mon_pos.x;
        let mon_right = mon_pos.x + mon_size.width as i32;
        let mon_top = mon_pos.y;
        let mon_bottom = mon_pos.y + mon_size.height as i32;

        // Check if title bar region overlaps with this monitor
        window_right > mon_left
            && window_left < mon_right
            && window_title_bar_bottom > mon_top
            && window_top < mon_bottom
    });

    if !is_visible {
        // Window is off-screen, reset to center of first available monitor
        if let Some(primary) = monitors.into_iter().next() {
            let mon_pos = primary.position();
            let mon_size = primary.size();
            let new_x = mon_pos.x + (mon_size.width as i32 - size.width as i32) / 2;
            let new_y = mon_pos.y + (mon_size.height as i32 - size.height as i32) / 2;
            let _ = window.set_position(PhysicalPosition::new(new_x.max(0), new_y.max(0)));
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSActivityOptions;
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSNotificationName, NSProcessInfo, NSString,
    };
    use serde::Serialize;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::WebviewWindow;

    // CoreGraphics FFI: detects whether the main display is actually awake.
    //
    // macOS wakes the system periodically for background tasks (DarkWake /
    // PowerNap — e.g. Mail fetch, Time Machine) without turning the display
    // on. From the app's point of view these look identical to a real wake:
    // `NSWorkspaceDidWakeNotification` fires, timers resume, the network
    // briefly comes up. Without a way to distinguish the two, the client
    // performs a full reconnect + MAM catch-up + webview reload dozens of
    // times per night, burning battery and churning state that no one sees.
    //
    // `CGDisplayIsAsleep(CGMainDisplayID())` returns non-zero during dark
    // wake and zero during user-driven wake. We pipe this into the wake
    // event payload so the webview can skip handling when no user is
    // present to benefit from the work.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayIsAsleep(display: u32) -> i32;
    }

    pub(crate) fn is_display_active() -> bool {
        // SAFETY: CGMainDisplayID / CGDisplayIsAsleep are pure Core Graphics
        // queries with no preconditions; safe to call from any thread.
        unsafe {
            let display = CGMainDisplayID();
            CGDisplayIsAsleep(display) == 0
        }
    }

    #[derive(Serialize, Clone)]
    struct WakeEventPayload {
        #[serde(rename = "displayActive")]
        display_active: bool,
    }

    // Store the window reference for the observer callback
    static WINDOW: std::sync::OnceLock<Arc<Mutex<Option<WebviewWindow>>>> =
        std::sync::OnceLock::new();

    // Store the app handle for emitting events from activation observer
    static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

    // Store pending wake timestamp (epoch seconds, 0 = no pending wake)
    // When system wakes while app is in background, JS can't process the event.
    // We store the timestamp and emit when app becomes active.
    static PENDING_WAKE_TIME: AtomicU64 = AtomicU64::new(0);

    /// Disable App Nap to keep the connection alive when minimized or on another desktop.
    /// This is particularly important for macOS versions before 14.0 where
    /// backgroundThrottling config option doesn't work.
    pub fn disable_app_nap() {
        let process_info = NSProcessInfo::processInfo();
        let reason = NSString::from_str("Maintaining XMPP connection");

        // NSActivityUserInitiatedAllowingIdleSystemSleep prevents App Nap
        // while still allowing the system to sleep if the user is idle
        let options = NSActivityOptions::UserInitiatedAllowingIdleSystemSleep
            | NSActivityOptions::LatencyCritical;

        // Begin the activity and leak it intentionally.
        // IMPORTANT: The activity token must be retained for the lifetime of the app.
        // If it's dropped, the activity ends and App Nap will suspend the app.
        // We use Box::leak to ensure it's never dropped.
        let activity = process_info.beginActivityWithOptions_reason(options, &reason);
        Box::leak(Box::new(activity));
    }

    pub fn setup_activation_observer(window: WebviewWindow, app_handle: tauri::AppHandle) {
        use std::time::{SystemTime, UNIX_EPOCH};
        use tauri::Emitter;

        // Store window reference
        let window_holder = WINDOW.get_or_init(|| Arc::new(Mutex::new(None)));
        *window_holder.lock().unwrap() = Some(window);

        // Store app handle for emitting events
        let _ = APP_HANDLE.set(app_handle);

        unsafe {
            let center = NSNotificationCenter::defaultCenter();
            let name = NSNotificationName::from_str("NSApplicationDidBecomeActiveNotification");

            // Use block-based observer
            center.addObserverForName_object_queue_usingBlock(
                Some(&name),
                None,
                None,
                &RcBlock::new(|_notification: NonNull<NSNotification>| {
                    // When app becomes active, show the window if it exists
                    if let Some(window_holder) = WINDOW.get() {
                        if let Ok(guard) = window_holder.lock() {
                            if let Some(ref win) = *guard {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }

                    // Check for pending wake event that couldn't be processed while in background
                    let pending_wake = PENDING_WAKE_TIME.swap(0, Ordering::SeqCst);
                    if pending_wake > 0 {
                        if let Some(handle) = APP_HANDLE.get() {
                            // Calculate how long ago the wake happened
                            let now = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            let sleep_duration_secs = now.saturating_sub(pending_wake);

                            // Emit wake event with the duration the app was "asleep"
                            // (time from actual wake to now when app becomes active)
                            let _ = handle.emit("system-did-wake-deferred", sleep_duration_secs);
                        }
                    }
                }),
            );
        }
    }

    /// Set up observer for system sleep events.
    /// Emits "system-will-sleep" event to frontend before laptop goes to sleep.
    /// Emits "system-did-wake" event to frontend when laptop wakes from sleep.
    ///
    /// Note: When the app is in background, the JS event handler may not run due to
    /// WebView throttling. We store the wake timestamp so that when the app becomes
    /// active, we can emit a deferred wake event with the actual sleep duration.
    pub fn setup_sleep_observer(app_handle: tauri::AppHandle) {
        use std::time::{SystemTime, UNIX_EPOCH};
        use tauri::Emitter;

        unsafe {
            // NSWorkspace notifications use the shared workspace's notification center
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();

            // Sleep notification
            let sleep_name = NSNotificationName::from_str("NSWorkspaceWillSleepNotification");
            let sleep_handle = app_handle.clone();
            center.addObserverForName_object_queue_usingBlock(
                Some(&sleep_name),
                None,
                None,
                &RcBlock::new(move |_notification: NonNull<NSNotification>| {
                    // Clear any pending wake (shouldn't happen, but be safe)
                    PENDING_WAKE_TIME.store(0, Ordering::SeqCst);
                    // Emit event to frontend so it can set XA presence
                    let _ = sleep_handle.emit("system-will-sleep", ());
                }),
            );

            // Wake notification
            let wake_name = NSNotificationName::from_str("NSWorkspaceDidWakeNotification");
            let wake_handle = app_handle.clone();
            center.addObserverForName_object_queue_usingBlock(
                Some(&wake_name),
                None,
                None,
                &RcBlock::new(move |_notification: NonNull<NSNotification>| {
                    // Store wake timestamp for deferred handling if app is in background
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    PENDING_WAKE_TIME.store(now, Ordering::SeqCst);

                    // Probe the display state before emitting so the webview
                    // can distinguish DarkWake/PowerNap (display asleep, no
                    // user present) from a user-driven wake. The probe runs
                    // on the notification-center dispatch thread; it's a
                    // read-only CG call and doesn't block.
                    let display_active = is_display_active();

                    // Also emit immediately - if app is in foreground, JS will handle it
                    // and the pending wake will be cleared when activation fires
                    let _ = wake_handle.emit(
                        "system-did-wake",
                        WakeEventPayload { display_active },
                    );
                }),
            );
        }
    }
}

/// Payload for the native `xmpp-keepalive` event. Serialized with camelCase
/// keys to match the WebView's `KeepalivePayload` interface
/// (`displayActive`, `sleptMs`). Mirrors `macos::WakeEventPayload`'s serde
/// convention so the JS side can parse both uniformly.
#[derive(Serialize, Clone)]
struct KeepalivePayload {
    #[serde(rename = "displayActive")]
    display_active: bool,
    #[serde(rename = "sleptMs")]
    slept_ms: u64,
}

/// Construct a keepalive payload. Pure seam so the loop's payload shape is
/// unit-testable without the FFI display probe or the Tauri emitter.
fn build_keepalive_payload(display_active: bool, slept_ms: u64) -> KeepalivePayload {
    KeepalivePayload {
        display_active,
        slept_ms,
    }
}

/// Native keepalive cadence. The thread emits an `xmpp-keepalive` event every
/// `KEEPALIVE_INTERVAL`, regardless of display state.
const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Floor above the interval beyond which an iteration's measured wall-clock
/// elapsed is attributed to the machine having slept rather than to scheduler
/// jitter. `30s + 90s = 120s`, well above any plausible jitter and aligned
/// with the JS `SLEEP_THRESHOLD_MS`-driven wake handling.
const SLEEP_GAP_MARGIN: std::time::Duration = std::time::Duration::from_secs(90);

/// Wall-clock wake detection. When a loop iteration's measured `elapsed` is at
/// or above `interval + margin`, the machine almost certainly slept through the
/// `sleep()` call; return `Some(elapsed_ms)` so the loop can fire immediately.
/// Otherwise (normal tick + jitter) return `None`. Pure seam — no FFI, no clock.
fn detect_sleep_gap(
    elapsed: std::time::Duration,
    interval: std::time::Duration,
    margin: std::time::Duration,
) -> Option<u64> {
    if elapsed >= interval + margin {
        Some(elapsed.as_millis() as u64)
    } else {
        None
    }
}

/// Decide how long to wait before the next keepalive iteration. When the prior
/// iteration detected a sleep gap (`Some`), wait `ZERO` so the post-wake tick
/// fires immediately instead of waiting out another full interval; otherwise
/// wait the normal `KEEPALIVE_INTERVAL`. Pure seam.
fn next_wait(slept: Option<u64>) -> std::time::Duration {
    if slept.is_some() {
        std::time::Duration::ZERO
    } else {
        KEEPALIVE_INTERVAL
    }
}

/// One keepalive iteration's pure work: detect a sleep gap from the measured
/// `elapsed`, probe the display state **fresh** (so a transient stuck reading
/// can't poison later ticks), build the payload, and compute the next wait.
/// Returns the payload to emit and the duration to sleep before the next tick.
/// The Tauri `emit` and the real wall-clock measurement stay in the thread;
/// this seam takes them as inputs so it is fully unit-testable.
fn keepalive_step<F: Fn() -> bool>(
    elapsed: std::time::Duration,
    interval: std::time::Duration,
    margin: std::time::Duration,
    display_probe: F,
) -> (KeepalivePayload, std::time::Duration) {
    let slept = detect_sleep_gap(elapsed, interval, margin);
    let display_active = display_probe();
    let payload = build_keepalive_payload(display_active, slept.unwrap_or(0));
    (payload, next_wait(slept))
}

/// Crate-level display-active probe for the keepalive thread. Fails open:
/// returns `true` on platforms without a display-sleep probe, and the macOS
/// `CGDisplayIsAsleep` path is documented to default active on any ambiguity.
/// Failing open is mandatory — since `system-did-wake` is demoted to
/// reload-only, a stuck-`false` probe would otherwise silently kill
/// reconnection forever.
fn keepalive_display_active() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_display_active()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Forward a WebView console message to the terminal via tracing.
/// Only produces output when a tracing subscriber is active (--verbose or RUST_LOG).
#[tauri::command]
fn log_to_terminal(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "webview", "{}", message),
        "warn" => tracing::warn!(target: "webview", "{}", message),
        "debug" => tracing::debug!(target: "webview", "{}", message),
        _ => tracing::info!(target: "webview", "{}", message),
    }
}

/// Open the operating system's notification settings.
///
/// Uses a native process launch rather than the shell/opener plugins: their
/// default scopes reject custom URL schemes (`x-apple.systempreferences:`,
/// `ms-settings:`), and Linux has no notification-settings URL at all — it
/// needs a control-center invocation. Best-effort; a failed launch is returned
/// to the caller, which logs it.
#[tauri::command]
fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        .spawn();

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:notifications"])
        .spawn();

    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("gnome-control-center")
        .arg("notifications")
        .spawn();

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let result: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "unsupported platform",
    ));

    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Print startup diagnostics to stderr for debugging.
fn print_startup_diagnostics() {
    eprintln!(
        "Fluux Messenger v{} (build {})",
        env!("CARGO_PKG_VERSION"),
        env!("GIT_HASH")
    );
    eprintln!(
        "Platform: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );

    #[cfg(target_os = "linux")]
    {
        let compositing_disabled = std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE")
            .map(|v| v == "1")
            .unwrap_or(false);

        eprintln!("WebKitGTK GPU settings:");
        eprintln!("  WEBKIT_DISABLE_DMABUF_RENDERER: always enabled (Wayland crash workaround)");
        eprintln!(
            "  WEBKIT_DISABLE_COMPOSITING_MODE: {}",
            if compositing_disabled {
                "enabled (FLUUX_DISABLE_GPU set)"
            } else {
                "disabled (set FLUUX_DISABLE_GPU to enable)"
            }
        );
    }

    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("GPU workarounds: N/A (not Linux)");
    }

    eprintln!("---");
}

fn main() {
    // Keep the loopback hop to the local XMPP bridge off any system-wide proxy.
    // On Linux this also runs from a pre-main ctor (before WebKitGTK init); on
    // macOS/Windows this is the earliest hook before the webview is created.
    ensure_loopback_no_proxy();

    // Parse CLI flags early, before tracing subscriber init
    let args: Vec<String> = std::env::args().collect();
    let clear_storage = args
        .iter()
        .any(|arg| arg == "--clear-storage" || arg == "-c");
    let dangerous_insecure_tls = args.iter().any(|arg| arg == "--dangerous-insecure-tls");

    // Set insecure TLS flag before any proxy can start
    xmpp_proxy::set_dangerous_insecure_tls(dangerous_insecure_tls);
    if dangerous_insecure_tls {
        eprintln!("WARNING: TLS certificate verification is DISABLED (--dangerous-insecure-tls)");
        eprintln!("         This is insecure and should only be used for development/testing.");
    }

    // Parse verbose level: --verbose / -v (default, no XMPP packets) or --verbose=xmpp (with packets)
    let verbose_level = args.iter().find_map(|arg| {
        if arg == "--verbose" || arg == "-v" {
            Some("default")
        } else if arg.starts_with("--verbose=") {
            Some(arg.strip_prefix("--verbose=").unwrap())
        } else {
            None
        }
    });
    let verbose = verbose_level.is_some();

    // Parse --log-file=<path> option
    let log_file_path = args
        .iter()
        .find_map(|arg| arg.strip_prefix("--log-file=").map(|s| s.to_string()));

    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        eprintln!("Fluux Messenger v{}", env!("CARGO_PKG_VERSION"));
        eprintln!();
        eprintln!("Usage: fluux-messenger [OPTIONS]");
        eprintln!();
        eprintln!("Options:");
        eprintln!("  -v, --verbose         Enable verbose logging to stderr (no XMPP traffic)");
        eprintln!("      --verbose=xmpp    Enable verbose logging including XMPP packet content");
        eprintln!(
            "      --log-file=PATH   Override log file directory (default: platform log dir)"
        );
        eprintln!("  -c, --clear-storage   Clear local storage on startup");
        eprintln!("      --dangerous-insecure-tls");
        eprintln!("                        Disable TLS certificate verification (INSECURE!)");
        eprintln!("  -h, --help            Show this help message");
        eprintln!();
        eprintln!("Logs are always written to a daily-rotating file in:");
        eprintln!("  macOS:   ~/Library/Logs/com.processone.fluux/");
        eprintln!("  Linux:   ~/.local/share/com.processone.fluux/logs/");
        eprintln!("  Windows: %APPDATA%\\com.processone.fluux\\logs\\");
        eprintln!();
        eprintln!("Environment variables:");
        eprintln!("  RUST_LOG              Override log filter (e.g. RUST_LOG=debug)");
        eprintln!("  FLUUX_DISABLE_GPU     Disable compositing mode (Linux, for NVIDIA EGL issues)");
        std::process::exit(0);
    }

    // Determine the log directory: --log-file=<path> overrides the default platform path
    let log_dir = if let Some(ref path) = log_file_path {
        std::path::PathBuf::from(path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    } else {
        // Platform log directory:
        //   macOS:   ~/Library/Logs/com.processone.fluux/
        //   Linux:   ~/.local/share/com.processone.fluux/logs/  (or $XDG_DATA_HOME)
        //   Windows: %APPDATA%\com.processone.fluux\logs\
        let base = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        let dir = base.join("com.processone.fluux").join("logs");

        #[cfg(target_os = "macos")]
        let dir = dirs::home_dir()
            .map(|h| h.join("Library").join("Logs").join("com.processone.fluux"))
            .unwrap_or(dir);

        dir
    };

    // Initialize tracing subscriber:
    // - Always write to a log file in the platform log directory (for bug reports)
    // - Optionally add stderr output when --verbose is passed
    {
        use tracing_subscriber::prelude::*;
        use tracing_subscriber::EnvFilter;

        // Ensure log directory exists
        if let Err(e) = std::fs::create_dir_all(&log_dir) {
            eprintln!(
                "Warning: could not create log directory '{}': {}",
                log_dir.display(),
                e
            );
        }

        // File log filter: always at info level (captures app + webview logs)
        let file_filter = if std::env::var("RUST_LOG").is_ok() {
            EnvFilter::from_default_env()
        } else {
            EnvFilter::new("fluux=info,webview=info,info")
        };

        // File layer: daily-rotating log file, non-blocking writes
        let file_appender = tracing_appender::rolling::daily(&log_dir, "fluux.log");
        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
        let file_layer = tracing_subscriber::fmt::layer()
            .with_writer(non_blocking)
            .with_ansi(false)
            .with_filter(file_filter);

        // Stderr layer: only when --verbose or --log-file is passed
        let stderr_layer =
            if verbose || log_file_path.is_some() || std::env::var("RUST_LOG").is_ok() {
                let effective_level = verbose_level.or(if log_file_path.is_some() {
                    Some("default")
                } else {
                    None
                });

                let stderr_filter = if std::env::var("RUST_LOG").is_ok() {
                    EnvFilter::from_default_env()
                } else if effective_level == Some("xmpp") {
                    EnvFilter::new("fluux=info,fluux::xmpp_proxy=debug,webview=debug,info")
                } else {
                    EnvFilter::new("fluux=info,info")
                };

                Some(
                    tracing_subscriber::fmt::layer()
                        .with_writer(std::io::stderr)
                        .with_filter(stderr_filter),
                )
            } else {
                None
            };

        tracing_subscriber::registry()
            .with(file_layer)
            .with(stderr_layer)
            .init();

        // Keep the non-blocking guard alive for the entire program lifetime.
        // Dropping it would flush and stop the background writer thread.
        // We use forget() since we want it to live until process exit.
        std::mem::forget(_guard);

        eprintln!("Log file: {}", log_dir.display());
    }

    // Print startup diagnostics when verbose or logging to file
    if verbose || log_file_path.is_some() {
        print_startup_diagnostics();
    }

    // Shared flag to signal the keepalive thread to stop on app exit
    let keepalive_running = Arc::new(AtomicBool::new(true));
    let keepalive_flag_for_setup = keepalive_running.clone();
    let keepalive_flag_for_run = keepalive_running.clone();
    // Tracks whether graceful shutdown has already started so we only prevent
    // the first exit request. The second request (from frontend or fallback
    // timer) is allowed to complete and terminate the app.
    let graceful_shutdown_started = Arc::new(AtomicBool::new(false));
    let graceful_shutdown_flag_for_run = graceful_shutdown_started.clone();
    // Tray "Quit" (and the Linux no-tray X-close) start the graceful shutdown
    // themselves, so they must claim the flag too. Otherwise the frontend's
    // follow-up `exit_app` looks like a *first* exit request to the run handler
    // below, which prevents it — leaving the 2s fallback timer as the only way
    // out, i.e. every tray quit force-killed instead of exiting cleanly.
    // Underscore-prefixed: only the linux/windows cfg blocks below consume it.
    let _graceful_shutdown_flag_for_setup = graceful_shutdown_started.clone();

    let app = tauri::Builder::default()
        // Single-instance guard MUST be the first plugin registered (Tauri
        // requirement). When a second copy of Fluux is launched, the OS lock is
        // already held, so the new process hands its argv to this callback and
        // exits instead of opening a duplicate window. We restore the live
        // window: unminimize, then show (Linux closes to the system tray, so the
        // window may be hidden), re-clamp it on-screen, and focus it.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                ensure_window_visible(&window);
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // On macOS, decorum's on_window_ready hook repositions the traffic
        // lights at a fixed inset (dot centre ~20px from top) and keeps them
        // there across resize. The AppBar height is matched to that. We do NOT
        // call decorum's per-window APIs — see the note in the macOS setup
        // block. Cross-platform-safe to register everywhere.
        .plugin(tauri_plugin_decorum::init())
        .invoke_handler(tauri::generate_handler![
            get_idle_time,
            save_credentials,
            get_credentials,
            delete_credentials,
            exit_app,
            fetch_url_metadata,
            upload::upload_file,
            download::download_file,
            start_xmpp_proxy,
            stop_xmpp_proxy,
            mcp_start_server,
            mcp_stop_server,
            mcp_reset_token,
            mcp::bridge::mcp_respond,
            log_to_terminal,
            open_notification_settings,
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
            #[cfg(target_os = "macos")]
            notifications::post_notification,
            #[cfg(target_os = "macos")]
            notifications::notification_permission_state,
            #[cfg(target_os = "macos")]
            notifications::request_notification_permission,
            #[cfg(target_os = "macos")]
            notifications::take_pending_notification_target,
            #[cfg(target_os = "macos")]
            notifications::set_notification_listener_ready,
            #[cfg(target_os = "macos")]
            notifications::remove_delivered_notifications
        ])
        .on_page_load(move |webview, payload| {
            // Always inject console-forwarding script so SDK diagnostic logs
            // (prefixed with [Fluux]) reach the Rust file log for troubleshooting.
            // When --verbose is not active, this is the only way JS logs reach the file.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = webview.eval(r#"
                    (function() {
                        if (window.__consoleForwardingActive) return;
                        window.__consoleForwardingActive = true;
                        var origLog = console.log;
                        var origInfo = console.info;
                        var origWarn = console.warn;
                        var origError = console.error;
                        var origDebug = console.debug;
                        function serializeArg(a) {
                            if (typeof a === 'string') return a;
                            // Error objects keep message/stack on non-enumerable
                            // properties, so JSON.stringify(err) === "{}". Surface
                            // them explicitly or every logged error becomes "{}".
                            if (a instanceof Error) {
                                var head = (a.name || 'Error') + ': ' + (a.message || '');
                                return a.stack ? head + '\n' + a.stack : head;
                            }
                            try {
                                var s = JSON.stringify(a);
                                if (s === undefined || s === '{}') {
                                    // Error-like objects (DOMException, custom) or
                                    // anything whose own enumerable props are empty.
                                    if (a && (a.message || a.name || a.stack)) {
                                        var parts = [];
                                        if (a.name) parts.push(String(a.name));
                                        if (a.message) parts.push(String(a.message));
                                        if (a.stack) parts.push(String(a.stack));
                                        return parts.join(': ');
                                    }
                                    return s === undefined ? String(a) : Object.prototype.toString.call(a);
                                }
                                return s;
                            } catch (e) {
                                try { return String(a); } catch (e2) { return '[unserializable]'; }
                            }
                        }
                        function forward(level, args) {
                            try {
                                var msg = Array.prototype.slice.call(args).map(serializeArg).join(' ');
                                window.__TAURI_INTERNALS__.invoke('log_to_terminal', { level: level, message: msg });
                            } catch(e) {}
                        }
                        console.log = function() { origLog.apply(console, arguments); forward('info', arguments); };
                        console.info = function() { origInfo.apply(console, arguments); forward('info', arguments); };
                        console.warn = function() { origWarn.apply(console, arguments); forward('warn', arguments); };
                        console.error = function() { origError.apply(console, arguments); forward('error', arguments); };
                        console.debug = function() { origDebug.apply(console, arguments); forward('debug', arguments); };
                        window.addEventListener('error', function(e) {
                            // Benign, self-correcting browser notice — NOT an app error. WebKitGTK
                            // emits 'ResizeObserver loop completed with undelivered notifications'
                            // routinely with content-visibility rows plus a scroll-correction
                            // ResizeObserver. Forwarding it as 'Uncaught error' is alarming log
                            // noise; a genuine runaway loop is surfaced separately by the
                            // rate-limited '[ScrollResizeLoop]' diagnostic. Swallow it here.
                            if (e.message && e.message.indexOf('ResizeObserver loop') !== -1) {
                                return;
                            }
                            // Resource load failures (img/video/script/link): e.target is the element.
                            if (e.target && e.target !== window && e.target.tagName) {
                                var src = e.target.src || e.target.href || '(unknown)';
                                forward('error', ['Failed to load resource: ' + e.target.tagName.toLowerCase() + ' ' + src]);
                                return;
                            }
                            // Uncaught JS exception: carries the real Error (message + stack)
                            // and the source location. Without this, render-phase throws that
                            // escape React reach the log as nothing at all.
                            var where = (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0);
                            if (e.error) {
                                forward('error', ['Uncaught exception at ' + where + ':', e.error]);
                            } else {
                                forward('error', ['Uncaught error at ' + where + ': ' + (e.message || '(unknown)')]);
                            }
                        }, true);
                        window.addEventListener('unhandledrejection', function(e) {
                            forward('error', ['Unhandled promise rejection:', e && e.reason]);
                        });
                    })();
                "#);
            }
        })
        .setup(move |app| {
            // Wire up native notification backends (macOS: request auth now;
            // the delegate / click routing lands in a later task).
            notifications::setup(app.handle());

            // OpenPGP key storage needs the per-user app data dir. Resolve
            // it here (inside setup, where `app.path()` is available) and
            // hand the state to the Tauri managed-state system. Falling
            // back to the OS tmp dir keeps the app bootable even if the
            // path resolver fails — the user would just lose their key
            // across the next restart, which is still better than a
            // startup crash.
            let openpgp_data_dir = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    tracing::warn!(
                        "openpgp: could not resolve app data dir ({e}); persisted keys will not survive restart"
                    );
                    std::env::temp_dir().join("fluux-openpgp-ephemeral")
                }
            };
            // Wrap in Arc so the async `openpgp_ensure_key` command and
            // the detached prewarm task can each hold an owned reference
            // across thread boundaries without borrowing the Tauri
            // `State<'_>`. (Tauri's State guard is tied to the command's
            // stack frame — we can't move it into a `'static` task.)
            let openpgp_state = Arc::new(openpgp::OpenpgpState::new(openpgp_data_dir));
            app.manage(Arc::clone(&openpgp_state));
            app.manage(Arc::new(mcp::bridge::PendingRequests::new()));

            // Boot-time prewarm: if `last_user` is stashed in the keychain
            // AND we have an encrypted TSK on disk for that JID, start the
            // unlock now so it overlaps with Tauri window creation, React
            // boot, and the XMPP handshake. Both preconditions matter —
            // the disk check avoids speculatively GENERATING a new key
            // for users who never opted into E2EE.
            //
            // This runs on Tauri's blocking pool to keep setup()
            // non-blocking. `prewarm_if_persisted` itself is cheap (just
            // a file-exists check); the Argon2id work it spawns runs on
            // Tauri's blocking pool too.
            let prewarm_state = Arc::clone(&openpgp_state);
            tauri::async_runtime::spawn_blocking(move || {
                let entry = match keyring::Entry::new(KEYRING_SERVICE, "last_user") {
                    Ok(e) => e,
                    Err(_) => return,
                };
                let jid = match entry.get_password() {
                    Ok(j) => j,
                    Err(_) => return, // NoEntry or access failure — quiet no-op
                };
                // Mirrors the canonical XEP-0373 §8.5 trust-anchor UID defined
                // in TS at `src/e2ee/openpgpUserId.ts` (`accountUserId`). Keep in
                // sync — generation and verification key off this exact form.
                let user_id = format!("xmpp:{jid}");
                prewarm_state.prewarm_if_persisted(jid, user_id);
            });

            // Handle --clear-storage CLI flag (useful for debugging connection issues)
            if clear_storage {
                tracing::info!("CLI: --clear-storage flag detected, will clear local data on startup");
                // Emit event to frontend after window is ready
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Small delay to ensure frontend is ready
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = app_handle.emit("clear-storage-requested", ());
                });
            }

            // Register xmpp: URI scheme for deep linking (RFC 5122)
            // This allows the app to open when users click xmpp: links
            // On macOS, URI schemes are registered via Info.plist at build time
            // (configured in tauri.conf.json), so runtime registration is only
            // needed on Linux and Windows.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                match app.deep_link().register("xmpp") {
                    Ok(_) => tracing::info!("Deep link: registered xmpp: URI scheme"),
                    Err(e) => tracing::warn!("Deep link: failed to register xmpp: URI scheme: {}", e),
                }
            }

            // macOS: Create custom menu with Help submenu
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::MenuItem;

                // App menu (standard macOS app menu)
                let app_menu = SubmenuBuilder::new(app, "Fluux Messenger")
                    .item(&PredefinedMenuItem::about(app, Some("About Fluux Messenger"), None)?)
                    .separator()
                    .item(&PredefinedMenuItem::services(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, Some("Hide Fluux Messenger"))?)
                    .item(&PredefinedMenuItem::hide_others(app, None)?)
                    .item(&PredefinedMenuItem::show_all(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(app, Some("Quit Fluux Messenger"))?)
                    .build()?;

                // Edit menu (standard text editing)
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::undo(app, None)?)
                    .item(&PredefinedMenuItem::redo(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;

                // View menu
                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&PredefinedMenuItem::fullscreen(app, Some("Toggle Full Screen"))?)
                    .build()?;

                // Window menu
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .item(&PredefinedMenuItem::minimize(app, None)?)
                    .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
                    .separator()
                    .item(&PredefinedMenuItem::close_window(app, None)?)
                    .build()?;

                // Help menu with GitHub link and log access
                let github_item = MenuItem::with_id(app, "github", "Fluux Messenger on GitHub", true, None::<&str>)?;
                let report_issue_item = MenuItem::with_id(app, "report_issue", "Report an Issue...", true, None::<&str>)?;
                let show_logs_item = MenuItem::with_id(app, "show_logs", "Reveal Logs in Finder", true, None::<&str>)?;

                let help_menu = SubmenuBuilder::new(app, "Help")
                    .item(&github_item)
                    .item(&report_issue_item)
                    .separator()
                    .item(&show_logs_item)
                    .build()?;

                // Build and set the menu
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                    .build()?;

                app.set_menu(menu)?;

                // Handle menu events
                let log_dir_for_menu = log_dir.clone();
                app.on_menu_event(move |app_handle, event| {
                    match event.id().as_ref() {
                        "github" => {
                            let _ = app_handle.opener().open_url("https://github.com/processone/fluux-messenger", None::<&str>);
                        }
                        "report_issue" => {
                            let _ = app_handle.opener().open_url("https://github.com/processone/fluux-messenger/issues/new", None::<&str>);
                        }
                        "show_logs" => {
                            let _ = app_handle.opener().reveal_item_in_dir(&log_dir_for_menu);
                        }
                        _ => {}
                    }
                });
            }

            // Check if window is off-screen (e.g., monitor was disconnected) and reset if needed
            if let Some(window) = app.get_webview_window("main") {
                ensure_window_visible(&window);
                // Ensure window has keyboard focus on launch
                let _ = window.set_focus();
                // Linux/WebKitGTK: force the loopback hop to the XMPP bridge
                // direct, even when a system-wide (e.g. KDE SOCKS5) proxy is set.
                #[cfg(target_os = "linux")]
                apply_loopback_proxy_bypass(&window);
            }

            // macOS: Hide window instead of quitting when close button is clicked
            // (standard macOS behavior - app stays in dock)
            #[cfg(target_os = "macos")]
            {
                // Disable App Nap to keep XMPP connection alive when minimized
                macos::disable_app_nap();

                let main_window = app.get_webview_window("main").unwrap();

                // Explicitly (re)assert the window title so macOS system surfaces
                // that sample the live NSWindow title — notably Control Center's
                // media / Now Playing control shown while playing a voice note or
                // video — never fall back to wry's built-in "Tauri App" default.
                // `hiddenTitle: true` (tauri.macos.conf.json) keeps this out of our
                // custom AppBar titlebar, so it is invisible in-app while correcting
                // the name shown in the system media controls.
                let _ = main_window.set_title("Fluux Messenger");

                // NOTE: the macOS traffic lights are positioned by the decorum
                // plugin's own `on_window_ready` hook at its FIXED inset (dot
                // centre ~20px from the window top), kept in place across resize
                // by a native delegate. We intentionally do NOT call
                // set_traffic_lights_inset / create_overlay_titlebar: decorum
                // hardcodes the inset and overrides any per-call value, and
                // create_overlay_titlebar injects its own titlebar HTML that
                // clashes with our AppBar. Instead the AppBar height (h-10 /
                // 40px, see components/AppBar.tsx) is chosen so that fixed dot
                // centre lands in the middle of the bar.

                let window = main_window.clone();
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        // Save window state before hiding (since we're preventing actual close)
                        let _ = app_handle.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN);
                        let _ = window.hide();
                    }
                });
                macos::setup_activation_observer(main_window.clone(), app.handle().clone());
                macos::setup_sleep_observer(app.handle().clone());
            }

            // Linux: Hide to system tray when close button is clicked.
            //
            // KNOWN ISSUE: After a hide→show cycle, tao's client-side decoration
            // (CSD) hit-test regions become stale, making titlebar buttons and
            // webview clicks unresponsive until the user manually maximizes.
            // Upstream: https://github.com/tauri-apps/tauri/issues/11856
            //           https://github.com/tauri-apps/tao/issues/1046
            // Workaround: briefly maximize after show() to force GTK to
            // recalculate decorations, then restore the saved window state.
            //
            // NOTE: With the current libappindicator-based tray backend, Linux
            // tray click events are not emitted, so left-click restore does not
            // reliably fire. Users should restore via the tray menu ("Show Fluux").
            // We keep the click handler below for parity/future backend support.
            //
            // When NO functional tray host is present at all (e.g. GNOME with no
            // AppIndicator extension), hiding would strand the window — so the
            // close handler below quits gracefully instead. See linux_tray.rs.
            #[cfg(target_os = "linux")]
            {
                let show_item = MenuItem::with_id(app, "show", "Show Fluux", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
                // GNOME can restore hidden windows at (0,0). Keep the last placement
                // and re-apply it when restoring from the tray menu.
                let last_window_state =
                    Arc::new(std::sync::Mutex::new(None::<(i32, i32, bool, bool)>));
                // Track whether the main window is currently hidden to tray.
                // Linux visibility reporting can be inconsistent across WMs.
                let window_hidden_to_tray = Arc::new(AtomicBool::new(false));

                let tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .tooltip("Fluux Messenger")
                    .on_menu_event({
                        let keepalive_flag = keepalive_flag_for_setup.clone();
                        let graceful_shutdown_flag = _graceful_shutdown_flag_for_setup.clone();
                        let last_window_state = last_window_state.clone();
                        let window_hidden_to_tray = window_hidden_to_tray.clone();
                        move |app, event| match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let was_hidden_to_tray =
                                        window_hidden_to_tray.load(Ordering::Relaxed);
                                    if !was_hidden_to_tray {
                                        // Already visible — just focus.
                                        let _ = window.set_focus();
                                        return;
                                    }

                                    let saved_state =
                                        last_window_state.lock().ok().and_then(|state| *state);

                                    let _ = window.show();
                                    if window.is_minimized().unwrap_or(false) {
                                        let _ = window.unminimize();
                                    }

                                    // Workaround for tao CSD bug (tauri#11856): after a
                                    // hide→show cycle the client-side decoration hit-test
                                    // regions are stale, making titlebar buttons and
                                    // webview clicks unresponsive.  A brief maximize
                                    // toggle forces GTK to recalculate decorations while
                                    // respecting the work area (top bar, dock).
                                    let was_maximized =
                                        saved_state.is_some_and(|(_, _, m, _)| m);
                                    let was_fullscreen =
                                        saved_state.is_some_and(|(_, _, _, fs)| fs);
                                    if !was_maximized && !was_fullscreen {
                                        let _ = window.maximize();
                                    }

                                    window_hidden_to_tray.store(false, Ordering::Relaxed);

                                    let handle = app.clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(
                                            std::time::Duration::from_millis(80),
                                        );
                                        if let Some(window) = handle.get_webview_window("main") {
                                            // Restore the saved window state.
                                            if let Some((x, y, maximized, fullscreen)) =
                                                saved_state
                                            {
                                                if fullscreen {
                                                    let _ = window.set_fullscreen(true);
                                                } else if maximized {
                                                    // Already maximized, nothing to undo.
                                                } else {
                                                    let _ = window.unmaximize();
                                                    // Restore position if GNOME reset it.
                                                    let should_restore =
                                                        match window.outer_position() {
                                                            Ok(cur) => {
                                                                cur.x == 0
                                                                    && cur.y == 0
                                                                    && (x != 0 || y != 0)
                                                            }
                                                            Err(_) => true,
                                                        };
                                                    if should_restore {
                                                        let _ = window.set_position(
                                                            tauri::PhysicalPosition::new(x, y),
                                                        );
                                                    }
                                                }
                                            } else {
                                                let _ = window.unmaximize();
                                            }

                                            let _ = window.set_focus();
                                            let _ = window.emit("tray-restore-focus", ());
                                        }
                                    });
                                }
                            }
                            "quit" => {
                                keepalive_flag.store(false, Ordering::Relaxed);
                                // Claim the shutdown so the frontend's exit_app
                                // is treated as the second request and allowed.
                                graceful_shutdown_flag.store(true, Ordering::Relaxed);
                                let _ = app.emit("graceful-shutdown", ());
                                let handle = app.clone();
                                std::thread::spawn(move || {
                                    std::thread::sleep(std::time::Duration::from_secs(2));
                                    handle.exit(0);
                                });
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event({
                        let window_hidden_to_tray = window_hidden_to_tray.clone();
                        move |tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                if let Some(window) = tray.app_handle().get_webview_window("main")
                                {
                                    let was_hidden_to_tray =
                                        window_hidden_to_tray.load(Ordering::Relaxed);
                                    if !was_hidden_to_tray {
                                        let _ = window.set_focus();
                                        return;
                                    }

                                    let _ = window.show();
                                    if window.is_minimized().unwrap_or(false) {
                                        let _ = window.unminimize();
                                    }

                                    // CSD workaround — see menu "show" handler comment.
                                    let _ = window.maximize();
                                    window_hidden_to_tray.store(false, Ordering::Relaxed);

                                    let handle = tray.app_handle().clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(
                                            std::time::Duration::from_millis(80),
                                        );
                                        if let Some(window) = handle.get_webview_window("main") {
                                            let _ = window.unmaximize();
                                            let _ = window.set_focus();
                                            let _ = window.emit("tray-restore-focus", ());
                                        }
                                    });
                                }
                            }
                        }
                    })
                    .build(app);

                // A tray-build failure must no longer abort startup — it flips
                // us into quit-on-close mode (no tray means X must close the app).
                let tray_built = tray.is_ok();
                if let Err(error) = &tray {
                    tracing::warn!(error = %error, "Linux: system tray failed to build; X-close will quit");
                }
                // Keep the icon alive for the app's lifetime when it built.
                let _tray = tray.ok();

                let main_window = app.get_webview_window("main").unwrap();
                let window = main_window.clone();
                let last_window_state_for_close = last_window_state.clone();
                let window_hidden_to_tray_for_close = window_hidden_to_tray.clone();
                let keepalive_flag_for_close = keepalive_flag_for_setup.clone();
                let graceful_shutdown_flag_for_close = _graceful_shutdown_flag_for_setup.clone();
                let app_handle_for_close = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();

                        // Only hide to tray when an icon will actually be shown
                        // (and can restore the window). Otherwise quit, so the
                        // window can never be stranded with no way back.
                        let host_registered = linux_tray::status_notifier_host_registered();
                        if !linux_tray::should_hide_to_tray(tray_built, host_registered) {
                            tracing::info!(
                                tray_built,
                                host_registered,
                                "Linux: no functional system tray — X-close quitting"
                            );
                            // Mirror the tray "Quit" menu item: stop keepalive,
                            // let the frontend disconnect XMPP, then force-exit.
                            keepalive_flag_for_close.store(false, Ordering::Relaxed);
                            graceful_shutdown_flag_for_close.store(true, Ordering::Relaxed);
                            let _ = app_handle_for_close.emit("graceful-shutdown", ());
                            let handle = app_handle_for_close.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_secs(2));
                                handle.exit(0);
                            });
                            return;
                        }

                        if let Ok(position) = window.outer_position() {
                            let maximized = window.is_maximized().unwrap_or(false);
                            let fullscreen = window.is_fullscreen().unwrap_or(false);
                            if let Ok(mut state) = last_window_state_for_close.lock() {
                                *state = Some((
                                    position.x,
                                    position.y,
                                    maximized,
                                    fullscreen,
                                ));
                            }
                        }
                        window_hidden_to_tray_for_close.store(true, Ordering::Relaxed);
                        let _ = window.hide();
                    }
                });
            }

            // Windows: Hide to system tray when close button is clicked
            // Minimize button works normally (minimize to taskbar)
            #[cfg(target_os = "windows")]
            {
                // Create system tray menu
                let show_item = MenuItem::with_id(app, "show", "Show Fluux", true, None::<&str>)?;
                let show_logs_item = MenuItem::with_id(app, "show_logs", "Open Logs Folder", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &show_logs_item, &quit_item])?;

                // Build the system tray icon
                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .tooltip("Fluux Messenger")
                    .on_menu_event({
                        let keepalive_flag = keepalive_flag_for_setup.clone();
                        let graceful_shutdown_flag = _graceful_shutdown_flag_for_setup.clone();
                        let log_dir_for_tray = log_dir.clone();
                        move |app, event| match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let already_visible = window.is_visible().unwrap_or(false);
                                    let is_minimized = window.is_minimized().unwrap_or(false);
                                    if already_visible && !is_minimized {
                                        let _ = window.set_focus();
                                        return;
                                    }

                                    let _ = window.show();
                                    if is_minimized {
                                        let _ = window.unminimize();
                                    }
                                    let _ = window.set_focus();
                                }
                            }
                            "show_logs" => {
                                let _ = app.opener().reveal_item_in_dir(&log_dir_for_tray);
                            }
                            "quit" => {
                                // Stop the keepalive thread
                                keepalive_flag.store(false, Ordering::Relaxed);
                                // Claim the shutdown so the frontend's exit_app
                                // is treated as the second request and allowed.
                                graceful_shutdown_flag.store(true, Ordering::Relaxed);
                                // Emit graceful shutdown event to frontend
                                let _ = app.emit("graceful-shutdown", ());
                                // Set a fallback timer to force exit after 2 seconds
                                let handle = app.clone();
                                std::thread::spawn(move || {
                                    std::thread::sleep(std::time::Duration::from_secs(2));
                                    handle.exit(0);
                                });
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        // Show window on left-click (single or double)
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let already_visible = window.is_visible().unwrap_or(false);
                                let is_minimized = window.is_minimized().unwrap_or(false);
                                if already_visible && !is_minimized {
                                    let _ = window.set_focus();
                                    return;
                                }

                                let _ = window.show();
                                if is_minimized {
                                    let _ = window.unminimize();
                                }
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;

                // Hide to tray when close button is clicked
                let main_window = app.get_webview_window("main").unwrap();
                let window = main_window.clone();
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        // Save window state before hiding
                        let _ = app_handle.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN);
                        let _ = window.hide();
                    }
                    // Alt-tabbing or clicking the taskbar focuses the top-level
                    // window, but WebView2 does not move keyboard focus into the
                    // webview child — so shortcuts (F12, Ctrl+K, …) and typing
                    // stay dead until the user clicks. Ask the JS side to grab
                    // webview input focus (controller.MoveFocus). (#654)
                    WindowEvent::Focused(true) => {
                        let _ = window.emit("window-focus-restore", ());
                    }
                    _ => {}
                });
            }

            // Start XMPP keepalive timer (30 seconds)
            // This runs in Rust and is immune to WKWebView JS timer throttling
            // which can suspend timers when the app is on another virtual desktop.
            // Uses an AtomicBool flag to stop cleanly on app exit (prevents 100% CPU).
            if let Some(window) = app.get_webview_window("main") {
                let running = keepalive_flag_for_setup.clone();
                std::thread::spawn(move || {
                    // Measure real wall-clock elapsed per iteration so a sleep
                    // the machine slept through (the `sleep()` call returns
                    // late) is detected and the post-wake tick fires
                    // immediately instead of waiting out another full interval.
                    // The display state is probed FRESH every emit and the tick
                    // keeps arriving every interval even when the display is
                    // off, so the JS state machine can learn when it returns.
                    let mut wait = KEEPALIVE_INTERVAL;
                    while running.load(Ordering::Relaxed) {
                        let started = std::time::Instant::now();
                        std::thread::sleep(wait);
                        if !running.load(Ordering::Relaxed) {
                            break;
                        }
                        let elapsed = started.elapsed();
                        let (payload, next) = keepalive_step(
                            elapsed,
                            KEEPALIVE_INTERVAL,
                            SLEEP_GAP_MARGIN,
                            keepalive_display_active,
                        );
                        let _ = window.emit("xmpp-keepalive", payload);
                        wait = next;
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, _event| {
        // Handle clicking dock icon to show window again (macOS only)
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = &_event {
            if let Some(window) = _app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        // Handle app termination: request graceful shutdown (all platforms)
        if let RunEvent::ExitRequested { api, .. } = &_event {
            // First exit request: trigger graceful shutdown and delay exit.
            // Subsequent request: allow exit to proceed.
            if graceful_shutdown_flag_for_run.swap(true, Ordering::Relaxed) {
                return;
            }

            // Stop the keepalive thread to prevent 100% CPU on exit
            keepalive_flag_for_run.store(false, Ordering::Relaxed);
            // Save window state including position (macOS and Windows only)
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                let _ = _app_handle.save_window_state(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                );
            }
            // Emit event to frontend for graceful disconnect
            let _ = _app_handle.emit("graceful-shutdown", ());
            // Prevent immediate exit - frontend will call exit_app after disconnect
            api.prevent_exit();
            // Set a fallback timer to force exit after 2 seconds
            let handle = _app_handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                handle.exit(0);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

    #[test]
    fn test_merge_no_proxy_empty_adds_all_loopback() {
        let merged = merge_no_proxy("", &LOOPBACK).expect("should append to empty");
        assert_eq!(merged, "localhost,127.0.0.1,::1");
    }

    #[test]
    fn test_merge_no_proxy_preserves_existing_entries() {
        let merged =
            merge_no_proxy("example.com, 10.0.0.0/8", &LOOPBACK).expect("should append loopback");
        assert_eq!(merged, "example.com,10.0.0.0/8,localhost,127.0.0.1,::1");
    }

    #[test]
    fn test_merge_no_proxy_noop_when_all_present() {
        // Already-present hosts (case-insensitive) → no write needed.
        assert_eq!(merge_no_proxy("LOCALHOST,127.0.0.1,::1", &LOOPBACK), None);
    }

    #[test]
    fn test_merge_no_proxy_appends_only_missing() {
        let merged = merge_no_proxy("127.0.0.1", &LOOPBACK).expect("should append the rest");
        assert_eq!(merged, "127.0.0.1,localhost,::1");
    }

    #[test]
    fn test_pick_proxy_uri_none_when_all_unset() {
        assert_eq!(pick_proxy_uri(&[None, None]), None);
    }

    #[test]
    fn test_pick_proxy_uri_skips_empty_and_whitespace() {
        let candidates = [
            Some(String::new()),
            Some("   ".to_string()),
            Some("socks5://127.0.0.1:1080".to_string()),
        ];
        assert_eq!(
            pick_proxy_uri(&candidates).as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
    }

    #[test]
    fn test_pick_proxy_uri_prefers_first_non_empty() {
        // Order encodes precedence (all_proxy before http_proxy); first wins.
        let candidates = [
            Some("socks5://proxy:1080".to_string()),
            Some("http://proxy:3128".to_string()),
        ];
        assert_eq!(
            pick_proxy_uri(&candidates).as_deref(),
            Some("socks5://proxy:1080")
        );
    }

    #[test]
    fn test_pick_proxy_uri_trims_surrounding_whitespace() {
        let candidates = [Some("  http://proxy:3128  ".to_string())];
        assert_eq!(
            pick_proxy_uri(&candidates).as_deref(),
            Some("http://proxy:3128")
        );
    }

    use std::time::Duration;

    #[test]
    fn test_loop_contract_fires_immediately_after_simulated_sleep() {
        // Iteration 1: a 2.5h sleep gap → emit immediately (ZERO wait), payload
        // carries the slept_ms. Iteration 2: steady state → 30s wait.
        let (p1, w1) =
            keepalive_step(Duration::from_secs(9000), KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || true);
        assert_eq!(w1, Duration::ZERO);
        assert_eq!(p1.slept_ms, 9_000_000);

        let (p2, w2) =
            keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || true);
        assert_eq!(w2, KEEPALIVE_INTERVAL);
        assert_eq!(p2.slept_ms, 0);
    }

    #[test]
    fn test_keepalive_display_active_is_callable() {
        // Must not panic; on non-macOS hosts it fails open to `true`.
        let _v: bool = keepalive_display_active();
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn test_keepalive_display_active_fails_open_off_macos() {
        assert!(keepalive_display_active());
    }

    #[test]
    fn test_keepalive_step_steady_state_uses_probe_and_interval() {
        let (payload, wait) =
            keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || true);
        assert!(payload.display_active);
        assert_eq!(payload.slept_ms, 0);
        assert_eq!(wait, KEEPALIVE_INTERVAL);
    }

    #[test]
    fn test_keepalive_step_sleep_gap_immediate_and_carries_slept_ms() {
        let elapsed = Duration::from_secs(9000);
        let (payload, wait) =
            keepalive_step(elapsed, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || true);
        assert_eq!(payload.slept_ms, 9_000_000);
        assert_eq!(wait, Duration::ZERO);
    }

    #[test]
    fn test_keepalive_step_probe_read_fresh_each_call() {
        // Probe flips false→true between calls; each payload reflects the
        // value read at that call (guards the stuck-`false` landmine).
        let state = std::cell::Cell::new(false);
        let probe = || {
            let v = state.get();
            state.set(!v);
            v
        };
        let (p1, _) = keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, &probe);
        let (p2, _) = keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, &probe);
        assert!(!p1.display_active);
        assert!(p2.display_active);
    }

    #[test]
    fn test_keepalive_step_display_inactive_still_emits() {
        // Display off → still produce a payload (the tick keeps arriving so
        // the state machine can learn when the display returns).
        let (payload, wait) =
            keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || false);
        assert!(!payload.display_active);
        assert_eq!(payload.slept_ms, 0);
        assert_eq!(wait, KEEPALIVE_INTERVAL);
    }

    #[test]
    fn test_next_wait_no_gap_uses_interval() {
        assert_eq!(next_wait(None), KEEPALIVE_INTERVAL);
    }

    #[test]
    fn test_next_wait_after_gap_fires_immediately() {
        // A detected sleep gap → fire the next tick immediately (zero wait).
        assert_eq!(next_wait(Some(9_000_000)), Duration::ZERO);
    }

    #[test]
    fn test_detect_sleep_gap_normal_interval_no_gap() {
        // Steady-state 30s tick: not a sleep.
        assert_eq!(
            detect_sleep_gap(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN),
            None
        );
    }

    #[test]
    fn test_detect_sleep_gap_scheduler_jitter_no_false_positive() {
        // 30s + 89s of jitter is still under the 120s floor → no false positive.
        let elapsed = KEEPALIVE_INTERVAL + Duration::from_secs(89);
        assert_eq!(detect_sleep_gap(elapsed, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN), None);
    }

    #[test]
    fn test_detect_sleep_gap_exact_floor_is_gap() {
        // Exactly interval + margin = 120s → treated as slept (inclusive boundary).
        let elapsed = KEEPALIVE_INTERVAL + SLEEP_GAP_MARGIN;
        assert_eq!(
            detect_sleep_gap(elapsed, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN),
            Some(120_000)
        );
    }

    #[test]
    fn test_detect_sleep_gap_long_sleep_returns_millis() {
        let elapsed = Duration::from_secs(9000);
        assert_eq!(
            detect_sleep_gap(elapsed, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN),
            Some(9_000_000)
        );
    }

    #[test]
    fn test_build_keepalive_payload_carries_fields() {
        let payload = build_keepalive_payload(true, 90_000);
        assert!(payload.display_active);
        assert_eq!(payload.slept_ms, 90_000);
    }

    #[test]
    fn test_build_keepalive_payload_inactive_display() {
        let payload = build_keepalive_payload(false, 0);
        assert!(!payload.display_active);
        assert_eq!(payload.slept_ms, 0);
    }

    #[test]
    fn test_keepalive_payload_serializes_camel_case() {
        let payload = KeepalivePayload {
            display_active: true,
            slept_ms: 120_000,
        };
        let json = serde_json::to_string(&payload).expect("serialize");
        assert_eq!(json, r#"{"displayActive":true,"sleptMs":120000}"#);
    }

    #[test]
    fn test_keepalive_payload_is_clone() {
        let payload = KeepalivePayload {
            display_active: false,
            slept_ms: 0,
        };
        let cloned = payload.clone();
        assert!(!cloned.display_active);
        assert_eq!(cloned.slept_ms, 0);
    }

    // --- Link-preview OG metadata extraction (parse_og_metadata) ---

    #[test]
    fn test_parse_og_metadata_full_open_graph() {
        let html = r#"
            <html><head>
              <meta property="og:title" content="The Rock">
              <meta property="og:description" content="A 1996 action film">
              <meta property="og:image" content="https://example.com/rock.jpg">
              <meta property="og:site_name" content="IMDb">
              <meta property="og:url" content="https://example.com/canonical">
            </head></html>
        "#;
        let m = parse_og_metadata("https://example.com/requested", html);
        assert_eq!(m.title.as_deref(), Some("The Rock"));
        assert_eq!(m.description.as_deref(), Some("A 1996 action film"));
        assert_eq!(m.image.as_deref(), Some("https://example.com/rock.jpg"));
        assert_eq!(m.site_name.as_deref(), Some("IMDb"));
        // og:url overrides the requested url as the canonical link.
        assert_eq!(m.url, "https://example.com/canonical");
    }

    #[test]
    fn test_parse_og_metadata_falls_back_to_title_and_meta_description() {
        let html = r#"
            <html><head>
              <title>  Plain Title  </title>
              <meta name="description" content="Plain description">
            </head></html>
        "#;
        let m = parse_og_metadata("https://example.com/a", html);
        // <title> is trimmed; used when og:title is absent.
        assert_eq!(m.title.as_deref(), Some("Plain Title"));
        assert_eq!(m.description.as_deref(), Some("Plain description"));
        assert_eq!(m.image, None);
        assert_eq!(m.site_name, None);
        // No og:url → keep the requested url.
        assert_eq!(m.url, "https://example.com/a");
    }

    #[test]
    fn test_parse_og_metadata_prefers_og_title_over_title_tag() {
        let html = r#"
            <html><head>
              <title>Fallback Title</title>
              <meta property="og:title" content="OG Title">
            </head></html>
        "#;
        let m = parse_og_metadata("https://example.com/a", html);
        assert_eq!(m.title.as_deref(), Some("OG Title"));
    }

    #[test]
    fn test_parse_og_metadata_empty_document_yields_only_url() {
        let m = parse_og_metadata("https://example.com/a", "<html></html>");
        assert_eq!(m.url, "https://example.com/a");
        assert_eq!(m.title, None);
        assert_eq!(m.description, None);
        assert_eq!(m.image, None);
        assert_eq!(m.site_name, None);
    }

    #[test]
    fn test_parse_og_metadata_ignores_empty_title_tag() {
        // A whitespace-only <title> must not become a spurious title.
        let m = parse_og_metadata("https://example.com/a", "<html><head><title>   </title></head></html>");
        assert_eq!(m.title, None);
    }
}

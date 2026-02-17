// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Linux: Set WebKitGTK workaround env vars BEFORE main() runs
// This uses ctor to run a static constructor before any other code,
// ensuring the env vars are set before WebKitGTK initializes.
// Fixes grey screen / "Could not create default EGL display: EGL_BAD_PARAMETER"
// See: https://github.com/tauri-apps/tauri/issues/11988
#[cfg(target_os = "linux")]
#[ctor::ctor]
fn set_linux_webkit_env() {
    if std::env::var("FLUUX_ENABLE_GPU").is_err() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

use tauri::{Emitter, Manager, RunEvent};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::WindowEvent;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
// Menu support
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
// System tray support for Windows
#[cfg(target_os = "windows")]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri_plugin_deep_link::DeepLinkExt;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_opener::OpenerExt;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use scraper::{Html, Selector};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

mod xmpp_proxy;

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

    const UNSUPPORTED_IDLE_REASON: &str = "Linux idle detection unavailable (MIT-SCREEN-SAVER extension missing)";
    const QUERY_FAILED_IDLE_REASON: &str = "Linux idle detection unavailable (XScreenSaver query failed)";

    /// Cache XScreenSaver support so we avoid repeatedly probing an unsupported
    /// display and flooding logs.
    static HAS_XSCREENSAVER_EXTENSION: OnceLock<bool> = OnceLock::new();
    static IDLE_BACKEND_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

    fn has_xscreensaver_extension() -> bool {
        *HAS_XSCREENSAVER_EXTENSION.get_or_init(|| unsafe {
            let display = xlib::XOpenDisplay(ptr::null());
            if display.is_null() {
                tracing::info!("Idle: no X11 display available, falling back to DOM idle detection");
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
                tracing::info!("Idle: MIT-SCREEN-SAVER extension missing, falling back to DOM idle detection");
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
                tracing::info!("Idle: failed to open X11 display, falling back to DOM idle detection");
                return Err("Linux idle detection unavailable (failed to open X11 display)".to_string());
            }

            let root = xlib::XDefaultRootWindow(display);
            let info = xss::XScreenSaverAllocInfo();
            if info.is_null() {
                xlib::XCloseDisplay(display);
                IDLE_BACKEND_UNAVAILABLE.store(true, Ordering::Relaxed);
                tracing::info!("Idle: could not allocate XScreenSaverInfo, falling back to DOM idle detection");
                return Err("Linux idle detection failed (could not allocate XScreenSaverInfo)".to_string());
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
        format!("Keychain access conflict during {} (item may exist or access was denied)", operation)
    } else {
        match e {
            keyring::Error::NoStorageAccess(_) => {
                format!("Keychain locked or inaccessible during {}: {}", operation, msg)
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
async fn save_credentials(jid: String, password: String, server: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let entry = Entry::new(KEYRING_SERVICE, &jid)
            .map_err(|e| {
                tracing::error!("Keychain: failed to create entry for {}: {}", jid, e);
                format!("Failed to create keyring entry: {}", e)
            })?;

        let credentials = StoredCredentials { jid: jid.clone(), password, server };
        let json = serde_json::to_string(&credentials)
            .map_err(|e| {
                tracing::error!("Keychain: failed to serialize credentials for {}: {}", jid, e);
                format!("Failed to serialize credentials: {}", e)
            })?;

        entry.set_password(&json)
            .map_err(|e| {
                let desc = classify_keyring_error(&e, "save");
                tracing::error!("Keychain: {} for {}", desc, jid);
                desc
            })?;

        // Also store the JID as the "last user" so we know which account to load
        let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user")
            .map_err(|e| {
                tracing::error!("Keychain: failed to create last_user entry: {}", e);
                format!("Failed to create last_user entry: {}", e)
            })?;
        last_user_entry.set_password(&credentials.jid)
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
        let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user")
            .map_err(|e| {
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
        let entry = Entry::new(KEYRING_SERVICE, &jid)
            .map_err(|e| {
                tracing::error!("Keychain: failed to create entry for {}: {}", jid, e);
                format!("Failed to create keyring entry: {}", e)
            })?;

        match entry.get_password() {
            Ok(json) => {
                let credentials: StoredCredentials = serde_json::from_str(&json)
                    .map_err(|e| {
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
        let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user")
            .map_err(|e| {
                tracing::error!("Keychain: failed to create last_user entry: {}", e);
                format!("Failed to create last_user entry: {}", e)
            })?;

        if let Ok(jid) = last_user_entry.get_password() {
            // Delete the credentials entry
            let entry = Entry::new(KEYRING_SERVICE, &jid)
                .map_err(|e| {
                    tracing::error!("Keychain: failed to create entry for {}: {}", jid, e);
                    format!("Failed to create keyring entry: {}", e)
                })?;
            match entry.delete_credential() {
                Ok(()) => tracing::info!("Keychain: deleted credentials for {}", jid),
                Err(keyring::Error::NoEntry) => tracing::debug!("Keychain: no credentials to delete for {}", jid),
                Err(e) => {
                    let desc = classify_keyring_error(&e, &format!("delete credentials for {}", jid));
                    tracing::warn!("Keychain: {}", desc);
                }
            }
        } else {
            tracing::debug!("Keychain: no last_user entry to look up for deletion");
        }

        // Delete the last_user entry
        match last_user_entry.delete_credential() {
            Ok(()) => tracing::debug!("Keychain: deleted last_user entry"),
            Err(keyring::Error::NoEntry) => tracing::debug!("Keychain: no last_user entry to delete"),
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

/// Start XMPP WebSocket-to-TCP proxy.
/// The `server` parameter supports: `tls://host:port`, `tcp://host:port`, `host:port`, or bare `domain`.
#[tauri::command]
async fn start_xmpp_proxy(app: tauri::AppHandle, server: String) -> Result<xmpp_proxy::ProxyStartResult, String> {
    xmpp_proxy::start_proxy(server, Some(app)).await
}

/// Stop XMPP WebSocket-to-TCP proxy
#[tauri::command]
async fn stop_xmpp_proxy() -> Result<(), String> {
    xmpp_proxy::stop_proxy().await
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

/// Fetch URL and extract Open Graph metadata for link previews
#[tauri::command]
fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
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
    let response = client
        .get(&url)
        .send()
        .map_err(|e| {
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

    let html = response
        .text()
        .map_err(|e| {
            tracing::warn!(url = %url, "Link preview: failed to read response body: {}", e);
            format!("Failed to read response: {}", e)
        })?;

    // Parse HTML and extract OG metadata
    let document = Html::parse_document(&html);

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
        url: url.clone(),
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

    // Only return success if we got at least a title
    if metadata.title.is_some() {
        Ok(metadata)
    } else {
        tracing::debug!(url = %url, "Link preview: no title found in page metadata");
        Err("Could not extract metadata from URL".to_string())
    }
}

/// Check if window is visible on any monitor, reset to center if off-screen
fn ensure_window_visible(window: &tauri::WebviewWindow) {
    use tauri::PhysicalPosition;

    let Ok(position) = window.outer_position() else { return };
    let Ok(size) = window.outer_size() else { return };
    let Ok(monitors) = window.available_monitors() else { return };

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
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};
    use std::sync::atomic::{AtomicU64, Ordering};
    use block2::RcBlock;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName, NSProcessInfo, NSString};
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSActivityOptions;
    use tauri::WebviewWindow;

    // Store the window reference for the observer callback
    static WINDOW: std::sync::OnceLock<Arc<Mutex<Option<WebviewWindow>>>> = std::sync::OnceLock::new();

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
        use tauri::Emitter;
        use std::time::{SystemTime, UNIX_EPOCH};

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
        use tauri::Emitter;
        use std::time::{SystemTime, UNIX_EPOCH};

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

                    // Also emit immediately - if app is in foreground, JS will handle it
                    // and the pending wake will be cleared when activation fires
                    let _ = wake_handle.emit("system-did-wake", ());
                }),
            );
        }
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

/// Print startup diagnostics to stderr for debugging.
fn print_startup_diagnostics() {
    eprintln!("Fluux Messenger v{} (build {})", env!("CARGO_PKG_VERSION"), env!("GIT_HASH"));
    eprintln!("Platform: {} / {}", std::env::consts::OS, std::env::consts::ARCH);

    #[cfg(target_os = "linux")]
    {
        let gpu_enabled = std::env::var("FLUUX_ENABLE_GPU").is_ok();
        let dmabuf_disabled = std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .map(|v| v == "1")
            .unwrap_or(false);
        let compositing_disabled = std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE")
            .map(|v| v == "1")
            .unwrap_or(false);

        eprintln!("WebKitGTK GPU workarounds:");
        eprintln!(
            "  FLUUX_ENABLE_GPU: {}",
            if gpu_enabled {
                "set (GPU workarounds disabled)"
            } else {
                "not set"
            }
        );
        eprintln!("  WEBKIT_DISABLE_DMABUF_RENDERER: {}", dmabuf_disabled);
        eprintln!("  WEBKIT_DISABLE_COMPOSITING_MODE: {}", compositing_disabled);
    }

    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("GPU workarounds: N/A (not Linux)");
    }

    eprintln!("---");
}

fn main() {
    // Parse CLI flags early, before tracing subscriber init
    let args: Vec<String> = std::env::args().collect();
    let clear_storage = args.iter().any(|arg| arg == "--clear-storage" || arg == "-c");
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
    let log_file_path = args.iter().find_map(|arg| {
        arg.strip_prefix("--log-file=").map(|s| s.to_string())
    });

    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        eprintln!("Fluux Messenger v{}", env!("CARGO_PKG_VERSION"));
        eprintln!();
        eprintln!("Usage: fluux-messenger [OPTIONS]");
        eprintln!();
        eprintln!("Options:");
        eprintln!("  -v, --verbose         Enable verbose logging to stderr (no XMPP traffic)");
        eprintln!("      --verbose=xmpp    Enable verbose logging including XMPP packet content");
        eprintln!("      --log-file=PATH   Override log file directory (default: platform log dir)");
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
        eprintln!("  FLUUX_ENABLE_GPU      Disable WebKitGTK GPU workarounds (Linux)");
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
        let base = dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."));
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
            eprintln!("Warning: could not create log directory '{}': {}", log_dir.display(), e);
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
        let stderr_layer = if verbose || log_file_path.is_some() || std::env::var("RUST_LOG").is_ok() {
            let effective_level = verbose_level.or(if log_file_path.is_some() { Some("default") } else { None });

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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_idle_time,
            save_credentials,
            get_credentials,
            delete_credentials,
            exit_app,
            fetch_url_metadata,
            start_xmpp_proxy,
            stop_xmpp_proxy,
            log_to_terminal
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
                        function forward(level, args) {
                            try {
                                var msg = Array.prototype.slice.call(args).map(function(a) {
                                    return typeof a === 'string' ? a : JSON.stringify(a);
                                }).join(' ');
                                window.__TAURI_INTERNALS__.invoke('log_to_terminal', { level: level, message: msg });
                            } catch(e) {}
                        }
                        console.log = function() { origLog.apply(console, arguments); forward('info', arguments); };
                        console.info = function() { origInfo.apply(console, arguments); forward('info', arguments); };
                        console.warn = function() { origWarn.apply(console, arguments); forward('warn', arguments); };
                        console.error = function() { origError.apply(console, arguments); forward('error', arguments); };
                        console.debug = function() { origDebug.apply(console, arguments); forward('debug', arguments); };
                        window.addEventListener('error', function(e) {
                            if (e.target !== window && e.target.tagName) {
                                var src = e.target.src || e.target.href || '(unknown)';
                                forward('error', ['Failed to load resource: ' + e.target.tagName.toLowerCase() + ' ' + src]);
                            }
                        }, true);
                    })();
                "#);
            }
        })
        .setup(move |app| {
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
            }

            // macOS: Hide window instead of quitting when close button is clicked
            // (standard macOS behavior - app stays in dock)
            #[cfg(target_os = "macos")]
            {
                // Disable App Nap to keep XMPP connection alive when minimized
                macos::disable_app_nap();

                let main_window = app.get_webview_window("main").unwrap();
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
                        let log_dir_for_tray = log_dir.clone();
                        move |app, event| match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                            "show_logs" => {
                                let _ = app.opener().reveal_item_in_dir(&log_dir_for_tray);
                            }
                            "quit" => {
                                // Stop the keepalive thread
                                keepalive_flag.store(false, Ordering::Relaxed);
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
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;

                // Hide to tray when close button is clicked
                let main_window = app.get_webview_window("main").unwrap();
                let window = main_window.clone();
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        // Save window state before hiding
                        let _ = app_handle.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN);
                        let _ = window.hide();
                    }
                });
            }

            // Start XMPP keepalive timer (30 seconds)
            // This runs in Rust and is immune to WKWebView JS timer throttling
            // which can suspend timers when the app is on another virtual desktop.
            // Uses an AtomicBool flag to stop cleanly on app exit (prevents 100% CPU).
            if let Some(window) = app.get_webview_window("main") {
                let running = keepalive_flag_for_setup.clone();
                std::thread::spawn(move || {
                    while running.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_secs(30));
                        if !running.load(Ordering::Relaxed) {
                            break;
                        }
                        let _ = window.emit("xmpp-keepalive", ());
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
            // Stop the keepalive thread to prevent 100% CPU on exit
            keepalive_flag_for_run.store(false, Ordering::Relaxed);
            // Save window state including position (macOS and Windows only)
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                let _ = _app_handle.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN);
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

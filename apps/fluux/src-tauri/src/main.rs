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

use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri::{RunEvent, WindowEvent};
#[cfg(target_os = "windows")]
use tauri::WindowEvent;
#[cfg(target_os = "macos")]
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
use tauri_plugin_deep_link::DeepLinkExt;
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use scraper::{Html, Selector};

#[cfg(target_os = "macos")]
mod idle {
    use std::process::Command;

    /// Get system idle time using IOKit via ioreg command
    pub fn get_idle_seconds() -> Result<u64, String> {
        let output = Command::new("ioreg")
            .args(["-c", "IOHIDSystem"])
            .output()
            .map_err(|e| format!("Failed to run ioreg: {}", e))?;

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

        Err("HIDIdleTime not found".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod idle {
    use user_idle::UserIdle;

    pub fn get_idle_seconds() -> Result<u64, String> {
        UserIdle::get_time()
            .map(|idle| idle.as_seconds())
            .map_err(|e| e.to_string())
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

/// Save credentials to OS keychain
#[tauri::command]
fn save_credentials(jid: String, password: String, server: Option<String>) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &jid)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    let credentials = StoredCredentials { jid: jid.clone(), password, server };
    let json = serde_json::to_string(&credentials)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

    entry.set_password(&json)
        .map_err(|e| format!("Failed to save to keychain: {}", e))?;

    // Also store the JID as the "last user" so we know which account to load
    let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user")
        .map_err(|e| format!("Failed to create last_user entry: {}", e))?;
    last_user_entry.set_password(&credentials.jid)
        .map_err(|e| format!("Failed to save last_user: {}", e))?;

    Ok(())
}

/// Get credentials from OS keychain
#[tauri::command]
fn get_credentials() -> Result<Option<StoredCredentials>, String> {
    // First get the last used JID
    let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user")
        .map_err(|e| format!("Failed to create last_user entry: {}", e))?;

    let jid = match last_user_entry.get_password() {
        Ok(jid) => jid,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(format!("Failed to get last_user: {}", e)),
    };

    // Now get the credentials for that JID
    let entry = Entry::new(KEYRING_SERVICE, &jid)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    match entry.get_password() {
        Ok(json) => {
            let credentials: StoredCredentials = serde_json::from_str(&json)
                .map_err(|e| format!("Failed to parse credentials: {}", e))?;
            Ok(Some(credentials))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to get credentials: {}", e)),
    }
}

/// Delete credentials from OS keychain
#[tauri::command]
fn delete_credentials() -> Result<(), String> {
    // Get the last used JID
    let last_user_entry = Entry::new(KEYRING_SERVICE, "last_user")
        .map_err(|e| format!("Failed to create last_user entry: {}", e))?;

    if let Ok(jid) = last_user_entry.get_password() {
        // Delete the credentials entry
        let entry = Entry::new(KEYRING_SERVICE, &jid)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
        let _ = entry.delete_credential(); // Ignore error if not found
    }

    // Delete the last_user entry
    let _ = last_user_entry.delete_credential(); // Ignore error if not found

    Ok(())
}

/// Exit the app (called by frontend after graceful disconnect)
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
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
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Fetch the URL
    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    // Check content type - only process HTML
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !content_type.contains("text/html") {
        return Err("URL does not return HTML content".to_string());
    }

    let html = response
        .text()
        .map_err(|e| format!("Failed to read response: {}", e))?;

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

fn main() {
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
            fetch_url_metadata
        ])
        .setup(|app| {
            // Register xmpp: URI scheme for deep linking (RFC 5122)
            // This allows the app to open when users click xmpp: links
            #[cfg(desktop)]
            {
                let _ = app.deep_link().register("xmpp");
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

                // Help menu with GitHub link
                let github_item = MenuItem::with_id(app, "github", "Fluux Messenger on GitHub", true, None::<&str>)?;
                let report_issue_item = MenuItem::with_id(app, "report_issue", "Report an Issue...", true, None::<&str>)?;

                let help_menu = SubmenuBuilder::new(app, "Help")
                    .item(&github_item)
                    .item(&report_issue_item)
                    .build()?;

                // Build and set the menu
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                    .build()?;

                app.set_menu(menu)?;

                // Handle Help menu events
                app.on_menu_event(move |app_handle, event| {
                    match event.id().as_ref() {
                        "github" => {
                            let _ = app_handle.opener().open_url("https://github.com/processone/fluux-messenger", None::<&str>);
                        }
                        "report_issue" => {
                            let _ = app_handle.opener().open_url("https://github.com/processone/fluux-messenger/issues/new", None::<&str>);
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
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

                // Build the system tray icon
                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .tooltip("Fluux Messenger")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
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
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                });
            }

            // Start XMPP keepalive timer (30 seconds)
            // This runs in Rust and is immune to WKWebView JS timer throttling
            // which can suspend timers when the app is on another virtual desktop
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(30));
                        let _ = window.emit("xmpp-keepalive", ());
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        #[cfg(target_os = "macos")]
        match &_event {
            // Handle clicking dock icon to show window again
            RunEvent::Reopen { .. } => {
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            // Handle Command-Q or app termination: request graceful shutdown
            RunEvent::ExitRequested { api, .. } => {
                // Save window state including position
                let _ = _app_handle.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN);
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
            _ => {}
        }
    });
}

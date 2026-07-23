//! Windows WinRT notifications with in-process activation routing.
//!
//! Local Fluux notifications are produced while the process is alive. The
//! callback therefore covers visible, minimized, and hidden-to-tray states
//! without requiring a Windows App SDK runtime or COM cold-start activator.

use crate::notifications::backend::NativeNotification;
use std::path::Path;
use tauri::AppHandle;
use tauri_winrt_notification::{IconCrop, Toast};

pub fn setup(_app: &AppHandle) {}

pub fn post(n: NativeNotification) -> Result<(), String> {
    let identifier = super::APP_HANDLE
        .get()
        .map(|app| app.config().identifier.clone())
        .unwrap_or_else(|| "com.processone.fluux".to_string());
    let target = n.target;
    let mut toast = Toast::new(&identifier)
        .title(&n.title)
        .text1(&n.body)
        .on_activated(move |_arguments| {
            super::activate_target(target.clone());
            Ok(())
        });

    if let Some(path) = n.avatar_path.as_deref() {
        toast = toast.icon(Path::new(path), IconCrop::Circular, "");
    }

    toast.show().map_err(|e| e.to_string())
}

pub fn dismiss(
    _nav_type: &str,
    _nav_target: &str,
    _account_id: Option<&str>,
) -> Result<(), String> {
    // The inbox WinRT wrapper used here does not expose toast tags/history.
    // Routing is reliable; selective Action Center removal remains best-effort
    // and is intentionally a no-op rather than deleting unrelated toasts.
    Ok(())
}

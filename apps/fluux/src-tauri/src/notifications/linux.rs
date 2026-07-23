//! Linux notifications with freedesktop.org default-action routing.
//!
//! The Tauri notification plugin can display a banner but drops the returned
//! notification handle, so it cannot observe `ActionInvoked`. Keeping the
//! `notify-rust` handle alive in a worker lets a click reach the shared routing
//! dispatcher while Fluux is running (including hidden-to-tray).

use crate::notifications::backend::{NativeNotification, NavTarget};
use notify_rust::{Hint, Notification};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

/// Notification IDs grouped by account/conversation for read dismissal.
static DELIVERED_IDS: OnceLock<Mutex<HashMap<String, Vec<u32>>>> = OnceLock::new();

fn delivered_ids() -> &'static Mutex<HashMap<String, Vec<u32>>> {
    DELIVERED_IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn setup(_app: &AppHandle) {}

pub fn post(n: NativeNotification) -> Result<(), String> {
    let mut notification = Notification::new();
    notification
        .appname("Fluux Messenger")
        .summary(&n.title)
        .body(&n.body)
        // Per the Desktop Notifications specification, `default` represents
        // clicking the notification body rather than a labelled action button.
        .action("default", "")
        .hint(Hint::DesktopEntry("com.processone.fluux".to_string()))
        .icon("com.processone.fluux");

    if let Some(path) = n.avatar_path.as_deref() {
        notification.hint(Hint::ImagePath(path.to_string()));
    }

    let handle = notification.show().map_err(|e| e.to_string())?;
    let id = handle.id();
    let group_key = n.target.group_key();
    delivered_ids()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(group_key.clone())
        .or_default()
        .push(id);

    // wait_for_action is blocking and owns the D-Bus connection/handle. A
    // short-lived worker per delivered notification is required so actions
    // remain observable on notification servers that tie signals to the
    // sender's connection. Its lifetime follows the OS notification: compliant
    // daemons emit NotificationClosed on expiry, dismissal, or user action.
    std::thread::spawn(move || {
        let target = n.target;
        handle.wait_for_action(|action| {
            if action == "default" {
                super::activate_target(target);
            }
        });
        remove_id(&group_key, id);
    });

    Ok(())
}

fn remove_id(group_key: &str, id: u32) {
    let mut delivered = delivered_ids().lock().unwrap_or_else(|e| e.into_inner());
    let remove_group = if let Some(ids) = delivered.get_mut(group_key) {
        ids.retain(|candidate| *candidate != id);
        ids.is_empty()
    } else {
        false
    };
    if remove_group {
        delivered.remove(group_key);
    }
}

pub fn dismiss(nav_type: &str, nav_target: &str, account_id: Option<&str>) -> Result<(), String> {
    let group_key = NavTarget {
        nav_type: nav_type.to_string(),
        nav_target: nav_target.to_string(),
        message_id: None,
        account_id: account_id.map(str::to_string),
    }
    .group_key();
    let ids = delivered_ids()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&group_key)
        .unwrap_or_default();

    if ids.is_empty() {
        return Ok(());
    }

    // A second session-bus connection may close notifications whose original
    // handles are owned by the action-listener workers.
    let connection = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let proxy = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
    )
    .map_err(|e| e.to_string())?;
    for id in ids {
        let result: zbus::Result<()> = proxy.call("CloseNotification", &(id,));
        if let Err(error) = result {
            tracing::warn!(notification_id = id, %error, "could not close Linux notification");
        }
    }
    Ok(())
}

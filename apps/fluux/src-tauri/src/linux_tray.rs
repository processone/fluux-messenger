//! Linux system-tray functionality detection.
//!
//! Close-to-tray is only safe when a tray will actually display the icon. On
//! Linux that is not guaranteed: `TrayIconBuilder::build` often succeeds even
//! when nothing renders the icon (e.g. GNOME without an AppIndicator /
//! KStatusNotifierItem extension). Hiding the window then strands the app with
//! no way to restore it.
//!
//! [`should_hide_to_tray`] is the pure, platform-agnostic, unit-tested
//! decision; [`status_notifier_host_registered`] is the Linux-only DBus I/O
//! boundary, verified manually on Linux.

/// Returns `true` only when the tray was built AND a StatusNotifier host is
/// registered — i.e. an icon will actually be displayed and can restore the
/// window. Any other combination means hiding to tray would strand the app.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn should_hide_to_tray(keep_in_tray: bool, tray_built: bool, host_registered: bool) -> bool {
    keep_in_tray && tray_built && host_registered
}

/// Probes whether a StatusNotifier host is registered on the session bus.
///
/// Reads `IsStatusNotifierHostRegistered` on `org.kde.StatusNotifierWatcher`
/// (the freedesktop SNI standard — used by KDE, the GNOME AppIndicator
/// extension, XFCE, and the libappindicator backend Tauri itself uses). Returns
/// `false` on ANY error — absent service, missing property, connection failure,
/// or timeout — so a broken/absent tray is always treated as non-functional
/// (conservative: prefer quitting over stranding the window).
///
/// The DBus call runs on a worker thread bounded by a 1s wait, so a hung
/// session bus can never freeze the window close handler. A timeout returns
/// `false`; the detached worker is harmless if it outlives the wait.
#[cfg(target_os = "linux")]
pub fn status_notifier_host_registered() -> bool {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(query_host_registered());
    });
    rx.recv_timeout(Duration::from_secs(1)).unwrap_or(false)
}

// Proxy construction succeeds even when the watcher service is absent (it does
// not activate the name), so the "no host" case usually surfaces as an error
// from `get_property`, not from `Proxy::new`. Both paths map to `false`.
#[cfg(target_os = "linux")]
fn query_host_registered() -> bool {
    let Ok(conn) = zbus::blocking::Connection::session() else {
        return false;
    };
    let Ok(proxy) = zbus::blocking::Proxy::new(
        &conn,
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher",
    ) else {
        return false;
    };
    proxy
        .get_property::<bool>("IsStatusNotifierHostRegistered")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_to_tray_requires_built_and_host() {
        assert!(should_hide_to_tray(true, true, true));
        assert!(!should_hide_to_tray(false, true, true));
        assert!(!should_hide_to_tray(true, true, false));
        assert!(!should_hide_to_tray(true, false, true));
        assert!(!should_hide_to_tray(true, false, false));
    }
}

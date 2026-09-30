//! Linux system-tray functionality detection.
//!
//! Close-to-tray is only safe when a tray will actually display the icon. On
//! Linux that is not guaranteed: `TrayIconBuilder::build` often succeeds even
//! when nothing renders the icon (e.g. GNOME without an AppIndicator /
//! KStatusNotifierItem extension). Hiding the window then strands the app with
//! no way to restore it.
//!
//! AppIndicator automatically falls back to GtkStatusIcon/XEmbed on X11 when
//! no StatusNotifierWatcher owns the bus name. Both host types must therefore
//! be considered; a watcher that accepts registration but has no host suppresses
//! that fallback and must still be treated as unavailable.

/// Hide only when tray mode is enabled and a built icon has a supported host.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn should_hide_to_tray(keep_in_tray: bool, tray_built: bool, host_registered: bool) -> bool {
    keep_in_tray && tray_built && host_registered
}

/// The actual GTK window backend determines whether GtkStatusIcon can use
/// XEmbed. A Wayland session may also set DISPLAY for unrelated XWayland apps.
#[cfg(target_os = "linux")]
pub struct TrayHostProbe {
    x11: bool,
}

#[cfg(target_os = "linux")]
impl TrayHostProbe {
    pub fn new(x11: bool) -> Self {
        Self { x11 }
    }

    /// Bound DBus and X11 I/O by a one-second wait in the window close handler.
    /// Errors and timeouts fail closed so an inaccessible icon cannot strand
    /// the window. The worker owns its connections if it outlives the wait.
    pub fn registered(&self) -> bool {
        use std::sync::mpsc;
        use std::time::Duration;

        let x11 = self.x11;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let registered = select_host(query_status_notifier_host().map_err(|_| ()), || {
                x11 && xembed_host_registered()
            });
            let _ = tx.send(registered);
        });
        rx.recv_timeout(Duration::from_secs(1)).unwrap_or(false)
    }
}

#[cfg(any(target_os = "linux", test))]
fn select_host(sni: Result<Option<bool>, ()>, xembed: impl FnOnce() -> bool) -> bool {
    match sni {
        Ok(Some(registered)) => registered,
        Ok(None) => xembed(),
        Err(()) => false,
    }
}

/// `None` means the watcher is absent, not that a present watcher has no host.
#[cfg(target_os = "linux")]
fn query_status_notifier_host() -> zbus::Result<Option<bool>> {
    let conn = zbus::blocking::Connection::session()?;
    let bus = zbus::blocking::fdo::DBusProxy::new(&conn)?;
    let watcher = "org.kde.StatusNotifierWatcher";
    if !bus.name_has_owner(watcher.try_into()?)? {
        return Ok(None);
    }
    let proxy = zbus::blocking::Proxy::new(&conn, watcher, "/StatusNotifierWatcher", watcher)?;
    proxy
        .get_property::<bool>("IsStatusNotifierHostRegistered")
        .map(Some)
}

/// The freedesktop System Tray protocol assigns one selection owner per screen.
/// AppIndicator's GtkStatusIcon fallback docks with this owner automatically.
#[cfg(target_os = "linux")]
fn xembed_host_registered() -> bool {
    use std::ffi::CString;
    use x11::xlib;

    // This connection is confined to the probe worker; GTK's connection is
    // never used off the main thread.
    unsafe {
        let display = xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return false;
        }
        let screen = xlib::XDefaultScreen(display);
        let selection = CString::new(format!("_NET_SYSTEM_TRAY_S{screen}"))
            .expect("numeric screen index cannot contain NUL");
        let atom = xlib::XInternAtom(display, selection.as_ptr(), xlib::True);
        let registered = atom != 0 && xlib::XGetSelectionOwner(display, atom) != 0;
        xlib::XCloseDisplay(display);
        registered
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_to_tray_requires_built_and_host() {
        for enabled in [false, true] {
            for built in [false, true] {
                for host in [false, true] {
                    assert_eq!(
                        should_hide_to_tray(enabled, built, host),
                        enabled && built && host
                    );
                }
            }
        }
    }

    #[test]
    fn xembed_fallback_keeps_running_without_sni_watcher() {
        let host = select_host(Ok(None), || true);
        assert!(should_hide_to_tray(true, true, host));
        assert!(!should_hide_to_tray(false, true, host));
        assert!(!should_hide_to_tray(true, false, host));
    }

    #[test]
    fn missing_tray_preserves_quit_on_close() {
        assert!(!select_host(Ok(None), || false));
    }

    #[test]
    fn present_watcher_controls_availability_without_xembed_fallback() {
        for registered in [false, true] {
            assert_eq!(
                select_host(Ok(Some(registered)), || panic!("SNI suppresses XEmbed")),
                registered
            );
        }
    }

    #[test]
    fn probe_errors_cannot_claim_a_working_tray() {
        assert!(!select_host(Err(()), || panic!(
            "unknown SNI state is not an absent watcher"
        )));
    }
}

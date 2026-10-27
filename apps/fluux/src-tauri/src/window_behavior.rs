//! Cross-platform policy for choosing between native window behavior and the
//! system tray. Kept pure so Windows decisions are tested by Linux CI too.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_window_state::StateFlags;

/// What the window-state plugin saves on exit and restores when the window is
/// created.
///
/// Decorations stay out. The window's frame is decided by the build
/// (`tauri.windows.conf.json` removes it on Windows), and a state file written
/// by a build that still had one would otherwise put the native title bar back
/// on every launch.
pub fn persisted_window_state() -> StateFlags {
    StateFlags::all().difference(StateFlags::DECORATIONS)
}

/// Smallest and default window size in logical pixels; they match `minWidth`,
/// `minHeight`, `width` and `height` in `tauri.conf.json`.
pub const MIN_WINDOW_SIZE: (f64, f64) = (360.0, 600.0);
pub const DEFAULT_WINDOW_SIZE: (f64, f64) = (1000.0, 700.0);

/// A saved size below the window's own minimum can only come from a window that
/// was minimized or hidden when its state was saved (#1820). Restoring it leaves
/// a sliver the user cannot recover from.
pub fn saved_size_is_unusable(width: f64, height: f64) -> bool {
    width < MIN_WINDOW_SIZE.0 || height < MIN_WINDOW_SIZE.1
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    HideToTray,
    Quit,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn close_action(keep_in_tray: bool, tray_available: bool) -> CloseAction {
    if keep_in_tray && tray_available {
        CloseAction::HideToTray
    } else {
        CloseAction::Quit
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn should_hide_on_minimize(
    keep_in_tray: bool,
    tray_available: bool,
    is_minimized: bool,
    already_hidden: bool,
) -> bool {
    keep_in_tray && tray_available && is_minimized && !already_hidden
}

pub struct WindowBehavior {
    keep_in_tray: AtomicBool,
}

impl WindowBehavior {
    #[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
    pub fn keep_in_tray(&self) -> bool {
        self.keep_in_tray.load(Ordering::Relaxed)
    }

    #[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
    pub fn set_keep_in_tray(&self, enabled: bool) {
        self.keep_in_tray.store(enabled, Ordering::Relaxed);
    }
}

impl Default for WindowBehavior {
    fn default() -> Self {
        Self {
            keep_in_tray: AtomicBool::new(true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_window_state_never_restores_decorations() {
        let flags = persisted_window_state();
        assert!(!flags.contains(StateFlags::DECORATIONS));
        for flag in [
            StateFlags::SIZE,
            StateFlags::POSITION,
            StateFlags::MAXIMIZED,
            StateFlags::VISIBLE,
            StateFlags::FULLSCREEN,
        ] {
            assert!(flags.contains(flag), "{flag:?} must still be persisted");
        }
    }

    #[test]
    fn close_hides_only_with_enabled_available_tray() {
        assert_eq!(close_action(true, true), CloseAction::HideToTray);
        assert_eq!(close_action(false, true), CloseAction::Quit);
        assert_eq!(close_action(true, false), CloseAction::Quit);
        assert_eq!(close_action(false, false), CloseAction::Quit);
    }

    #[test]
    fn minimize_hides_only_in_enabled_available_tray_mode() {
        assert!(should_hide_on_minimize(true, true, true, false));
        assert!(!should_hide_on_minimize(false, true, true, false));
        assert!(!should_hide_on_minimize(true, false, true, false));
        assert!(!should_hide_on_minimize(true, true, false, false));
        assert!(!should_hide_on_minimize(true, true, true, true));
    }

    #[test]
    fn saved_size_below_the_window_minimum_is_unusable() {
        // 144 x 19 is the sliver reported in #1820.
        assert!(saved_size_is_unusable(144.0, 19.0));
        assert!(saved_size_is_unusable(1000.0, 599.0));
        assert!(saved_size_is_unusable(359.0, 700.0));
        assert!(!saved_size_is_unusable(360.0, 600.0));
        assert!(!saved_size_is_unusable(
            DEFAULT_WINDOW_SIZE.0,
            DEFAULT_WINDOW_SIZE.1
        ));
    }

    #[test]
    fn native_state_defaults_enabled_and_round_trips() {
        let state = WindowBehavior::default();
        assert!(state.keep_in_tray());
        state.set_keep_in_tray(false);
        assert!(!state.keep_in_tray());
    }
}

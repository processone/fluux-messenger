//! Cross-platform policy for choosing between native window behavior and the
//! system tray. Kept pure so Windows decisions are tested by Linux CI too.

use std::sync::atomic::{AtomicBool, Ordering};

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
    fn native_state_defaults_enabled_and_round_trips() {
        let state = WindowBehavior::default();
        assert!(state.keep_in_tray());
        state.set_keep_in_tray(false);
        assert!(!state.keep_in_tray());
    }
}

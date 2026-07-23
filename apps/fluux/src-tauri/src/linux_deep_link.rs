//! Linux deep-link registration policy.
//!
//! Installed packages already export a canonical desktop entry advertising
//! `x-scheme-handler/xmpp`. Registering again at application startup would
//! create a second user-local desktop entry and run `xdg-mime default`, which
//! can silently replace another XMPP client's user-selected association.
//!
//! Runtime registration remains useful for development and portable builds
//! (including AppImages), where no package manager installed a desktop entry.

#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
const DESKTOP_ENTRY_NAMES: [&str; 2] = ["fluux-messenger.desktop", "com.processone.fluux.desktop"];
const XMPP_SCHEME_HANDLER: &str = "x-scheme-handler/xmpp";

/// Pure decision boundary for runtime deep-link registration.
///
/// Debug and AppImage builds must register so links target the current
/// executable. Flatpak and package-managed installs rely on their exported
/// desktop entry. An otherwise unintegrated release binary is treated as a
/// portable build and self-registers.
pub fn should_register_at_runtime(
    debug_build: bool,
    appimage: bool,
    flatpak: bool,
    packaged_desktop_entry: bool,
) -> bool {
    debug_build || appimage || (!flatpak && !packaged_desktop_entry)
}

/// Returns whether this Linux process should create/update a user-local
/// deep-link handler.
#[cfg(target_os = "linux")]
pub fn should_register_current_process(appimage: bool) -> bool {
    should_register_at_runtime(
        cfg!(debug_assertions),
        appimage,
        is_flatpak(),
        packaged_desktop_entry_installed(),
    )
}

#[cfg(target_os = "linux")]
fn is_flatpak() -> bool {
    std::env::var_os("FLATPAK_ID").is_some() || Path::new("/.flatpak-info").is_file()
}

#[cfg(target_os = "linux")]
fn packaged_desktop_entry_installed() -> bool {
    application_data_dirs().iter().any(|data_dir| {
        DESKTOP_ENTRY_NAMES.iter().any(|name| {
            let path = data_dir.join("applications").join(name);
            std::fs::read_to_string(path)
                .map(|contents| desktop_entry_supports_xmpp(&contents))
                .unwrap_or(false)
        })
    })
}

#[cfg(target_os = "linux")]
fn application_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(data_home));
    } else if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share"));
    }

    if let Some(data_dirs) = std::env::var_os("XDG_DATA_DIRS") {
        dirs.extend(std::env::split_paths(&data_dirs));
    } else {
        dirs.push(PathBuf::from("/usr/local/share"));
        dirs.push(PathBuf::from("/usr/share"));
    }

    // The Flatpak desktop entry is installed inside /app and exported to the
    // host by Flatpak. Keeping it in the search list also makes detection work
    // in stripped-down test/container environments without FLATPAK_ID.
    dirs.push(PathBuf::from("/app/share"));
    dirs
}

fn desktop_entry_supports_xmpp(contents: &str) -> bool {
    let mut handles_xmpp = false;
    let mut accepts_uri = false;

    for line in contents.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "MimeType" => {
                handles_xmpp = value
                    .split(';')
                    .any(|mime_type| mime_type.trim() == XMPP_SCHEME_HANDLER);
            }
            "Exec" => {
                accepts_uri = value
                    .split_whitespace()
                    .any(|arg| arg == "%u" || arg == "%U");
            }
            _ => {}
        }
    }

    handles_xmpp && accepts_uri
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_appimage_builds_always_register() {
        assert!(should_register_at_runtime(true, false, true, true));
        assert!(should_register_at_runtime(false, true, true, true));
    }

    #[test]
    fn packaged_and_flatpak_builds_do_not_replace_the_user_default() {
        assert!(!should_register_at_runtime(false, false, false, true));
        assert!(!should_register_at_runtime(false, false, true, false));
    }

    #[test]
    fn unintegrated_release_binary_is_treated_as_portable() {
        assert!(should_register_at_runtime(false, false, false, false));
    }

    #[test]
    fn recognizes_xmpp_among_multiple_mime_types() {
        assert!(desktop_entry_supports_xmpp(
            "Exec=fluux-messenger %u\nMimeType=text/plain;x-scheme-handler/xmpp;\n"
        ));
        assert!(!desktop_entry_supports_xmpp(
            "Exec=fluux-messenger %u\nMimeType=x-scheme-handler/mailto;\n"
        ));
    }

    #[test]
    fn rejects_handler_that_cannot_receive_a_uri() {
        assert!(!desktop_entry_supports_xmpp(
            "Exec=fluux-messenger\nMimeType=x-scheme-handler/xmpp;\n"
        ));
    }

    #[test]
    fn ignores_comments_and_similar_keys() {
        assert!(!desktop_entry_supports_xmpp(
            "Exec=fluux-messenger %u\n# MimeType=x-scheme-handler/xmpp;\nX-MimeType=x-scheme-handler/xmpp;\n"
        ));
    }
}

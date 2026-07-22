//! "Open system notification settings" — the OS notification pane shortcut.
//!
//! Uses a native process launch rather than the shell/opener plugins: their
//! default scopes reject custom URL schemes (`x-apple.systempreferences:`,
//! `ms-settings:`), and Linux has no notification-settings URL at all — it
//! needs a control-center invocation.
//!
//! Linux has no single control center, so [`linux_candidates`] turns the
//! desktop-environment hints into an ordered list of commands to try; it is a
//! pure function, unit-tested on every platform. [`open`] is the I/O boundary
//! that reads the environment and spawns.

// The candidate table is compiled everywhere so its tests run on any dev
// machine, but only the Linux build calls it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// A launchable settings command: program plus its arguments.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Candidate {
    pub program: &'static str,
    pub args: &'static [&'static str],
}

const fn candidate(program: &'static str, args: &'static [&'static str]) -> Candidate {
    Candidate { program, args }
}

/// Known desktops, each with the aliases that identify it and the commands
/// that open its notification pane. Order within a desktop matters (Plasma 6
/// ships `systemsettings`, Plasma 5 `systemsettings5`); order of the table is
/// the fallback order used when the desktop is unknown.
const DESKTOPS: &[(&[&str], &[Candidate])] = &[
    (
        &["gnome", "unity"],
        &[candidate("gnome-control-center", &["notifications"])],
    ),
    (
        &["cinnamon"],
        &[candidate("cinnamon-settings", &["notifications"])],
    ),
    (
        &["kde", "plasma"],
        &[
            candidate("systemsettings", &["kcm_notifications"]),
            candidate("systemsettings5", &["kcm_notifications"]),
        ],
    ),
    (&["xfce"], &[candidate("xfce4-notifyd-config", &[])]),
    (
        &["budgie"],
        &[candidate("budgie-control-center", &["notifications"])],
    ),
    (&["lxqt"], &[candidate("lxqt-config-notificationd", &[])]),
];

/// Normalise one desktop token for matching: lowercase, drop the `X-` vendor
/// prefix (`X-Cinnamon`), and reduce a `DESKTOP_SESSION` path to its basename
/// (`/usr/share/xsessions/plasma`).
fn normalize(token: &str) -> String {
    let token = token.rsplit('/').next().unwrap_or(token);
    let lower = token.trim().to_ascii_lowercase();
    lower.strip_prefix("x-").unwrap_or(&lower).to_string()
}

/// True when a normalised token names this desktop. Prefix matching absorbs the
/// session variants (`gnome-xorg`, `plasmawayland`, `budgie-desktop`); no alias
/// is a prefix of another desktop's alias, so this cannot cross-match.
fn matches(token: &str, aliases: &[&str]) -> bool {
    aliases.iter().any(|alias| token.starts_with(alias))
}

/// The ordered commands to try for the given desktop hints.
///
/// `xdg_current_desktop` is the colon-separated, case-insensitive
/// `XDG_CURRENT_DESKTOP` (e.g. `ubuntu:GNOME`); `desktop_session` is the
/// `DESKTOP_SESSION` fallback for the sessions that leave the former unset.
///
/// The matched desktop's commands come first, followed by every other known
/// command: the environment names the desktop but does not promise its binary
/// is installed, so a failed spawn only means "not this one" and trying the
/// rest still beats doing nothing.
///
/// When several tokens name a desktop, the earliest one wins — the desktop
/// entry spec orders `XDG_CURRENT_DESKTOP` most-specific-first, so Budgie's
/// `Budgie:GNOME` must open Budgie's pane, not GNOME's. `DESKTOP_SESSION` is
/// appended last and therefore only breaks ties `XDG_CURRENT_DESKTOP` left open.
pub fn linux_candidates(
    xdg_current_desktop: Option<&str>,
    desktop_session: Option<&str>,
) -> Vec<Candidate> {
    let tokens: Vec<String> = xdg_current_desktop
        .into_iter()
        .flat_map(|value| value.split(':'))
        .chain(desktop_session)
        .map(normalize)
        .filter(|token| !token.is_empty())
        .collect();

    // Rank by the position of the first token naming this desktop; unmatched
    // desktops sort last, keeping the table's order among themselves.
    let mut ranked: Vec<_> = DESKTOPS
        .iter()
        .map(|(aliases, commands)| {
            let rank = tokens
                .iter()
                .position(|token| matches(token, aliases))
                .unwrap_or(usize::MAX);
            (rank, commands)
        })
        .collect();
    ranked.sort_by_key(|(rank, _)| *rank);

    ranked
        .into_iter()
        .flat_map(|(_, commands)| commands.iter().copied())
        .collect()
}

/// Open the OS notification settings. `Err` carries a message for the caller to
/// log; the UI shows its own translated fallback text.
pub fn open() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:notifications"])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "linux")]
    {
        let xdg = std::env::var("XDG_CURRENT_DESKTOP").ok();
        let session = std::env::var("DESKTOP_SESSION").ok();
        let candidates = linux_candidates(xdg.as_deref(), session.as_deref());

        for c in &candidates {
            match std::process::Command::new(c.program).args(c.args).spawn() {
                Ok(_) => return Ok(()),
                // Usually ENOENT — this desktop's control center isn't
                // installed. Keep going; the next candidate may be.
                Err(e) => tracing::debug!(
                    "notification settings: {} unavailable: {}",
                    c.program,
                    e
                ),
            }
        }

        Err(format!(
            "no notification settings command available (tried: {})",
            candidates
                .iter()
                .map(|c| c.program)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("unsupported platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn programs(xdg: Option<&str>, session: Option<&str>) -> Vec<&'static str> {
        linux_candidates(xdg, session)
            .into_iter()
            .map(|c| c.program)
            .collect()
    }

    #[test]
    fn gnome_is_tried_first() {
        assert_eq!(
            programs(Some("GNOME"), None).first(),
            Some(&"gnome-control-center")
        );
    }

    #[test]
    fn vendor_prefixed_and_multi_token_xdg_still_matches() {
        // Ubuntu ships `ubuntu:GNOME`; Cinnamon ships `X-Cinnamon`.
        assert_eq!(
            programs(Some("ubuntu:GNOME"), None).first(),
            Some(&"gnome-control-center")
        );
        assert_eq!(
            programs(Some("X-Cinnamon"), None).first(),
            Some(&"cinnamon-settings")
        );
    }

    #[test]
    fn kde_tries_plasma6_then_plasma5() {
        let kde = programs(Some("KDE"), None);
        assert_eq!(&kde[..2], &["systemsettings", "systemsettings5"]);
    }

    #[test]
    fn each_desktop_leads_with_its_own_command() {
        let cases = [
            ("XFCE", "xfce4-notifyd-config"),
            ("Budgie:GNOME", "budgie-control-center"),
            ("LXQt", "lxqt-config-notificationd"),
            ("Unity", "gnome-control-center"),
        ];
        for (xdg, expected) in cases {
            assert_eq!(
                programs(Some(xdg), None).first(),
                Some(&expected),
                "XDG_CURRENT_DESKTOP={xdg}"
            );
        }
    }

    #[test]
    fn the_most_specific_token_wins() {
        // `XDG_CURRENT_DESKTOP` is ordered most-specific-first, and the
        // GNOME-derived desktops advertise `GNOME` as a later token. Ranking by
        // table order instead of token order sends these to GNOME's pane.
        assert_eq!(
            programs(Some("Budgie:GNOME"), None).first(),
            Some(&"budgie-control-center")
        );
        assert_eq!(
            programs(Some("Unity:Unity7:ubuntu"), None).first(),
            Some(&"gnome-control-center")
        );
    }

    #[test]
    fn session_variants_match_by_prefix() {
        assert_eq!(
            programs(Some("plasmawayland"), None).first(),
            Some(&"systemsettings")
        );
        assert_eq!(
            programs(Some("budgie-desktop"), None).first(),
            Some(&"budgie-control-center")
        );
    }

    #[test]
    fn desktop_session_is_the_fallback_when_xdg_is_unset() {
        assert_eq!(
            programs(None, Some("cinnamon")).first(),
            Some(&"cinnamon-settings")
        );
        // Display managers hand out a full path.
        assert_eq!(
            programs(None, Some("/usr/share/xsessions/plasma")).first(),
            Some(&"systemsettings")
        );
    }

    #[test]
    fn xdg_wins_over_desktop_session() {
        // `DESKTOP_SESSION` is often the generic distro session name while
        // `XDG_CURRENT_DESKTOP` names the actual desktop.
        assert_eq!(
            programs(Some("X-Cinnamon"), Some("lightdm-xsession")).first(),
            Some(&"cinnamon-settings")
        );
    }

    #[test]
    fn unknown_or_absent_desktop_still_offers_every_candidate() {
        for hints in [(None, None), (Some("Enlightenment"), Some("weird-session"))] {
            let all = programs(hints.0, hints.1);
            assert_eq!(all.len(), 7, "hints={hints:?}");
            assert!(all.contains(&"gnome-control-center"), "hints={hints:?}");
            assert!(all.contains(&"lxqt-config-notificationd"), "hints={hints:?}");
        }
    }

    #[test]
    fn matched_desktop_keeps_the_others_as_fallbacks() {
        // The desktop env var doesn't promise the binary is installed, so the
        // remaining commands must still be tried after the matched one.
        let xfce = programs(Some("XFCE"), None);
        assert_eq!(xfce.first(), Some(&"xfce4-notifyd-config"));
        assert_eq!(xfce.len(), 7);
        assert!(xfce[1..].contains(&"gnome-control-center"));
    }

    #[test]
    fn no_alias_is_a_prefix_of_another_desktops_alias() {
        // Guards the prefix matching in `matches`: adding an alias that is a
        // prefix of another desktop's would silently mis-route.
        let aliases: Vec<&str> = DESKTOPS.iter().flat_map(|(a, _)| a.iter().copied()).collect();
        for (i, a) in aliases.iter().enumerate() {
            for (j, b) in aliases.iter().enumerate() {
                assert!(i == j || !b.starts_with(a), "alias {a:?} is a prefix of {b:?}");
            }
        }
    }
}

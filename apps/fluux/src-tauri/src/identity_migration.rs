//! Carries per-user data over from the legacy `com.processone.*` application
//! identifier to the current `net.processone.*` one.
//!
//! Every platform keys the app's directories by its identifier, including the
//! webview's storage (IndexedDB, localStorage), so a renamed app starts empty
//! unless those directories are moved before Tauri creates the webview.
//!
//! macOS keychain consolidation and legacy secret recovery are handled by
//! `macos_secrets`, without re-creating separate items under each identity.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Written in the current app data directory once the directories are migrated.
pub const DIRS_MARKER: &str = ".identity-migrated";
const COPY_MARKER: &str = ".identity-copy-complete";
const CURRENT_PREFIX: &str = "net.processone.";
const LEGACY_PREFIX: &str = "com.processone.";

/// Identifier this app used before the `net.processone` prefix, if any.
pub fn legacy_identifier(current: &str) -> Option<String> {
    current
        .strip_prefix(CURRENT_PREFIX)
        .map(|rest| format!("{LEGACY_PREFIX}{rest}"))
}

/// Parent directories that hold a per-identifier subdirectory on this platform,
/// matching the roots Tauri's path resolver and the system webview use.
pub fn platform_roots() -> Vec<PathBuf> {
    #[allow(unused_mut)]
    let mut roots: Vec<PathBuf> = [
        dirs::data_dir(),
        dirs::data_local_dir(),
        dirs::config_dir(),
        dirs::cache_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();

    #[cfg(target_os = "macos")]
    if let Some(library) = dirs::home_dir().map(|home| home.join("Library")) {
        // WKWebView's default data store, the log directory and URL-session storage.
        roots.extend(["WebKit", "Logs", "HTTPStorages"].map(|dir| library.join(dir)));
    }

    let mut unique = Vec::with_capacity(roots.len());
    for root in roots {
        if !unique.contains(&root) {
            unique.push(root);
        }
    }
    unique
}

/// Directory holding the migration markers: the current app data directory.
pub fn marker_dir(current: &str) -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(current))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DirsReport {
    pub already_done: bool,
    /// Legacy directories moved to their current location.
    pub moved: Vec<PathBuf>,
    /// Pre-existing current directories renamed out of the way, never deleted.
    pub set_aside: Vec<PathBuf>,
    pub errors: Vec<String>,
}

/// One directory to carry over to its current location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transfer {
    pub from: PathBuf,
    pub to: PathBuf,
    /// Copy instead of rename, for a source this process may only read.
    pub copy: bool,
}

/// `<root>/<legacy>` renamed to `<root>/<current>` under every root.
pub fn renames(roots: &[PathBuf], legacy: &str, current: &str) -> Vec<Transfer> {
    roots
        .iter()
        .map(|root| Transfer {
            from: root.join(legacy),
            to: root.join(current),
            copy: false,
        })
        .collect()
}

/// Copies out of the sandbox of the Flatpak published as `legacy`.
///
/// A Flatpak only sees its own `~/.var/app/<app-id>`, so the renamed Flatpak
/// reads the previous one's directory through a read-only `--filesystem`
/// permission and copies the data and config it finds there. The previous
/// Flatpak keeps its copy until the user uninstalls it.
pub fn flatpak_copies(
    home: &Path,
    legacy: &str,
    current: &str,
    data_dir: &Path,
    config_dir: &Path,
) -> Vec<Transfer> {
    let previous = home.join(".var/app").join(legacy);
    [("data", data_dir), ("config", config_dir)]
        .into_iter()
        .map(|(sub, root)| Transfer {
            from: previous.join(sub).join(legacy),
            to: root.join(current),
            copy: true,
        })
        .collect()
}

/// Carries every transfer over, once.
///
/// The marker, not the presence of the current directory, decides whether the
/// migration ran: a current directory can already exist without holding the
/// user's data (a build that briefly used the new identifier, or a launch
/// interrupted mid-migration). Such a directory is renamed to
/// `<name>.pre-migration-<timestamp>` rather than merged or deleted.
///
/// The global marker is written when every transfer succeeded. A copy's own
/// completion marker keeps successful transfers out of subsequent retries.
pub fn migrate_dirs(
    transfers: &[Transfer],
    legacy: &str,
    marker_dir: &Path,
    timestamp: u64,
) -> DirsReport {
    let mut report = DirsReport::default();
    if marker_dir.join(DIRS_MARKER).exists() {
        report.already_done = true;
        return report;
    }

    for transfer in transfers {
        let Transfer { from, to, copy } = transfer;
        if *copy && fs::read_to_string(to.join(COPY_MARKER)).ok().as_deref() == Some(legacy) {
            continue;
        }
        if !from.is_dir() {
            continue;
        }

        let mut aside = None;
        if to.exists() {
            let mut name = to.file_name().unwrap_or_default().to_os_string();
            name.push(format!(".pre-migration-{timestamp}"));
            let target = to.with_file_name(name);
            if let Err(e) = fs::rename(to, &target) {
                report
                    .errors
                    .push(format!("set aside {}: {e}", to.display()));
                continue;
            }
            aside = Some(target);
        }

        let result = if *copy {
            copy_completed_dir(from, to, legacy, timestamp)
        } else {
            fs::rename(from, to)
        };
        match result {
            Ok(()) => {
                report.moved.push(to.clone());
                report.set_aside.extend(aside);
            }
            Err(e) => {
                report
                    .errors
                    .push(format!("transfer {}: {e}", from.display()));
                if let Some(target) = aside {
                    if let Err(e) = fs::rename(&target, to) {
                        report
                            .errors
                            .push(format!("restore {}: {e}", target.display()));
                    }
                }
            }
        }
    }

    if report.errors.is_empty() {
        if let Err(e) = write_marker(marker_dir, DIRS_MARKER, legacy) {
            report.errors.push(format!("write marker: {e}"));
        }
    }
    report
}

/// Publish the copy and its completion marker together so a retry cannot
/// replace data written by the app after an interrupted migration.
fn copy_completed_dir(from: &Path, to: &Path, legacy: &str, timestamp: u64) -> io::Result<()> {
    let mut name = to.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        ".migration-copy-{timestamp}-{}",
        std::process::id()
    ));
    let staged = to.with_file_name(name);
    if let Some(parent) = staged.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(&staged)?;
    let result = (|| {
        copy_dir(from, &staged)?;
        let mut marker = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(staged.join(COPY_MARKER))?;
        marker.write_all(legacy.as_bytes())?;
        marker.sync_all()?;
        drop(marker);
        fs::rename(&staged, to)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staged);
    }
    result
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    let mut entries = fs::read_dir(from)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(entry.path())?, &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Migrates this platform's directories from the legacy identifier, if `current` has one.
pub fn migrate_platform_dirs(current: &str) -> Option<DirsReport> {
    let legacy = legacy_identifier(current)?;
    let marker = marker_dir(current)?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();

    let mut transfers = Vec::new();
    if std::env::var_os("FLATPAK_ID").is_some() {
        if let (Some(home), Some(data), Some(config)) =
            (dirs::home_dir(), dirs::data_dir(), dirs::config_dir())
        {
            transfers.extend(flatpak_copies(&home, &legacy, current, &data, &config));
        }
    }
    transfers.extend(renames(&platform_roots(), &legacy, current));
    Some(migrate_dirs(&transfers, &legacy, &marker, timestamp))
}

pub fn write_marker(dir: &Path, name: &str, contents: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join(name), contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "fluux-identity-migration-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const LEGACY: &str = "com.processone.fluux";
    const CURRENT: &str = "net.processone.fluux";

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn migrate(roots: &[PathBuf], marker: &Path, timestamp: u64) -> DirsReport {
        migrate_dirs(&renames(roots, LEGACY, CURRENT), LEGACY, marker, timestamp)
    }

    #[test]
    fn derives_the_legacy_identifier() {
        assert_eq!(legacy_identifier(CURRENT).as_deref(), Some(LEGACY));
        assert_eq!(
            legacy_identifier("net.processone.fluux.dev").as_deref(),
            Some("com.processone.fluux.dev")
        );
        assert_eq!(legacy_identifier("org.example.app"), None);
    }

    #[test]
    fn moves_every_legacy_directory_and_writes_the_marker() {
        let tmp = TempDir::new();
        let support = tmp.0.join("Application Support");
        let webkit = tmp.0.join("WebKit");
        let caches = tmp.0.join("Caches");
        write(&support.join(LEGACY).join("openpgp/key.tsk.asc"), "tsk");
        write(&webkit.join(LEGACY).join("WebsiteData/IndexedDB/db"), "idb");
        fs::create_dir_all(&caches).unwrap();
        let marker = support.join(CURRENT);

        let report = migrate(
            &[support.clone(), webkit.clone(), caches.clone()],
            &marker,
            7,
        );

        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(
            report.moved,
            vec![support.join(CURRENT), webkit.join(CURRENT)]
        );
        assert_eq!(
            read(&support.join(CURRENT).join("openpgp/key.tsk.asc")),
            "tsk"
        );
        assert_eq!(
            read(&webkit.join(CURRENT).join("WebsiteData/IndexedDB/db")),
            "idb"
        );
        assert!(!support.join(LEGACY).exists());
        assert!(!webkit.join(LEGACY).exists());
        assert!(!caches.join(CURRENT).exists());
        assert_eq!(read(&marker.join(DIRS_MARKER)), LEGACY);
    }

    #[test]
    fn sets_aside_a_current_directory_that_predates_the_migration() {
        let tmp = TempDir::new();
        let root = tmp.0.join("WebKit");
        write(&root.join(LEGACY).join("data"), "user data");
        write(&root.join(CURRENT).join("data"), "stale");
        let marker = tmp.0.join("marker");

        let report = migrate(&[root.clone()], &marker, 42);

        let aside = root.join(format!("{CURRENT}.pre-migration-42"));
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.set_aside, vec![aside.clone()]);
        assert_eq!(read(&root.join(CURRENT).join("data")), "user data");
        assert_eq!(read(&aside.join("data")), "stale");
    }

    #[test]
    fn runs_once() {
        let tmp = TempDir::new();
        let root = tmp.0.join("Caches");
        let marker = tmp.0.join("marker");
        write(&root.join(LEGACY).join("a"), "first");
        migrate(&[root.clone()], &marker, 1);

        // The legacy app was launched again after the upgrade.
        write(&root.join(LEGACY).join("a"), "downgrade");
        let report = migrate(&[root.clone()], &marker, 2);

        assert!(report.already_done);
        assert_eq!(read(&root.join(CURRENT).join("a")), "first");
        assert_eq!(read(&root.join(LEGACY).join("a")), "downgrade");
    }

    #[test]
    fn marks_a_fresh_install_without_moving_anything() {
        let tmp = TempDir::new();
        let root = tmp.0.join("Caches");
        fs::create_dir_all(&root).unwrap();
        let marker = tmp.0.join("marker");

        let report = migrate(&[root], &marker, 1);

        assert_eq!(report.moved, Vec::<PathBuf>::new());
        assert!(marker.join(DIRS_MARKER).exists());
    }

    #[test]
    fn leaves_the_marker_unwritten_when_a_move_fails() {
        let tmp = TempDir::new();
        let root = tmp.0.join("WebKit");
        write(&root.join(LEGACY).join("data"), "user data");
        // An occupied set-aside path makes renaming the current directory fail.
        write(&root.join(CURRENT).join("data"), "stale");
        write(
            &root.join(format!("{CURRENT}.pre-migration-9")).join("x"),
            "occupied",
        );
        let marker = tmp.0.join("marker");

        let report = migrate(&[root.clone()], &marker, 9);

        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(!marker.join(DIRS_MARKER).exists());
        assert_eq!(read(&root.join(LEGACY).join("data")), "user data");
        assert_eq!(read(&root.join(CURRENT).join("data")), "stale");
    }

    #[test]
    fn copies_out_of_the_previous_flatpak_sandbox() {
        let tmp = TempDir::new();
        let home = tmp.0.join("home");
        let previous = home.join(".var/app").join(LEGACY);
        write(
            &previous
                .join("data")
                .join(LEGACY)
                .join("openpgp/key.tsk.asc"),
            "tsk",
        );
        write(
            &previous.join("data").join(LEGACY).join("storage/idb"),
            "idb",
        );
        write(
            &previous
                .join("config")
                .join(LEGACY)
                .join(".window-state.json"),
            "{}",
        );
        let sandbox = home.join(".var/app").join(CURRENT);
        let (data, config) = (sandbox.join("data"), sandbox.join("config"));
        let marker = data.join(CURRENT);

        let transfers = flatpak_copies(&home, LEGACY, CURRENT, &data, &config);
        let report = migrate_dirs(&transfers, LEGACY, &marker, 3);

        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(read(&data.join(CURRENT).join("openpgp/key.tsk.asc")), "tsk");
        assert_eq!(read(&data.join(CURRENT).join("storage/idb")), "idb");
        assert_eq!(read(&config.join(CURRENT).join(".window-state.json")), "{}");
        // Read-only source: the previous Flatpak keeps its data.
        assert_eq!(
            read(&previous.join("data").join(LEGACY).join("storage/idb")),
            "idb"
        );
        assert!(marker.join(DIRS_MARKER).exists());
    }

    #[test]
    fn retries_only_unfinished_flatpak_copies_after_a_partial_migration() {
        let tmp = TempDir::new();
        let data = tmp.0.join("data");
        let config = tmp.0.join("config");
        let marker = data.join(CURRENT);
        let transfers = vec![
            Transfer {
                from: tmp.0.join("old-data"),
                to: marker.clone(),
                copy: true,
            },
            Transfer {
                from: tmp.0.join("old-config"),
                to: config.clone(),
                copy: true,
            },
        ];
        write(&transfers[0].from.join("storage"), "legacy archive");
        write(&transfers[1].from.join("settings"), "legacy settings");
        write(&config.join("settings"), "current settings");
        write(&tmp.0.join("config.pre-migration-1/occupied"), "occupied");

        let first = migrate_dirs(&transfers, LEGACY, &marker, 1);
        assert_eq!(first.errors.len(), 1);
        assert!(!marker.join(DIRS_MARKER).exists());
        write(&marker.join("storage"), "new messages and keys");

        let second = migrate_dirs(&transfers, LEGACY, &marker, 2);
        assert!(second.errors.is_empty(), "{:?}", second.errors);
        assert_eq!(second.moved, vec![config.clone()]);
        assert_eq!(read(&marker.join("storage")), "new messages and keys");
        assert_eq!(read(&config.join("settings")), "legacy settings");
        assert!(marker.join(DIRS_MARKER).exists());
    }

    #[test]
    fn a_failed_copy_marker_keeps_the_current_directory_and_allows_a_retry() {
        let tmp = TempDir::new();
        let from = tmp.0.join("previous");
        let to = tmp.0.join("current");
        let marker = tmp.0.join("marker");
        write(&from.join("data"), "legacy");
        // A directory cannot be replaced by the marker's file write.
        fs::create_dir_all(from.join(COPY_MARKER)).unwrap();
        write(&to.join("data"), "current");
        let transfers = [Transfer {
            from: from.clone(),
            to: to.clone(),
            copy: true,
        }];

        let failed = migrate_dirs(&transfers, LEGACY, &marker, 1);
        assert_eq!(failed.errors.len(), 1);
        assert_eq!(read(&to.join("data")), "current");
        assert!(!marker.join(DIRS_MARKER).exists());
        fs::remove_dir_all(from.join(COPY_MARKER)).unwrap();

        let retried = migrate_dirs(&transfers, LEGACY, &marker, 2);
        assert!(retried.errors.is_empty(), "{:?}", retried.errors);
        assert_eq!(read(&to.join("data")), "legacy");
        assert_eq!(read(&to.join(COPY_MARKER)), LEGACY);
    }

    #[cfg(unix)]
    #[test]
    fn a_legacy_marker_symlink_cannot_overwrite_another_file() {
        let tmp = TempDir::new();
        let from = tmp.0.join("previous");
        let to = tmp.0.join("current");
        let marker = tmp.0.join("marker");
        let unrelated = tmp.0.join("unrelated");
        write(&from.join("data"), "legacy");
        write(&to.join("data"), "current");
        write(&unrelated, "untouched");
        std::os::unix::fs::symlink(&unrelated, from.join(COPY_MARKER)).unwrap();
        let transfers = [Transfer {
            from,
            to: to.clone(),
            copy: true,
        }];

        let report = migrate_dirs(&transfers, LEGACY, &marker, 1);
        assert_eq!(read(&unrelated), "untouched");
        assert_eq!(report.errors.len(), 1);
        assert_eq!(read(&to.join("data")), "current");
        assert!(!marker.join(DIRS_MARKER).exists());
    }

    #[cfg(unix)]
    #[test]
    fn removes_a_partial_copy_and_retries_later() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new();
        let from = tmp.0.join("previous");
        // Entries are copied in name order, so the failure comes after a copied file.
        write(&from.join("a-readable"), "ok");
        write(&from.join("b-unreadable"), "secret");
        fs::set_permissions(from.join("b-unreadable"), fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(from.join("b-unreadable")).is_ok() {
            // Running as root: permissions cannot make the copy fail.
            return;
        }
        let to = tmp.0.join("current");
        write(&to.join("stale"), "stale");
        let marker = tmp.0.join("marker");
        let transfer = Transfer {
            from,
            to: to.clone(),
            copy: true,
        };

        let report = migrate_dirs(&[transfer], LEGACY, &marker, 5);

        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(!marker.join(DIRS_MARKER).exists());
        assert_eq!(read(&to.join("stale")), "stale");
        assert!(!to.join("a-readable").exists());
    }
}

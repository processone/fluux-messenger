//! Carries per-user data over from the legacy `com.processone.*` application
//! identifier to the current `net.processone.*` one.
//!
//! Every platform keys the app's directories by its identifier, including the
//! webview's storage (IndexedDB, localStorage), so a renamed app starts empty
//! unless those directories are moved before Tauri creates the webview.
//!
//! On macOS the login keychain additionally ties each item's access list to
//! the code signature that created it, and that signature embeds the bundle
//! identifier. The renamed app can only read the existing items after the user
//! approves a system prompt; [`reown_secrets`] then re-creates them so they
//! belong to the current signature and the prompt does not come back.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Written in the current app data directory once the directories are migrated.
pub const DIRS_MARKER: &str = ".identity-migrated";
/// Written in the current app data directory once the keychain items are re-owned.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const KEYCHAIN_MARKER: &str = ".keychain-reowned";

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
/// The marker is only written when every transfer succeeded, so a failure is
/// retried on the next launch.
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
        if !from.is_dir() {
            continue;
        }

        let mut aside = None;
        if to.exists() {
            let mut name = to.file_name().unwrap_or_default().to_os_string();
            name.push(format!(".pre-migration-{timestamp}"));
            let target = to.with_file_name(name);
            if let Err(e) = fs::rename(to, &target) {
                report.errors.push(format!("set aside {}: {e}", to.display()));
                continue;
            }
            aside = Some(target);
        }

        let result = if *copy {
            copy_dir(from, to).inspect_err(|_| {
                let _ = fs::remove_dir_all(to);
            })
        } else {
            fs::rename(from, to)
        };
        match result {
            Ok(()) => {
                report.moved.push(to.clone());
                report.set_aside.extend(aside);
            }
            Err(e) => {
                report.errors.push(format!("transfer {}: {e}", from.display()));
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

/// Minimal secret-store surface needed to re-own keychain items. Only macOS
/// binds keychain items to the application, so only macOS re-owns them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub trait SecretStore {
    /// `Ok(None)` when the item does not exist.
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SET_ATTEMPTS: usize = 3;

/// Re-creates each existing item so the current code signature owns it, and
/// returns how many were re-owned.
///
/// The first error stops before the remaining items, leaving them for the next
/// launch. An item is only deleted after it was read, and re-creating it is
/// retried because a failure at that point would lose the secret.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn reown_secrets<S: SecretStore>(store: &S, accounts: &[String]) -> Result<usize, String> {
    let mut reowned = 0;
    for account in accounts {
        let Some(secret) = store.get(account)? else {
            continue;
        };
        store.delete(account)?;
        let mut result = Err(String::new());
        for _ in 0..SET_ATTEMPTS {
            result = store.set(account, &secret);
            if result.is_ok() {
                break;
            }
        }
        result.map_err(|e| format!("re-create {account}: {e}"))?;
        reowned += 1;
    }
    Ok(reowned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
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

        let report = migrate(&[support.clone(), webkit.clone(), caches.clone()], &marker, 7);

        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.moved, vec![support.join(CURRENT), webkit.join(CURRENT)]);
        assert_eq!(read(&support.join(CURRENT).join("openpgp/key.tsk.asc")), "tsk");
        assert_eq!(read(&webkit.join(CURRENT).join("WebsiteData/IndexedDB/db")), "idb");
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
        write(&root.join(format!("{CURRENT}.pre-migration-9")).join("x"), "occupied");
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
        write(&previous.join("data").join(LEGACY).join("openpgp/key.tsk.asc"), "tsk");
        write(&previous.join("data").join(LEGACY).join("storage/idb"), "idb");
        write(&previous.join("config").join(LEGACY).join(".window-state.json"), "{}");
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
        assert_eq!(read(&previous.join("data").join(LEGACY).join("storage/idb")), "idb");
        assert!(marker.join(DIRS_MARKER).exists());
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
        let transfer = Transfer { from, to: to.clone(), copy: true };

        let report = migrate_dirs(&[transfer], LEGACY, &marker, 5);

        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(!marker.join(DIRS_MARKER).exists());
        assert_eq!(read(&to.join("stale")), "stale");
        assert!(!to.join("a-readable").exists());
    }

    #[derive(Default)]
    struct FakeStore {
        items: RefCell<HashMap<String, String>>,
        owned: RefCell<Vec<String>>,
        deny: Option<String>,
        failing_sets: RefCell<usize>,
    }

    impl SecretStore for FakeStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            if self.deny.as_deref() == Some(account) {
                return Err("denied".into());
            }
            Ok(self.items.borrow().get(account).cloned())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.items.borrow_mut().remove(account);
            Ok(())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            let mut failing = self.failing_sets.borrow_mut();
            if *failing > 0 {
                *failing -= 1;
                return Err("busy".into());
            }
            self.items
                .borrow_mut()
                .insert(account.to_string(), secret.to_string());
            self.owned.borrow_mut().push(account.to_string());
            Ok(())
        }
    }

    fn store(items: &[(&str, &str)]) -> FakeStore {
        FakeStore {
            items: RefCell::new(
                items
                    .iter()
                    .map(|(a, s)| (a.to_string(), s.to_string()))
                    .collect(),
            ),
            ..FakeStore::default()
        }
    }

    fn accounts(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn reowns_existing_items_and_skips_missing_ones() {
        let store = store(&[
            ("last_user", "alice@example.com"),
            ("openpgp_passphrase:alice@example.com", "pass"),
        ]);

        let count = reown_secrets(
            &store,
            &accounts(&["last_user", "mcp-token", "openpgp_passphrase:alice@example.com"]),
        )
        .unwrap();

        assert_eq!(count, 2);
        assert_eq!(
            *store.owned.borrow(),
            vec!["last_user", "openpgp_passphrase:alice@example.com"]
        );
        assert_eq!(store.items.borrow()["openpgp_passphrase:alice@example.com"], "pass");
    }

    #[test]
    fn stops_without_deleting_when_access_is_denied() {
        let mut store = store(&[("last_user", "alice@example.com"), ("mcp-token", "token")]);
        store.deny = Some("last_user".into());

        assert!(reown_secrets(&store, &accounts(&["last_user", "mcp-token"])).is_err());
        assert_eq!(store.items.borrow().len(), 2);
        assert!(store.owned.borrow().is_empty());
    }

    #[test]
    fn retries_re_creating_a_deleted_item() {
        let store = store(&[("mcp-token", "token")]);
        *store.failing_sets.borrow_mut() = SET_ATTEMPTS - 1;

        assert_eq!(reown_secrets(&store, &accounts(&["mcp-token"])).unwrap(), 1);
        assert_eq!(store.items.borrow()["mcp-token"], "token");
    }
}

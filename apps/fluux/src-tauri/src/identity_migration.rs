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

/// Moves `<root>/<legacy>` to `<root>/<current>` under every root, once.
///
/// The marker, not the presence of the current directory, decides whether the
/// migration ran: a current directory can already exist without holding the
/// user's data (a build that briefly used the new identifier, or a launch
/// interrupted mid-migration). Such a directory is renamed to
/// `<current>.pre-migration-<timestamp>` rather than merged or deleted.
///
/// The marker is only written when every move succeeded, so a failure is
/// retried on the next launch.
pub fn migrate_dirs(
    roots: &[PathBuf],
    legacy: &str,
    current: &str,
    marker_dir: &Path,
    timestamp: u64,
) -> DirsReport {
    let mut report = DirsReport::default();
    if marker_dir.join(DIRS_MARKER).exists() {
        report.already_done = true;
        return report;
    }

    for root in roots {
        let old = root.join(legacy);
        let new = root.join(current);
        if !old.is_dir() {
            continue;
        }

        let mut aside = None;
        if new.exists() {
            let target = root.join(format!("{current}.pre-migration-{timestamp}"));
            if let Err(e) = fs::rename(&new, &target) {
                report.errors.push(format!("set aside {}: {e}", new.display()));
                continue;
            }
            aside = Some(target);
        }

        match fs::rename(&old, &new) {
            Ok(()) => {
                report.moved.push(new);
                report.set_aside.extend(aside);
            }
            Err(e) => {
                report.errors.push(format!("move {}: {e}", old.display()));
                if let Some(target) = aside {
                    if let Err(e) = fs::rename(&target, &new) {
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

/// Migrates this platform's directories from the legacy identifier, if `current` has one.
pub fn migrate_platform_dirs(current: &str) -> Option<DirsReport> {
    let legacy = legacy_identifier(current)?;
    let marker = marker_dir(current)?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    Some(migrate_dirs(&platform_roots(), &legacy, current, &marker, timestamp))
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

        let report = migrate_dirs(
            &[support.clone(), webkit.clone(), caches.clone()],
            LEGACY,
            CURRENT,
            &marker,
            7,
        );

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

        let report = migrate_dirs(&[root.clone()], LEGACY, CURRENT, &marker, 42);

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
        migrate_dirs(&[root.clone()], LEGACY, CURRENT, &marker, 1);

        // The legacy app was launched again after the upgrade.
        write(&root.join(LEGACY).join("a"), "downgrade");
        let report = migrate_dirs(&[root.clone()], LEGACY, CURRENT, &marker, 2);

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

        let report = migrate_dirs(&[root], LEGACY, CURRENT, &marker, 1);

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

        let report = migrate_dirs(&[root.clone()], LEGACY, CURRENT, &marker, 9);

        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(!marker.join(DIRS_MARKER).exists());
        assert_eq!(read(&root.join(LEGACY).join("data")), "user data");
        assert_eq!(read(&root.join(CURRENT).join("data")), "stale");
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

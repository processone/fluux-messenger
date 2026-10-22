//! macOS generic-password items have per-item access lists, not per-service
//! permissions. Keep all desktop secrets in one item and serialize its cached
//! read/modify/write operations across Tauri's blocking workers.
use crate::credentials::SecretStore;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};

const ACCOUNT: &str = "secrets-v1";
const BACKUP_PREFIX: &str = "identity-migration-backup:";

pub trait Backend: SecretStore {
    /// Account attributes only: enumerating these must not decrypt secrets.
    fn accounts(&self) -> Result<Vec<String>, String>;
}

#[derive(Clone, Serialize, Deserialize)]
struct Bundle {
    version: u32,
    #[serde(skip)]
    legacy: bool,
    items: BTreeMap<String, String>,
    /// Persisted before deleting any legacy item, so interrupted cleanup resumes.
    #[serde(default)]
    pending_cleanup: Vec<String>,
}

impl Default for Bundle {
    fn default() -> Self {
        Self {
            version: 1,
            legacy: false,
            items: BTreeMap::new(),
            pending_cleanup: Vec::new(),
        }
    }
}

pub struct Secrets<S> {
    store: S,
    // Cache failures too: overlapping prewarm/login/unlock must not repeatedly
    // prompt after a denial. Relaunching provides an explicit new attempt.
    cache: Mutex<Option<Result<Bundle, String>>>,
}

impl<S: Backend> Secrets<S> {
    pub fn new(store: S) -> Self {
        Self {
            store,
            cache: Mutex::new(None),
        }
    }

    fn encode(bundle: &Bundle) -> Result<String, String> {
        serde_json::to_string(bundle).map_err(|_| "Could not encode macOS secrets".into())
    }

    fn load(&self) -> Result<Bundle, String> {
        let mut verified = false;
        let mut bundle = if let Some(json) = self.store.get(ACCOUNT)? {
            let bundle: Bundle = serde_json::from_str(&json)
                .map_err(|_| "Invalid macOS secrets item; refusing to overwrite it".to_string())?;
            if bundle.version != 1 {
                return Err("Unsupported macOS secrets version".into());
            }
            bundle
        } else {
            let mut bundle = Bundle::default();
            // Import every account, including inactive OpenPGP keys and recovery
            // copies left by the old identifier migration. Never treat denial as
            // absence or delete anything until the combined copy is verified.
            for account in self.store.accounts()? {
                let target = account.strip_prefix(BACKUP_PREFIX).unwrap_or(&account);
                if target == ACCOUNT {
                    continue;
                }
                if let Some(secret) = self.store.get(&account)? {
                    if let Some(previous) = bundle.items.insert(target.into(), secret.clone()) {
                        if previous != secret {
                            return Err("Conflicting legacy keychain recovery copy".into());
                        }
                    }
                    bundle.pending_cleanup.push(account);
                }
            }
            if !bundle.pending_cleanup.is_empty() {
                let json = Self::encode(&bundle)?;
                if let Err(error) = self.store.set(ACCOUNT, &json) {
                    tracing::warn!("macOS secrets consolidation failed; using legacy items for this launch: {error}");
                    // Nothing has been deleted. Continue on the old layout for
                    // this launch; retry consolidation only on the next launch.
                    bundle.legacy = true;
                    bundle.pending_cleanup.clear();
                    return Ok(bundle);
                }
                if self.store.get(ACCOUNT)?.as_deref() != Some(json.as_str()) {
                    return Err("Could not verify migrated macOS secrets".into());
                }
                verified = true;
            }
            bundle
        };
        if !bundle.pending_cleanup.is_empty() {
            if !verified {
                // A previous process may have stopped before read-back, or an
                // old app may have changed a source before cleanup resumed.
                // Verify every surviving original before deleting any of them.
                for account in &bundle.pending_cleanup {
                    if let Some(secret) = self.store.get(account)? {
                        let target = account.strip_prefix(BACKUP_PREFIX).unwrap_or(account);
                        if bundle.items.get(target) != Some(&secret) {
                            return Err(
                                "Legacy secrets changed before migration cleanup; originals kept"
                                    .into(),
                            );
                        }
                    }
                }
            }
            for account in &bundle.pending_cleanup {
                self.store.delete(account)?;
            }
            bundle.pending_cleanup.clear();
            self.store.set(ACCOUNT, &Self::encode(&bundle)?)?;
        }
        Ok(bundle)
    }

    fn access<T>(&self, f: impl FnOnce(&mut Bundle) -> Result<T, String>) -> Result<T, String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "macOS secrets lock poisoned".to_string())?;
        if cache.is_none() {
            *cache = Some(self.load());
        }
        match cache.as_mut().expect("initialized above") {
            Ok(bundle) => f(bundle),
            Err(error) => Err(error.clone()),
        }
    }
}

impl<S: Backend> SecretStore for Secrets<S> {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.access(|bundle| Ok(bundle.items.get(account).cloned()))
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.access(|bundle| {
            let mut updated = bundle.clone();
            updated.items.insert(account.into(), secret.into());
            if bundle.legacy {
                // A failed add may have had an uncertain outcome. Remove only
                // that unverified replacement before changing its originals.
                self.store.delete(ACCOUNT)?;
                self.store.set(account, secret)?;
            } else {
                self.store.set(ACCOUNT, &Self::encode(&updated)?)?;
            }
            *bundle = updated;
            Ok(())
        })
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.access(|bundle| {
            let mut updated = bundle.clone();
            updated.items.remove(account);
            // Keep an empty bundle: deleting it would re-import leftover legacy
            // credentials on the next launch after logout.
            if bundle.legacy {
                self.store.delete(ACCOUNT)?;
                self.store.delete(account)?;
            } else {
                self.store.set(ACCOUNT, &Self::encode(&updated)?)?;
            }
            *bundle = updated;
            Ok(())
        })
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use security_framework::{
        item::{ItemClass, ItemSearchOptions, Limit, Reference, SearchResult},
        os::macos::{keychain::SecKeychain, passwords::find_generic_password},
    };
    use std::sync::OnceLock;

    // Sharing between release and Dev is retained; separate Dev storage was not
    // selected. Neither identity re-creates the other's items anymore.
    const SERVICE: &str = "com.processone.fluux";
    #[derive(Default)]
    pub struct Keychain {
        // None in the app; the native regression supplies an explicit scratch
        // keychain, never changing the user's default or search list.
        keychain: Option<SecKeychain>,
        observed_revision: Mutex<Option<u64>>,
    }
    impl Keychain {
        // Release and Dev share the item but not their memory caches. A shared,
        // secret-free revision file rejects stale writers without a second
        // keychain read (which could prompt again). Never silently overwrite a
        // password, logout or token rotation saved by another running identity.
        fn revision(&self) -> Result<(std::fs::File, u64), String> {
            use std::{fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt};
            let path = if self.keychain.is_some() {
                // The test host supplies an explicit scratch path below, rather
                // than changing the production service's coordination directory.
                std::path::PathBuf::from(
                    std::env::var_os("FLUUX_PROBE_KEYCHAIN").ok_or("Missing scratch path")?,
                )
                .with_extension("revision")
            } else {
                dirs::data_dir()
                    .ok_or("Could not find macOS application data")?
                    .join("net.processone.fluux")
                    .join(".secrets-revision")
            };
            std::fs::create_dir_all(path.parent().ok_or("Missing revision directory")?)
                .map_err(|e| e.to_string())?;
            let mut file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(path)
                .map_err(|e| e.to_string())?;
            file.lock().map_err(|e| e.to_string())?;
            let mut value = String::new();
            file.read_to_string(&mut value).map_err(|e| e.to_string())?;
            if !value.is_empty() && !value.ends_with('\n') {
                // The journal is advanced and synced before a keychain write.
                // An incomplete final record therefore never authorized one.
                // Drop only that tail under the lock and resume safely.
                let complete = value.rfind('\n').map_or(0, |i| i + 1);
                file.set_len(complete as u64).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                value.truncate(complete);
            }
            let revision = if value.is_empty() {
                0
            } else {
                value
                    .lines()
                    .last()
                    .ok_or("Missing secrets revision")?
                    .parse()
                    .map_err(|_| "Invalid secrets revision")?
            };
            Ok((file, revision))
        }

        fn begin_write(&self) -> Result<std::fs::File, String> {
            use std::io::{Seek, SeekFrom, Write};
            let (mut file, revision) = self.revision()?;
            let mut observed = self
                .observed_revision
                .lock()
                .map_err(|_| "Revision lock poisoned")?;
            if *observed != Some(revision) {
                return Err("Secrets changed in another Fluux process; quit and reopen this app before saving".into());
            }
            let next = revision.checked_add(1).ok_or("Secrets revision overflow")?;
            // Advance before writing the keychain: interruption can reject an
            // extra stale writer, but can never authorize an overwrite.
            file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
            writeln!(file, "{next}").map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            *observed = Some(next);
            Ok(file)
        }

        fn query(&self, account: Option<&str>) -> ItemSearchOptions {
            let mut query = ItemSearchOptions::new();
            query.class(ItemClass::generic_password()).service(SERVICE);
            if let Some(keychain) = &self.keychain {
                query.keychains(std::slice::from_ref(keychain));
            }
            if let Some(account) = account {
                query.account(account);
            }
            query
        }
    }
    impl SecretStore for Keychain {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            let revision = if account == ACCOUNT {
                Some(self.revision()?)
            } else {
                None
            };
            if let Some((_, revision)) = &revision {
                *self
                    .observed_revision
                    .lock()
                    .map_err(|_| "Revision lock poisoned")? = Some(*revision);
            }
            match find_generic_password(
                self.keychain.as_ref().map(std::slice::from_ref),
                SERVICE,
                account,
            ) {
                Ok((bytes, _)) => String::from_utf8(bytes.to_vec())
                    .map(Some)
                    .map_err(|_| "Invalid keychain text".into()),
                Err(e) if e.code() == -25300 => Ok(None),
                Err(e) => Err(format!("Read macOS secrets: {e}")),
            }
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            let _revision = if account == ACCOUNT {
                Some(self.begin_write()?)
            } else {
                None
            };
            // Find the reference, not the password: a write must not decrypt
            // the item again after the launch's single authorization.
            match self.query(Some(account)).load_refs(true).search() {
                Ok(mut items) => match items.pop() {
                    Some(SearchResult::Ref(Reference::KeychainItem(mut item))) => {
                        item.set_password(secret.as_bytes())
                    }
                    _ => return Err("Unexpected macOS keychain reference".into()),
                },
                Err(e) if e.code() == -25300 => {
                    let keychain = match &self.keychain {
                        Some(k) => k.clone(),
                        None => SecKeychain::default().map_err(|e| e.to_string())?,
                    };
                    keychain
                        .add_generic_password(SERVICE, account, secret.as_bytes())
                        .map(|_| ())
                }
                Err(e) => Err(e),
            }
            .map_err(|e| format!("Save macOS secrets: {e}"))
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            let _revision = if account == ACCOUNT {
                Some(self.begin_write()?)
            } else {
                None
            };
            match self.query(Some(account)).delete() {
                Ok(()) => Ok(()),
                Err(e) if e.code() == -25300 => Ok(()),
                Err(e) => Err(format!("Delete legacy macOS secret: {e}")),
            }
        }
    }
    impl Backend for Keychain {
        fn accounts(&self) -> Result<Vec<String>, String> {
            match self
                .query(None)
                .load_attributes(true)
                .limit(Limit::All)
                .search()
            {
                Ok(items) => items
                    .into_iter()
                    .map(|item| {
                        item.simplify_dict()
                            .and_then(|mut attrs| attrs.remove("acct"))
                            .ok_or_else(|| "Missing keychain account attribute".into())
                    })
                    .collect(),
                Err(e) if e.code() == -25300 => Ok(Vec::new()),
                Err(e) => Err(format!("List legacy macOS secrets: {e}")),
            }
        }
    }
    // FLM-66: opt-in OS check, invoked only by the scratch-HOME launcher.
    #[cfg(test)]
    #[test]
    #[ignore = "requires the disposable-keychain launcher"]
    fn native_keychain_probe() {
        let home = std::path::PathBuf::from(std::env::var_os("HOME").expect("scratch HOME"));
        let path = std::path::PathBuf::from(
            std::env::var_os("FLUUX_PROBE_KEYCHAIN").expect("explicit scratch keychain"),
        );
        assert!(
            home.join(".fluux-keychain-test-home").is_file(),
            "scratch marker required"
        );
        assert!(path.is_absolute() && path.starts_with(home.canonicalize().unwrap()));
        assert!(std::env::var_os("FM3000_LOCAL_CODESIGN_DIR").is_some());
        let _no_dialogs = SecKeychain::disable_user_interaction().unwrap();
        let action = std::env::var("FLUUX_PROBE_ACTION").unwrap();
        let keychain = SecKeychain::open(&path).unwrap();
        let raw = Keychain {
            keychain: Some(keychain),
            ..Keychain::default()
        };
        if action == "seed" {
            raw.set("last_user", "alice@example.com").unwrap();
            raw.set(
                "alice@example.com",
                r#"{"jid":"alice@example.com","password":"test-password","server":null}"#,
            )
            .unwrap();
            raw.set("openpgp_passphrase:alice@example.com", "dGVzdC1wYXNz")
                .unwrap();
            raw.set("mcp-token", "test-token").unwrap();
            println!("seeded four legacy items in disposable keychain");
            return;
        }
        if let Some(count) = action.strip_prefix("interrupt-") {
            let count: usize = count.parse().unwrap();
            assert!(raw.get(ACCOUNT).unwrap().is_none());
            let accounts = raw.accounts().unwrap();
            let mut bundle = Bundle::default();
            for account in accounts {
                bundle
                    .items
                    .insert(account.clone(), raw.get(&account).unwrap().unwrap());
                bundle.pending_cleanup.push(account);
            }
            let json = Secrets::<Keychain>::encode(&bundle).unwrap();
            raw.set(ACCOUNT, &json).unwrap();
            if count > 0 {
                assert_eq!(raw.get(ACCOUNT).unwrap().as_deref(), Some(json.as_str()));
            }
            for account in bundle.pending_cleanup.iter().take(count) {
                raw.delete(account).unwrap();
            }
            println!(
                "process exits after writing combined item and deleting {count} of four originals"
            );
            return;
        }
        struct Traced {
            raw: Keychain,
            fail_new_item: bool,
            reads: Mutex<Vec<String>>,
        }
        impl SecretStore for Traced {
            fn get(&self, a: &str) -> Result<Option<String>, String> {
                self.reads.lock().unwrap().push(a.into());
                self.raw.get(a)
            }
            fn set(&self, a: &str, s: &str) -> Result<(), String> {
                if a == ACCOUNT && self.fail_new_item {
                    return Err("injected new-item write failure".into());
                }
                self.raw.set(a, s)
            }
            fn delete(&self, a: &str) -> Result<(), String> {
                self.raw.delete(a)
            }
        }
        impl Backend for Traced {
            fn accounts(&self) -> Result<Vec<String>, String> {
                self.raw.accounts()
            }
        }
        let store = Secrets::new(Traced {
            raw,
            fail_new_item: action == "write-failed",
            reads: Mutex::new(Vec::new()),
        });
        if action == "denied" {
            assert!(crate::credentials::load(&store).is_err());
            assert!(store.get("openpgp_passphrase:alice@example.com").is_err());
            assert!(store.get("mcp-token").is_err());
            assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
            println!("changed identity: one native access refusal, no repeated reads or writes");
            return;
        }
        assert!(crate::credentials::load(&store).unwrap().is_some());
        assert!(store.get("last_user").unwrap().is_some());
        assert!(store
            .get("openpgp_passphrase:alice@example.com")
            .unwrap()
            .is_some());
        assert!(store.get("mcp-token").unwrap().is_some());
        if action == "write-failed" {
            assert_eq!(store.store.raw.accounts().unwrap().len(), 4);
            assert!(store.store.raw.get(ACCOUNT).unwrap().is_none());
            store.set("mcp-token", "legacy-rotated-token").unwrap();
            assert_eq!(
                store.store.raw.get("mcp-token").unwrap().as_deref(),
                Some("legacy-rotated-token")
            );
            let mut backend = store.store;
            backend.fail_new_item = false;
            let reopened = Secrets::new(backend);
            assert!(crate::credentials::load(&reopened).unwrap().is_some());
            assert_eq!(reopened.store.raw.accounts().unwrap(), [ACCOUNT]);
            assert_eq!(
                reopened.get("mcp-token").unwrap().as_deref(),
                Some("legacy-rotated-token")
            );
            println!("failed new-item write: legacy login, key and token usable; rotation and next-launch migration verified");
            return;
        }
        if action == "migrate" {
            assert_eq!(store.store.raw.accounts().unwrap(), [ACCOUNT]);
            use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
            let mut exported = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(home.join("approved-item.json"))
                .unwrap();
            exported
                .write_all(store.store.raw.get(ACCOUNT).unwrap().unwrap().as_bytes())
                .unwrap();
            println!("migration verified all four secrets and removed legacy items");
        } else {
            assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
            println!("startup: remembered login, prewarm, OpenPGP and MCP: one native item read");
            {
                use std::{fs::OpenOptions, io::Write};
                let journal = path.with_extension("revision");
                let mut file = OpenOptions::new().append(true).open(&journal).unwrap();
                file.write_all(b"999").unwrap();
                drop(file);
                let check = Keychain {
                    keychain: store.store.raw.keychain.clone(),
                    ..Keychain::default()
                };
                assert!(check.get(ACCOUNT).unwrap().is_some());
                println!("partial revision-journal append recovered before any keychain write");
            }
            let other = Secrets::new(Keychain {
                keychain: store.store.raw.keychain.clone(),
                ..Keychain::default()
            });
            assert!(other.get("mcp-token").unwrap().is_some());
            store.set("mcp-token", "rotated-test-token").unwrap();
            assert!(other
                .set("mcp-token", "stale-token")
                .unwrap_err()
                .contains("another Fluux process"));
            println!("concurrent release/Dev cache: stale writes refused without decrypting again");
            crate::credentials::delete(&store).unwrap();
            let store = Secrets::new(store.store);
            assert!(crate::credentials::load(&store).unwrap().is_none());
            assert_eq!(
                store.get("mcp-token").unwrap().as_deref(),
                Some("rotated-test-token")
            );
            assert!(store
                .get("openpgp_passphrase:alice@example.com")
                .unwrap()
                .is_some());
            println!("rotation and logout persisted; OpenPGP passphrase preserved");
        }
    }

    pub fn secrets() -> &'static Secrets<Keychain> {
        static SECRETS: OnceLock<Secrets<Keychain>> = OnceLock::new();
        SECRETS.get_or_init(|| Secrets::new(Keychain::default()))
    }
}
#[cfg(target_os = "macos")]
pub use native::secrets;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, sync::Mutex};

    #[derive(Default)]
    struct FakeStore {
        items: Mutex<BTreeMap<String, String>>,
        reads: Mutex<Vec<String>>,
        denied: Mutex<Option<String>>,
        fail_write: Mutex<bool>,
        corrupt_write: Mutex<bool>,
        deny_existing_bundle: Mutex<bool>,
        fail_delete: Mutex<Option<String>>,
    }
    impl SecretStore for FakeStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.reads.lock().unwrap().push(account.into());
            if account == ACCOUNT
                && *self.deny_existing_bundle.lock().unwrap()
                && self.items.lock().unwrap().contains_key(ACCOUNT)
            {
                return Err("read-back denied".into());
            }
            if self.denied.lock().unwrap().as_deref() == Some(account) {
                return Err("denied".into());
            }
            Ok(self.items.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            if *self.fail_write.lock().unwrap() {
                return Err("write failed".into());
            }
            let secret = if *self.corrupt_write.lock().unwrap() {
                "corrupt"
            } else {
                secret
            };
            self.items
                .lock()
                .unwrap()
                .insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            if self.fail_delete.lock().unwrap().as_deref() == Some(account) {
                return Err("delete failed".into());
            }
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    impl Backend for FakeStore {
        fn accounts(&self) -> Result<Vec<String>, String> {
            Ok(self.items.lock().unwrap().keys().cloned().collect())
        }
    }

    // FLM-66: prewarm, remembered login, OpenPGP unlock and MCP must share
    // one read, even when Tauri's blocking workers reach them concurrently.
    #[test]
    fn startup_reads_one_keychain_item_once() {
        let raw = FakeStore::default();
        let store = Secrets::new(raw);
        crate::credentials::save(
            &store,
            &crate::credentials::StoredCredentials {
                jid: "alice@example.com".into(),
                password: "test-password".into(),
                server: None,
            },
        )
        .unwrap();
        store
            .set("openpgp_passphrase:alice@example.com", "dGVzdC1wYXNz")
            .unwrap();
        store.set("mcp-token", "test-token").unwrap();
        store.store.reads.lock().unwrap().clear();
        let store = Secrets::new(store.store); // A fresh process has no memory cache.
        std::thread::scope(|scope| {
            scope.spawn(|| {
                assert_eq!(
                    store.get("last_user").unwrap().as_deref(),
                    Some("alice@example.com")
                );
            });
            scope.spawn(|| {
                assert!(crate::credentials::load(&store).unwrap().is_some());
            });
            scope.spawn(|| {
                assert!(store
                    .get("openpgp_passphrase:alice@example.com")
                    .unwrap()
                    .is_some());
            });
            scope.spawn(|| {
                assert!(store.get("mcp-token").unwrap().is_some());
            });
        });
        assert_eq!(*store.store.reads.lock().unwrap(), vec!["secrets-v1"]);
    }
    fn legacy() -> FakeStore {
        let raw = FakeStore::default();
        crate::credentials::save(
            &raw,
            &crate::credentials::StoredCredentials {
                jid: "alice@example.com".into(),
                password: "test-password".into(),
                server: Some("xmpp.example.com".into()),
            },
        )
        .unwrap();
        raw.set("openpgp_passphrase:alice@example.com", "dGVzdC1wYXNz")
            .unwrap();
        raw.set("openpgp_passphrase:bob@example.org", "aW5hY3RpdmUta2V5")
            .unwrap();
        raw.set("mcp-token", "test-token").unwrap();
        raw
    }

    // FLM-66 migration must preserve remembered login, inactive keys and MCP.
    #[test]
    fn migrates_all_accounts_and_recovery_copies_before_cleanup() {
        let raw = legacy();
        raw.set(
            "identity-migration-backup:openpgp_passphrase:carol@example.net",
            "cmVjb3Zlcnk=",
        )
        .unwrap();
        raw.set("unrelated", "not ours").unwrap();
        let store = Secrets::new(raw);
        let c = crate::credentials::load(&store).unwrap().unwrap();
        assert_eq!(c.server.as_deref(), Some("xmpp.example.com"));
        assert_eq!(
            store
                .get("openpgp_passphrase:bob@example.org")
                .unwrap()
                .as_deref(),
            Some("aW5hY3RpdmUta2V5")
        );
        assert_eq!(
            store
                .get("openpgp_passphrase:carol@example.net")
                .unwrap()
                .as_deref(),
            Some("cmVjb3Zlcnk=")
        );
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("test-token")
        );
        assert_eq!(store.get("unrelated").unwrap().as_deref(), Some("not ours"));
        assert_eq!(store.store.accounts().unwrap(), [ACCOUNT]);
        let reopened = Secrets::new(store.store);
        assert_eq!(crate::credentials::load(&reopened).unwrap().unwrap(), c);
        assert_eq!(
            *reopened.store.reads.lock().unwrap().last().unwrap(),
            ACCOUNT
        );
    }

    // FLM-66: refusal is not an absent account and must not prompt each consumer.
    #[test]
    fn denied_access_is_shared_without_overwriting_or_repeated_reads() {
        let raw = legacy();
        *raw.denied.lock().unwrap() = Some(ACCOUNT.into());
        let original = raw.items.lock().unwrap().clone();
        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).is_err());
        assert!(store.get("mcp-token").is_err());
        assert!(store.set("mcp-token", "replacement").is_err());
        assert!(crate::credentials::delete(&store).is_err());
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
        assert_eq!(*store.store.items.lock().unwrap(), original);
    }

    // FLM-66: migrate only after every legacy read succeeded and the copy verifies.
    #[test]
    fn failed_migration_never_deletes_the_only_copy() {
        for failure in ["denied", "verify", "conflict"] {
            let raw = legacy();
            let original = raw.items.lock().unwrap().clone();
            match failure {
                "denied" => *raw.denied.lock().unwrap() = Some("mcp-token".into()),
                "verify" => *raw.corrupt_write.lock().unwrap() = true,
                _ => raw
                    .set("identity-migration-backup:mcp-token", "conflicting-token")
                    .unwrap(),
            }
            let store = Secrets::new(raw);
            assert!(crate::credentials::load(&store).is_err(), "{failure}");
            for (account, secret) in original {
                assert_eq!(
                    store.store.items.lock().unwrap().get(&account),
                    Some(&secret),
                    "{failure}"
                );
            }
        }
    }

    // FLM-66: process interruption during cleanup must resume from the bundle.
    #[test]
    fn resumes_cleanup_after_verifying_remaining_originals() {
        let raw = legacy();
        *raw.fail_delete.lock().unwrap() = Some("mcp-token".into());
        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).is_err());
        assert!(store.store.items.lock().unwrap().contains_key(ACCOUNT));
        *store.store.fail_delete.lock().unwrap() = None;
        store.store.reads.lock().unwrap().clear();
        let store = Secrets::new(store.store);
        assert!(crate::credentials::load(&store).unwrap().is_some());
        assert_eq!(store.store.reads.lock().unwrap().first().unwrap(), ACCOUNT);
        assert_eq!(store.store.accounts().unwrap(), [ACCOUNT]);
    }

    // FLM-66: a malformed or future item must not silently reset saved secrets.
    #[test]
    fn refuses_malformed_and_future_bundles() {
        for json in ["not JSON", r#"{"version":2,"items":{}}"#] {
            let raw = legacy();
            raw.set(ACCOUNT, json).unwrap();
            let original = raw.items.lock().unwrap().clone();
            let store = Secrets::new(raw);
            assert!(store.set("mcp-token", "replacement").is_err());
            assert_eq!(*store.store.items.lock().unwrap(), original);
            assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
        }
    }

    // FLM-66: serialized writes cannot lose a password, passphrase or rotated token.
    #[test]
    fn concurrent_updates_survive_restart_and_logout_removes_only_login() {
        let store = Secrets::new(legacy());
        assert!(crate::credentials::load(&store).unwrap().is_some());
        std::thread::scope(|scope| {
            scope.spawn(|| store.set("mcp-token", "rotated-token").unwrap());
            scope.spawn(|| {
                store
                    .set("openpgp_passphrase:alice@example.com", "cm90YXRlZA==")
                    .unwrap()
            });
        });
        *store.store.fail_write.lock().unwrap() = true;
        assert!(store.set("mcp-token", "failed-rotation").is_err());
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("rotated-token")
        );
        *store.store.fail_write.lock().unwrap() = false;
        crate::credentials::delete(&store).unwrap();
        let store = Secrets::new(store.store);
        assert!(crate::credentials::load(&store).unwrap().is_none());
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("rotated-token")
        );
        assert_eq!(
            store
                .get("openpgp_passphrase:alice@example.com")
                .unwrap()
                .as_deref(),
            Some("cm90YXRlZA==")
        );
        assert_eq!(store.store.accounts().unwrap(), [ACCOUNT]);
    }
    // Captain's migration ruling: a failed new-item write keeps the old layout
    // usable, including token rotation and logout, and is retried on relaunch.
    #[test]
    fn failed_combined_write_falls_back_to_legacy_and_retries_next_launch() {
        let raw = legacy();
        *raw.fail_write.lock().unwrap() = true;
        let original = raw.items.lock().unwrap().clone();
        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).unwrap().is_some());
        assert_eq!(*store.store.items.lock().unwrap(), original);
        assert!(store
            .get("openpgp_passphrase:bob@example.org")
            .unwrap()
            .is_some());
        *store.store.fail_write.lock().unwrap() = false;
        store.set("mcp-token", "rotated-legacy-token").unwrap();
        assert_eq!(
            store.store.items.lock().unwrap().get("mcp-token").unwrap(),
            "rotated-legacy-token"
        );
        assert!(!store.store.items.lock().unwrap().contains_key(ACCOUNT));
        crate::credentials::delete(&store).unwrap();
        assert!(!store.store.items.lock().unwrap().contains_key("last_user"));
        assert!(!store
            .store
            .items
            .lock()
            .unwrap()
            .contains_key("alice@example.com"));
        let store = Secrets::new(store.store);
        assert!(crate::credentials::load(&store).unwrap().is_none());
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("rotated-legacy-token")
        );
        assert!(store
            .get("openpgp_passphrase:alice@example.com")
            .unwrap()
            .is_some());
        assert!(store
            .get("openpgp_passphrase:bob@example.org")
            .unwrap()
            .is_some());
        assert_eq!(store.store.accounts().unwrap(), [ACCOUNT]);
    }

    // Captain's migration ruling: crash before verification or after any delete
    // must be resumable, and resumed verification must precede further deletion.
    #[test]
    fn interruptions_before_verification_and_during_cleanup_preserve_every_secret() {
        for removed in 0..=5 {
            let raw = legacy();
            let original = raw.items.lock().unwrap().clone();
            let bundle = Bundle {
                items: original.clone(),
                pending_cleanup: original.keys().cloned().collect(),
                ..Bundle::default()
            };
            raw.set(ACCOUNT, &Secrets::<FakeStore>::encode(&bundle).unwrap())
                .unwrap();
            for account in original.keys().take(removed) {
                raw.delete(account).unwrap();
            }
            let store = Secrets::new(raw);
            for (account, secret) in &original {
                assert_eq!(store.get(account).unwrap().as_ref(), Some(secret));
            }
            assert_eq!(store.store.accounts().unwrap(), [ACCOUNT]);
            let store = Secrets::new(store.store);
            for (account, secret) in &original {
                assert_eq!(store.get(account).unwrap().as_ref(), Some(secret));
            }
        }
        let raw = legacy();
        let original = raw.items.lock().unwrap().clone();
        let mut bundle = Bundle {
            items: original.clone(),
            pending_cleanup: original.keys().cloned().collect(),
            ..Bundle::default()
        };
        bundle.items.remove("mcp-token");
        raw.set(ACCOUNT, &Secrets::<FakeStore>::encode(&bundle).unwrap())
            .unwrap();
        let store = Secrets::new(raw);
        assert!(store.get("last_user").is_err());
        for (account, secret) in original {
            assert_eq!(
                store.store.items.lock().unwrap().get(&account),
                Some(&secret)
            );
        }
    }
    // Captain's migration ruling: read-back failure cannot authorize deletion;
    // a fresh process can verify the durable replacement and finish safely.
    #[test]
    fn read_back_denial_keeps_originals_and_relaunch_verifies_before_cleanup() {
        let raw = legacy();
        let original = raw.items.lock().unwrap().clone();
        *raw.deny_existing_bundle.lock().unwrap() = true;
        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).is_err());
        for (account, secret) in &original {
            assert_eq!(store.store.items.lock().unwrap().get(account), Some(secret));
        }
        *store.store.deny_existing_bundle.lock().unwrap() = false;
        let store = Secrets::new(store.store);
        for (account, secret) in &original {
            assert_eq!(store.get(account).unwrap().as_ref(), Some(secret));
        }
        assert_eq!(store.store.accounts().unwrap(), [ACCOUNT]);
    }
}

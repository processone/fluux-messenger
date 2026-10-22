//! macOS keychain access lists belong to items, not services. Share one cached
//! item across desktop consumers, retaining legacy items for the 0.18.0 release.
use crate::credentials::SecretStore;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};

const ACCOUNT: &str = "secrets-v1";
const BACKUP_PREFIX: &str = "identity-migration-backup:";

pub trait Backend: SecretStore {
    /// Account attributes only; this must not decrypt secrets.
    fn accounts(&self) -> Result<Vec<String>, String>;
}

#[derive(Clone, Serialize, Deserialize)]
struct Bundle {
    version: u32,
    #[serde(skip)]
    legacy: bool,
    items: BTreeMap<String, String>,
}
impl Default for Bundle {
    fn default() -> Self {
        Self {
            version: 1,
            legacy: false,
            items: BTreeMap::new(),
        }
    }
}

fn user_denial(error: &str) -> bool {
    error.contains("macOS keychain (-25293)") || error.contains("macOS keychain (-128)")
}

pub struct Secrets<S> {
    store: S,
    // Only an explicit denial/cancel is shared by overlapping consumers.
    // Transient failures leave the cache empty so the next caller can retry.
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
        if let Some(json) = self.store.get(ACCOUNT)? {
            let bundle: Bundle = serde_json::from_str(&json)
                .map_err(|_| "Invalid macOS secrets item; refusing to overwrite it".to_string())?;
            if bundle.version != 1 {
                return Err("Unsupported macOS secrets version".into());
            }
            // No legacy reads or cleanup once the bundle exists. In particular,
            // ignore pending_cleanup from an earlier development build.
            return Ok(bundle);
        }
        let mut bundle = Bundle::default();
        for account in self.store.accounts()? {
            if account == ACCOUNT {
                continue;
            }
            if let Some(secret) = self.store.get(&account)? {
                bundle.items.insert(account, secret);
            }
        }
        // Live originals win over conflicting recovery copies. Preserve both
        // copies, including the backup's original account name, without writing
        // or deleting either legacy item.
        for (account, secret) in bundle.items.clone() {
            if let Some(target) = account.strip_prefix(BACKUP_PREFIX) {
                bundle.items.entry(target.into()).or_insert(secret);
            }
        }
        if !bundle.items.is_empty() {
            let json = Self::encode(&bundle)?;
            let migrated = self.store.set(ACCOUNT, &json).and_then(|()| {
                if self.store.get(ACCOUNT)?.as_deref() == Some(json.as_str()) {
                    Ok(())
                } else {
                    Err("Could not verify migrated macOS secrets".into())
                }
            });
            if let Err(error) = migrated {
                tracing::error!(
                    "macOS secrets migration failed; using legacy items for this launch: {error}"
                );
                bundle.legacy = true;
            }
        }
        // Cleanup is deliberately deferred for at least one release. Dev must
        // not remove the password, MCP token or passphrase still read by 0.18.0.
        Ok(bundle)
    }
    fn access<T>(
        &self,
        operation: &str,
        f: impl FnOnce(&mut Bundle) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut cache = self.cache.lock().map_err(|_| {
            let error = "macOS secrets lock poisoned".to_string();
            tracing::error!("macOS secrets {operation} failed: {error}");
            error
        })?;
        if cache.is_none() {
            match self.load() {
                Ok(bundle) => *cache = Some(Ok(bundle)),
                Err(error) => {
                    tracing::error!("macOS secrets load failed: {error}");
                    if user_denial(&error) {
                        *cache = Some(Err(error.clone()));
                    }
                    return Err(error);
                }
            }
        }
        let result = match cache.as_mut().expect("initialized above") {
            Ok(bundle) => f(bundle),
            Err(error) => return Err(error.clone()),
        };
        if let Err(error) = &result {
            tracing::error!("macOS secrets {operation} failed: {error}");
        }
        result
    }
}
impl<S: Backend> SecretStore for Secrets<S> {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.access("read", |bundle| Ok(bundle.items.get(account).cloned()))
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.access("write", |bundle| {
            if bundle
                .items
                .get(account)
                .is_some_and(|current| current == secret)
            {
                return Ok(());
            }
            let mut updated = bundle.clone();
            updated.items.insert(account.into(), secret.into());
            if bundle.legacy {
                // Only discard an unverified replacement created by this failed
                // migration, never an original or another process's newer item.
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
        self.access("delete", |bundle| {
            if !bundle.items.contains_key(account) {
                return Ok(());
            }
            let mut updated = bundle.clone();
            updated.items.remove(account);
            if bundle.legacy {
                self.store.delete(ACCOUNT)?;
                self.store.delete(account)?;
                let backup = format!("{BACKUP_PREFIX}{account}");
                if updated.items.remove(&backup).is_some() {
                    self.store.delete(&backup)?;
                }
            } else {
                self.store.set(ACCOUNT, &Self::encode(&updated)?)?;
            }
            // Retain even an empty bundle so logout cannot re-import originals.
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
        fn revision_path(&self) -> Result<std::path::PathBuf, String> {
            if self.keychain.is_some() {
                Ok(std::path::PathBuf::from(
                    std::env::var_os("FLUUX_PROBE_KEYCHAIN").ok_or("Missing scratch path")?,
                )
                .with_extension("revision"))
            } else {
                Ok(dirs::data_dir()
                    .ok_or("Could not find macOS application data")?
                    .join("net.processone.fluux")
                    .join(".secrets-revision"))
            }
        }
        fn revision(&self) -> Result<(std::fs::File, std::path::PathBuf, u64), String> {
            use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt};
            let path = self.revision_path()?;
            std::fs::create_dir_all(path.parent().ok_or("Missing revision directory")?)
                .map_err(|e| e.to_string())?;
            // The lock file is never replaced. Only the single revision value is.
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(path.with_extension("lock"))
                .map_err(|e| e.to_string())?;
            file.lock().map_err(|e| e.to_string())?;
            let revision = match std::fs::read_to_string(&path) {
                Ok(value) => value
                    .trim()
                    .parse()
                    .map_err(|_| "Invalid secrets revision".to_string())?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
                Err(e) => return Err(e.to_string()),
            };
            Ok((file, path, revision))
        }
        fn begin_write(&self) -> Result<std::fs::File, String> {
            use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
            let (lock, path, revision) = self.revision()?;
            let mut observed = self
                .observed_revision
                .lock()
                .map_err(|_| "Revision lock poisoned")?;
            if *observed != Some(revision) {
                return Err("Secrets changed or revision tracking was unavailable; quit and reopen this app before saving".into());
            }
            let next = revision.checked_add(1).ok_or("Secrets revision overflow")?;
            let temporary = path.with_extension(format!("revision-{}.tmp", std::process::id()));
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            writeln!(file, "{next}").map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
            std::fs::File::open(path.parent().ok_or("Missing revision directory")?)
                .and_then(|dir| dir.sync_all())
                .map_err(|e| e.to_string())?;
            *observed = Some(next);
            Ok(lock)
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
                self.revision().ok()
            } else {
                None
            };
            if account == ACCOUNT {
                *self
                    .observed_revision
                    .lock()
                    .map_err(|_| "Revision lock poisoned")? =
                    revision.as_ref().map(|(_, _, value)| *value);
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
                Err(e) => Err(format!("Read macOS keychain ({}): {e}", e.code())),
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
            .map_err(|e| format!("Save macOS keychain ({}): {e}", e.code()))
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
                Err(e) => Err(format!("Delete macOS keychain ({}): {e}", e.code())),
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
                Err(e) => Err(format!("List macOS keychain ({}): {e}", e.code())),
            }
        }
    }
    // FLM-66 / FLM-79: production backend, explicit disposable keychains only.
    #[cfg(test)]
    #[test]
    #[ignore = "requires the disposable-keychain launcher"]
    fn native_keychain_probe() {
        let home = std::path::PathBuf::from(std::env::var_os("HOME").expect("scratch HOME"));
        let path = std::path::PathBuf::from(
            std::env::var_os("FLUUX_PROBE_KEYCHAIN").expect("scratch keychain"),
        );
        assert!(home.join(".fluux-keychain-test-home").is_file());
        assert!(path.is_absolute() && path.starts_with(home.canonicalize().unwrap()));
        assert!(std::env::var_os("FM3000_LOCAL_CODESIGN_DIR").is_some());
        let _no_dialogs = SecKeychain::disable_user_interaction().unwrap();
        let action = std::env::var("FLUUX_PROBE_ACTION").unwrap();
        let raw = Keychain {
            keychain: Some(SecKeychain::open(&path).unwrap()),
            ..Keychain::default()
        };
        if action == "seed" {
            crate::credentials::save(
                &raw,
                &crate::credentials::StoredCredentials {
                    jid: "alice@example.com".into(),
                    password: "test-password".into(),
                    server: None,
                },
            )
            .unwrap();
            raw.set("openpgp_passphrase:alice@example.com", "dGVzdC1wYXNz")
                .unwrap();
            raw.set("mcp-token", "test-token").unwrap();
            println!("seeded four legacy items");
            return;
        }
        if action == "legacy-read" {
            let login = crate::credentials::load(&raw).unwrap().unwrap();
            assert_eq!(login.password, "test-password");
            assert_eq!(raw.get("mcp-token").unwrap().as_deref(), Some("test-token"));
            assert_eq!(
                raw.get("openpgp_passphrase:alice@example.com")
                    .unwrap()
                    .as_deref(),
                Some("dGVzdC1wYXNz")
            );
            println!("installed-release identity still reads its original login, token and OpenPGP passphrase");
            return;
        }
        if action == "interrupt" {
            assert!(raw.get(ACCOUNT).unwrap().is_none());
            let mut bundle = Bundle::default();
            for account in raw.accounts().unwrap() {
                bundle
                    .items
                    .insert(account.clone(), raw.get(&account).unwrap().unwrap());
            }
            let mut json = serde_json::to_value(&bundle).unwrap();
            json["pending_cleanup"] = serde_json::json!(["last_user", "mcp-token"]);
            raw.set(ACCOUNT, &json.to_string()).unwrap();
            raw.set("mcp-token", "older-app-updated-token").unwrap();
            println!("exit after combined write; original changed and old pending_cleanup remains");
            return;
        }
        struct Traced {
            raw: Keychain,
            fail_new: bool,
            reads: Mutex<Vec<String>>,
        }
        impl SecretStore for Traced {
            fn get(&self, a: &str) -> Result<Option<String>, String> {
                self.reads.lock().unwrap().push(a.into());
                self.raw.get(a)
            }
            fn set(&self, a: &str, s: &str) -> Result<(), String> {
                if a == ACCOUNT && self.fail_new {
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
            fail_new: action == "write-failed",
            reads: Mutex::new(Vec::new()),
        });
        if action == "denied" {
            let error = crate::credentials::load(&store).unwrap_err();
            assert!(user_denial(&error), "{error}");
            assert!(store.get("mcp-token").is_err());
            assert!(store.get("openpgp_passphrase:alice@example.com").is_err());
            assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
            println!("changed identity: one native denial, cached across startup consumers");
            return;
        }
        assert_eq!(
            crate::credentials::load(&store).unwrap().unwrap().password,
            "test-password"
        );
        assert_eq!(
            store
                .get("openpgp_passphrase:alice@example.com")
                .unwrap()
                .as_deref(),
            Some("dGVzdC1wYXNz")
        );
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("test-token")
        );
        if action == "write-failed" {
            assert!(store.store.raw.get(ACCOUNT).unwrap().is_none());
            assert_eq!(store.store.raw.accounts().unwrap().len(), 4);
            store.set("mcp-token", "legacy-rotated-token").unwrap();
            let mut raw = store.store;
            raw.fail_new = false;
            let store = Secrets::new(raw);
            assert_eq!(
                store.get("mcp-token").unwrap().as_deref(),
                Some("legacy-rotated-token")
            );
            assert_eq!(store.store.raw.accounts().unwrap().len(), 5);
            println!("failed combined write: old layout usable, rotation and next-launch migration succeed; originals retained");
            return;
        }
        if action == "migrate" {
            assert_eq!(store.store.raw.accounts().unwrap().len(), 5);
            use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(home.join("approved-item.json"))
                .unwrap()
                .write_all(store.store.raw.get(ACCOUNT).unwrap().unwrap().as_bytes())
                .unwrap();
            println!("combined item verified; all four originals retained, no cleanup");
            return;
        }
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
        println!("startup: one combined read supplies login, prewarm, OpenPGP and MCP");
        let revision = path.with_extension("revision");
        let before = std::fs::read(&revision).ok();
        store.set("mcp-token", "test-token").unwrap();
        store.delete("absent").unwrap();
        assert_eq!(std::fs::read(&revision).ok(), before);
        // An incomplete atomic replacement is ignored; reads use the old value.
        let temporary = revision.with_extension(format!("revision-{}.tmp", std::process::id()));
        std::fs::write(&temporary, b"999\n").unwrap();
        let other = Secrets::new(Keychain {
            keychain: store.store.raw.keychain.clone(),
            ..Keychain::default()
        });
        assert!(other.get("mcp-token").unwrap().is_some());
        store.set("mcp-token", "rotated-test-token").unwrap();
        let value = std::fs::read_to_string(&revision).unwrap();
        assert_eq!(value.lines().count(), 1);
        assert!(value.trim().parse::<u64>().is_ok());
        assert!(other
            .set("mcp-token", "stale-token")
            .unwrap_err()
            .contains("quit and reopen"));
        println!("no-op writes skipped; one atomic revision value; stale running copy refused");
        // A broken coordination file must never block a keychain read.
        let saved = std::fs::read(&revision).unwrap();
        std::fs::remove_file(&revision).unwrap();
        std::fs::create_dir(&revision).unwrap();
        let readonly = Secrets::new(Keychain {
            keychain: store.store.raw.keychain.clone(),
            ..Keychain::default()
        });
        assert_eq!(
            readonly.get("mcp-token").unwrap().as_deref(),
            Some("rotated-test-token")
        );
        assert!(readonly.set("mcp-token", "blocked-write").is_err());
        std::fs::remove_dir(&revision).unwrap();
        std::fs::write(&revision, saved).unwrap();
        assert!(readonly
            .set("mcp-token", "blocked-write")
            .unwrap_err()
            .contains("quit and reopen"));
        println!("revision file unavailable: secrets remain readable, only writes refused");
        crate::credentials::delete(&store).unwrap();
        let store = Secrets::new(store.store);
        assert!(crate::credentials::load(&store).unwrap().is_none());
        assert!(store
            .get("openpgp_passphrase:alice@example.com")
            .unwrap()
            .is_some());
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("rotated-test-token")
        );
        println!("logout and token rotation persist in combined item without re-importing retained originals");
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
    #[derive(Default)]
    struct FakeStore {
        items: Mutex<BTreeMap<String, String>>,
        reads: Mutex<Vec<String>>,
        writes: Mutex<Vec<String>>,
        deletes: Mutex<Vec<String>>,
        read_error: Mutex<Option<(String, usize)>>,
        fail_write: Mutex<bool>,
        fail_delete: Mutex<bool>,
        corrupt_write: Mutex<bool>,
    }
    impl SecretStore for FakeStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.reads.lock().unwrap().push(account.into());
            if account == ACCOUNT {
                if let Some((error, remaining)) = self.read_error.lock().unwrap().as_mut() {
                    if *remaining > 0 {
                        *remaining -= 1;
                        return Err(error.clone());
                    }
                }
            }
            Ok(self.items.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.writes.lock().unwrap().push(account.into());
            if *self.fail_write.lock().unwrap() {
                return Err("write failed".into());
            }
            self.items.lock().unwrap().insert(
                account.into(),
                if *self.corrupt_write.lock().unwrap() {
                    "corrupt".into()
                } else {
                    secret.into()
                },
            );
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.deletes.lock().unwrap().push(account.into());
            if *self.fail_delete.lock().unwrap() {
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
    fn combined() -> Secrets<FakeStore> {
        let store = Secrets::new(legacy());
        assert!(crate::credentials::load(&store).unwrap().is_some());
        store.store.reads.lock().unwrap().clear();
        store.store.writes.lock().unwrap().clear();
        Secrets::new(store.store)
    }
    // FLM-66: all startup consumers share exactly one item read.
    #[test]
    fn startup_reads_one_keychain_item_once() {
        let store = combined();
        std::thread::scope(|scope| {
            scope.spawn(|| assert!(store.get("last_user").unwrap().is_some()));
            scope.spawn(|| assert!(crate::credentials::load(&store).unwrap().is_some()));
            scope.spawn(|| {
                assert!(store
                    .get("openpgp_passphrase:alice@example.com")
                    .unwrap()
                    .is_some())
            });
            scope.spawn(|| assert!(store.get("mcp-token").unwrap().is_some()));
        });
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
    }
    // FLM-79 F1: Dev consolidation and subsequent writes never remove or alter
    // the originals read by the installed 0.18.0 release.
    #[test]
    fn consolidation_and_logout_retain_every_legacy_item() {
        let raw = legacy();
        let original = raw.items.lock().unwrap().clone();
        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).unwrap().is_some());
        store.set("mcp-token", "rotated-token").unwrap();
        crate::credentials::delete(&store).unwrap();
        for (account, secret) in &original {
            assert_eq!(store.store.items.lock().unwrap().get(account), Some(secret));
        }
        assert!(store.store.deletes.lock().unwrap().is_empty());
        let store = Secrets::new(store.store);
        assert!(crate::credentials::load(&store).unwrap().is_none());
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("rotated-token")
        );
        assert!(store
            .get("openpgp_passphrase:bob@example.org")
            .unwrap()
            .is_some());
    }
    // FLM-79 F3 state 1: live original wins; preserve the conflicting recovery copy.
    #[test]
    fn conflicting_backup_prefers_live_original_without_lockout() {
        let raw = legacy();
        raw.set("identity-migration-backup:mcp-token", "previous-token")
            .unwrap();
        raw.set(
            "identity-migration-backup:openpgp_passphrase:carol@example.net",
            "cmVjb3Zlcnk=",
        )
        .unwrap();
        let originals = raw.items.lock().unwrap().clone();
        let store = Secrets::new(raw);
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("test-token")
        );
        assert_eq!(
            store
                .get("identity-migration-backup:mcp-token")
                .unwrap()
                .as_deref(),
            Some("previous-token")
        );
        assert!(store
            .get("openpgp_passphrase:carol@example.net")
            .unwrap()
            .is_some());
        for (a, s) in originals {
            assert_eq!(store.store.items.lock().unwrap().get(&a), Some(&s));
        }
    }
    fn pending() -> FakeStore {
        let raw = legacy();
        let items = raw.items.lock().unwrap().clone();
        raw.set(ACCOUNT, &serde_json::json!({"version":1,"items":items,"pending_cleanup":["last_user","mcp-token"]}).to_string()).unwrap();
        raw.writes.lock().unwrap().clear();
        raw
    }
    // FLM-79 F3 state 2: an original changed after an earlier combined write.
    #[test]
    fn changed_original_does_not_block_loading_an_existing_bundle() {
        let raw = pending();
        raw.set("mcp-token", "older-app-updated-token").unwrap();
        let store = Secrets::new(raw);
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("test-token")
        );
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
        assert_eq!(
            store.store.items.lock().unwrap().get("mcp-token").unwrap(),
            "older-app-updated-token"
        );
    }
    // FLM-79 F3 state 3: cleanup delete or final rewrite is unavailable.
    #[test]
    fn cleanup_failures_cannot_block_a_verified_bundle() {
        let raw = pending();
        *raw.fail_delete.lock().unwrap() = true;
        *raw.fail_write.lock().unwrap() = true;
        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).unwrap().is_some());
        assert!(store
            .get("openpgp_passphrase:alice@example.com")
            .unwrap()
            .is_some());
        assert!(store.store.writes.lock().unwrap().is_empty());
        assert!(store.store.deletes.lock().unwrap().is_empty());
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
    }
    // Captain's migration ruling: failed writes or read-back keep originals usable.
    #[test]
    fn failed_migration_falls_back_without_deleting_sources() {
        for corrupt in [false, true] {
            let raw = legacy();
            let originals = raw.items.lock().unwrap().clone();
            *raw.fail_write.lock().unwrap() = !corrupt;
            *raw.corrupt_write.lock().unwrap() = corrupt;
            let store = Secrets::new(raw);
            assert!(crate::credentials::load(&store).unwrap().is_some());
            assert!(store
                .get("openpgp_passphrase:bob@example.org")
                .unwrap()
                .is_some());
            for (a, s) in originals {
                assert_eq!(store.store.items.lock().unwrap().get(&a), Some(&s));
            }
            assert!(store.store.deletes.lock().unwrap().is_empty());
            *store.store.fail_write.lock().unwrap() = false;
            *store.store.corrupt_write.lock().unwrap() = false;
            store.set("mcp-token", "legacy-rotated-token").unwrap();
            crate::credentials::delete(&store).unwrap();
            let store = Secrets::new(store.store);
            assert!(crate::credentials::load(&store).unwrap().is_none());
            assert_eq!(
                store.get("mcp-token").unwrap().as_deref(),
                Some("legacy-rotated-token")
            );
            assert!(store
                .get("openpgp_passphrase:alice@example.com")
                .unwrap()
                .is_some());
        }
    }
    // FLM-79 F4: cache only explicit denial/cancel, not locked/transient errors.
    #[test]
    fn denial_and_cancel_are_cached_but_transient_errors_retry() {
        for code in [-25293, -128, -25308, -25291] {
            let store = combined();
            *store.store.read_error.lock().unwrap() = Some((
                format!("Read macOS keychain ({code}): simulated platform failure"),
                1,
            ));
            assert!(store.get("mcp-token").is_err());
            if matches!(code, -25293 | -128) {
                assert!(store.get("mcp-token").is_err());
                assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
            } else {
                assert_eq!(
                    store.get("mcp-token").unwrap().as_deref(),
                    Some("test-token")
                );
                assert!(store.get("mcp-token").unwrap().is_some());
                assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT, ACCOUNT]);
            }
        }
    }
    // FLM-79 F7: identical saves and missing deletes must not invalidate other caches.
    #[test]
    fn no_op_changes_do_not_write_or_delete() {
        let store = combined();
        let credentials = crate::credentials::load(&store).unwrap().unwrap();
        crate::credentials::save(&store, &credentials).unwrap();
        store.set("mcp-token", "test-token").unwrap();
        store.delete("absent").unwrap();
        assert!(store.store.writes.lock().unwrap().is_empty());
        assert!(store.store.deletes.lock().unwrap().is_empty());
        store.set("mcp-token", "different-token").unwrap();
        assert_eq!(*store.store.writes.lock().unwrap(), [ACCOUNT]);
    }
    // FLM-66: unsupported data must not authorize overwriting the only newer copy.
    #[test]
    fn malformed_or_future_bundles_are_not_overwritten() {
        for value in ["not JSON", r#"{"version":2,"items":{}}"#] {
            let raw = legacy();
            raw.set(ACCOUNT, value).unwrap();
            let original = raw.items.lock().unwrap().clone();
            let store = Secrets::new(raw);
            assert!(store.set("mcp-token", "replacement").is_err());
            assert_eq!(*store.store.items.lock().unwrap(), original);
        }
    }
    // FLM-66: serial writes must preserve unrelated secrets across restart.
    #[test]
    fn concurrent_mutations_preserve_other_secrets() {
        let store = combined();
        std::thread::scope(|scope| {
            scope.spawn(|| store.set("mcp-token", "rotated-token").unwrap());
            scope.spawn(|| {
                store
                    .set("openpgp_passphrase:alice@example.com", "cm90YXRlZA==")
                    .unwrap()
            });
        });
        let store = Secrets::new(store.store);
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
    }
    // FLM-79 F5: one centralized log per failed operation, not one per caller.
    #[test]
    fn load_and_write_errors_reach_the_log_once() {
        use std::{io::Write, sync::Arc};
        #[derive(Clone)]
        struct Capture(Arc<Mutex<Vec<u8>>>);
        impl Write for Capture {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let output = Arc::new(Mutex::new(Vec::new()));
        let writer = Capture(output.clone());
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let store = combined();
            *store.store.read_error.lock().unwrap() =
                Some(("Read macOS keychain (-128): canceled".into(), 1));
            assert!(store.get("mcp-token").is_err());
            assert!(store.get("mcp-token").is_err());
            let store = combined();
            assert!(store.get("mcp-token").is_ok());
            *store.store.fail_write.lock().unwrap() = true;
            assert!(store.set("mcp-token", "new-token").is_err());
        });
        let output = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        assert_eq!(output.matches("macOS secrets load failed").count(), 1);
        assert_eq!(output.matches("macOS secrets write failed").count(), 1);
    }
}

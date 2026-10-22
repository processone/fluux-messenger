//! macOS keychain access lists belong to items, not services. Share one cached
//! item across desktop consumers, retaining legacy items for the 0.18.0 release.
use crate::credentials::SecretStore;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
};

const ACCOUNT: &str = "secrets-v1";
const BACKUP_PREFIX: &str = "identity-migration-backup:";
const RECOVERY_PREFIX: &str = "keychain-recovery:";
fn recovery_prefix(account: &str) -> String {
    format!("{RECOVERY_PREFIX}{}:{account}:", account.len())
}

/// Preserve platform status independently of localized/display error text.
#[derive(Debug, Clone)]
pub struct StoreError {
    code: Option<i32>,
    message: String,
}
impl StoreError {
    fn native(code: i32, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
        }
    }
    fn user_denial(&self) -> bool {
        matches!(self.code, Some(-25293 | -128))
    }
}
impl From<String> for StoreError {
    fn from(message: String) -> Self {
        Self {
            code: None,
            message,
        }
    }
}
impl From<&str> for StoreError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            Some(code) => write!(f, "{} ({code})", self.message),
            None => f.write_str(&self.message),
        }
    }
}
impl std::error::Error for StoreError {}
type StoreResult<T> = Result<T, StoreError>;

pub trait Backend: SecretStore {
    fn read(&self, account: &str) -> StoreResult<Option<String>>;
    /// Account attributes only; this must not decrypt secrets.
    fn accounts(&self) -> StoreResult<Vec<String>>;
}

#[derive(Clone, Serialize, Deserialize)]
struct Bundle {
    version: u32,
    #[serde(skip)]
    legacy: bool,
    items: BTreeMap<String, String>,
    #[serde(skip)]
    legacy_reads: BTreeMap<String, StoreResult<Option<String>>>,
}
impl Default for Bundle {
    fn default() -> Self {
        Self {
            version: 1,
            legacy: false,
            items: BTreeMap::new(),
            legacy_reads: BTreeMap::new(),
        }
    }
}

pub struct Secrets<S> {
    store: S,
    // Only an explicit denial/cancel is shared by overlapping consumers.
    // Transient failures leave the cache empty so the next caller can retry.
    cache: Mutex<Option<StoreResult<Bundle>>>,
}
impl<S: Backend> Secrets<S> {
    pub fn new(store: S) -> Self {
        Self {
            store,
            cache: Mutex::new(None),
        }
    }
    fn encode(bundle: &Bundle) -> StoreResult<String> {
        serde_json::to_string(bundle).map_err(|_| "Could not encode macOS secrets".into())
    }
    fn load(&self) -> StoreResult<Bundle> {
        if let Some(json) = self.store.read(ACCOUNT)? {
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
            if let Some(secret) = self.store.read(&account)? {
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
            let migrated = self
                .store
                .set(ACCOUNT, &json)
                .map_err(StoreError::from)
                .and_then(|()| {
                    if self.store.read(ACCOUNT)?.as_deref() == Some(json.as_str()) {
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
    pub fn legacy_candidate(&self, account: &str) -> Result<Option<String>, String> {
        self.access("legacy recovery", |bundle| {
            if bundle.legacy {
                return Ok(bundle.items.get(account).cloned());
            }
            if let Some(result) = bundle.legacy_reads.get(account) {
                return result.clone();
            }
            let result = self.store.read(account);
            // A completed read (including absence) or a user denial is one-shot.
            // A transient platform failure still retries, like the bundle read.
            if result
                .as_ref()
                .err()
                .is_none_or(|error| error.user_denial())
            {
                bundle.legacy_reads.insert(account.into(), result.clone());
            }
            result
        })
        .map_err(|error| error.to_string())
    }

    pub fn adopt_legacy(&self, account: &str, secret: &str) -> Result<(), String> {
        self.access("adopt legacy", |bundle| {
            if bundle
                .items
                .get(account)
                .is_some_and(|current| current == secret)
            {
                return Ok(());
            }
            if let Some(previous) = bundle.items.get(account).cloned().filter(|previous| {
                !bundle.items.iter().any(|(name, value)| {
                    name.starts_with(&recovery_prefix(account)) && value == previous
                })
            }) {
                let name = format!("{}{}", recovery_prefix(account), uuid::Uuid::new_v4());
                let mut saved = bundle.clone();
                saved.items.insert(name.clone(), previous.clone());
                // Persist the replaced value before changing the live slot. A
                // unique name never overwrites another identity's recovery copy.
                if bundle.legacy {
                    self.store.delete(ACCOUNT)?;
                    self.store.set(&name, &previous)?;
                } else {
                    self.store.set(ACCOUNT, &Self::encode(&saved)?)?;
                }
                *bundle = saved;
            }
            let mut adopted = bundle.clone();
            adopted.items.insert(account.into(), secret.into());
            if bundle.legacy {
                self.store.set(account, secret)?;
            } else {
                self.store.set(ACCOUNT, &Self::encode(&adopted)?)?;
            }
            *bundle = adopted;
            Ok(())
        })
        .map_err(|error| error.to_string())
    }

    fn access<T>(
        &self,
        operation: &str,
        f: impl FnOnce(&mut Bundle) -> StoreResult<T>,
    ) -> StoreResult<T> {
        let mut cache = self.cache.lock().map_err(|_| {
            let error = StoreError::from("macOS secrets lock poisoned");
            tracing::error!("macOS secrets {operation} failed: {error}");
            error
        })?;
        if cache.is_none() {
            match self.load() {
                Ok(bundle) => *cache = Some(Ok(bundle)),
                Err(error) => {
                    tracing::error!("macOS secrets load failed: {error}");
                    if error.user_denial() {
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
    fn legacy_candidate(&self, account: &str) -> Result<Option<String>, String> {
        Secrets::legacy_candidate(self, account)
    }
    fn adopt_legacy(&self, account: &str, secret: &str) -> Result<(), String> {
        Secrets::adopt_legacy(self, account, secret)
    }
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.access("read", |bundle| Ok(bundle.items.get(account).cloned()))
            .map_err(|error| error.to_string())
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
        .map_err(|error| error.to_string())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.access("delete", |bundle| {
            let prefix = recovery_prefix(account);
            let backup = format!("{BACKUP_PREFIX}{account}");
            let mut copies = BTreeSet::from([account.to_string(), backup]);
            copies.extend(
                bundle
                    .items
                    .keys()
                    .filter(|key| key.starts_with(&prefix))
                    .cloned(),
            );
            let mut updated = bundle.clone();
            let mut changed = false;
            for name in &copies {
                changed |= updated.items.remove(name).is_some();
                updated.legacy_reads.insert(name.clone(), Ok(None));
            }
            if bundle.legacy {
                self.store.delete(ACCOUNT)?;
            } else if changed {
                self.store.set(ACCOUNT, &Self::encode(&updated)?)?;
            }
            *bundle = updated;
            // The keychain's attributes reveal retained recovery names without
            // decrypting them, including a retry after a partial old-copy erase.
            let mut failure = None;
            match self.store.accounts() {
                Ok(names) => {
                    copies.extend(names.into_iter().filter(|key| key.starts_with(&prefix)))
                }
                Err(error) => failure = Some(error),
            }
            for name in copies {
                if let Err(error) = self.store.delete(&name) {
                    if failure.is_none() {
                        failure = Some(error.into());
                    }
                }
            }
            if let Some(error) = failure {
                Err(error)
            } else {
                Ok(())
            }
        })
        .map_err(|error| error.to_string())
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
            self.read(account).map_err(|error| error.to_string())
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
        fn read(&self, account: &str) -> StoreResult<Option<String>> {
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
                Err(e) => Err(StoreError::native(
                    e.code(),
                    format!("Read macOS keychain: {e}"),
                )),
            }
        }

        fn accounts(&self) -> StoreResult<Vec<String>> {
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
                Err(e) => Err(StoreError::native(
                    e.code(),
                    format!("List macOS keychain: {e}"),
                )),
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
        if action == "legacy-erased" {
            for account in [
                "last_user",
                "alice@example.com",
                "openpgp_passphrase:alice@example.com",
            ] {
                assert!(raw.get(account).unwrap().is_none());
                assert!(raw
                    .get(&format!("{BACKUP_PREFIX}{account}"))
                    .unwrap()
                    .is_none());
            }
            println!("explicit logout/forget erased matching old originals and backups");
            return;
        }
        if action == "forget" {
            Secrets::new(raw)
                .delete("openpgp_passphrase:alice@example.com")
                .unwrap();
            println!("explicit forget removed bundled and legacy passphrases");
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
            fn read(&self, a: &str) -> StoreResult<Option<String>> {
                self.reads.lock().unwrap().push(a.into());
                self.raw.read(a)
            }
            fn accounts(&self) -> StoreResult<Vec<String>> {
                self.raw.accounts()
            }
        }
        let store = Secrets::new(Traced {
            raw,
            fail_new: action == "write-failed",
            reads: Mutex::new(Vec::new()),
        });
        if action == "denied" {
            assert!(crate::credentials::load(&store).is_err());
            assert!(
                matches!(store.cache.lock().unwrap().as_ref(), Some(Err(error)) if error.user_denial())
            );
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
        crate::credentials::delete_macos(&store).unwrap();
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
        snapshots: Mutex<Vec<BTreeMap<String, String>>>,
        deletes: Mutex<Vec<String>>,
        read_error: Mutex<Option<(StoreError, usize)>>,
        fail_write: Mutex<bool>,
        fail_delete: Mutex<bool>,
        corrupt_write: Mutex<bool>,
    }
    impl SecretStore for FakeStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.read(account).map_err(|error| error.to_string())
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
            if account == ACCOUNT {
                let stored = self.items.lock().unwrap().get(account).cloned().unwrap();
                if let Ok(bundle) = serde_json::from_str::<Bundle>(&stored) {
                    self.snapshots.lock().unwrap().push(bundle.items);
                }
            }
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
        fn read(&self, account: &str) -> StoreResult<Option<String>> {
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

        fn accounts(&self) -> StoreResult<Vec<String>> {
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
    // FLM-79 F1 / R1: migration retains compatibility copies; explicit logout
    // removes only the matching originals, not unrelated account secrets.
    #[test]
    fn migration_retains_originals_but_explicit_logout_removes_matching_copies() {
        let raw = legacy();
        let original = raw.items.lock().unwrap().clone();
        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).unwrap().is_some());
        store.set("mcp-token", "rotated-token").unwrap();
        crate::credentials::delete_macos(&store).unwrap();
        for (account, secret) in &original {
            if matches!(account.as_str(), "last_user" | "alice@example.com") {
                assert!(!store.store.items.lock().unwrap().contains_key(account));
            } else {
                assert_eq!(store.store.items.lock().unwrap().get(account), Some(secret));
            }
        }
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
            crate::credentials::delete_macos(&store).unwrap();
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
                StoreError::native(
                    code,
                    "localized wording that does not contain a status code",
                ),
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
        struct Capture {
            output: Arc<Mutex<Vec<u8>>>,
            owner: std::thread::ThreadId,
        }
        impl Write for Capture {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                if std::thread::current().id() == self.owner {
                    self.output.lock().unwrap().extend_from_slice(b);
                }
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let output = Arc::new(Mutex::new(Vec::new()));
        let writer = Capture {
            output: output.clone(),
            owner: std::thread::current().id(),
        };
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_writer(move || writer.clone())
            .finish();
        // A scoped thread-local subscriber can race callsite registration from
        // parallel tests with no subscriber. Own one stable global dispatcher;
        // capture only this test's thread so sibling events cannot affect counts.
        tracing::subscriber::set_global_default(subscriber).unwrap();
        {
            let store = combined();
            *store.store.read_error.lock().unwrap() =
                Some((StoreError::native(-128, "canceled"), 1));
            assert!(store.get("mcp-token").is_err());
            assert!(store.get("mcp-token").is_err());
            let store = combined();
            assert!(store.get("mcp-token").is_ok());
            *store.store.fail_write.lock().unwrap() = true;
            assert!(store.set("mcp-token", "new-token").is_err());
        }
        let output = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        assert_eq!(output.matches("macOS secrets load failed").count(), 1);
        assert_eq!(output.matches("macOS secrets write failed").count(), 1);
    }
    // FLM-79 R1: explicit forget removes originals and backup copies in both layouts.
    #[test]
    fn explicit_delete_erases_original_and_backup_even_when_bundle_entry_is_absent() {
        let raw = legacy();
        let account = "openpgp_passphrase:alice@example.com";
        let backup = format!("{BACKUP_PREFIX}{account}");
        raw.set(&backup, "previous-passphrase").unwrap();
        let store = Secrets::new(raw);
        assert!(store.get(account).unwrap().is_some());
        store.delete(account).unwrap();
        assert!(store.get(account).unwrap().is_none());
        assert!(store.get(&backup).unwrap().is_none());
        assert!(!store.store.items.lock().unwrap().contains_key(account));
        assert!(!store.store.items.lock().unwrap().contains_key(&backup));
        // A partial old-item delete can be retried after the bundle was cleared.
        store.store.set(account, "late-old-copy").unwrap();
        store.delete(account).unwrap();
        assert!(!store.store.items.lock().unwrap().contains_key(account));
        assert!(store.legacy_candidate(account).unwrap().is_none());
    }
    // FLM-79 R2: a recovery read is on-demand and bounded to once per account.
    #[test]
    fn legacy_recovery_reads_once_and_adoption_survives_restart() {
        let store = combined();
        let account = "openpgp_passphrase:alice@example.com";
        assert!(store.get(account).unwrap().is_some());
        store.store.set(account, "cmVwbGFjZWQta2V5").unwrap();
        assert_eq!(
            store.legacy_candidate(account).unwrap().as_deref(),
            Some("cmVwbGFjZWQta2V5")
        );
        assert_eq!(
            store.legacy_candidate(account).unwrap().as_deref(),
            Some("cmVwbGFjZWQta2V5")
        );
        assert_eq!(
            store
                .store
                .reads
                .lock()
                .unwrap()
                .iter()
                .filter(|a| a.as_str() == account)
                .count(),
            1
        );
        store.set(account, "cmVwbGFjZWQta2V5").unwrap();
        let store = Secrets::new(store.store);
        assert_eq!(
            store.get(account).unwrap().as_deref(),
            Some("cmVwbGFjZWQta2V5")
        );
    }
    // FLM-79 R4: status codes, not error wording, govern denial caching.
    #[test]
    fn denial_text_without_a_denial_code_is_not_cached() {
        let store = combined();
        *store.store.read_error.lock().unwrap() =
            Some((StoreError::native(-25308, "macOS keychain (-25293)"), 1));
        assert!(store.get("mcp-token").is_err());
        assert!(store.get("mcp-token").unwrap().is_some());
    }
    // FLM-79 R1: old-item refusal cannot keep the current secret in the bundle,
    // and a failed original must not prevent attempting its backup cleanup.
    #[test]
    fn old_cleanup_failure_does_not_undo_current_secret_erasure() {
        let store = combined();
        let account = "openpgp_passphrase:alice@example.com";
        assert!(store.get(account).unwrap().is_some());
        *store.store.fail_delete.lock().unwrap() = true;
        assert!(store.delete(account).is_err());
        assert!(store.get(account).unwrap().is_none());
        assert_eq!(
            store
                .store
                .deletes
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([account.to_string(), format!("{BACKUP_PREFIX}{account}")])
        );
        assert!(store.store.items.lock().unwrap().contains_key(account));
        let store = Secrets::new(store.store);
        assert!(store.get(account).unwrap().is_none());
    }
    // FLM-79 S4: adoption first persists a uniquely named replaced value, and
    // explicit forget removes every matching recovery value too.
    #[test]
    fn adoption_preserves_replaced_values_before_overwrite() {
        let store = combined();
        let account = "openpgp_passphrase:alice@example.com";
        let previous = store.get(account).unwrap().unwrap();
        store.store.snapshots.lock().unwrap().clear();
        store.adopt_legacy(account, "recovered-passphrase").unwrap();
        let snapshots = store.store.snapshots.lock().unwrap();
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].get(account), Some(&previous));
        let saved = snapshots[0]
            .iter()
            .find(|(name, value)| {
                name.starts_with(&recovery_prefix(account)) && *value == &previous
            })
            .unwrap()
            .0
            .clone();
        assert_eq!(snapshots[1].get(&saved), Some(&previous));
        assert_eq!(
            snapshots[1].get(account).map(String::as_str),
            Some("recovered-passphrase")
        );
        drop(snapshots);
        store.adopt_legacy(account, "another-passphrase").unwrap();
        let bundle: Bundle =
            serde_json::from_str(store.store.items.lock().unwrap().get(ACCOUNT).unwrap()).unwrap();
        assert_eq!(
            bundle
                .items
                .keys()
                .filter(|name| name.starts_with(&recovery_prefix(account)))
                .count(),
            2
        );
        store.delete(account).unwrap();
        assert!(store.get(&saved).unwrap().is_none());
        assert!(!store.store.items.lock().unwrap().contains_key(account));
    }
    // FLM-79 S1: real bundle deletion errors still allow macOS pointer cleanup.
    #[test]
    fn macos_logout_erases_last_user_even_if_old_copies_refuse_cleanup() {
        let store = combined();
        assert!(crate::credentials::load(&store).unwrap().is_some());
        *store.store.fail_delete.lock().unwrap() = true;
        assert!(crate::credentials::delete_macos(&store).is_err());
        assert!(store.get("last_user").unwrap().is_none());
        assert!(store.get("alice@example.com").unwrap().is_none());
        let store = Secrets::new(store.store);
        assert!(crate::credentials::load(&store).unwrap().is_none());
    }
    // FLM-79 S4: a backup write failure must leave the replaced value live.
    #[test]
    fn refused_recovery_backup_never_overwrites_the_replaced_value() {
        let store = combined();
        let account = "openpgp_passphrase:alice@example.com";
        let previous = store.get(account).unwrap().unwrap();
        *store.store.fail_write.lock().unwrap() = true;
        assert!(store.adopt_legacy(account, "new-passphrase").is_err());
        assert_eq!(store.get(account).unwrap(), Some(previous));
    }
}

//! macOS keychain access lists belong to items, not services. Share one cached
//! item across desktop consumers, retaining legacy items for the 0.18.0 release.
use crate::credentials::SecretStore;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
};

const ACCOUNT: &str = "secrets-v1";
// Combined item of a user who restored from a backup instead of migrating. It
// never coexists with the old items' access lists, so a refused or inaccessible
// legacy item cannot block it.
const FRESH_ACCOUNT: &str = "secrets-fresh-v1";
fn is_bundle(account: &str) -> bool {
    account == ACCOUNT || account == FRESH_ACCOUNT
}
const BACKUP_PREFIX: &str = "identity-migration-backup:";
const RECOVERY_PREFIX: &str = "keychain-recovery:";
fn recovery_prefix(account: &str) -> String {
    format!("{RECOVERY_PREFIX}{}:{account}:", account.len())
}

/// Preserve platform status independently of localized/display error text.
#[derive(Debug, Clone)]
pub struct StoreError {
    code: Option<i32>,
    invalid_item: bool,
    message: String,
}
impl StoreError {
    fn native(code: i32, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            invalid_item: false,
            message: message.into(),
        }
    }
    #[cfg(test)]
    pub(crate) fn denied() -> Self {
        Self::native(-25293, "authorization refused")
    }
    fn user_denial(&self) -> bool {
        matches!(self.code, Some(-25293 | -128))
    }
    fn invalid_item(message: &str) -> Self {
        Self {
            invalid_item: true,
            ..Self::from(message)
        }
    }
}
impl From<String> for StoreError {
    fn from(message: String) -> Self {
        Self {
            code: None,
            invalid_item: false,
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
    /// Whether the user chose to leave the old items behind for good.
    fn fresh_start(&self) -> bool {
        false
    }
    /// Persist that choice; it must outlive this process.
    fn mark_fresh_start(&self) -> StoreResult<()> {
        Err("Fresh start is unavailable for this store".into())
    }
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
    // Denial/cancel and deterministic combined-item decode/version failures
    // are shared for this launch. Transient failures leave the cache empty.
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
    fn account(&self) -> &'static str {
        if self.store.fresh_start() {
            FRESH_ACCOUNT
        } else {
            ACCOUNT
        }
    }
    fn load(&self) -> StoreResult<Bundle> {
        let fresh = self.store.fresh_start();
        if let Some(json) = self.store.read(self.account())? {
            let bundle: Bundle = serde_json::from_str(&json).map_err(|_| {
                StoreError::invalid_item("Invalid macOS secrets item; refusing to overwrite it")
            })?;
            if bundle.version != 1 {
                return Err(StoreError::invalid_item(
                    "Unsupported macOS secrets version",
                ));
            }
            // No legacy reads or cleanup once the bundle exists. In particular,
            // ignore pending_cleanup from an earlier development build.
            return Ok(bundle);
        }
        if fresh {
            // Nothing is read from, or cleaned up in, the old layout.
            return Ok(Bundle::default());
        }
        let mut bundle = Bundle::default();
        for account in self.store.accounts()? {
            if is_bundle(&account) {
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
                .set(self.account(), &json)
                .map_err(StoreError::from)
                .and_then(|()| {
                    self.store
                        .read(self.account())?
                        .and_then(|json| serde_json::from_str::<Bundle>(&json).ok())
                        .ok_or_else(|| "Could not verify migrated macOS secrets".into())
                });
            match migrated {
                Ok(verified) => {
                    if verified.version != 1 {
                        return Err(StoreError::invalid_item(
                            "Unsupported macOS secrets version",
                        ));
                    }
                    // Read-back also observes the writer revision. Cache that
                    // exact bundle: another instance may have changed it since
                    // our write, including removing retained legacy secrets.
                    bundle = verified;
                }
                Err(error) => {
                    tracing::error!(
                        "macOS secrets migration failed; using legacy items for this launch: {error}"
                    );
                    bundle.legacy = true;
                }
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

    pub fn recovery_candidates(&self, account: &str) -> Result<Vec<String>, String> {
        self.access("recovery copies", |bundle| {
            let prefix = recovery_prefix(account);
            Ok(bundle
                .items
                .iter()
                .filter(|(name, _)| name.starts_with(&prefix))
                .map(|(_, value)| value.clone())
                .collect())
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
            if bundle.legacy {
                // An unverified combined item must not survive either legacy write.
                self.store.delete(self.account())?;
            }
            let mut adopted = bundle.clone();
            if let Some(previous) = bundle.items.get(account).cloned().filter(|previous| {
                !bundle.items.iter().any(|(name, value)| {
                    name.starts_with(&recovery_prefix(account)) && value == previous
                })
            }) {
                let name = format!("{}{}", recovery_prefix(account), uuid::Uuid::new_v4());
                adopted.items.insert(name.clone(), previous.clone());
                if bundle.legacy {
                    // Separate old items require a durable backup before the
                    // live slot changes. Preserve it in the cache if that fails.
                    self.store.set(&name, &previous)?;
                    *bundle = adopted.clone();
                }
            }
            // In the normal layout both values share one atomic item update.
            // Do not add an intermediate write (and revision bump).
            adopted.items.insert(account.into(), secret.into());
            if bundle.legacy {
                self.store.set(account, secret)?;
            } else {
                self.store.set(self.account(), &Self::encode(&adopted)?)?;
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
                    if error.user_denial() || error.invalid_item {
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
    fn start_fresh(&self) -> Result<(), String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "macOS secrets lock poisoned".to_string())?;
        self.store
            .mark_fresh_start()
            .map_err(|error| error.to_string())?;
        // Drop a cached denial of the old items: they are never read again.
        *cache = None;
        Ok(())
    }
    fn retry_denied_access(&self) -> Result<(), String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "macOS secrets lock poisoned".to_string())?;
        if matches!(cache.as_ref(), Some(Err(error)) if error.user_denial()) {
            *cache = None;
        }
        Ok(())
    }
    fn legacy_candidate(&self, account: &str) -> Result<Option<String>, String> {
        Secrets::legacy_candidate(self, account)
    }
    fn recovery_candidates(&self, account: &str) -> Result<Vec<String>, String> {
        Secrets::recovery_candidates(self, account)
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
                self.store.delete(self.account())?;
                self.store.set(account, secret)?;
            } else {
                self.store.set(self.account(), &Self::encode(&updated)?)?;
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
                self.store.delete(self.account())?;
            } else if changed {
                self.store.set(self.account(), &Self::encode(&updated)?)?;
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
        #[cfg(test)]
        revision_dir: Option<std::path::PathBuf>,
    }
    impl Keychain {
        // Release and Dev share the item but not their memory caches. A shared,
        // secret-free revision file rejects stale writers without a second
        // keychain read (which could prompt again). Never silently overwrite a
        // password, logout or token rotation saved by another running identity.
        fn revision_path(&self) -> Result<std::path::PathBuf, String> {
            #[cfg(test)]
            if let Some(dir) = &self.revision_dir {
                return Ok(dir.join(".secrets-revision"));
            }
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
        // Secret-free marker of the choice to restore from a backup rather than
        // migrate. Shared by Release and Dev like the revision file.
        fn fresh_marker_path(&self) -> Result<std::path::PathBuf, String> {
            let revision = self.revision_path()?;
            Ok(if self.keychain.is_some() {
                revision.with_extension("fresh")
            } else {
                revision.with_file_name(".secrets-fresh-start")
            })
        }
        fn revision(
            &self,
            exclusive: bool,
        ) -> Result<(std::fs::File, std::path::PathBuf, u64), String> {
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
            // Readers may wait for authorization while holding this lock. Let
            // other readers proceed, but keep writes exclusive through mutation.
            if exclusive {
                file.lock()
            } else {
                file.lock_shared()
            }
            .map_err(|e| e.to_string())?;
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
            self.bump_revision(true)
        }
        // `verify` is false only for the fresh-start transition, which must
        // advance the revision even when this process never observed one.
        fn bump_revision(&self, verify: bool) -> Result<std::fs::File, String> {
            use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
            let (lock, path, revision) = self.revision(true)?;
            let mut observed = self
                .observed_revision
                .lock()
                .map_err(|_| "Revision lock poisoned")?;
            if verify && *observed != Some(revision) {
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
            let _revision = if is_bundle(account) {
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
            let _revision = if is_bundle(account) {
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
        fn fresh_start(&self) -> bool {
            self.fresh_marker_path().is_ok_and(|path| path.exists())
        }

        fn mark_fresh_start(&self) -> StoreResult<()> {
            let path = self.fresh_marker_path()?;
            std::fs::create_dir_all(path.parent().ok_or("Missing marker directory")?)
                .map_err(|e| e.to_string())?;
            // Hold the exclusive revision lock across the switch and advance the
            // revision, so a running sibling's cached bundle can no longer be
            // written into the new item. It must quit and reopen, as for any
            // other stale write.
            let _revision = self.bump_revision(false)?;
            std::fs::write(&path, b"1")
                .map_err(|e| format!("Could not record the fresh start: {e}").into())
        }

        fn read(&self, account: &str) -> StoreResult<Option<String>> {
            let revision = if is_bundle(account) {
                self.revision(false).ok()
            } else {
                None
            };
            if is_bundle(account) {
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
                Ok((bytes, _)) => String::from_utf8(bytes.to_vec()).map(Some).map_err(|_| {
                    if is_bundle(account) {
                        StoreError::invalid_item("Invalid keychain text")
                    } else {
                        "Invalid keychain text".into()
                    }
                }),
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
    // FLM-298 review R4: switching to fresh storage must reject a running
    // sibling's stale cached bundle. Touches only files in a temporary directory.
    #[test]
    fn fresh_start_transition_rejects_a_stale_sibling_write() {
        let dir = std::env::temp_dir().join(format!("fluux-fresh-{}", uuid::Uuid::new_v4()));
        let make = || Keychain {
            revision_dir: Some(dir.clone()),
            ..Keychain::default()
        };
        let (sibling, restoring) = (make(), make());
        *sibling.observed_revision.lock().unwrap() = Some(0);
        assert!(!sibling.fresh_start());
        restoring.mark_fresh_start().unwrap();
        assert!(sibling.fresh_start() && restoring.fresh_start());
        let error = sibling.begin_write().unwrap_err();
        assert!(error.contains("quit and reopen"), "{error}");
        std::fs::remove_dir_all(dir).unwrap();
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
        // FLM-104 I1: the launcher holds a shared revision lock in a separate
        // process. A pending reader must not serialize another identity's read.
        if action == "shared-read" {
            assert!(raw.get(ACCOUNT).unwrap().is_some());
            println!("second identity read the combined item while another reader held its revision lock");
            return;
        }
        if action == "exclusive-write" {
            assert!(raw.get(ACCOUNT).unwrap().is_some());
            let _write = raw.begin_write().unwrap();
            let contender = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(raw.revision_path().unwrap().with_extension("lock"))
                .unwrap();
            assert!(matches!(
                contender.try_lock_shared(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
            assert!(matches!(
                contender.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
            println!("exclusive write still excludes both readers and writers");
            return;
        }
        // FLM-104 I3: exercise native UTF-8 decoding as well as bundle decoding.
        let invalid: Option<&[u8]> = match action.as_str() {
            "invalid-utf8" => Some(&[0xff]),
            "invalid-json" => Some(b"not JSON"),
            "invalid-version" => Some(br#"{"version":2,"items":{}}"#),
            _ => None,
        };
        if let Some(bytes) = invalid {
            raw.keychain
                .as_ref()
                .unwrap()
                .add_generic_password(SERVICE, ACCOUNT, bytes)
                .unwrap();
        }
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
        if let Some(bytes) = invalid {
            let error = crate::credentials::load(&store).unwrap_err();
            assert_eq!(store.get("mcp-token").unwrap_err(), error);
            assert_eq!(
                store
                    .get("openpgp_passphrase:alice@example.com")
                    .unwrap_err(),
                error
            );
            store.retry_denied_access().unwrap();
            assert_eq!(store.set("mcp-token", "replacement").unwrap_err(), error);
            assert_eq!(store.delete("mcp-token").unwrap_err(), error);
            assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
            let (stored, _) = find_generic_password(
                store.store.raw.keychain.as_ref().map(std::slice::from_ref),
                SERVICE,
                ACCOUNT,
            )
            .unwrap();
            assert_eq!(stored.to_vec(), bytes);
            println!("{action}: one native read across startup consumers and explicit retry; original item unchanged");
            return;
        }
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
        concurrent_migration_bundle: Mutex<Option<Bundle>>,
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
            if is_bundle(account) {
                let stored = self.items.lock().unwrap().get(account).cloned().unwrap();
                if let Ok(bundle) = serde_json::from_str::<Bundle>(&stored) {
                    self.snapshots.lock().unwrap().push(bundle.items);
                }
                // Another instance writes after migration, before its read-back.
                if let Some(bundle) = self.concurrent_migration_bundle.lock().unwrap().take() {
                    self.items
                        .lock()
                        .unwrap()
                        .insert(ACCOUNT.into(), serde_json::to_string(&bundle).unwrap());
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
            if is_bundle(account) {
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
    #[test]
    fn migration_preserves_concurrent_changes_during_read_back() {
        let raw = legacy();
        let mut concurrent = Bundle {
            items: raw.items.lock().unwrap().clone(),
            ..Bundle::default()
        };
        concurrent.items.insert(
            "openpgp_passphrase:carol@example.net".into(),
            "new-passphrase".into(),
        );
        concurrent.items.insert(
            "openpgp_passphrase:alice@example.com".into(),
            "updated-passphrase".into(),
        );
        concurrent
            .items
            .remove("openpgp_passphrase:bob@example.org");
        *raw.concurrent_migration_bundle.lock().unwrap() = Some(concurrent);

        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).unwrap().is_some());
        store.set("mcp-token", "rotated-token").unwrap();

        let restarted = Secrets::new(store.store);
        assert_eq!(
            restarted
                .get("openpgp_passphrase:carol@example.net")
                .unwrap()
                .as_deref(),
            Some("new-passphrase")
        );
        assert_eq!(
            restarted
                .get("openpgp_passphrase:alice@example.com")
                .unwrap()
                .as_deref(),
            Some("updated-passphrase")
        );
        assert!(restarted
            .get("openpgp_passphrase:bob@example.org")
            .unwrap()
            .is_none());
        assert_eq!(
            restarted.get("mcp-token").unwrap().as_deref(),
            Some("rotated-token")
        );
    }

    #[test]
    fn migration_does_not_overwrite_a_concurrent_future_bundle() {
        let raw = legacy();
        let future = Bundle {
            version: 2,
            ..Bundle::default()
        };
        let expected = serde_json::to_string(&future).unwrap();
        *raw.concurrent_migration_bundle.lock().unwrap() = Some(future);
        let store = Secrets::new(raw);

        assert!(store.set("mcp-token", "replacement").is_err());
        assert!(store.delete("mcp-token").is_err());
        assert_eq!(
            store.store.read(ACCOUNT).unwrap().as_deref(),
            Some(expected.as_str())
        );
        assert!(store.store.deletes.lock().unwrap().is_empty());
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
    // FLM-79 F4: cache native denial/cancel, not locked/transient errors.
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
    // FLM-66 / FLM-104 I3: unsupported data is read once per launch and never
    // overwritten, even by an explicit denial retry. A new launch can retry it.
    #[test]
    fn malformed_or_future_bundles_are_cached_without_overwriting() {
        for value in ["not JSON", r#"{"version":2,"items":{}}"#] {
            let raw = legacy();
            raw.set(ACCOUNT, value).unwrap();
            raw.reads.lock().unwrap().clear();
            raw.writes.lock().unwrap().clear();
            let original = raw.items.lock().unwrap().clone();
            let store = Secrets::new(raw);
            let failure = crate::credentials::load(&store).unwrap_err();
            assert_eq!(store.get("mcp-token").unwrap_err(), failure);
            assert_eq!(
                store
                    .get("openpgp_passphrase:alice@example.com")
                    .unwrap_err(),
                failure
            );
            store.retry_denied_access().unwrap();
            assert_eq!(store.set("mcp-token", "replacement").unwrap_err(), failure);
            assert_eq!(store.delete("mcp-token").unwrap_err(), failure);
            assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
            assert!(store.store.writes.lock().unwrap().is_empty());
            assert!(store.store.deletes.lock().unwrap().is_empty());
            assert_eq!(*store.store.items.lock().unwrap(), original);
            // Even if another app repairs the item, this launch keeps its error.
            let repaired = serde_json::to_string(&Bundle::default()).unwrap();
            store
                .store
                .items
                .lock()
                .unwrap()
                .insert(ACCOUNT.into(), repaired);
            assert_eq!(store.get("mcp-token").unwrap_err(), failure);
            let restarted = Secrets::new(store.store);
            assert!(restarted.get("mcp-token").unwrap().is_none());
            assert_eq!(*restarted.store.reads.lock().unwrap(), [ACCOUNT, ACCOUNT]);
            println!(
                "malformed/future item: one read per launch, no writes or deletes, restart retries"
            );
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
    // FLM-79 S4 / FLM-84 F4: one atomic adoption preserves the replaced value
    // alongside the new slot; explicit forget removes the recovery copy too.
    #[test]
    fn adoption_preserves_replaced_values_before_overwrite() {
        let store = combined();
        let account = "openpgp_passphrase:alice@example.com";
        let previous = store.get(account).unwrap().unwrap();
        store.store.snapshots.lock().unwrap().clear();
        store.store.writes.lock().unwrap().clear();
        store.adopt_legacy(account, "recovered-passphrase").unwrap();
        assert_eq!(*store.store.writes.lock().unwrap(), [ACCOUNT]);
        let snapshots = store.store.snapshots.lock().unwrap();
        assert_eq!(snapshots.len(), 1);
        let saved = snapshots[0]
            .iter()
            .find(|(name, value)| {
                name.starts_with(&recovery_prefix(account)) && *value == &previous
            })
            .unwrap()
            .0
            .clone();
        assert_eq!(snapshots[0].get(&saved), Some(&previous));
        assert_eq!(
            snapshots[0].get(account).map(String::as_str),
            Some("recovered-passphrase")
        );
        drop(snapshots);
        store.adopt_legacy(account, "another-passphrase").unwrap();
        assert_eq!(*store.store.writes.lock().unwrap(), [ACCOUNT, ACCOUNT]);
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
        assert_eq!(store.get(account).unwrap(), Some(previous.clone()));
        assert!(store.recovery_candidates(account).unwrap().is_empty());
        let restarted = Secrets::new(store.store);
        assert_eq!(restarted.get(account).unwrap(), Some(previous));
        assert!(restarted.recovery_candidates(account).unwrap().is_empty());
    }
    // FLM-84 F4: unlike one combined item, fallback items need ordered writes.
    #[test]
    fn legacy_adoption_keeps_backup_before_live_slot_ordering() {
        let store = Secrets::new(legacy());
        let account = "openpgp_passphrase:alice@example.com";
        *store.store.fail_write.lock().unwrap() = true;
        let previous = store.get(account).unwrap().unwrap();
        *store.store.fail_write.lock().unwrap() = false;
        store.store.writes.lock().unwrap().clear();
        store.adopt_legacy(account, "recovered-passphrase").unwrap();
        let writes = store.store.writes.lock().unwrap();
        assert_eq!(writes.len(), 2);
        assert!(writes[0].starts_with(&recovery_prefix(account)));
        assert_eq!(writes[1], account);
        assert_eq!(store.store.get(&writes[0]).unwrap(), Some(previous));
        assert_eq!(
            store.store.get(account).unwrap().as_deref(),
            Some("recovered-passphrase")
        );
    }
    // Captain's T2: selecting an account's loaded recovery copies must not
    // decrypt another keychain item or include another account's copies.
    #[test]
    fn recovery_copy_lookup_uses_only_the_loaded_account_values() {
        let store = combined();
        let alice = "openpgp_passphrase:alice@example.com";
        let previous = store.get(alice).unwrap().unwrap();
        store.adopt_legacy(alice, "new-alice-passphrase").unwrap();
        store
            .adopt_legacy("openpgp_passphrase:bob@example.org", "new-bob-passphrase")
            .unwrap();
        store.store.reads.lock().unwrap().clear();
        assert_eq!(store.recovery_candidates(alice).unwrap(), [previous]);
        assert!(store.store.reads.lock().unwrap().is_empty());
    }
    // FLM-93 F2: explicit wipe retries cached Deny/Cancel once, not ordinary logout.
    #[test]
    fn explicit_wipe_retries_cached_denial_once() {
        for code in [-25293, -128] {
            for denied_again in [false, true] {
                let store = combined();
                *store.store.read_error.lock().unwrap() = Some((
                    StoreError::native(code, "denied"),
                    if denied_again { 2 } else { 1 },
                ));
                assert!(store.get("last_user").is_err());
                assert!(crate::credentials::delete_macos(&store).is_err());
                assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);
                let erased = crate::credentials::delete_macos_explicit(&store);
                assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT, ACCOUNT]);
                if denied_again {
                    assert!(erased.is_err());
                    assert!(store.get("last_user").is_err());
                    assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT, ACCOUNT]);
                } else {
                    erased.unwrap();
                    let restarted = Secrets::new(store.store);
                    assert!(crate::credentials::load(&restarted).unwrap().is_none());
                    assert!(restarted.store.get("alice@example.com").unwrap().is_none());
                }
            }
        }
    }

    // FLM-93 F3: even without a new recovery copy, clear the failed replacement.
    #[test]
    fn legacy_adoption_discards_unverified_bundle_without_a_new_backup() {
        for has_previous in [false, true] {
            let raw = legacy();
            let account = if has_previous {
                "openpgp_passphrase:alice@example.com"
            } else {
                "openpgp_passphrase:new@example.com"
            };
            if has_previous {
                let previous = raw.get(account).unwrap().unwrap();
                raw.set(&format!("{}existing", recovery_prefix(account)), &previous)
                    .unwrap();
            }
            let store = Secrets::new(raw);
            *store.store.corrupt_write.lock().unwrap() = true;
            let _ = store.get(account).unwrap();
            assert_eq!(
                store.store.get(ACCOUNT).unwrap().as_deref(),
                Some("corrupt")
            );
            *store.store.corrupt_write.lock().unwrap() = false;
            store.adopt_legacy(account, "recovered-passphrase").unwrap();
            assert!(store.store.get(ACCOUNT).unwrap().is_none());
            let restarted = Secrets::new(store.store);
            assert_eq!(
                restarted.get(account).unwrap().as_deref(),
                Some("recovered-passphrase")
            );
        }
    }
}

//! macOS keychain access lists belong to items, not services. Share one cached
//! item across desktop consumers, retaining legacy items for the 0.18.0 release.
use crate::credentials::SecretStore;
use crate::keychain_refusal::{RefusalState, RefusedRetry};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
};

// The backend reports access lifetime without depending on any UI or startup
// policy. The desktop composition root may register an observer once.
type AccessObserver = fn(bool);
static ACCESS_OBSERVER: std::sync::OnceLock<AccessObserver> = std::sync::OnceLock::new();
pub fn register_access_observer(observer: AccessObserver) {
    let _ = ACCESS_OBSERVER.set(observer);
}
struct AccessScope(Option<AccessObserver>);
impl AccessScope {
    fn new(observer: Option<AccessObserver>) -> Self {
        if let Some(observer) = observer { observer(true); }
        Self(observer)
    }
    fn begin() -> Self { Self::new(ACCESS_OBSERVER.get().copied()) }
}
impl Drop for AccessScope {
    fn drop(&mut self) {
        if let Some(observer) = self.0 { observer(false); }
    }
}

const ACCOUNT: &str = "secrets-v1";
// Combined item of a user who restored from a backup instead of migrating. It
// never coexists with the old items' access lists, so a refused or inaccessible
// legacy item cannot block it.
const FRESH_ACCOUNT: &str = "secrets-fresh-v1";
fn is_bundle(account: &str) -> bool {
    account == ACCOUNT || account == FRESH_ACCOUNT
}
const BACKUP_PREFIX: &str = "identity-migration-backup:";
// Staged restore secret in the fresh item. It protects nothing until promoted,
// so a failed restore never replaces the live protection of an active key.
const PENDING_PREFIX: &str = "pending-fresh:";
const RECOVERY_PREFIX: &str = "keychain-recovery:";
pub(crate) fn recovery_prefix(account: &str) -> String {
    format!("{RECOVERY_PREFIX}{}:{account}:", account.len())
}
fn legacy_owner(name: &str) -> Option<&str> {
    if let Some(account) = name.strip_prefix(BACKUP_PREFIX) {
        return Some(account);
    }
    let (length, rest) = name.strip_prefix(RECOVERY_PREFIX)?.split_once(':')?;
    let length = length.parse::<usize>().ok()?;
    let account = rest.get(..length)?;
    rest.get(length..)?.starts_with(':').then_some(account)
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
    /// Accounts whose secret the user restored from a backup instead of
    /// migrating. Their secrets live only in the fresh item.
    /// An unreadable record is an error, never an empty list: silently
    /// routing back to the old items could overwrite a restored key.
    fn fresh_accounts(&self) -> StoreResult<Vec<String>> {
        Ok(Vec::new())
    }
    /// Persist that an account is fresh; it must outlive this process.
    fn mark_fresh_account(&self, _account: &str) -> StoreResult<()> {
        Err("Fresh start is unavailable for this store".into())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Bundle {
    version: u32,
    #[serde(skip)]
    legacy: bool,
    items: BTreeMap<String, String>,
    // Keep physical names even when an explicit erase clears a denial result,
    // so a protecting copy cannot silently become absence on the next read.
    #[serde(skip)]
    legacy_accounts: BTreeSet<String>,
    // First-migration snapshot (including per-item errors), or on-demand
    // recovery reads after migration. Never serialize failures as missing data.
    #[serde(skip)]
    legacy_reads: BTreeMap<String, StoreResult<Option<String>>>,
}
impl Bundle {
    fn should_read(&self, source: &str, retry_errors: bool) -> bool {
        match self.legacy_reads.get(source) {
            None => true, // an explicit request cleared this source's denial
            Some(Err(error)) => retry_errors && !error.user_denial(),
            Some(Ok(_)) => false,
        }
    }
    /// Value reads use only the live item or its migration backup. Recovery
    /// copies are candidates, but their refusals still enable explicit retry
    /// for a locked key, even when its readable live value is stale.
    fn failed_read(
        &self,
        account: &str,
        accepts: impl Fn(&StoreError) -> bool,
        include_recovery: bool,
    ) -> Option<(&str, &StoreError)> {
        if let Some((name, Err(error))) = self.legacy_reads.get_key_value(account) {
            if accepts(error) {
                return Some((name, error));
            }
        }
        if !self.legacy {
            return None;
        }
        let live = matches!(self.legacy_reads.get(account), Some(Ok(Some(_))));
        self.legacy_reads.iter().find_map(|(name, result)| {
            let error = result.as_ref().err()?;
            let relevant = if name.starts_with(RECOVERY_PREFIX) {
                include_recovery
            } else {
                !live
            };
            (relevant && legacy_owner(name) == Some(account) && accepts(error))
                .then_some((name.as_str(), error))
        })
    }
}
impl Default for Bundle {
    fn default() -> Self {
        Self {
            version: 1,
            legacy: false,
            items: BTreeMap::new(),
            legacy_accounts: BTreeSet::new(),
            legacy_reads: BTreeMap::new(),
        }
    }
}

pub struct Secrets<S> {
    store: S,
    // Denial/cancel and deterministic combined-item decode/version failures
    // are shared for this launch. Transient failures leave the cache empty.
    // Only an explicit request reads a refused item again: erasing it, or the
    // user's retry from the recovery panel (`retry_refused_access`).
    cache: Mutex<Option<StoreResult<Bundle>>>,
    // The fresh item is independent of the old one: a refusal of the old items
    // is cached above and never reaches it.
    fresh_cache: Mutex<Option<StoreResult<Bundle>>>,
}
impl<S: Backend> Secrets<S> {
    pub fn new(store: S) -> Self {
        Self {
            store,
            cache: Mutex::new(None),
            fresh_cache: Mutex::new(None),
        }
    }
    fn is_fresh(&self, account: &str) -> StoreResult<bool> {
        Ok(self.store.fresh_accounts()?.iter().any(|name| name == account))
    }
    fn load_fresh(&self) -> StoreResult<Bundle> {
        match self.store.read(FRESH_ACCOUNT)? {
            None => Ok(Bundle::default()),
            Some(json) => match serde_json::from_str::<Bundle>(&json) {
                Ok(bundle) if bundle.version == 1 => Ok(bundle),
                _ => Err(StoreError::invalid_item("Invalid fresh macOS secrets item")),
            },
        }
    }
    fn fresh_access<T>(
        &self,
        f: impl FnOnce(&mut Bundle) -> StoreResult<T>,
    ) -> StoreResult<T> {
        let mut cache = self
            .fresh_cache
            .lock()
            .map_err(|_| StoreError::from("macOS secrets lock poisoned"))?;
        if cache.is_none() {
            *cache = Some(self.load_fresh());
        }
        match cache.as_mut().expect("initialized above") {
            Ok(bundle) => f(bundle),
            Err(error) => {
                let error = error.clone();
                // Only deterministic failures stay cached; retry the rest.
                if !(error.user_denial() || error.invalid_item) {
                    *cache = None;
                }
                Err(error)
            }
        }
    }
    fn fresh_set(&self, account: &str, secret: Option<&str>) -> StoreResult<()> {
        self.fresh_access(|bundle| {
            let mut updated = bundle.clone();
            match secret {
                Some(secret) => updated.items.insert(account.into(), secret.into()),
                None => updated.items.remove(account),
            };
            if updated.items != bundle.items {
                self.store.set(FRESH_ACCOUNT, &Self::encode(&updated)?)?;
                *bundle = updated;
            }
            Ok(())
        })
    }
    fn encode(bundle: &Bundle) -> StoreResult<String> {
        serde_json::to_string(bundle).map_err(|_| "Could not encode macOS secrets".into())
    }
    fn load(&self) -> StoreResult<Bundle> {
        if let Some(json) = self.store.read(ACCOUNT)? {
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
        let mut bundle = Bundle::default();
        // A restored account and its aliases live in the fresh item. Their old
        // originals may be refused: never read them again, only erase them.
        let restored = self.store.fresh_accounts()?;
        let is_restored_copy = |name: &str| {
            restored.iter().any(|account| {
                name == account
                    || name.strip_prefix(BACKUP_PREFIX) == Some(account)
                    || name.starts_with(&recovery_prefix(account))
            })
        };
        for account in self.store.accounts()? {
            if is_bundle(&account) || is_restored_copy(&account) {
                continue;
            }
            bundle.legacy_accounts.insert(account.clone());
            let result = self.store.read(&account);
            match &result {
                Ok(Some(secret)) => {
                    bundle.items.insert(account.clone(), secret.clone());
                }
                Err(error) => {
                    tracing::error!("macOS secrets legacy item read failed: {error}");
                    bundle.legacy = true;
                }
                Ok(None) => {}
            }
            if let Some(owner) = legacy_owner(&account) {
                // Enumeration did not find a live value yet. A later live
                // read replaces this absence; otherwise retrying a copy must
                // not trigger an extra on-demand read of its missing owner.
                bundle.legacy_reads.entry(owner.into()).or_insert(Ok(None));
            }
            bundle.legacy_reads.insert(account, result);
        }
        // Live originals win over conflicting recovery copies. Preserve both
        // copies, including the backup's original account name, without writing
        // or deleting either legacy item.
        for (account, secret) in bundle.items.clone() {
            if let Some(target) = account.strip_prefix(BACKUP_PREFIX) {
                // A failed live read is not absence: do not substitute an
                // unvalidated, possibly stale backup for that secret.
                if !matches!(bundle.legacy_reads.get(target), Some(Err(_))) {
                    bundle.items.entry(target.into()).or_insert(secret);
                }
            }
        }
        // A partial snapshot remains usable in memory, never as a durable
        // bundle: otherwise the next launch would silently abandon the unread
        // originals. Later calls retry only their needed non-denial failures,
        // never the full scan or a held refusal.
        if !bundle.legacy && !bundle.items.is_empty() {
            let json = Self::encode(&bundle)?;
            let migrated = self
                .store
                .set(ACCOUNT, &json)
                .map_err(StoreError::from)
                .and_then(|()| {
                    self.store
                        .read(ACCOUNT)?
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
    fn read_legacy_source(&self, bundle: &mut Bundle, source: &str) -> StoreResult<Option<String>> {
        let result = self.store.read(source);
        match &result {
            Ok(Some(secret)) => {
                bundle.items.insert(source.into(), secret.clone());
            }
            Ok(None) => {
                bundle.items.remove(source);
            }
            Err(_) => {}
        }
        bundle.legacy_reads.insert(source.into(), result.clone());
        result
    }
    fn legacy_value(
        &self,
        bundle: &mut Bundle,
        account: &str,
        retry_errors: bool,
    ) -> StoreResult<Option<String>> {
        // A later call retries only a needed non-denial failure. An explicit
        // erase may also have cleared this account's denial for one new read.
        if (bundle.legacy_accounts.contains(account) || bundle.legacy_reads.contains_key(account))
            && bundle.should_read(account, retry_errors)
        {
            self.read_legacy_source(bundle, account)?;
        }
        if let Some(Err(error)) = bundle.legacy_reads.get(account) {
            return Err(error.clone());
        }
        if !matches!(bundle.legacy_reads.get(account), Some(Ok(Some(_)))) {
            let backup = format!("{BACKUP_PREFIX}{account}");
            if (bundle.legacy_accounts.contains(&backup)
                || bundle.legacy_reads.contains_key(&backup))
                && bundle.should_read(&backup, retry_errors)
            {
                self.read_legacy_source(bundle, &backup)?;
            }
            if let Some((_, error)) = bundle.failed_read(account, |_| true, false) {
                return Err(error.clone());
            }
            if let Some(secret) = bundle.items.get(&backup) {
                return Ok(Some(secret.clone()));
            }
        }
        if !bundle.items.contains_key(account) && !bundle.legacy_reads.contains_key(account) {
            return self.read_legacy_source(bundle, account);
        }
        Ok(bundle.items.get(account).cloned())
    }
    pub fn legacy_candidate(&self, account: &str) -> Result<Option<String>, String> {
        self.access("legacy recovery", |bundle, retry_errors| {
            if bundle.legacy {
                return self.legacy_value(bundle, account, retry_errors);
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
        self.access("recovery copies", |bundle, retry_errors| {
            let prefix = recovery_prefix(account);
            if bundle.legacy {
                let pending: BTreeSet<_> = bundle
                    .legacy_accounts
                    .iter()
                    .chain(bundle.legacy_reads.keys())
                    .filter(|name| {
                        name.starts_with(&prefix) && bundle.should_read(name, retry_errors)
                    })
                    .cloned()
                    .collect();
                for source in pending {
                    if let Err(error) = self.read_legacy_source(bundle, &source) {
                        tracing::warn!("OpenPGP recovery-copy read failed: {error}");
                    }
                }
            }
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
        self.access("adopt legacy", |bundle, _| {
            if bundle
                .items
                .get(account)
                .is_some_and(|current| current == secret)
            {
                return Ok(());
            }
            if bundle.legacy {
                // An unverified combined item must not survive either legacy write.
                self.store.delete(ACCOUNT)?;
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
                adopted
                    .legacy_reads
                    .insert(account.into(), Ok(Some(secret.into())));
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
        f: impl FnOnce(&mut Bundle, bool) -> StoreResult<T>,
    ) -> StoreResult<T> {
        let mut cache = self.cache.lock().map_err(|_| {
            let error = StoreError::from("macOS secrets lock poisoned");
            tracing::error!("macOS secrets {operation} failed: {error}");
            error
        })?;
        let retry_errors = cache.is_some();
        self.fill(&mut cache)?;
        let result = match cache.as_mut().expect("initialized above") {
            Ok(bundle) => f(bundle, retry_errors),
            Err(error) => return Err(error.clone()),
        };
        if let Err(error) = &result {
            tracing::error!("macOS secrets {operation} failed: {error}");
        }
        result
    }

    /// Load an empty cache once. A denial or an invalid item stays cached for
    /// this launch; a transient failure leaves the cache empty.
    fn fill(&self, cache: &mut Option<StoreResult<Bundle>>) -> StoreResult<()> {
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
        Ok(())
    }
}
impl<S: Backend> SecretStore for Secrets<S> {
    fn fresh_write(&self, account: &str, secret: &str) -> Result<(), String> {
        self.fresh_set(&format!("{PENDING_PREFIX}{account}"), Some(secret))
            .map_err(|error| error.to_string())
    }
    fn restored(&self, account: &str) -> Result<bool, String> {
        self.is_fresh(account).map_err(|error| error.to_string())
    }
    fn abort_fresh(&self, account: &str) -> Result<(), String> {
        self.fresh_set(&format!("{PENDING_PREFIX}{account}"), None)
            .map_err(|error| error.to_string())
    }
    fn commit_fresh(&self, account: &str) -> Result<(), String> {
        let already = self.is_fresh(account).map_err(|e| e.to_string())?;
        let pending = format!("{PENDING_PREFIX}{account}");
        // One write replaces the live secret with the staged one. Only then is
        // a new account routed to the fresh item, so a failure before that
        // leaves every read, and an active key's protection, unchanged.
        self.fresh_access(|bundle| {
            let mut updated = bundle.clone();
            let secret = updated
                .items
                .remove(&pending)
                .ok_or_else(|| StoreError::from("No staged secret to promote"))?;
            updated.items.insert(account.into(), secret);
            self.store.set(FRESH_ACCOUNT, &Self::encode(&updated)?)?;
            *bundle = updated;
            Ok(())
        })
        .map_err(|error| error.to_string())?;
        if !already {
            if let Err(error) = self.store.mark_fresh_account(account) {
                // The record may have been published before the failure (its
                // directory sync). Then it is in use: confirm it again, never
                // report a failure that the next read contradicts.
                match self.is_fresh(account) {
                    Ok(true) => {
                        if self.store.mark_fresh_account(account).is_err() {
                            return Err(error.to_string());
                        }
                    }
                    Ok(false) => return Err(error.to_string()),
                    // Not knowing is not "absent": say so, so no caller rolls back.
                    Err(probe) => {
                        return Err(format!(
                            "{error}; whether the record was published could not be confirmed: {probe}"
                        ))
                    }
                }
            }
        }
        Ok(())
    }
    fn retry_denied_access(&self, account: &str) -> Result<(), String> {
        for cache in [&self.cache, &self.fresh_cache] {
            let mut cache = cache
                .lock()
                .map_err(|_| "macOS secrets lock poisoned".to_string())?;
            if matches!(cache.as_ref(), Some(Err(error)) if error.user_denial()) {
                *cache = None;
            } else if let Some(Ok(bundle)) = cache.as_mut() {
                if bundle.legacy {
                    bundle.legacy_reads.retain(|name, result| {
                        !(matches!(result, Err(error) if error.user_denial())
                            && (name == account || legacy_owner(name) == Some(account)))
                    });
                }
            }
        }
        Ok(())
    }
    fn refused_access(&self, account: &str) -> Result<RefusalState, String> {
        if self.is_fresh(account).map_err(|e| e.to_string())? {
            return Ok(RefusalState::NotHeld);
        }
        let cache = match self.cache.try_lock() {
            Ok(cache) => cache,
            // A read is under way, perhaps a retry waiting on the user's
            // answer. Never wait for it, and never call it consumed.
            Err(std::sync::TryLockError::WouldBlock) => return Ok(RefusalState::Pending),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("macOS secrets lock poisoned".into())
            }
        };
        let held = match cache.as_ref() {
            Some(Err(error)) => error.user_denial(),
            Some(Ok(bundle)) => bundle
                .failed_read(account, StoreError::user_denial, true)
                .is_some(),
            None => false,
        };
        Ok(if held { RefusalState::Held } else { RefusalState::NotHeld })
    }
    fn retry_refused_access(&self, account: &str) -> Result<RefusedRetry, String> {
        if self.is_fresh(account).map_err(|e| e.to_string())? {
            return Err("A restored account never reads its old items again".into());
        }
        // The read happens under the cache lock, so no other reader can turn
        // this one request into a second one.
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "macOS secrets lock poisoned".to_string())?;
        match cache.as_mut() {
            Some(Err(refusal)) if refusal.user_denial() => {
                let refusal = refusal.clone();
                *cache = None;
                match self.fill(&mut cache) {
                    Ok(()) => Ok(RefusedRetry::Read),
                    Err(error) if error.user_denial() => Ok(RefusedRetry::RefusedAgain),
                    Err(error) => {
                        // Not the user's answer: keep the refusal, so nothing
                        // reads again before the next explicit request.
                        if cache.is_none() {
                            *cache = Some(Err(refusal));
                        }
                        Err(error.to_string())
                    }
                }
            }
            Some(Ok(bundle)) => {
                let Some((source, _)) = bundle.failed_read(account, StoreError::user_denial, true)
                else {
                    return Ok(RefusedRetry::NothingRefused);
                };
                let source = source.to_string();
                match self.store.read(&source) {
                    Ok(value) => {
                        if bundle.legacy {
                            match &value {
                                Some(secret) => {
                                    bundle.items.insert(source.clone(), secret.clone());
                                }
                                None => {
                                    bundle.items.remove(&source);
                                }
                            }
                        }
                        bundle.legacy_reads.insert(source, Ok(value));
                        Ok(RefusedRetry::Read)
                    }
                    Err(error) if error.user_denial() => {
                        bundle.legacy_reads.insert(source, Err(error));
                        Ok(RefusedRetry::RefusedAgain)
                    }
                    // The earlier refusal stays cached, including for a copy.
                    Err(error) => Err(error.to_string()),
                }
            }
            _ => Ok(RefusedRetry::NothingRefused),
        }
    }
    fn legacy_candidate(&self, account: &str) -> Result<Option<String>, String> {
        if self.is_fresh(account).map_err(|e| e.to_string())? {
            return Ok(None);
        }
        Secrets::legacy_candidate(self, account)
    }
    fn recovery_candidates(&self, account: &str) -> Result<Vec<String>, String> {
        if self.is_fresh(account).map_err(|e| e.to_string())? {
            return Ok(Vec::new());
        }
        Secrets::recovery_candidates(self, account)
    }
    fn adopt_legacy(&self, account: &str, secret: &str) -> Result<(), String> {
        if self.is_fresh(account).map_err(|e| e.to_string())? {
            return Err("A restored account never adopts old items".into());
        }
        Secrets::adopt_legacy(self, account, secret)
    }
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if self.is_fresh(account).map_err(|e| e.to_string())? {
            return self
                .fresh_access(|bundle| Ok(bundle.items.get(account).cloned()))
                .map_err(|error| error.to_string());
        }
        self.access("read", |bundle, retry_errors| {
            if bundle.legacy {
                self.legacy_value(bundle, account, retry_errors)
            } else {
                Ok(bundle.items.get(account).cloned())
            }
        })
        .map_err(|error| error.to_string())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        if self.is_fresh(account).map_err(|e| e.to_string())? {
            return self
                .fresh_set(account, Some(secret))
                .map_err(|error| error.to_string());
        }
        self.access("write", |bundle, _| {
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
                updated
                    .legacy_reads
                    .insert(account.into(), Ok(Some(secret.into())));
            } else {
                self.store.set(ACCOUNT, &Self::encode(&updated)?)?;
            }
            *bundle = updated;
            Ok(())
        })
        .map_err(|error| error.to_string())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        // A restored account keeps a copy in the fresh item and may still have
        // old copies; a failed restore may have left a staged one. Try all, and
        // say which could not be erased.
        let restored = self.is_fresh(account).map_err(|e| e.to_string())?;
        let fresh = self.fresh_access(|bundle| {
            let mut updated = bundle.clone();
            updated.items.remove(account);
            updated.items.remove(&format!("{PENDING_PREFIX}{account}"));
            if updated.items != bundle.items {
                self.store.set(FRESH_ACCOUNT, &Self::encode(&updated)?)?;
                *bundle = updated;
            }
            Ok(())
        });
        let old = self.delete_old(account);
        match (fresh, old) {
            (Ok(()), old) if !restored => old,
            (fresh, old) => {
                let failures: Vec<String> = [
                    fresh.err().map(|error| format!("restored copy ({error})")),
                    old.err().map(|error| format!("old copy ({error})")),
                ]
                .into_iter()
                .flatten()
                .collect();
                if failures.is_empty() {
                    Ok(())
                } else {
                    Err(format!("Not erased: {}", failures.join("; ")))
                }
            }
        }
    }
}
impl<S: Backend> Secrets<S> {
    fn delete_old(&self, account: &str) -> Result<(), String> {
        self.access("delete", |bundle, _| {
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
            // Unread copies have no value in items, but their cached errors
            // still protect this account. Erase their cache outcomes too.
            copies.extend(
                bundle
                    .legacy_accounts
                    .iter()
                    .chain(bundle.legacy_reads.keys())
                    .filter(|name| legacy_owner(name) == Some(account))
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

    // The record routes reads to the fresh item. It reaches the disk, and its
    // rename does too, before the caller goes on, so a power loss cannot keep a
    // promoted secret while losing the route to it.
    fn write_durably(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        let temporary = path.with_extension("tmp");
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        note_durability("file-sync");
        std::fs::rename(&temporary, path)?;
        note_durability("rename");
        if let Some(dir) = path.parent() {
            std::fs::File::open(dir)?.sync_all()?;
            note_durability("dir-sync");
        }
        Ok(())
    }
    #[cfg(test)]
    thread_local! {
        static DURABILITY: std::cell::RefCell<Vec<&'static str>> =
            const { std::cell::RefCell::new(Vec::new()) };
    }
    fn note_durability(_step: &'static str) {
        #[cfg(test)]
        DURABILITY.with(|log| log.borrow_mut().push(_step));
    }

    // Sharing between release and Dev is retained; separate Dev storage was not
    // selected. Neither identity re-creates the other's items anymore.
    const SERVICE: &str = "com.processone.fluux";
    #[derive(Default)]
    pub struct Keychain {
        // None in the app; the native regression supplies an explicit scratch
        // keychain, never changing the user's default or search list.
        keychain: Option<SecKeychain>,
        // Per item: a revision observed while reading one item says nothing
        // about the cached contents of the other.
        observed_revision: Mutex<BTreeMap<String, u64>>,
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
        fn begin_write(&self, account: &str) -> Result<std::fs::File, String> {
            self.bump_revision(Some(account))
        }
        // `verify` is None only for the fresh-start transition, which must
        // advance the revision even when this process never observed one.
        fn bump_revision(&self, verify: Option<&str>) -> Result<std::fs::File, String> {
            use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
            let (lock, path, revision) = self.revision(true)?;
            let mut observed = self
                .observed_revision
                .lock()
                .map_err(|_| "Revision lock poisoned")?;
            if verify.is_some_and(|account| observed.get(account) != Some(&revision)) {
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
            // Items this process had in sync stay in sync after its own write.
            for value in observed.values_mut().filter(|value| **value == revision) {
                *value = next;
            }
            if let Some(account) = verify {
                observed.insert(account.into(), next);
            }
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
            let _access = super::AccessScope::begin();
            let _revision = if is_bundle(account) {
                Some(self.begin_write(account)?)
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
            let _access = super::AccessScope::begin();
            let _revision = if is_bundle(account) {
                Some(self.begin_write(account)?)
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
        fn fresh_accounts(&self) -> StoreResult<Vec<String>> {
            match std::fs::read_to_string(self.fresh_marker_path()?) {
                Ok(text) => Ok(text.lines().map(str::to_string).collect()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
                Err(e) => Err(format!("Could not read the fresh-start record: {e}").into()),
            }
        }

        fn mark_fresh_account(&self, account: &str) -> StoreResult<()> {
            let path = self.fresh_marker_path()?;
            std::fs::create_dir_all(path.parent().ok_or("Missing marker directory")?)
                .map_err(|e| e.to_string())?;
            // Hold the exclusive revision lock across the switch and advance the
            // revision, so a running sibling's cached bundles can no longer be
            // written. It must quit and reopen, as for any other stale write.
            let _revision = self.bump_revision(None)?;
            let mut accounts = self.fresh_accounts()?;
            if !accounts.iter().any(|name| name == account) {
                accounts.push(account.into());
            }
            write_durably(&path, accounts.join("\n").as_bytes())
                .map_err(|e| format!("Could not record the fresh start: {e}").into())
        }

        fn read(&self, account: &str) -> StoreResult<Option<String>> {
            let _access = super::AccessScope::begin();
            let revision = if is_bundle(account) {
                self.revision(false).ok()
            } else {
                None
            };
            if is_bundle(account) {
                let mut observed = self
                    .observed_revision
                    .lock()
                    .map_err(|_| "Revision lock poisoned")?;
                match revision.as_ref() {
                    Some((_, _, value)) => observed.insert(account.into(), *value),
                    None => observed.remove(account),
                };
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
            // Enumeration is a native keychain operation too; retry/migration
            // may reach it before startup has qualified (FLM-403 F4 and F31).
            let _access = super::AccessScope::begin();
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
    // FLM-298 review R4: switching an account to fresh storage must reject a
    // running sibling's stale cached bundles, whichever item it holds, and one
    // item's observed revision must not vouch for the other. Touches only files
    // in a temporary directory.
    #[test]
    fn fresh_commit_rejects_stale_sibling_writes_per_item() {
        let dir = std::env::temp_dir().join(format!("fluux-fresh-{}", uuid::Uuid::new_v4()));
        let make = || Keychain {
            revision_dir: Some(dir.clone()),
            ..Keychain::default()
        };
        let (sibling, restoring) = (make(), make());
        // The sibling read the fresh item (empty) and then the old one.
        sibling
            .observed_revision
            .lock()
            .unwrap()
            .extend([(FRESH_ACCOUNT.to_string(), 0), (ACCOUNT.to_string(), 0)]);
        assert!(restoring.fresh_accounts().unwrap().is_empty());
        restoring.mark_fresh_account("openpgp_passphrase:a@x").unwrap();
        assert_eq!(sibling.fresh_accounts().unwrap(), ["openpgp_passphrase:a@x"]);
        for account in [ACCOUNT, FRESH_ACCOUNT] {
            let error = sibling.begin_write(account).unwrap_err();
            assert!(error.contains("quit and reopen"), "{error}");
        }
        // The committing process stays writable for what it had in sync.
        restoring
            .observed_revision
            .lock()
            .unwrap()
            .insert(FRESH_ACCOUNT.into(), 1);
        restoring.begin_write(FRESH_ACCOUNT).unwrap();
        // A sibling that re-read only the old item at the new revision still
        // cannot write its stale copy of the fresh item.
        sibling
            .observed_revision
            .lock()
            .unwrap()
            .insert(ACCOUNT.into(), 2);
        assert!(sibling.begin_write(FRESH_ACCOUNT).is_err());
        sibling.begin_write(ACCOUNT).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    // FLM-302 C3: with no sibling at all, the process that records a restored
    // account stays writable for the items it had in sync, without any new
    // read, for the following fresh restore and erasure.
    #[test]
    fn committer_keeps_writing_after_its_own_record_without_a_new_read() {
        let dir = std::env::temp_dir().join(format!("fluux-fresh-{}", uuid::Uuid::new_v4()));
        let only = Keychain {
            revision_dir: Some(dir.clone()),
            ..Keychain::default()
        };
        // It read both items once, as the secrets cache does when it loads.
        only.observed_revision
            .lock()
            .unwrap()
            .extend([(FRESH_ACCOUNT.to_string(), 0), (ACCOUNT.to_string(), 0)]);
        only.mark_fresh_account("openpgp_passphrase:a@x").unwrap();
        // A second restore and an erasure follow; neither re-reads first.
        only.mark_fresh_account("openpgp_passphrase:b@x").unwrap();
        only.begin_write(FRESH_ACCOUNT).unwrap();
        only.begin_write(ACCOUNT).unwrap();
        only.begin_write(FRESH_ACCOUNT).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    // FLM-302 R9: a marker that cannot be read is an error, and a commit does
    // not overwrite it. Touches only files in a temporary directory.
    #[test]
    fn unreadable_marker_is_an_error_not_an_empty_list() {
        let dir = std::env::temp_dir().join(format!("fluux-marker-{}", uuid::Uuid::new_v4()));
        let keychain = Keychain {
            revision_dir: Some(dir.clone()),
            ..Keychain::default()
        };
        assert!(keychain.fresh_accounts().unwrap().is_empty());
        // A directory where the record belongs cannot be read as text.
        std::fs::create_dir_all(keychain.fresh_marker_path().unwrap()).unwrap();
        assert!(keychain.fresh_accounts().is_err());
        assert!(keychain.mark_fresh_account("openpgp_passphrase:a@x").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    // FLM-302 R10: the record of restored accounts is on disk, renamed and
    // directory-synced, before the commit returns.
    #[test]
    fn recording_a_restored_account_is_durable() {
        let dir = std::env::temp_dir().join(format!("fluux-durable-{}", uuid::Uuid::new_v4()));
        let keychain = Keychain {
            revision_dir: Some(dir.clone()),
            ..Keychain::default()
        };
        DURABILITY.with(|log| log.borrow_mut().clear());
        keychain.mark_fresh_account("openpgp_passphrase:a@x").unwrap();
        let log = DURABILITY.with(|log| log.borrow().clone());
        // The revision bump comes first, then the record itself.
        assert!(
            log.ends_with(&["file-sync", "rename", "dir-sync"]),
            "{log:?}"
        );
        assert_eq!(keychain.fresh_accounts().unwrap(), ["openpgp_passphrase:a@x"]);
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
            let _write = raw.begin_write(ACCOUNT).unwrap();
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
            scans: Mutex<usize>,
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
                *self.scans.lock().unwrap() += 1;
                self.raw.accounts()
            }
        }
        let store = Secrets::new(Traced {
            raw,
            fail_new: action == "write-failed",
            reads: Mutex::new(Vec::new()),
            scans: Mutex::new(0),
        });
        if action == "recovery-copy-startup" {
            let account = "openpgp_passphrase:alice@example.com";
            assert!(store.get(account).unwrap().is_none());
            assert_eq!(
                store.recovery_candidates(account).unwrap(),
                ["dGVzdC1wYXNz"]
            );
            assert!(crate::credentials::load(&store).unwrap().is_some());
            assert_eq!(
                store.get("mcp-token").unwrap().as_deref(),
                Some("test-token")
            );
            println!("readable recovery-only source remains a candidate after restart/migration, without becoming an unvalidated live passphrase");
            return;
        }
        if action.starts_with("partial-") {
            let blocked = match action.as_str() {
                "partial-login" => "alice@example.com",
                "partial-pgp" | "partial-recovery-pgp" => "openpgp_passphrase:alice@example.com",
                "partial-mcp" | "partial-invalid" | "partial-backup-mcp" => "mcp-token",
                _ => panic!("unknown partial migration fixture"),
            };
            let recovery_only = action == "partial-recovery-pgp";
            let source = if action == "partial-backup-mcp" {
                format!("{BACKUP_PREFIX}{blocked}")
            } else if recovery_only {
                format!("{}fixture", recovery_prefix(blocked))
            } else {
                blocked.to_string()
            };
            let error = if recovery_only {
                assert!(store.get(blocked).unwrap().is_none());
                store.get(&source).unwrap_err()
            } else {
                store.get(blocked).unwrap_err()
            };
            assert_eq!(store.store.reads.lock().unwrap().len(), 5);
            for _ in 0..3 {
                if blocked == "alice@example.com" {
                    assert_eq!(crate::credentials::load(&store).unwrap_err(), error);
                } else {
                    assert_eq!(
                        crate::credentials::load(&store).unwrap().unwrap().password,
                        "test-password"
                    );
                }
                for other in ["mcp-token", "openpgp_passphrase:alice@example.com"] {
                    if other == blocked {
                        if recovery_only {
                            assert!(store.get(other).unwrap().is_none());
                        } else {
                            assert_eq!(store.get(other).unwrap_err(), error);
                        }
                    } else {
                        assert!(store.get(other).unwrap().is_some());
                    }
                }
                if recovery_only {
                    assert!(store.get(blocked).unwrap().is_none());
                } else {
                    assert_eq!(store.get(blocked).unwrap_err(), error);
                }
            }
            assert_eq!(*store.store.scans.lock().unwrap(), 1);
            let reads = store.store.reads.lock().unwrap().clone();
            for name in
                std::iter::once(ACCOUNT.to_string()).chain(store.store.raw.accounts().unwrap())
            {
                let count = reads.iter().filter(|read| **read == name).count();
                if action == "partial-invalid" && name == source {
                    assert!(count > 1);
                } else {
                    assert_eq!(
                        count, 1,
                        "only the failed non-denial source may reread: {name}"
                    );
                }
            }
            assert!(store.store.raw.read(ACCOUNT).unwrap().is_none());
            assert_eq!(store.store.raw.accounts().unwrap().len(), 4);
            if matches!(
                action.as_str(),
                "partial-backup-mcp" | "partial-recovery-pgp"
            ) {
                assert_eq!(store.refused_access(blocked).unwrap(), RefusalState::Held);
                assert_eq!(
                    store.retry_refused_access(blocked).unwrap(),
                    RefusedRetry::RefusedAgain
                );
                assert_eq!(store.store.reads.lock().unwrap().last(), Some(&source));
                assert_eq!(store.store.reads.lock().unwrap().len(), 6);
                assert_eq!(store.refused_access(blocked).unwrap(), RefusalState::Held);
                println!("{action}: logical refusal held; explicit retry read only its physical copy and retained the refusal");
            }
            println!("{action}: native error {error}; other consumers succeeded; one scan, {} source reads (only non-denial failures retry); four originals retained; no partial bundle", reads.len());
            return;
        }
        if let Some(bytes) = invalid {
            let error = crate::credentials::load(&store).unwrap_err();
            assert_eq!(store.get("mcp-token").unwrap_err(), error);
            assert_eq!(
                store
                    .get("openpgp_passphrase:alice@example.com")
                    .unwrap_err(),
                error
            );
            store.retry_denied_access("mcp-token").unwrap();
            assert_eq!(store.set("mcp-token", "replacement").unwrap_err(), error);
            assert_eq!(store.delete("mcp-token").unwrap_err(), error);
            // Explicit erase also checks the independent fresh store for a
            // staged/restored copy. Neither store may decrypt more than once.
            assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT, FRESH_ACCOUNT]);
            let (stored, _) = find_generic_password(
                store.store.raw.keychain.as_ref().map(std::slice::from_ref),
                SERVICE,
                ACCOUNT,
            )
            .unwrap();
            assert_eq!(stored.to_vec(), bytes);
            println!("{action}: one old combined-item read across startup consumers and explicit retry; erase checks the fresh store once; original item unchanged");
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
#[cfg(all(target_os = "macos", not(feature = "startup-recovery-lab")))]
pub use native::secrets;
#[cfg(all(target_os = "macos", feature = "startup-recovery-lab"))]
#[path = "macos_secrets/lab.rs"]
mod lab;
#[cfg(all(target_os = "macos", feature = "startup-recovery-lab"))]
pub use lab::secrets;

#[cfg(test)]
mod tests {
    use super::*;
    // FLM-403 F10: backend observation stays balanced on error, with no UI dependency.
    #[test]
    fn access_observer_reports_scope_end_on_early_error() {
        thread_local! { static EVENTS: std::cell::RefCell<Vec<bool>> = const { std::cell::RefCell::new(Vec::new()) }; }
        fn observe(pending: bool) { EVENTS.with(|events| events.borrow_mut().push(pending)); }
        EVENTS.with(|events| events.borrow_mut().clear());
        let result: Result<(), &str> = (|| {
            let _access = AccessScope::new(Some(observe));
            EVENTS.with(|events| assert_eq!(*events.borrow(), vec![true]));
            Err("disposable backend failure")
        })();
        assert!(result.is_err());
        EVENTS.with(|events| assert_eq!(*events.borrow(), vec![true, false]));
    }

    #[derive(Default)]
    struct FakeStore {
        items: Mutex<BTreeMap<String, String>>,
        reads: Mutex<Vec<String>>,
        scans: Mutex<usize>,
        writes: Mutex<Vec<String>>,
        snapshots: Mutex<Vec<BTreeMap<String, String>>>,
        deletes: Mutex<Vec<String>>,
        read_error: Mutex<Option<(StoreError, usize)>>,
        fresh_read_error: Mutex<Option<(StoreError, usize)>>,
        fail_write: Mutex<bool>,
        fail_delete: Mutex<bool>,
        corrupt_write: Mutex<bool>,
        concurrent_migration_bundle: Mutex<Option<Bundle>>,
        fresh: Mutex<Vec<String>>,
        fresh_unreadable: Mutex<bool>,
        // Publish the record, then fail (a directory sync that errors).
        mark_failures_after_publish: Mutex<usize>,
        // After a failed mark, the record can no longer be read back.
        unreadable_after_failed_mark: Mutex<bool>,
        // Failures of reads of one named old item, and how many remain.
        item_read_errors: Mutex<BTreeMap<String, (StoreError, usize)>>,
        access_observer: Option<AccessObserver>,
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
        fn fresh_accounts(&self) -> StoreResult<Vec<String>> {
            if *self.fresh_unreadable.lock().unwrap() {
                return Err("marker unreadable".into());
            }
            Ok(self.fresh.lock().unwrap().clone())
        }
        fn mark_fresh_account(&self, account: &str) -> StoreResult<()> {
            self.fresh.lock().unwrap().push(account.into());
            let mut failures = self.mark_failures_after_publish.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                if *self.unreadable_after_failed_mark.lock().unwrap() {
                    *self.fresh_unreadable.lock().unwrap() = true;
                }
                return Err("directory sync failed".into());
            }
            Ok(())
        }
        fn read(&self, account: &str) -> StoreResult<Option<String>> {
            let _access = AccessScope::new(self.access_observer);
            // `reads` pins the old layout; the fresh item is a separate store.
            if account != FRESH_ACCOUNT {
                self.reads.lock().unwrap().push(account.into());
            }
            if let Some((error, remaining)) = self.item_read_errors.lock().unwrap().get_mut(account) {
                if *remaining > 0 {
                    *remaining -= 1;
                    return Err(error.clone());
                }
            }
            if is_bundle(account) {
                let failures = if account == FRESH_ACCOUNT {
                    &self.fresh_read_error
                } else {
                    &self.read_error
                };
                if let Some((error, remaining)) = failures.lock().unwrap().as_mut() {
                    if *remaining > 0 {
                        *remaining -= 1;
                        return Err(error.clone());
                    }
                }
            }
            Ok(self.items.lock().unwrap().get(account).cloned())
        }

        fn accounts(&self) -> StoreResult<Vec<String>> {
            *self.scans.lock().unwrap() += 1;
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
    // FLM-86: a refused/failed old item disables only that secret, and even a
    // transient failure must not restart the whole migration on each call.
    #[test]
    fn partial_migration_isolates_each_error_and_scans_once_until_restart() {
        for account in [
            "last_user",
            "alice@example.com",
            "openpgp_passphrase:alice@example.com",
            "mcp-token",
        ] {
            for error in [
                StoreError::denied(),
                StoreError::native(-128, "canceled"),
                StoreError::native(-25291, "unavailable"),
                StoreError::invalid_item("invalid UTF-8"),
            ] {
                let raw = legacy();
                let originals = raw.items.lock().unwrap().clone();
                raw.item_read_errors
                    .lock()
                    .unwrap()
                    .insert(account.into(), (error.clone(), 1));
                raw.writes.lock().unwrap().clear();
                let store = Secrets::new(raw);
                assert_eq!(store.get(account).unwrap_err(), error.to_string());
                // Captain's F3 choice: only a non-denial source retries later.
                for _ in 0..3 {
                    if error.user_denial() {
                        assert_eq!(store.get(account).unwrap_err(), error.to_string());
                        assert_eq!(
                            store.legacy_candidate(account).unwrap_err(),
                            error.to_string()
                        );
                    } else {
                        assert_eq!(store.get(account).unwrap().as_ref(), originals.get(account));
                        assert_eq!(
                            store.legacy_candidate(account).unwrap().as_ref(),
                            originals.get(account)
                        );
                    }
                    for (other, value) in &originals {
                        if other != account {
                            assert_eq!(store.get(other).unwrap().as_ref(), Some(value));
                        }
                    }
                    let login = crate::credentials::load(&store);
                    if error.user_denial() && ["last_user", "alice@example.com"].contains(&account)
                    {
                        assert_eq!(login.unwrap_err(), error.to_string());
                    } else {
                        assert_eq!(login.unwrap().unwrap().password, "test-password");
                    }
                }
                assert_eq!(*store.store.scans.lock().unwrap(), 1);
                assert_eq!(
                    store.store.reads.lock().unwrap().len(),
                    originals.len() + 1 + usize::from(!error.user_denial())
                );
                assert_eq!(*store.store.items.lock().unwrap(), originals);
                assert!(store.store.writes.lock().unwrap().is_empty());
                let restarted = Secrets::new(store.store);
                assert_eq!(
                    restarted.get(account).unwrap().as_ref(),
                    originals.get(account)
                );
                let items = restarted.store.items.lock().unwrap();
                let bundle: Bundle = serde_json::from_str(items.get(ACCOUNT).unwrap()).unwrap();
                assert_eq!(bundle.items, originals);
            }
        }
    }

    // FLM-440 F1: a failed protecting copy is not a missing logical secret.
    // In particular, MCP must receive an error instead of minting a new token.
    #[test]
    fn partial_migration_failed_backups_belong_to_their_logical_secret() {
        for account in [
            "last_user",
            "alice@example.com",
            "openpgp_passphrase:alice@example.com",
            "mcp-token",
        ] {
            let copy = format!("{BACKUP_PREFIX}{account}");
            for code in [-25293, -128, -25291] {
                for live_present in [false, true] {
                    let raw = legacy();
                    let value = raw.items.lock().unwrap()[account].clone();
                    raw.set(&copy, &value).unwrap();
                    if !live_present {
                        raw.items.lock().unwrap().remove(account);
                    }
                    let error = StoreError::native(code, "copy read failed");
                    raw.item_read_errors
                        .lock()
                        .unwrap()
                        .insert(copy.clone(), (error.clone(), 1));
                    let original = raw.items.lock().unwrap().clone();
                    raw.writes.lock().unwrap().clear();
                    let store = Secrets::new(raw);
                    let first = store.get(account);
                    if live_present {
                        assert_eq!(first.unwrap().as_ref(), Some(&value));
                    } else {
                        assert_eq!(first.unwrap_err(), error.to_string());
                    }
                    let count = store.store.reads.lock().unwrap().len();
                    for _ in 0..3 {
                        if !live_present && error.user_denial() {
                            assert_eq!(store.get(account).unwrap_err(), error.to_string());
                            assert_eq!(
                                store.legacy_candidate(account).unwrap_err(),
                                error.to_string()
                            );
                            assert_eq!(store.refused_access(account).unwrap(), RefusalState::Held);
                        } else {
                            assert_eq!(store.get(account).unwrap().as_ref(), Some(&value));
                            assert_eq!(
                                store.legacy_candidate(account).unwrap().as_ref(),
                                Some(&value)
                            );
                            assert_eq!(
                                store.refused_access(account).unwrap(),
                                RefusalState::NotHeld
                            );
                        }
                        for other in original
                            .keys()
                            .filter(|name| name.as_str() != account && **name != copy)
                        {
                            assert!(store.get(other).unwrap().is_some());
                        }
                    }
                    assert_eq!(
                        store.store.reads.lock().unwrap().len(),
                        count + usize::from(!live_present && !error.user_denial())
                    );
                    assert_eq!(*store.store.scans.lock().unwrap(), 1);
                    assert!(store.store.writes.lock().unwrap().is_empty());
                    assert_eq!(*store.store.items.lock().unwrap(), original);
                }
            }
        }
    }

    // FLM-440 F1: one explicit request reads one failed physical source, not
    // its absent logical name or another account's refused source.
    #[test]
    fn partial_migration_copy_retry_uses_the_physical_source() {
        let account = "openpgp_passphrase:alice@example.com";
        let raw = legacy();
        let value = raw.items.lock().unwrap().remove(account).unwrap();
        let copies = [
            format!("{BACKUP_PREFIX}{account}"),
            format!("{}fixture", recovery_prefix(account)),
        ];
        for copy in &copies {
            raw.set(copy, &value).unwrap();
            raw.item_read_errors
                .lock()
                .unwrap()
                .insert(copy.clone(), (StoreError::denied(), 1));
        }
        let other = "openpgp_passphrase:bob@example.org";
        raw.item_read_errors
            .lock()
            .unwrap()
            .insert(other.into(), (StoreError::denied(), 1));
        let store = Secrets::new(raw);
        assert!(store.get(account).is_err());
        store.store.reads.lock().unwrap().clear();
        for (index, copy) in copies.iter().enumerate() {
            for error in [
                StoreError::native(-25291, "transient"),
                StoreError::denied(),
            ] {
                store
                    .store
                    .item_read_errors
                    .lock()
                    .unwrap()
                    .insert(copy.clone(), (error.clone(), 1));
                let result = store.retry_refused_access(account);
                if error.user_denial() {
                    assert_eq!(result.unwrap(), RefusedRetry::RefusedAgain);
                } else {
                    assert!(result.is_err());
                }
                assert_eq!(store.refused_access(account).unwrap(), RefusalState::Held);
                if index == 0 {
                    assert!(store.get(account).is_err());
                } else {
                    assert_eq!(store.get(account).unwrap().as_deref(), Some(value.as_str()));
                }
            }
            assert_eq!(
                store.retry_refused_access(account).unwrap(),
                RefusedRetry::Read
            );
        }
        assert_eq!(store.get(account).unwrap().as_deref(), Some(value.as_str()));
        assert_eq!(
            store.refused_access(account).unwrap(),
            RefusalState::NotHeld
        );
        assert_eq!(
            store.retry_refused_access(account).unwrap(),
            RefusedRetry::NothingRefused
        );
        assert_eq!(store.recovery_candidates(account).unwrap(), [value]);
        assert_eq!(
            *store.store.reads.lock().unwrap(),
            [
                copies[0].clone(),
                copies[0].clone(),
                copies[0].clone(),
                copies[1].clone(),
                copies[1].clone(),
                copies[1].clone()
            ]
        );
        assert!(store.get(other).is_err());
        assert_eq!(store.refused_access(other).unwrap(), RefusalState::Held);
        assert_eq!(*store.store.scans.lock().unwrap(), 1);
        assert!(!store.store.items.lock().unwrap().contains_key(account));
        assert!(!store.store.items.lock().unwrap().contains_key(ACCOUNT));
    }

    // FLM-440 F5: successful erase must clear failed recovery-copy outcomes,
    // not just readable values, so key retirement can save a replacement now.
    #[test]
    fn partial_migration_erase_clears_failed_recovery_copy_results() {
        let account = "openpgp_passphrase:alice@example.com";
        let other = "openpgp_passphrase:bob@example.org";
        for code in [-25293, -128, -25291] {
            for live_present in [false, true] {
                for clear_denials_first in [false, true] {
                    let raw = legacy();
                    let value = raw.items.lock().unwrap()[account].clone();
                    let copy = format!("{}fixture", recovery_prefix(account));
                    raw.set(&copy, &value).unwrap();
                    if !live_present {
                        raw.items.lock().unwrap().remove(account);
                    }
                    raw.item_read_errors.lock().unwrap().insert(
                        copy.clone(),
                        (StoreError::native(code, "copy unavailable"), 1),
                    );
                    // Keep an unrelated failure: erasing Alice must not hide it.
                    raw.item_read_errors.lock().unwrap().insert(
                        other.into(),
                        (StoreError::native(-25291, "other unavailable"), usize::MAX),
                    );
                    let store = Secrets::new(raw);
                    assert!(store.get(&copy).is_err());
                    let other_error = store.get(other).unwrap_err();
                    if clear_denials_first {
                        store.retry_denied_access(account).unwrap();
                    }
                    let reads = store.store.reads.lock().unwrap().clone();
                    store.delete(account).unwrap();
                    assert!(store.get(account).unwrap().is_none());
                    assert!(store.get(&copy).unwrap().is_none());
                    assert!(store.recovery_candidates(account).unwrap().is_empty());
                    assert_eq!(
                        store.refused_access(account).unwrap(),
                        RefusalState::NotHeld
                    );
                    assert_eq!(
                        store.retry_refused_access(account).unwrap(),
                        RefusedRetry::NothingRefused
                    );
                    assert_eq!(
                        store.get("mcp-token").unwrap().as_deref(),
                        Some("test-token")
                    );
                    assert_eq!(
                        *store.store.reads.lock().unwrap(),
                        reads,
                        "erase never decrypts the failed copy again"
                    );
                    assert_eq!(store.get(other).unwrap_err(), other_error);
                    assert!(!store.store.items.lock().unwrap().contains_key(account));
                    assert!(!store.store.items.lock().unwrap().contains_key(&copy));
                    // Retirement's next key save need not wait for a restart.
                    store.set(account, "cmVwbGFjZW1lbnQ=").unwrap();
                    assert_eq!(
                        store.get(account).unwrap().as_deref(),
                        Some("cmVwbGFjZW1lbnQ=")
                    );
                    let restarted = Secrets::new(store.store);
                    assert_eq!(
                        restarted.get(account).unwrap().as_deref(),
                        Some("cmVwbGFjZW1lbnQ=")
                    );
                    assert!(restarted.recovery_candidates(account).unwrap().is_empty());
                }
            }
        }
    }

    // FLM-440 F1: clearing an alias denial for explicit erase/retry must not
    // turn its unread value into absence and let MCP replace the configured token.
    #[test]
    fn partial_migration_cleared_copy_result_keeps_its_physical_source() {
        let raw = legacy();
        let account = "mcp-token";
        let value = raw.items.lock().unwrap().remove(account).unwrap();
        let copy = format!("{BACKUP_PREFIX}{account}");
        raw.set(&copy, &value).unwrap();
        raw.item_read_errors
            .lock()
            .unwrap()
            .insert(copy.clone(), (StoreError::denied(), 1));
        let store = Secrets::new(raw);
        assert!(store.get(account).is_err());
        store.store.reads.lock().unwrap().clear();
        store.retry_denied_access(account).unwrap();
        assert_eq!(store.get(account).unwrap().as_deref(), Some(value.as_str()));
        assert_eq!(*store.store.reads.lock().unwrap(), [copy]);
        assert!(!store.store.items.lock().unwrap().contains_key(account));
    }

    // FLM-440 F1: a granted recovery copy stays a candidate for real key
    // validation; it must not become an unvalidated live passphrase.
    #[test]
    fn partial_migration_retry_recovers_candidates_without_promoting_them() {
        let account = "openpgp_passphrase:alice@example.com";
        for absent_after_retry in [false, true] {
            let raw = legacy();
            let value = raw.items.lock().unwrap().remove(account).unwrap();
            let copy = format!("{}fixture", recovery_prefix(account));
            raw.set(&copy, &value).unwrap();
            raw.item_read_errors
                .lock()
                .unwrap()
                .insert(copy.clone(), (StoreError::denied(), 1));
            let store = Secrets::new(raw);
            assert!(store.get(account).unwrap().is_none());
            assert_eq!(store.refused_access(account).unwrap(), RefusalState::Held);
            store.store.reads.lock().unwrap().clear();
            if absent_after_retry {
                store.store.items.lock().unwrap().remove(&copy);
            }
            assert_eq!(
                store.retry_refused_access(account).unwrap(),
                RefusedRetry::Read
            );
            assert!(store.get(account).unwrap().is_none());
            assert_eq!(
                store.recovery_candidates(account).unwrap(),
                if absent_after_retry {
                    vec![]
                } else {
                    vec![value]
                }
            );
            assert_eq!(*store.store.reads.lock().unwrap(), [copy]);
            assert!(!store.store.items.lock().unwrap().contains_key(account));
            assert_eq!(
                store.refused_access(account).unwrap(),
                RefusalState::NotHeld
            );
        }
    }

    // FLM-86: unknown live data must not become a stale backup or genuine absence.
    #[test]
    fn partial_migration_does_not_substitute_backup_for_failed_live_item() {
        let raw = legacy();
        let account = "openpgp_passphrase:alice@example.com";
        raw.set(&format!("{BACKUP_PREFIX}{account}"), "stale-backup")
            .unwrap();
        raw.item_read_errors
            .lock()
            .unwrap()
            .insert(account.into(), (StoreError::denied(), 1));
        let store = Secrets::new(raw);
        assert!(store.get(account).is_err());
        assert!(store.legacy_candidate(account).is_err());
        assert_eq!(store.refused_access(account).unwrap(), RefusalState::Held);
        assert_eq!(
            store.retry_refused_access(account).unwrap(),
            RefusedRetry::Read
        );
        assert_eq!(store.get(account).unwrap().as_deref(), Some("dGVzdC1wYXNz"));
        assert_eq!(
            store
                .store
                .reads
                .lock()
                .unwrap()
                .iter()
                .filter(|a| a.as_str() == account)
                .count(),
            2
        );
        assert_eq!(*store.store.scans.lock().unwrap(), 1);
    }

    // FLM-86: explicit retries keep their existing one-request semantics, but
    // no longer ask about unrelated failed migration items.
    #[test]
    fn partial_migration_explicit_retry_is_targeted_and_preserves_refusal_on_error() {
        let raw = legacy();
        let account = "openpgp_passphrase:alice@example.com";
        for name in [account, "mcp-token"] {
            raw.item_read_errors
                .lock()
                .unwrap()
                .insert(name.into(), (StoreError::denied(), 1));
        }
        let store = Secrets::new(raw);
        assert!(store.get(account).is_err());
        store.store.reads.lock().unwrap().clear();
        for error in [
            StoreError::native(-25291, "unavailable"),
            StoreError::denied(),
        ] {
            store
                .store
                .item_read_errors
                .lock()
                .unwrap()
                .insert(account.into(), (error.clone(), 1));
            let retried = store.retry_refused_access(account);
            if error.user_denial() {
                assert_eq!(retried.unwrap(), RefusedRetry::RefusedAgain);
            } else {
                assert!(retried.is_err());
            }
            assert_eq!(store.refused_access(account).unwrap(), RefusalState::Held);
            assert!(store.get(account).is_err());
        }
        assert_eq!(
            store.retry_refused_access(account).unwrap(),
            RefusedRetry::Read
        );
        assert!(store.get(account).unwrap().is_some());
        assert!(store.get("mcp-token").is_err());
        assert_eq!(
            *store.store.reads.lock().unwrap(),
            [account, account, account]
        );
        assert_eq!(*store.store.scans.lock().unwrap(), 1);
    }

    // FLM-86: writes, adoption and explicit erase must replace their cached
    // per-item failure, including when every source initially failed.
    #[test]
    fn partial_migration_mutations_clear_only_their_own_error_after_success() {
        for operation in ["save", "adopt", "erase"] {
            let raw = legacy();
            let originals = raw.items.lock().unwrap().clone();
            for name in originals.keys() {
                raw.item_read_errors
                    .lock()
                    .unwrap()
                    .insert(name.clone(), (StoreError::denied(), 1));
            }
            let store = Secrets::new(raw);
            let account = "openpgp_passphrase:alice@example.com";
            assert!(store.get(account).is_err());
            if operation == "erase" {
                store.retry_denied_access(account).unwrap();
                // Captain F2: a key erase clears only this account's refusal.
                let count = store.store.reads.lock().unwrap().len();
                assert!(store.get("last_user").is_err());
                assert_eq!(store.store.reads.lock().unwrap().len(), count);
                store.delete(account).unwrap();
                assert!(store.get(account).unwrap().is_none());
            } else {
                *store.store.fail_write.lock().unwrap() = true;
                assert!(if operation == "save" {
                    store.set(account, "new-pass")
                } else {
                    store.adopt_legacy(account, "new-pass")
                }
                .is_err());
                assert!(store.get(account).is_err());
                *store.store.fail_write.lock().unwrap() = false;
                if operation == "save" {
                    store.set(account, "new-pass").unwrap();
                } else {
                    store.adopt_legacy(account, "new-pass").unwrap();
                }
                assert_eq!(store.get(account).unwrap().as_deref(), Some("new-pass"));
            }
            assert!(store.get("mcp-token").is_err());
            assert!(store.get("last_user").is_err());
            assert!(!store.store.items.lock().unwrap().contains_key(ACCOUNT));
            let restarted = Secrets::new(store.store);
            assert_eq!(
                restarted.get(account).unwrap().as_deref(),
                if operation == "erase" {
                    None
                } else {
                    Some("new-pass")
                }
            );
            assert_eq!(
                restarted.get("mcp-token").unwrap().as_deref(),
                Some("test-token")
            );
        }
    }

    // Captain's F2=narrow and F3=reread: a wipe retries its pointer/account,
    // including a transient last_user or its backup, never other refusals.
    #[test]
    fn partial_migration_credential_wipe_retries_only_its_needed_sources() {
        for code in [-25291, -25293, -128] {
            for backup_pointer in [false, true] {
                let raw = legacy();
                let pointer = if backup_pointer {
                    let value = raw.items.lock().unwrap().remove("last_user").unwrap();
                    let copy = format!("{BACKUP_PREFIX}last_user");
                    raw.set(&copy, &value).unwrap();
                    copy
                } else {
                    "last_user".into()
                };
                raw.item_read_errors.lock().unwrap().insert(
                    pointer.clone(),
                    (StoreError::native(code, "pointer unavailable"), 1),
                );
                for name in [
                    "alice@example.com",
                    "mcp-token",
                    "openpgp_passphrase:alice@example.com",
                ] {
                    raw.item_read_errors
                        .lock()
                        .unwrap()
                        .insert(name.into(), (StoreError::denied(), 1));
                }
                let store = Secrets::new(raw);
                assert!(crate::credentials::load(&store).is_err());
                store.store.reads.lock().unwrap().clear();
                crate::credentials::delete_macos_explicit(&store).unwrap();
                assert!(crate::credentials::load(&store).unwrap().is_none());
                assert_eq!(*store.store.reads.lock().unwrap(), [pointer]);
                for name in ["mcp-token", "openpgp_passphrase:alice@example.com"] {
                    assert!(store.get(name).is_err());
                    assert_eq!(store.refused_access(name).unwrap(), RefusalState::Held);
                    assert!(store.store.items.lock().unwrap().contains_key(name));
                }
                assert!(!store
                    .store
                    .items
                    .lock()
                    .unwrap()
                    .contains_key("alice@example.com"));
                assert!(!store.store.items.lock().unwrap().contains_key("last_user"));
            }
        }
    }

    // Captain F3: repeated transient failures retry that item, not successful
    // siblings or a denial, even when the first migration had no usable item.
    #[test]
    fn partial_migration_later_reads_retry_only_the_failed_non_denial_item() {
        let raw = legacy();
        let names: Vec<_> = raw.items.lock().unwrap().keys().cloned().collect();
        let refused = "openpgp_passphrase:alice@example.com";
        for name in names {
            let error = if name == refused {
                StoreError::denied()
            } else {
                StoreError::native(-25291, "temporarily unavailable")
            };
            raw.item_read_errors
                .lock()
                .unwrap()
                .insert(name, (error, 2));
        }
        let store = Secrets::new(raw);
        assert!(store.get("mcp-token").is_err());
        store.store.reads.lock().unwrap().clear();
        assert!(store.get("mcp-token").is_err());
        assert_eq!(
            store.get("mcp-token").unwrap().as_deref(),
            Some("test-token")
        );
        assert!(store.get(refused).is_err());
        assert_eq!(store.refused_access(refused).unwrap(), RefusalState::Held);
        assert_eq!(
            *store.store.reads.lock().unwrap(),
            ["mcp-token", "mcp-token"]
        );
        assert_eq!(*store.store.scans.lock().unwrap(), 1);
        assert!(store
            .store
            .writes
            .lock()
            .unwrap()
            .iter()
            .all(|name| name != ACCOUNT));
    }

    // Captain F4=candidates: neither a good live value nor a migration backup
    // is blocked by a failed recovery copy. Refused candidates still enable
    // explicit retry for a locked key with a readable but stale passphrase.
    #[test]
    fn partial_migration_recovery_copies_are_candidates_not_value_failures() {
        let account = "openpgp_passphrase:alice@example.com";
        for live_present in [false, true] {
            for denied in [false, true] {
                let raw = legacy();
                let value = raw.items.lock().unwrap()[account].clone();
                let expected = if live_present {
                    raw.set(account, "c3RhbGU=").unwrap();
                    "c3RhbGU=".to_string()
                } else {
                    raw.items.lock().unwrap().remove(account);
                    raw.set(&format!("{BACKUP_PREFIX}{account}"), &value)
                        .unwrap();
                    value.clone()
                };
                let failed = format!("{}failed", recovery_prefix(account));
                let readable = format!("{}readable", recovery_prefix(account));
                raw.set(&failed, &value).unwrap();
                raw.set(&readable, "b3RoZXI=").unwrap();
                let error = if denied {
                    StoreError::denied()
                } else {
                    StoreError::native(-25291, "copy unavailable")
                };
                raw.item_read_errors
                    .lock()
                    .unwrap()
                    .insert(failed.clone(), (error, 1));
                let store = Secrets::new(raw);
                assert_eq!(
                    store.get(account).unwrap().as_deref(),
                    Some(expected.as_str())
                );
                store.store.reads.lock().unwrap().clear();
                let candidates = store.recovery_candidates(account).unwrap();
                assert!(candidates.contains(&"b3RoZXI=".to_string()));
                if denied {
                    assert!(!candidates.contains(&value));
                    assert_eq!(store.refused_access(account).unwrap(), RefusalState::Held);
                    assert_eq!(
                        store.retry_refused_access(account).unwrap(),
                        RefusedRetry::Read
                    );
                } else {
                    assert!(candidates.contains(&value));
                    assert_eq!(
                        store.refused_access(account).unwrap(),
                        RefusalState::NotHeld
                    );
                }
                assert!(store.recovery_candidates(account).unwrap().contains(&value));
                assert_eq!(
                    store.get(account).unwrap().as_deref(),
                    Some(expected.as_str())
                );
                assert_eq!(*store.store.reads.lock().unwrap(), [failed]);
                assert_eq!(*store.store.scans.lock().unwrap(), 1);
                assert!(!store.store.items.lock().unwrap().contains_key(ACCOUNT));
                assert_eq!(
                    store.store.items.lock().unwrap().get(account).cloned(),
                    if live_present { Some(expected) } else { None }
                );
            }
        }
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
    // FLM-298 review R1: restoring one account moves only that account. The
    // others, and the shared credentials, keep reading the old item.
    #[test]
    fn fresh_account_is_isolated_from_old_items_and_other_accounts() {
        let alice = "openpgp_passphrase:alice@example.com";
        let bob = "openpgp_passphrase:bob@example.org";
        let store = combined();
        store.fresh_write(alice, "restored").unwrap();
        // Nothing routes to the fresh item before the commit.
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("dGVzdC1wYXNz"));
        store.commit_fresh(alice).unwrap();
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("restored"));
        assert_eq!(store.get(bob).unwrap().as_deref(), Some("aW5hY3RpdmUta2V5"));
        assert_eq!(store.get("mcp-token").unwrap().as_deref(), Some("test-token"));
        assert!(crate::credentials::load(&store).unwrap().is_some());
        // Never an old-layout candidate for the restored account.
        assert_eq!(SecretStore::legacy_candidate(&store, alice).unwrap(), None);
        assert!(SecretStore::recovery_candidates(&store, alice).unwrap().is_empty());
        // Later writes stay in the fresh item.
        store.set(alice, "rotated").unwrap();
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("rotated"));
        let old: Bundle =
            serde_json::from_str(&store.store.get(ACCOUNT).unwrap().unwrap()).unwrap();
        assert_eq!(old.items[alice], "dGVzdC1wYXNz");
    }

    // FLM-298 review R1/R3: a refused old item never reaches a restored
    // account, and is not retried for the others.
    #[test]
    fn refused_old_items_do_not_block_a_restored_account() {
        let alice = "openpgp_passphrase:alice@example.com";
        let store = Secrets::new(legacy());
        *store.store.read_error.lock().unwrap() = Some((StoreError::denied(), usize::MAX));
        store.fresh_write(alice, "restored").unwrap();
        store.commit_fresh(alice).unwrap();
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("restored"));
        assert!(store.get("mcp-token").is_err());
        let reads = store.store.reads.lock().unwrap().len();
        assert!(store.get("mcp-token").is_err());
        assert_eq!(store.store.reads.lock().unwrap().len(), reads, "no retry");
        // A relaunch over the same storage still reads the restored secret.
        let relaunched = Secrets::new(store.store);
        assert_eq!(relaunched.get(alice).unwrap().as_deref(), Some("restored"));
    }

    // FLM-403 F31: newly merged explicit retry still goes through the observed
    // backend; cached denial/offer paths must not manufacture another access.
    #[test]
    fn explicit_keychain_retry_keeps_balanced_backend_access_observation() {
        thread_local! { static EVENTS: std::cell::RefCell<Vec<bool>> = const { std::cell::RefCell::new(Vec::new()) }; }
        fn observe(pending: bool) { EVENTS.with(|e| e.borrow_mut().push(pending)); }
        let mut store = combined();
        store.store.access_observer = Some(observe);
        EVENTS.with(|e| e.borrow_mut().clear());
        *store.store.read_error.lock().unwrap() = Some((StoreError::denied(), 1));
        let account = "openpgp_passphrase:alice@example.com";
        assert!(store.get(account).is_err());
        assert_eq!(store.refused_access(account), Ok(RefusalState::Held));
        EVENTS.with(|e| assert_eq!(*e.borrow(), [true, false]));
        assert_eq!(store.retry_refused_access(account), Ok(RefusedRetry::Read));
        EVENTS.with(|e| assert_eq!(*e.borrow(), [true, false, true, false]));
    }

    // FLM-304, the captain on FLM-298 review R3: "Never, but maybe an explicit
    // retry try could be proposed in a advanced panel, in case there is no
    // other way to recover the key". A refusal stays cached until the user
    // asks; each request reads once; offering the retry never reads or waits.
    #[test]
    fn flm304_explicit_retry_reads_a_refused_item_once_per_request() {
        let account = "openpgp_passphrase:alice@example.com";
        let store = combined();
        *store.store.read_error.lock().unwrap() = Some((StoreError::denied(), 2));
        assert!(store.get(account).is_err());
        assert!(store.get(account).is_err());
        assert_eq!(store.refused_access(account), Ok(RefusalState::Held));
        {
            // FLM-408 R4: a read under way, perhaps a retry on a prompt, is
            // neither a refusal nor a consumed one, and asking never waits.
            let _reading = store.cache.lock().unwrap();
            assert_eq!(store.refused_access(account), Ok(RefusalState::Pending));
        }
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT]);

        assert_eq!(store.retry_refused_access(account), Ok(RefusedRetry::RefusedAgain));
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT, ACCOUNT]);
        assert!(store.get(account).is_err());
        assert_eq!(store.refused_access(account), Ok(RefusalState::Held));
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT, ACCOUNT]);

        assert_eq!(store.retry_refused_access(account), Ok(RefusedRetry::Read));
        assert_eq!(store.get(account).unwrap().as_deref(), Some("dGVzdC1wYXNz"));
        assert_eq!(store.refused_access(account), Ok(RefusalState::NotHeld));
        assert_eq!(store.retry_refused_access(account), Ok(RefusedRetry::NothingRefused));
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT, ACCOUNT, ACCOUNT]);
    }

    // FLM-304: a retry that fails for another reason than the user's answer
    // keeps the refusal, so nothing reads again before the next request.
    #[test]
    fn flm304_a_failed_retry_keeps_the_refusal() {
        let account = "openpgp_passphrase:alice@example.com";
        let store = combined();
        *store.store.read_error.lock().unwrap() = Some((StoreError::denied(), 1));
        assert!(store.get(account).is_err());
        *store.store.read_error.lock().unwrap() =
            Some((StoreError::native(-25308, "interaction not allowed"), 1));
        assert!(store.retry_refused_access(account).is_err());
        assert!(store.get(account).is_err());
        assert_eq!(store.refused_access(account), Ok(RefusalState::Held));
        assert_eq!(*store.store.reads.lock().unwrap(), [ACCOUNT, ACCOUNT]);
        assert_eq!(store.retry_refused_access(account), Ok(RefusedRetry::Read));
    }

    // FLM-304: a refused old item of one account is retried for that account
    // only, and only on request.
    #[test]
    fn flm304_retry_rereads_only_this_accounts_refused_old_item() {
        let alice = "openpgp_passphrase:alice@example.com";
        let bob = "openpgp_passphrase:bob@example.org";
        let store = combined();
        store
            .store
            .item_read_errors
            .lock()
            .unwrap()
            .insert(alice.into(), (StoreError::denied(), 2));
        let alice_reads = || {
            store
                .store
                .reads
                .lock()
                .unwrap()
                .iter()
                .filter(|a| *a == alice)
                .count()
        };
        assert!(store.legacy_candidate(alice).is_err());
        assert!(store.legacy_candidate(alice).is_err());
        assert_eq!(alice_reads(), 1);
        assert_eq!(store.refused_access(alice), Ok(RefusalState::Held));
        assert_eq!(store.refused_access(bob), Ok(RefusalState::NotHeld));
        assert_eq!(store.retry_refused_access(bob), Ok(RefusedRetry::NothingRefused));

        assert_eq!(store.retry_refused_access(alice), Ok(RefusedRetry::RefusedAgain));
        assert!(store.legacy_candidate(alice).is_err());
        assert_eq!(alice_reads(), 2);
        assert_eq!(store.retry_refused_access(alice), Ok(RefusedRetry::Read));
        assert_eq!(store.legacy_candidate(alice).unwrap().as_deref(), Some("dGVzdC1wYXNz"));
        assert_eq!(alice_reads(), 3);
        assert!(store.store.reads.lock().unwrap().iter().all(|a| a != bob));
    }

    // FLM-304 with FLM-343: a restored account never reads its old items, so
    // it is never offered the retry, and a request reads nothing.
    #[test]
    fn flm304_a_restored_account_never_retries_its_old_items() {
        let alice = "openpgp_passphrase:alice@example.com";
        let store = Secrets::new(legacy());
        *store.store.read_error.lock().unwrap() = Some((StoreError::denied(), usize::MAX));
        store.fresh_write(alice, "restored").unwrap();
        store.commit_fresh(alice).unwrap();
        assert!(store.get("mcp-token").is_err());
        let reads = store.store.reads.lock().unwrap().len();
        assert_eq!(store.refused_access(alice), Ok(RefusalState::NotHeld));
        assert!(store.retry_refused_access(alice).is_err());
        assert_eq!(store.store.reads.lock().unwrap().len(), reads);
        assert_eq!(store.refused_access("openpgp_passphrase:bob@example.org"), Ok(RefusalState::Held));
    }

    // FLM-298 review R5: forgetting a restored account erases both storages,
    // or says which copy it could not erase.
    #[test]
    fn forgetting_a_restored_account_erases_both_copies_or_reports() {
        let alice = "openpgp_passphrase:alice@example.com";
        let store = combined();
        store.fresh_write(alice, "restored").unwrap();
        store.commit_fresh(alice).unwrap();
        store.delete(alice).unwrap();
        assert_eq!(store.get(alice).unwrap(), None);
        let old: Bundle =
            serde_json::from_str(&store.store.get(ACCOUNT).unwrap().unwrap()).unwrap();
        assert!(!old.items.contains_key(alice));
        assert!(store.store.get(alice).unwrap().is_none());

        let store = combined();
        store.fresh_write(alice, "restored").unwrap();
        store.commit_fresh(alice).unwrap();
        *store.store.fail_delete.lock().unwrap() = true;
        let error = store.delete(alice).unwrap_err();
        assert!(error.contains("old copy") && !error.contains("restored copy"), "{error}");
        assert_eq!(store.get(alice).unwrap(), None, "the restored copy is gone");

        let store = Secrets::new(legacy());
        *store.store.read_error.lock().unwrap() = Some((StoreError::denied(), usize::MAX));
        store.fresh_write(alice, "restored").unwrap();
        store.commit_fresh(alice).unwrap();
        let error = store.delete(alice).unwrap_err();
        assert!(error.starts_with("Not erased: old copy"), "{error}");
        assert_eq!(store.get(alice).unwrap(), None);
    }

    // FLM-302 R2 (store level): a staged restore secret never replaces the live
    // protection of an active key until it is promoted.
    #[test]
    fn staged_secret_replaces_the_live_one_only_on_commit() {
        let alice = "openpgp_passphrase:alice@example.com";
        let store = combined();
        store.fresh_write(alice, "first").unwrap();
        store.commit_fresh(alice).unwrap();
        store.fresh_write(alice, "second").unwrap();
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("first"));
        store.abort_fresh(alice).unwrap();
        assert!(store.commit_fresh(alice).is_err(), "nothing left to promote");
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("first"));
        store.fresh_write(alice, "second").unwrap();
        store.commit_fresh(alice).unwrap();
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("second"));
        let fresh: Bundle =
            serde_json::from_str(&store.store.get(FRESH_ACCOUNT).unwrap().unwrap()).unwrap();
        assert_eq!(fresh.items.len(), 1, "no staged copy remains");
    }

    // FLM-302 R10: a record published before its directory sync failed is in
    // use. Commit confirms it again instead of reporting a failure the next
    // read contradicts.
    #[test]
    fn commit_confirms_a_record_published_before_the_sync_failed() {
        let alice = "openpgp_passphrase:alice@example.com";
        let store = combined();
        *store.store.mark_failures_after_publish.lock().unwrap() = 1;
        store.fresh_write(alice, "restored").unwrap();
        store.commit_fresh(alice).unwrap();
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("restored"));
        // When it cannot be confirmed, the failure is reported.
        let other = "openpgp_passphrase:bob@example.org";
        *store.store.mark_failures_after_publish.lock().unwrap() = 2;
        store.fresh_write(other, "restored").unwrap();
        assert!(store.commit_fresh(other).is_err());
        assert!(store.restored(other).unwrap(), "yet it is published and in use");
    }

    // FLM-302 R10 (round 3): a failed record write followed by a failed read
    // back leaves publication unknown; commit says so instead of "absent".
    #[test]
    fn commit_reports_unknown_publication_when_the_probe_fails() {
        let alice = "openpgp_passphrase:alice@example.com";
        let store = combined();
        *store.store.mark_failures_after_publish.lock().unwrap() = 1;
        *store.store.unreadable_after_failed_mark.lock().unwrap() = true;
        store.fresh_write(alice, "restored").unwrap();
        let error = store.commit_fresh(alice).unwrap_err();
        assert!(error.contains("could not be confirmed"), "{error}");
        // The probe itself is an error, never "not restored".
        assert!(store.restored(alice).is_err());
    }

    // FLM-302 R3: startup loading after a restore must not read the restored
    // account's refused originals or their aliases again.
    #[test]
    fn migration_skips_restored_accounts_and_their_aliases() {
        let alice = "openpgp_passphrase:alice@example.com";
        let raw = legacy();
        raw.set(&format!("{BACKUP_PREFIX}{alice}"), "YmFja3Vw").unwrap();
        raw.set(&format!("{}uuid", recovery_prefix(alice)), "cmVjb3Zlcnk=")
            .unwrap();
        raw.fresh.lock().unwrap().push(alice.into());
        let store = Secrets::new(raw);
        assert!(crate::credentials::load(&store).unwrap().is_some());
        assert_eq!(store.get("mcp-token").unwrap().as_deref(), Some("test-token"));
        let reads = store.store.reads.lock().unwrap().clone();
        assert!(
            !reads.iter().any(|name| name.contains("alice@example.com")
                && name != "alice@example.com"),
            "read {reads:?}"
        );
        // Explicit erasure still reaches the retained originals.
        store.delete(alice).unwrap();
        let items = store.store.items.lock().unwrap();
        assert!(!items.contains_key(alice));
        assert!(!items.keys().any(|name| name.contains(&format!(":{alice}"))));
    }

    // FLM-302 R5: a staged secret from a failed restore is erased by forget,
    // even though the account was never routed to the fresh item.
    #[test]
    fn forgetting_erases_a_staged_secret_left_by_a_failed_restore() {
        let alice = "openpgp_passphrase:alice@example.com";
        let store = combined();
        store.fresh_write(alice, "staged").unwrap();
        store.delete(alice).unwrap();
        let fresh: Bundle =
            serde_json::from_str(&store.store.get(FRESH_ACCOUNT).unwrap().unwrap()).unwrap();
        assert!(fresh.items.is_empty(), "{:?}", fresh.items.keys());
    }

    // FLM-302 R9: an unreadable record of restored accounts is an error, never
    // an empty list that sends reads and writes back to the old items.
    #[test]
    fn unreadable_fresh_record_preserves_routes_instead_of_reverting() {
        let alice = "openpgp_passphrase:alice@example.com";
        let store = combined();
        store.fresh_write(alice, "restored").unwrap();
        store.commit_fresh(alice).unwrap();
        *store.store.fresh_unreadable.lock().unwrap() = true;
        let writes = store.store.writes.lock().unwrap().len();
        assert!(store.get(alice).is_err());
        assert!(store.set(alice, "x").is_err());
        assert!(store.delete(alice).is_err());
        assert!(store.fresh_write(alice, "again").is_ok(), "staging touches nothing live");
        assert!(store.commit_fresh(alice).is_err());
        assert_eq!(store.store.writes.lock().unwrap().len(), writes + 1);
        *store.store.fresh_unreadable.lock().unwrap() = false;
        assert_eq!(store.get(alice).unwrap().as_deref(), Some("restored"));
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
            store.retry_denied_access("mcp-token").unwrap();
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

    #[test]
    fn explicit_erase_retries_a_refused_fresh_item() {
        let account = "openpgp_passphrase:alice@example.com";
        let raw = legacy();
        raw.fresh.lock().unwrap().push(account.into());
        let mut bundle = Bundle::default();
        bundle
            .items
            .insert(account.into(), "protection-secret".into());
        raw.set(FRESH_ACCOUNT, &serde_json::to_string(&bundle).unwrap())
            .unwrap();
        *raw.fresh_read_error.lock().unwrap() = Some((StoreError::denied(), 1));
        let store = Secrets::new(raw);
        assert!(store.get(account).is_err());
        store.retry_denied_access(account).unwrap();
        store.delete(account).unwrap();
        let restarted = Secrets::new(store.store);
        assert!(restarted.get(account).unwrap().is_none());
    }

    #[test]
    fn explicit_retry_preserves_an_invalid_fresh_item() {
        let account = "openpgp_passphrase:alice@example.com";
        let raw = FakeStore::default();
        raw.fresh.lock().unwrap().push(account.into());
        raw.set(FRESH_ACCOUNT, "invalid bundle").unwrap();
        let store = Secrets::new(raw);
        let failure = store.get(account).unwrap_err();
        let repaired = serde_json::to_string(&Bundle::default()).unwrap();
        store
            .store
            .items
            .lock()
            .unwrap()
            .insert(FRESH_ACCOUNT.into(), repaired.clone());
        store.retry_denied_access(account).unwrap();
        assert_eq!(store.get(account).unwrap_err(), failure);
        assert_eq!(
            store
                .store
                .items
                .lock()
                .unwrap()
                .get(FRESH_ACCOUNT)
                .unwrap(),
            &repaired
        );
    }
}

//! Retire only verified duplicates. Never import an old value over a current
//! secret, and never delete an item whose value or generation is unknown.
use super::{is_bundle, legacy_owner, Bundle, StoreResult, ACCOUNT};

pub(super) struct Snapshot<T> {
    value: String,
    item: T,
}
trait Store {
    type Item;
    fn combined(&self) -> StoreResult<Option<String>>;
    fn restored(&self) -> StoreResult<Vec<String>>;
    fn accounts(&self) -> StoreResult<Vec<String>>;
    fn snapshot(&self, account: &str) -> StoreResult<Option<Snapshot<Self::Item>>>;
    /// Delete only this exact generation; false means it changed or disappeared.
    fn remove(&self, snapshot: Snapshot<Self::Item>) -> StoreResult<bool>;
}
#[derive(Default, Debug)]
struct Summary {
    removed: usize,
    retained: usize,
    unavailable: usize,
    changed: usize,
    problems: std::collections::BTreeSet<String>,
}
impl Summary {
    fn diagnostic(&self) -> String {
        format!(
            "Legacy keychain cleanup: {} removed, {} retained, {} unavailable, {} changed. \
             Retained copies were not erased. Quit older Fluux copies and reopen the current app to retry; \
             use explicit logout or OpenPGP forget to authorize erasing remaining copies. {}",
            self.removed, self.retained, self.unavailable, self.changed,
            self.problems.iter().cloned().collect::<Vec<_>>().join("; ")
        )
    }
}
fn owned(name: &str, value: &str) -> bool {
    let account = legacy_owner(name).unwrap_or(name);
    matches!(account, "last_user" | "mcp-token")
        || account
            .strip_prefix("openpgp_passphrase:")
            .is_some_and(|jid| !jid.is_empty())
        || (account
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty())
            && !account.contains('/')
            && serde_json::from_str::<crate::credentials::StoredCredentials>(value)
                .is_ok_and(|credentials| credentials.jid == account))
}
fn clean(store: &impl Store) -> StoreResult<Summary> {
    let Some(json) = store.combined()? else {
        return Ok(Summary::default());
    };
    let bundle: Bundle = serde_json::from_str(&json)
        .map_err(|_| "Could not verify combined secrets; legacy items were not erased")?;
    if bundle.version != 1 {
        return Err("Unsupported combined secrets; legacy items were not erased".into());
    }
    // A failed fresh-start record is not permission to route restored accounts
    // back to old storage, or to erase their copies.
    let restored = store.restored()?;
    let mut summary = Summary::default();
    for account in store.accounts()? {
        if is_bundle(&account) {
            continue;
        }
        let expected = bundle.items.get(&account);
        if expected.is_none_or(|value| !owned(&account, value))
            || restored
                .iter()
                .any(|name| name == &account || legacy_owner(&account) == Some(name.as_str()))
        {
            summary.retained += 1;
            continue;
        }
        let snapshot = match store.snapshot(&account) {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => continue,
            Err(error) => {
                // Preserve the backend status without printing account names,
                // secret bytes, or a malformed item's serialized contents.
                summary.problems.insert(format!("Read failed: {error}"));
                summary.unavailable += 1;
                continue;
            }
        };
        if Some(&snapshot.value) != expected {
            summary.retained += 1;
            continue;
        }
        match store.remove(snapshot) {
            Ok(true) => summary.removed += 1,
            Ok(false) => summary.changed += 1,
            Err(error) => {
                summary.problems.insert(format!("Deletion failed: {error}"));
                summary.unavailable += 1;
            }
        }
    }
    Ok(summary)
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use crate::macos_secrets::{
        native::{Keychain, SERVICE},
        Backend,
    };
    use core_foundation::{
        array::CFArray,
        base::{CFType, TCFType},
        data::CFData,
        dictionary::CFDictionary,
        string::CFString,
    };
    use security_framework::{item::SearchResult, os::macos::keychain::SecKeychain};
    use security_framework_sys::{item::*, keychain_item::SecItemDelete};
    // Public Security.framework constants not exposed by the current sys crate.
    // Their types and availability come from the platform's SecItem.h header.
    unsafe extern "C" {
        static kSecMatchItemList: core_foundation::string::CFStringRef;
    }

    pub(super) const FLAG: &str = "--cleanup-legacy-keychain";
    struct Generation {
        reference: CFType,
    }
    // All calls use this exact-item backend under one exclusive revision lock.
    // The helper never writes either combined item or the fresh-start record.
    struct Locked<'a>(&'a Keychain);
    fn field(
        dict: &CFDictionary,
        key: core_foundation::string::CFStringRef,
    ) -> StoreResult<CFType> {
        let value = dict
            .find(key.cast())
            .ok_or("Missing keychain generation attribute; copy retained")?;
        // SAFETY: the dictionary owns a Core Foundation value. Retain it before
        // the search results are dropped; typed fields are checked below.
        Ok(unsafe { CFType::wrap_under_get_rule(*value) })
    }
    impl Store for Locked<'_> {
        type Item = Generation;
        fn combined(&self) -> StoreResult<Option<String>> {
            self.0.read_item(ACCOUNT)
        }
        fn restored(&self) -> StoreResult<Vec<String>> {
            self.0.fresh_accounts()
        }
        fn accounts(&self) -> StoreResult<Vec<String>> {
            self.0.accounts()
        }
        fn snapshot(&self, account: &str) -> StoreResult<Option<Snapshot<Generation>>> {
            let items = match self
                .0
                .query(Some(account))
                .load_attributes(true)
                .load_data(true)
                .load_refs(true)
                .search()
            {
                Ok(items) => items,
                Err(error) if error.code() == -25300 => return Ok(None),
                Err(error) => {
                    return Err(
                        format!("Read legacy generation ({}): {error}", error.code()).into(),
                    )
                }
            };
            let Some(SearchResult::Dict(attributes)) = items.first() else {
                return Err("Missing keychain generation; copy retained".into());
            };
            let attributes = attributes.to_untyped();
            // SAFETY: these are the platform's immutable attribute keys.
            let (bytes, reference) = unsafe {
                (
                    field(&attributes, kSecValueData)?.downcast::<CFData>(),
                    field(&attributes, kSecValueRef)?,
                )
            };
            let bytes = bytes.ok_or("Invalid keychain data; copy retained")?;
            Ok(Some(Snapshot {
                value: String::from_utf8(bytes.bytes().to_vec())
                    .map_err(|_| "Invalid legacy keychain text; copy retained")?,
                item: Generation { reference },
            }))
        }
        fn remove(&self, snapshot: Snapshot<Generation>) -> StoreResult<bool> {
            let generation = snapshot.item;
            let references = CFArray::from_CFTypes(&[generation.reference]);
            // A password-data predicate is ignored by the file-based keychain.
            // Match this exact native reference. A separate writer invalidates
            // this process's old reference; never fall back to an account-only
            // delete that might erase its replacement.
            let query = unsafe {
                let key = |value| CFString::wrap_under_get_rule(value).as_CFType();
                let mut pairs = vec![
                    (key(kSecClass), key(kSecClassGenericPassword)),
                    (key(kSecAttrService), CFString::new(SERVICE).as_CFType()),
                    (key(kSecMatchItemList), references.as_CFType()),
                ];
                // Match the same search scope that supplied the reference.
                // kSecMatchItemList filters a search; it does not select the
                // explicit disposable keychain instead of the default list.
                if let Some(keychain) = &self.0.keychain {
                    pairs.push((
                        key(kSecMatchSearchList),
                        CFArray::from_CFTypes(std::slice::from_ref(keychain)).as_CFType(),
                    ));
                }
                CFDictionary::from_CFType_pairs(&pairs)
            };
            // SAFETY: all query values remain owned for this call, and the
            // exact reference prevents a duplicate in another keychain matching.
            let status = unsafe { SecItemDelete(query.as_concrete_TypeRef()) };
            match status {
                0 => Ok(true),
                -25300 => Ok(false),
                code => Err(format!("Delete legacy generation ({code}); copy retained").into()),
            }
        }
    }
    pub(crate) fn perform(keychain: &Keychain) -> StoreResult<String> {
        // Qualification builds replace native secrets with an in-memory store.
        // Even an explicit helper flag must not bypass that isolation.
        if cfg!(feature = "startup-recovery-lab") {
            return Err("Legacy keychain cleanup is disabled in the disposable startup lab".into());
        }
        // Process-wide for file keychains, so do this only in the private
        // helper. Normal app reads and explicit erase keep their prompt policy.
        let _silent = SecKeychain::disable_user_interaction().map_err(|error| {
            format!(
                "Could not disable keychain interaction ({}): {error}",
                error.code()
            )
        })?;
        let _revision = keychain.cleanup_revision()?;
        clean(&Locked(keychain)).map(|result| result.diagnostic())
    }
    // Deferred cleanup must exercise the actual conditional deletion after an uncoordinated
    // legacy write, not a source-text or simulated-status assertion.
    #[cfg(test)]
    pub(crate) fn changed_generation(keychain: &Keychain) {
        let locked = Locked(keychain);
        let snapshot = locked.snapshot("mcp-token").unwrap().unwrap();
        // The helper is a separate process, so its snapshots cannot be refreshed
        // by an in-process writer. Exercise the real older-app process boundary.
        let invoke = |action| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "macos_secrets::native::native_keychain_probe",
                    "--exact",
                    "--ignored",
                    "--nocapture",
                ])
                .env("FLUUX_PROBE_ACTION", action)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        invoke("cleanup-race-write");
        assert!(!locked.remove(snapshot).unwrap());
        // The old keychain handle itself can be stale; prove persisted state
        // through a newly opened process, as after an application restart.
        invoke("cleanup-race-read");
    }
    pub(crate) fn run_worker() {
        if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(FLAG)) {
            return;
        }
        match perform(&Keychain::default()) {
            Ok(summary) => {
                println!("{summary}");
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("Legacy keychain cleanup stopped; copies retained: {error}. Reopen the current app to retry.");
                std::process::exit(1);
            }
        }
    }
    #[cfg(not(test))]
    pub(crate) fn schedule() {
        static STARTED: std::sync::Once = std::sync::Once::new();
        STARTED.call_once(|| {
            if let Err(error) = std::thread::Builder::new().name("keychain-cleanup".into()).spawn(|| {
                let result = std::env::current_exe().and_then(|path| {
                    std::process::Command::new(path).arg(FLAG)
                        .stdin(std::process::Stdio::null()).output()
                });
                match result {
                    Ok(output) if output.status.success() => {
                        tracing::info!("{}", String::from_utf8_lossy(&output.stdout).trim());
                    }
                    Ok(output) => tracing::warn!("{}", String::from_utf8_lossy(&output.stderr).trim()),
                    Err(error) => tracing::warn!("Legacy keychain cleanup did not start; copies retained: {error}. Reopen the current app to retry."),
                }
            }) {
                tracing::warn!("Legacy keychain cleanup did not start; copies retained: {error}. Reopen the current app to retry.");
            }
        });
    }
}
#[cfg(target_os = "macos")]
pub(crate) use native::run_worker;
#[cfg(all(target_os = "macos", not(test)))]
pub(super) use native::schedule;
#[cfg(all(target_os = "macos", test))]
pub(super) use native::{changed_generation, perform};

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::BTreeMap};

    // Deferred cleanup uses realistic legacy accounts and bundle data, with controlled failure
    // points and opaque per-item references at the storage interface.
    struct Fixture {
        bundle: RefCell<String>,
        items: RefCell<BTreeMap<String, (String, uuid::Uuid)>>,
        fresh: Vec<String>,
        unreadable_record: bool,
        read_failure: Vec<String>,
        delete_failure: Vec<String>,
        race: Option<String>,
        exit_after: Option<usize>,
        removed: RefCell<Vec<String>>,
    }
    fn fixture() -> Fixture {
        let values = BTreeMap::from([
            ("last_user".to_string(), "alice@example.com".to_string()),
            (
                "alice@example.com".into(),
                r#"{"jid":"alice@example.com","password":"test-password","server":null}"#.into(),
            ),
            (
                "openpgp_passphrase:alice@example.com".into(),
                "dGVzdC1wYXNz".into(),
            ),
            ("mcp-token".into(), "test-token".into()),
            (
                "identity-migration-backup:mcp-token".into(),
                "previous-token".into(),
            ),
        ]);
        let json = serde_json::json!({"version":1,"items":values}).to_string();
        Fixture {
            bundle: RefCell::new(json),
            items: RefCell::new(
                values
                    .into_iter()
                    .map(|(k, v)| (k, (v, uuid::Uuid::new_v4())))
                    .collect(),
            ),
            fresh: Vec::new(),
            unreadable_record: false,
            read_failure: Vec::new(),
            delete_failure: Vec::new(),
            race: None,
            exit_after: None,
            removed: RefCell::new(Vec::new()),
        }
    }
    impl Store for Fixture {
        type Item = (String, uuid::Uuid);
        fn combined(&self) -> StoreResult<Option<String>> {
            Ok(Some(self.bundle.borrow().clone()))
        }
        fn restored(&self) -> StoreResult<Vec<String>> {
            if self.unreadable_record {
                Err("Could not read the fresh-start record".into())
            } else {
                Ok(self.fresh.clone())
            }
        }
        fn accounts(&self) -> StoreResult<Vec<String>> {
            Ok(self.items.borrow().keys().cloned().collect())
        }
        fn snapshot(&self, account: &str) -> StoreResult<Option<Snapshot<Self::Item>>> {
            if self.read_failure.iter().any(|name| name == account) {
                return Err("Read legacy generation (-25293)".into());
            }
            Ok(self
                .items
                .borrow()
                .get(account)
                .map(|(value, generation)| Snapshot {
                    value: value.clone(),
                    item: (account.into(), *generation),
                }))
        }
        fn remove(&self, snapshot: Snapshot<Self::Item>) -> StoreResult<bool> {
            let (name, generation) = snapshot.item;
            if self.exit_after == Some(self.removed.borrow().len()) {
                panic!("process exit during cleanup");
            }
            if self.delete_failure.contains(&name) {
                return Err("Delete legacy generation (-25244)".into());
            }
            let mut items = self.items.borrow_mut();
            if self.race.as_ref() == Some(&name) {
                items.insert(
                    name.clone(),
                    ("older-app-raced-token".into(), uuid::Uuid::new_v4()),
                );
            }
            if items
                .get(&name)
                .is_none_or(|(_, current)| *current != generation)
            {
                return Ok(false);
            }
            items.remove(&name);
            self.removed.borrow_mut().push(name);
            Ok(true)
        }
    }
    #[test]
    fn verified_duplicates_retire_without_rewriting_combined_secrets() {
        let store = fixture();
        let before = store.bundle.borrow().clone();
        let count = store.items.borrow().len();
        let result = clean(&store).unwrap();
        assert_eq!(result.removed, count);
        assert!(store.items.borrow().is_empty());
        assert_eq!(*store.bundle.borrow(), before);
        assert_eq!(clean(&store).unwrap().removed, 0);
    }
    #[test]
    fn conflicting_unknown_and_restored_values_are_not_deleted_or_imported() {
        let mut store = fixture();
        store
            .fresh
            .push("openpgp_passphrase:alice@example.com".into());
        store.items.borrow_mut().get_mut("mcp-token").unwrap().0 = "older-app-updated-token".into();
        let foreign =
            r#"{"jid":"unrecognized-service-entry","password":"opaque","server":null}"#.to_string();
        store.items.borrow_mut().insert(
            "unrecognized-service-entry".into(),
            (foreign.clone(), uuid::Uuid::new_v4()),
        );
        let mut bundled: Bundle = serde_json::from_str(&store.bundle.borrow()).unwrap();
        bundled
            .items
            .insert("unrecognized-service-entry".into(), foreign);
        let owner = "openpgp_passphrase:alice@example.com";
        let aliases = [
            format!("{}{}", super::super::BACKUP_PREFIX, owner),
            format!("{}saved", super::super::recovery_prefix(owner)),
        ];
        for alias in &aliases {
            store
                .items
                .borrow_mut()
                .insert(alias.clone(), ("dGVzdC1wYXNz".into(), uuid::Uuid::new_v4()));
            bundled.items.insert(alias.clone(), "dGVzdC1wYXNz".into());
        }
        *store.bundle.borrow_mut() = serde_json::to_string(&bundled).unwrap();
        let before = store.bundle.borrow().clone();
        let result = clean(&store).unwrap();
        assert_eq!(result.retained, 3 + aliases.len());
        let mut names = BTreeMap::from([
            ("mcp-token".to_string(), ()),
            (owner.to_string(), ()),
            ("unrecognized-service-entry".to_string(), ()),
        ]);
        for alias in aliases {
            names.insert(alias, ());
        }
        assert_eq!(
            store.items.borrow().keys().collect::<Vec<_>>(),
            names.keys().collect::<Vec<_>>()
        );
        assert_eq!(*store.bundle.borrow(), before);
        assert_eq!(
            store.items.borrow()["mcp-token"].0,
            "older-app-updated-token"
        );
    }
    #[test]
    fn missing_or_unverifiable_combined_values_never_authorize_deletion() {
        for json in [
            "not JSON",
            r#"{"version":2,"items":{}}"#,
            r#"{"version":1,"items":{}}"#,
        ] {
            let store = fixture();
            *store.bundle.borrow_mut() = json.into();
            let before = store.items.borrow().clone();
            let _ = clean(&store);
            assert_eq!(*store.items.borrow(), before);
            assert!(store.removed.borrow().is_empty());
        }
        let mut store = fixture();
        store.unreadable_record = true;
        assert!(clean(&store)
            .unwrap_err()
            .to_string()
            .contains("fresh-start record"));
        assert!(store.removed.borrow().is_empty());
    }
    #[test]
    fn refused_items_do_not_block_other_copies_and_errors_remain_actionable() {
        let mut store = fixture();
        store.read_failure.push("mcp-token".into());
        store.delete_failure.push("last_user".into());
        let result = clean(&store).unwrap();
        assert_eq!(
            result.unavailable,
            store.read_failure.len() + store.delete_failure.len()
        );
        assert_eq!(
            store.items.borrow().keys().cloned().collect::<Vec<_>>(),
            ["last_user", "mcp-token"]
        );
        let diagnostic = result.diagnostic();
        assert!(
            diagnostic.contains("reopen")
                && diagnostic.contains("logout")
                && diagnostic.contains("forget")
                && diagnostic.contains("-25293")
                && diagnostic.contains("-25244")
        );
        assert!(!diagnostic.contains("test-password") && !diagnostic.contains("alice@example.com"));
    }
    #[test]
    fn changed_generation_and_interrupted_cleanup_preserve_secrets_on_restart() {
        let mut store = fixture();
        store.race = Some("mcp-token".into());
        let result = clean(&store).unwrap();
        assert_eq!(result.changed, 1);
        assert_eq!(store.items.borrow()["mcp-token"].0, "older-app-raced-token");
        let mut store = fixture();
        let bundle = store.bundle.borrow().clone();
        store.exit_after = Some(2);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| clean(&store))).is_err());
        assert_eq!(store.removed.borrow().len(), 2);
        store.exit_after = None;
        clean(&store).unwrap();
        assert!(store.items.borrow().is_empty());
        assert_eq!(*store.bundle.borrow(), bundle);
    }
}

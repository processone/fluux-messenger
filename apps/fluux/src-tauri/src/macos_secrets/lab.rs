//! In-memory secret backend for disposable native startup qualification only.
use super::{AccessScope, Backend, Secrets, StoreError};
use crate::credentials::SecretStore;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

pub struct LabStore {
    items: Mutex<BTreeMap<String, String>>,
    delay: Duration,
}
impl Default for LabStore {
    fn default() -> Self {
        let milliseconds = std::env::var("FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .min(10_000);
        Self {
            items: Mutex::default(),
            delay: Duration::from_millis(milliseconds),
        }
    }
}
impl LabStore {
    fn access(&self) -> AccessScope {
        let scope = AccessScope::begin();
        std::thread::sleep(self.delay);
        scope
    }
}
impl SecretStore for LabStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let _access = self.access();
        Ok(self.items.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let _access = self.access();
        self.items
            .lock()
            .unwrap()
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        let _access = self.access();
        self.items.lock().unwrap().remove(account);
        Ok(())
    }
}
impl Backend for LabStore {
    fn read(&self, account: &str) -> Result<Option<String>, StoreError> {
        self.get(account).map_err(StoreError::from)
    }
    fn accounts(&self) -> Result<Vec<String>, StoreError> {
        let _access = self.access();
        Ok(self.items.lock().unwrap().keys().cloned().collect())
    }
}
pub fn secrets() -> &'static Secrets<LabStore> {
    static STORE: OnceLock<Secrets<LabStore>> = OnceLock::new();
    STORE.get_or_init(|| Secrets::new(LabStore::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static STARTS: AtomicUsize = AtomicUsize::new(0);
    static ENDS: AtomicUsize = AtomicUsize::new(0);
    fn observe(pending: bool) {
        if pending {
            STARTS.fetch_add(1, Ordering::SeqCst);
        } else {
            ENDS.fetch_add(1, Ordering::SeqCst);
        }
    }
    // FLM-403 F20: execute the real disposable backend, not a second fake observer path.
    #[test]
    fn disposable_backend_observes_reads_writes_and_enumeration() {
        super::super::register_access_observer(observe);
        let store = LabStore {
            items: Mutex::default(),
            delay: Duration::ZERO,
        };
        let key = super::super::ACCOUNT;
        assert_eq!(store.get(key).unwrap(), None);
        store.set(key, "{}").unwrap();
        assert_eq!(store.read(key).unwrap().as_deref(), Some("{}"));
        assert_eq!(store.accounts().unwrap(), [key]);
        store.delete(key).unwrap();
        assert_eq!(STARTS.load(Ordering::SeqCst), 5);
        assert_eq!(ENDS.load(Ordering::SeqCst), 5);
    }
}

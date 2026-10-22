//! XMPP credentials and iOS session secrets, over a logical secret store.
//!
//! Credentials use a logical JSON entry under the JID and a `last_user` pointer.
//! macOS packs these entries into one item; iOS keeps separate keychain items.
//! An iOS session secret is an item under `<kind>:<bare JID>`.

use serde::{Deserialize, Serialize};

const LAST_USER: &str = "last_user";

/// Credentials stored in the keychain.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredCredentials {
    pub jid: String,
    pub password: String,
    pub server: Option<String>,
}

/// A keychain, reduced to the generic password items this module uses.
pub trait SecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// Succeeds when the item does not exist.
    fn delete(&self, account: &str) -> Result<(), String>;
    /// Optional old-layout read for a caller that validates a recovery candidate.
    fn legacy_candidate(&self, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    /// Preserve any replaced value before adopting an already-validated candidate.
    fn adopt_legacy(&self, _account: &str, _secret: &str) -> Result<(), String> {
        Err("Legacy adoption is unavailable for this store".into())
    }
}

pub fn save(store: &impl SecretStore, credentials: &StoredCredentials) -> Result<(), String> {
    let json = serde_json::to_string(credentials)
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    store.set(&credentials.jid, &json)?;
    store.set(LAST_USER, &credentials.jid)
}

pub fn load(store: &impl SecretStore) -> Result<Option<StoredCredentials>, String> {
    let Some(jid) = store.get(LAST_USER)? else {
        return Ok(None);
    };
    let Some(json) = store.get(&jid)? else {
        return Ok(None);
    };
    serde_json::from_str(&json)
        .map(Some)
        .map_err(|e| format!("Failed to parse credentials: {e}"))
}

/// Deletes the last user's credentials, then `last_user` itself, so a failure
/// leaves a pointer that a later delete can follow.
pub fn delete(store: &impl SecretStore) -> Result<(), String> {
    if let Some(jid) = store.get(LAST_USER)? {
        store.delete(&jid)?;
    }
    store.delete(LAST_USER)
}

/// macOS has already removed the bundled credential when only old-copy cleanup
/// fails. Finish clearing its pointer, then report that cleanup failure. iOS
/// retains `delete`'s existing stop-on-failure ordering.
#[cfg(any(target_os = "macos", test))]
pub fn delete_macos(store: &impl SecretStore) -> Result<(), String> {
    let mut cleanup_error = None;
    if let Some(jid) = store.get(LAST_USER)? {
        if let Err(error) = store.delete(&jid) {
            if !matches!(store.get(&jid), Ok(None)) {
                return Err(error);
            }
            cleanup_error = Some(error);
        }
    }
    let pointer = store.delete(LAST_USER);
    if let Some(error) = cleanup_error {
        Err(error)
    } else {
        pointer
    }
}

/// The secrets, other than credentials, that the app keeps per account.
#[cfg(any(target_os = "ios", test))]
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretKind {
    /// An XEP-0484 FAST token, as the JSON the app stores.
    FastToken,
}

/// The keychain account of an account's secret. The JID comes from the
/// webview, so anything but a bare JID is refused rather than allowed to
/// name another item.
#[cfg(any(target_os = "ios", test))]
pub fn secret_account(kind: SecretKind, jid: &str) -> Result<String, String> {
    let valid = !jid.is_empty()
        && jid.len() <= 3071
        && jid.contains('@')
        && !jid.contains('/')
        && !jid.chars().any(|c| c.is_whitespace() || c.is_control());
    if !valid {
        return Err("Expected a bare JID".to_string());
    }
    let prefix = match kind {
        SecretKind::FastToken => "fast-token",
    };
    Ok(format!("{prefix}:{jid}"))
}

#[cfg(target_os = "ios")]
pub mod commands {
    use super::{secret_account, SecretKind, SecretStore, StoredCredentials};
    use crate::ios_keychain::IosKeychain;

    async fn blocking<T: Send + 'static>(
        operation: &'static str,
        task: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let result = tokio::task::spawn_blocking(task)
            .await
            .map_err(|e| format!("Keychain task panicked: {e}"))?;
        if let Err(e) = &result {
            tracing::error!("Keychain: {operation} failed: {e}");
        }
        result
    }

    #[tauri::command]
    pub async fn save_credentials(
        jid: String,
        password: String,
        server: Option<String>,
    ) -> Result<(), String> {
        blocking("save", move || {
            super::save(&IosKeychain, &StoredCredentials { jid, password, server })
        })
        .await
    }

    #[tauri::command]
    pub async fn get_credentials() -> Result<Option<StoredCredentials>, String> {
        blocking("read", || super::load(&IosKeychain)).await
    }

    #[tauri::command]
    pub async fn delete_credentials() -> Result<(), String> {
        blocking("delete", || super::delete(&IosKeychain)).await
    }

    #[tauri::command]
    pub async fn get_secret(kind: SecretKind, jid: String) -> Result<Option<String>, String> {
        let account = secret_account(kind, &jid)?;
        blocking("read secret", move || IosKeychain.get(&account)).await
    }

    #[tauri::command]
    pub async fn set_secret(kind: SecretKind, jid: String, secret: String) -> Result<(), String> {
        let account = secret_account(kind, &jid)?;
        blocking("save secret", move || IosKeychain.set(&account, &secret)).await
    }

    #[tauri::command]
    pub async fn delete_secret(kind: SecretKind, jid: String) -> Result<(), String> {
        let account = secret_account(kind, &jid)?;
        blocking("delete secret", move || IosKeychain.delete(&account)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeStore {
        items: RefCell<HashMap<String, String>>,
        failing_delete: Option<&'static str>,
    }

    impl SecretStore for FakeStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.items.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.items
                .borrow_mut()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            if self.failing_delete == Some(account) {
                return Err("denied".to_string());
            }
            self.items.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn alice() -> StoredCredentials {
        StoredCredentials {
            jid: "alice@example.com".to_string(),
            password: "secret".to_string(),
            server: Some("xmpp.example.com".to_string()),
        }
    }

    #[test]
    fn loads_the_saved_credentials_of_the_last_user() {
        let store = FakeStore::default();
        save(&store, &alice()).unwrap();
        save(
            &store,
            &StoredCredentials {
                jid: "bob@example.com".to_string(),
                password: "other".to_string(),
                server: None,
            },
        )
        .unwrap();

        assert_eq!(load(&store).unwrap().unwrap().jid, "bob@example.com");
    }

    #[test]
    fn uses_the_desktop_item_layout() {
        let store = FakeStore::default();
        save(&store, &alice()).unwrap();

        let items = store.items.borrow();
        assert_eq!(items.get("last_user").map(String::as_str), Some("alice@example.com"));
        let json: serde_json::Value = serde_json::from_str(&items["alice@example.com"]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"jid": "alice@example.com", "password": "secret", "server": "xmpp.example.com"})
        );
    }

    #[test]
    fn loads_nothing_from_an_empty_keychain_or_a_dangling_last_user() {
        let store = FakeStore::default();
        assert_eq!(load(&store).unwrap(), None);

        store.set("last_user", "ghost@example.com").unwrap();
        assert_eq!(load(&store).unwrap(), None);
    }

    #[test]
    fn delete_removes_both_items() {
        let store = FakeStore::default();
        save(&store, &alice()).unwrap();

        delete(&store).unwrap();

        assert!(store.items.borrow().is_empty());
        assert_eq!(load(&store).unwrap(), None);
    }

    #[test]
    fn names_a_secret_after_its_kind_and_account() {
        assert_eq!(
            secret_account(SecretKind::FastToken, "alice@example.com").unwrap(),
            "fast-token:alice@example.com"
        );
    }

    #[test]
    fn refuses_a_secret_for_anything_but_a_bare_jid() {
        for jid in ["", "last_user", "alice@example.com/phone", "alice@example.com\n", "a b@example.com"] {
            assert!(secret_account(SecretKind::FastToken, jid).is_err(), "{jid:?}");
        }
    }

    #[test]
    fn delete_keeps_last_user_when_the_credentials_survive() {
        let store = FakeStore {
            failing_delete: Some("alice@example.com"),
            ..FakeStore::default()
        };
        save(&store, &alice()).unwrap();

        assert!(delete(&store).is_err());
        assert_eq!(
            store.items.borrow().get("last_user").map(String::as_str),
            Some("alice@example.com")
        );
    }
    // FLM-79 S1: macOS finishes pointer cleanup after bundled credential erasure.
    #[test]
    fn macos_finishes_pointer_cleanup_before_reporting_old_copy_error() {
        struct ErasedThenRefused(FakeStore);
        impl SecretStore for ErasedThenRefused {
            fn get(&self, a: &str) -> Result<Option<String>, String> {
                self.0.get(a)
            }
            fn set(&self, a: &str, v: &str) -> Result<(), String> {
                self.0.set(a, v)
            }
            fn delete(&self, a: &str) -> Result<(), String> {
                self.0.delete(a)?;
                if a == "alice@example.com" {
                    Err("old copy refused".into())
                } else {
                    Ok(())
                }
            }
        }
        let store = ErasedThenRefused(FakeStore::default());
        save(&store, &alice()).unwrap();
        assert_eq!(delete_macos(&store).unwrap_err(), "old copy refused");
        assert!(store.get(LAST_USER).unwrap().is_none());
        assert!(store.get("alice@example.com").unwrap().is_none());
        let store = FakeStore {
            failing_delete: Some("alice@example.com"),
            ..FakeStore::default()
        };
        save(&store, &alice()).unwrap();
        assert!(delete_macos(&store).is_err());
        assert!(
            store.get(LAST_USER).unwrap().is_some(),
            "keep the pointer when bundled erasure itself failed"
        );
    }
}

//! XMPP credentials kept in the iOS keychain.
//!
//! The layout matches the desktop keychain: the credentials of an account are
//! a JSON item under its JID, and `last_user` names the account to load.

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

#[cfg(target_os = "ios")]
pub mod commands {
    use super::StoredCredentials;
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
}

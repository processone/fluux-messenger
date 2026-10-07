//! Key-value storage in the app data directory, holding the localStorage keys
//! that must outlive the webview's storage.
//!
//! WKWebView may evict an origin's storage, so on iOS the app routes these
//! keys here instead (`apps/fluux/src/utils/nativeLocalStorage.ts`).
//!
//! The file is a stable contract, independent of how the app reaches it:
//!
//! ```json
//! { "version": 1, "entries": { "<localStorage key>": "<string value>" } }
//! ```
//!
//! Keys and values are exactly the strings the app would have stored in
//! localStorage, account-scoped keys included (`base:<bareJid>`).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const FILE_NAME: &str = "local-storage.json";
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct StorageFile {
    version: u32,
    entries: BTreeMap<String, String>,
}

/// One batch of writes. `clear` applies first; `set` and `remove` never name
/// the same key.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageChange {
    #[serde(default)]
    pub clear: bool,
    #[serde(default)]
    pub set: BTreeMap<String, String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

pub struct NativeStorage {
    path: PathBuf,
    entries: Mutex<BTreeMap<String, String>>,
}

impl NativeStorage {
    /// Opens the file at `path`. An unreadable file is moved aside rather than
    /// overwritten by the next write, so its content can still be recovered.
    pub fn open(path: PathBuf) -> Self {
        let entries = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<StorageFile>(&bytes) {
                Ok(file) if file.version == VERSION => file.entries,
                Ok(file) => {
                    tracing::warn!("native storage: unsupported version {}", file.version);
                    set_aside(&path);
                    BTreeMap::new()
                }
                Err(e) => {
                    tracing::warn!("native storage: unreadable file ({e})");
                    set_aside(&path);
                    BTreeMap::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => {
                tracing::warn!("native storage: could not read file ({e})");
                BTreeMap::new()
            }
        };
        Self { path, entries: Mutex::new(entries) }
    }

    pub fn entries(&self) -> BTreeMap<String, String> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Applies `change` and writes the whole file. The in-memory state only
    /// moves when the write succeeds, so it never runs ahead of the disk.
    pub fn apply(&self, change: StorageChange) -> Result<(), String> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = if change.clear { BTreeMap::new() } else { entries.clone() };
        for key in &change.remove {
            next.remove(key);
        }
        next.extend(change.set);
        write_atomically(&self.path, &StorageFile { version: VERSION, entries: next.clone() })?;
        *entries = next;
        Ok(())
    }
}

fn set_aside(path: &Path) {
    let aside = path.with_extension("json.unreadable");
    if let Err(e) = fs::rename(path, &aside) {
        tracing::warn!("native storage: could not move unreadable file aside ({e})");
    }
}

fn write_atomically(path: &Path, file: &StorageFile) -> Result<(), String> {
    let bytes = serde_json::to_vec(file).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut out = fs::File::create(&tmp).map_err(|e| format!("create: {e}"))?;
    out.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    out.sync_all().map_err(|e| format!("sync: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))
}

#[cfg(target_os = "ios")]
pub mod commands {
    use super::{NativeStorage, StorageChange};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use tauri::State;

    #[tauri::command]
    pub async fn native_storage_load(
        storage: State<'_, Arc<NativeStorage>>,
    ) -> Result<BTreeMap<String, String>, String> {
        Ok(storage.entries())
    }

    #[tauri::command]
    pub async fn native_storage_apply(
        storage: State<'_, Arc<NativeStorage>>,
        change: StorageChange,
    ) -> Result<(), String> {
        let storage = Arc::clone(&storage);
        tokio::task::spawn_blocking(move || storage.apply(change))
            .await
            .map_err(|e| format!("native storage task failed: {e}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("fluux-native-storage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join(FILE_NAME)
    }

    fn change(set: &[(&str, &str)], remove: &[&str]) -> StorageChange {
        StorageChange {
            clear: false,
            set: set.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            remove: remove.iter().map(|k| k.to_string()).collect(),
        }
    }

    #[test]
    fn starts_empty_without_a_file() {
        assert!(NativeStorage::open(temp_path("empty")).entries().is_empty());
    }

    #[test]
    fn writes_the_documented_format() {
        let path = temp_path("format");
        let storage = NativeStorage::open(path.clone());
        storage.apply(change(&[("xmpp-last-jid", "alice@example.com"), ("fluux-theme", "dark")], &[])).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"version":1,"entries":{"fluux-theme":"dark","xmpp-last-jid":"alice@example.com"}}"#
        );
    }

    #[test]
    fn reads_the_documented_format() {
        let path = temp_path("read");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"version":1,"entries":{"fluux-room-drafts:alice@example.com":"{}"}}"#).unwrap();
        let entries = NativeStorage::open(path).entries();
        assert_eq!(entries.get("fluux-room-drafts:alice@example.com").map(String::as_str), Some("{}"));
    }

    #[test]
    fn survives_a_reopen_and_applies_removals_and_clear() {
        let path = temp_path("reopen");
        let storage = NativeStorage::open(path.clone());
        storage.apply(change(&[("a", "1"), ("b", "2")], &[])).unwrap();
        storage.apply(change(&[("c", "3")], &["a"])).unwrap();

        let reopened = NativeStorage::open(path.clone());
        assert_eq!(reopened.entries().keys().collect::<Vec<_>>(), ["b", "c"]);

        reopened
            .apply(StorageChange { clear: true, set: [("d".into(), "4".into())].into(), remove: vec![] })
            .unwrap();
        assert_eq!(NativeStorage::open(path).entries().keys().collect::<Vec<_>>(), ["d"]);
    }

    #[test]
    fn sets_aside_an_unreadable_file_instead_of_overwriting_it() {
        let path = temp_path("corrupt");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "not json").unwrap();

        let storage = NativeStorage::open(path.clone());
        assert!(storage.entries().is_empty());
        assert_eq!(fs::read_to_string(path.with_extension("json.unreadable")).unwrap(), "not json");

        storage.apply(change(&[("a", "1")], &[])).unwrap();
        assert_eq!(fs::read_to_string(path.with_extension("json.unreadable")).unwrap(), "not json");
    }

    #[test]
    fn sets_aside_a_file_from_a_newer_version() {
        let path = temp_path("version");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"version":2,"entries":{}}"#).unwrap();
        assert!(NativeStorage::open(path.clone()).entries().is_empty());
        assert!(path.with_extension("json.unreadable").exists());
    }

    #[test]
    fn deserializes_the_change_the_app_sends() {
        let change: StorageChange =
            serde_json::from_str(r#"{"clear":false,"set":{"a":"1"},"remove":["b"]}"#).unwrap();
        assert_eq!(change.set.get("a").map(String::as_str), Some("1"));
        assert_eq!(change.remove, ["b"]);
    }
}

//! Generic, protocol-agnostic at-rest KV store for E2EE plugin bytes.
//!
//! Each value is sealed with AES-256-GCM under a per-account master key held
//! in the OS keychain (`keyring`). Keychain-absent hosts fall back to a 0600
//! master-key file (with a caller-surfaced `fallback_used` flag). The store is
//! deliberately generic — opaque `key -> bytes` — so it is also the seam a
//! future Rust crypto engine would use.
//!
//! Layout, per account (JID):
//!   `<base_dir>/e2ee-store/<sanitized-jid>.json`  key -> base64(nonce||ct||tag)
//!   `<base_dir>/e2ee-store/<sanitized-jid>.mk`    raw 32-byte master key (0600 fallback only)
//!
//! The master key is read from the keychain (or fallback file) at most once per
//! account per `Store` instance and cached in memory — this keeps the hot path
//! off the keychain and makes the seal deterministic across get/put within a
//! session.
//!
//! The public surface (`Store` + get/put/delete/list) is consumed by the Tauri
//! command layer added in M2b Task 2; until that lands it is exercised only by
//! the tests below, so silence the binary's dead-code lint for this module.
#![allow(dead_code)]
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use std::collections::{BTreeMap, HashMap};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Keychain service name for per-account master keys. Distinct from the OpenPGP
/// service so the two subsystems never collide on an account entry.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYCHAIN_SERVICE: &str = "fluux-e2ee-store";

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

pub struct Store {
    base_dir: PathBuf,
    /// When false, skip the keychain entirely and use the 0600 master-key file.
    /// Only read on desktop targets — mobile has no `keyring` dependency and
    /// always takes the file path.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
    use_keychain: bool,
    /// Set once the store has resolved any account's master key from the 0600
    /// fallback file rather than the OS keychain. Callers surface this to warn
    /// that secrets are protected by a file-permission boundary, not the
    /// keychain. Never means "cleartext" — values are always AEAD-sealed.
    fallback_used: AtomicBool,
    /// In-memory per-account master-key cache (account JID -> 32-byte key).
    master_keys: Mutex<HashMap<String, [u8; KEY_LEN]>>,
}

/// Map a JID to a filesystem-safe basename. Collisions between distinct JIDs
/// are acceptable for isolation purposes only in that they would *share* a
/// file; since the source is app-owned account JIDs (validated elsewhere) and
/// alnum/`@._-` pass through unchanged, real JIDs do not collide in practice.
fn sanitize_jid(jid: &str) -> String {
    jid.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "@._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect()
}

impl Store {
    /// Production constructor: keychain-backed, rooted at `base_dir`.
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            use_keychain: true,
            fallback_used: AtomicBool::new(false),
            master_keys: Mutex::new(HashMap::new()),
        }
    }

    /// Test-only constructor exercising the keychain path. Tests install the
    /// `keyring` mock credential builder so this never touches the real OS
    /// keychain.
    #[cfg(test)]
    pub fn for_testing(base_dir: PathBuf) -> Self {
        Self::new(base_dir)
    }

    /// Test-only constructor that skips the keychain and always uses the 0600
    /// master-key file, simulating a host without an OS keychain.
    #[cfg(test)]
    pub fn for_testing_no_keychain(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            use_keychain: false,
            fallback_used: AtomicBool::new(false),
            master_keys: Mutex::new(HashMap::new()),
        }
    }

    /// True if any account's master key was resolved from the 0600 fallback
    /// file rather than the OS keychain. Values remain AES-256-GCM sealed
    /// either way; this only downgrades the key-protection boundary.
    pub fn fallback_used(&self) -> bool {
        self.fallback_used.load(Ordering::Relaxed)
    }

    fn dir(&self) -> std::io::Result<PathBuf> {
        let d = self.base_dir.join("e2ee-store");
        std::fs::create_dir_all(&d)?;
        Ok(d)
    }

    /// Per-account sealed-value JSON file. `dir()` creation is deferred to
    /// write time, so this is a pure path builder.
    pub fn file_path(&self, account: &str) -> PathBuf {
        self.base_dir
            .join("e2ee-store")
            .join(format!("{}.json", sanitize_jid(account)))
    }

    fn mk_path(&self, account: &str) -> PathBuf {
        self.file_path(account).with_extension("mk")
    }

    /// Load (cache) or create the per-account 32-byte master key.
    fn master_key(&self, account: &str) -> Result<[u8; KEY_LEN], String> {
        if let Some(k) = self
            .master_keys
            .lock()
            .map_err(|_| "master-key cache poisoned".to_string())?
            .get(account)
            .copied()
        {
            return Ok(k);
        }
        let key = self.load_or_create_master_key(account)?;
        self.master_keys
            .lock()
            .map_err(|_| "master-key cache poisoned".to_string())?
            .insert(account.to_string(), key);
        Ok(key)
    }

    fn load_or_create_master_key(&self, account: &str) -> Result<[u8; KEY_LEN], String> {
        // 1) Keychain path (desktop only; mobile has no `keyring` dep).
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if self.use_keychain {
            if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, account) {
                match entry.get_password() {
                    Ok(encoded) => {
                        // Stored as base64 of the raw 32-byte key.
                        if let Ok(bytes) = b64_decode(encoded.trim()) {
                            if bytes.len() == KEY_LEN {
                                let mut k = [0u8; KEY_LEN];
                                k.copy_from_slice(&bytes);
                                return Ok(k);
                            }
                        }
                        // Present but malformed — mint a fresh key and overwrite.
                        let k = random_key();
                        entry
                            .set_password(&b64_encode(&k))
                            .map_err(|e| format!("keychain set: {e}"))?;
                        return Ok(k);
                    }
                    Err(keyring::Error::NoEntry) => {
                        let k = random_key();
                        entry
                            .set_password(&b64_encode(&k))
                            .map_err(|e| format!("keychain set: {e}"))?;
                        return Ok(k);
                    }
                    // Keychain present but erroring (locked/access denied) —
                    // fall through to the 0600 file fallback rather than fail.
                    Err(_) => {}
                }
            }
        }

        // 2) 0600 master-key file fallback.
        self.fallback_used.store(true, Ordering::Relaxed);
        self.dir().map_err(|e| e.to_string())?;
        let p = self.mk_path(account);
        if let Ok(bytes) = std::fs::read(&p) {
            if bytes.len() == KEY_LEN {
                let mut k = [0u8; KEY_LEN];
                k.copy_from_slice(&bytes);
                return Ok(k);
            }
        }
        let k = random_key();
        write_0600(&p, &k).map_err(|e| format!("write fallback mk: {e}"))?;
        Ok(k)
    }

    fn read_map(&self, account: &str) -> Result<BTreeMap<String, String>, String> {
        match std::fs::read(self.file_path(account)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("parse store: {e}")),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("read store: {e}")),
        }
    }

    fn write_map(&self, account: &str, map: &BTreeMap<String, String>) -> Result<(), String> {
        self.dir().map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        write_0600(&self.file_path(account), &bytes).map_err(|e| e.to_string())
    }

    /// Fetch and unseal the value for `key`, or `None` if absent.
    pub fn get(&self, account: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
        let map = self.read_map(account)?;
        match map.get(key) {
            None => Ok(None),
            Some(sealed_b64) => {
                let sealed = b64_decode(sealed_b64)?;
                Ok(Some(self.unseal(account, &sealed)?))
            }
        }
    }

    /// Seal `value` and store it under `key`, replacing any existing value.
    pub fn put(&self, account: &str, key: &str, value: &[u8]) -> Result<(), String> {
        let sealed = self.seal(account, value)?;
        let mut map = self.read_map(account)?;
        map.insert(key.to_string(), b64_encode(&sealed));
        self.write_map(account, &map)
    }

    /// Remove `key`. A missing key is a no-op (not an error).
    pub fn delete(&self, account: &str, key: &str) -> Result<(), String> {
        let mut map = self.read_map(account)?;
        if map.remove(key).is_some() {
            self.write_map(account, &map)?;
        }
        Ok(())
    }

    /// List all keys for `account` whose name starts with `prefix`.
    pub fn list(&self, account: &str, prefix: &str) -> Result<Vec<String>, String> {
        Ok(self
            .read_map(account)?
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect())
    }

    fn seal(&self, account: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let key = self.master_key(account)?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
            .map_err(|e| format!("seal: {e}"))?;
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    fn unseal(&self, account: &str, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.len() < NONCE_LEN {
            return Err("sealed value too short".into());
        }
        let key = self.master_key(account)?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        cipher
            .decrypt(Nonce::from_slice(&sealed[..NONCE_LEN]), &sealed[NONCE_LEN..])
            .map_err(|e| format!("unseal (tampered or wrong key): {e}"))
    }
}

fn random_key() -> [u8; KEY_LEN] {
    let mut k = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut k);
    k
}

fn write_0600(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    Ok(())
}

fn b64_encode(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Once;
    use tempfile::tempdir;

    /// Install the in-memory `keyring` mock exactly once for the whole test
    /// process, so `for_testing` (keychain path) never touches the real OS
    /// keychain (no CI failures, no auth dialogs, no login-keychain pollution).
    fn install_mock_keychain() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    #[test]
    fn seals_and_round_trips_including_high_bytes() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        let v: Vec<u8> = vec![0x00, 0x7f, 0x80, 0xfe, 0xff, 0x01];
        s.put("alice@x", "session/bob/5", &v).unwrap();
        assert_eq!(s.get("alice@x", "session/bob/5").unwrap(), Some(v));
        // on-disk bytes are NOT the plaintext (sealed)
        let raw = std::fs::read(s.file_path("alice@x")).unwrap();
        assert!(!raw
            .windows(6)
            .any(|w| w == [0x00, 0x7f, 0x80, 0xfe, 0xff, 0x01]));
    }

    #[test]
    fn missing_key_is_none_and_delete_is_noop() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        assert_eq!(s.get("a@x", "nope").unwrap(), None);
        s.delete("a@x", "nope").unwrap(); // no error
    }

    #[test]
    fn accounts_are_isolated() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        s.put("a@x", "k", &[1]).unwrap();
        assert_eq!(s.get("b@x", "k").unwrap(), None);
    }

    #[test]
    fn list_filters_by_prefix() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        s.put("a@x", "session/1", &[1]).unwrap();
        s.put("a@x", "trust/1", &[2]).unwrap();
        let mut got = s.list("a@x", "session/").unwrap();
        got.sort();
        assert_eq!(got, vec!["session/1".to_string()]);
    }

    #[test]
    fn fallback_master_key_when_keychain_unavailable() {
        let dir = tempdir().unwrap();
        let s = Store::for_testing_no_keychain(dir.path().to_path_buf());
        assert!(!s.fallback_used());
        s.put("a@x", "k", &[9, 9]).unwrap();
        assert_eq!(s.get("a@x", "k").unwrap(), Some(vec![9, 9]));
        // 0600 fallback key file was created, and the flag is surfaced.
        assert!(s.file_path("a@x").with_extension("mk").exists());
        assert!(s.fallback_used());
    }

    // --- Adversarial at-rest crypto tests -----------------------------------

    #[test]
    fn tampered_sealed_value_fails_to_decrypt() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        s.put("a@x", "k", b"top secret payload").unwrap();

        // Flip a byte in the on-disk base64 sealed value (the last byte falls
        // inside the GCM auth tag).
        let path = s.file_path("a@x");
        let mut map: BTreeMap<String, String> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut raw = b64_decode(map.get("k").unwrap()).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        map.insert("k".to_string(), b64_encode(&raw));
        std::fs::write(&path, serde_json::to_vec(&map).unwrap()).unwrap();

        // Reuse the same store so the (correct) cached master key is used:
        // the failure must come from GCM authentication, not a wrong key.
        let result = s.get("a@x", "k");
        assert!(
            result.is_err(),
            "tampered sealed value must fail to decrypt, got {result:?}"
        );
    }

    #[test]
    fn overwriting_key_replaces_value() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        s.put("a@x", "k", b"first").unwrap();
        s.put("a@x", "k", b"second").unwrap();
        assert_eq!(s.get("a@x", "k").unwrap(), Some(b"second".to_vec()));
    }

    #[test]
    fn same_plaintext_seals_to_different_ciphertext() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let s = Store::for_testing(dir.path().to_path_buf());
        s.put("a@x", "k1", b"identical").unwrap();
        s.put("a@x", "k2", b"identical").unwrap();
        let map: BTreeMap<String, String> =
            serde_json::from_slice(&std::fs::read(s.file_path("a@x")).unwrap()).unwrap();
        assert_ne!(
            map.get("k1").unwrap(),
            map.get("k2").unwrap(),
            "same plaintext must seal to different bytes (random nonce)"
        );
    }
}

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
    /// Test seam: force the keychain read to report a transient failure
    /// (locked / access-denied / Secret-Service-down) rather than `NoEntry`,
    /// so the "do not mint a divergent key on a transient error" path can be
    /// exercised without a flaky real keychain. Always `false` in production.
    simulate_keychain_error: bool,
    /// Test seam: inject a raw stored keychain payload (base64 string) so the
    /// real decode + length validation in `read_keychain` can be exercised
    /// against a malformed entry. The `keyring` mock isolates its store per
    /// `Entry`, so an entry seeded from outside the `Store` is invisible to it;
    /// this seam feeds the payload the `Store`'s own read would have seen.
    /// Always `None` in production.
    test_keychain_payload: Option<String>,
}

/// Outcome of a keychain master-key read, keeping the three cases distinct so
/// the caller never conflates a *transient* failure with a genuinely *absent*
/// entry (minting a fresh key on the former silently orphans real secrets).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
enum KeychainRead {
    /// A valid 32-byte key was present.
    Found([u8; KEY_LEN]),
    /// `NoEntry` — the keychain works but holds nothing yet (genuine first use).
    Absent,
    /// The keychain errored (locked, access-denied, service unavailable). This
    /// is NOT "absent": we must not mint a fresh key that would diverge from
    /// the real (temporarily inaccessible) one.
    Unavailable,
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
            simulate_keychain_error: false,
            test_keychain_payload: None,
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
            simulate_keychain_error: false,
            test_keychain_payload: None,
        }
    }

    /// Test-only constructor exercising the keychain path but with the read
    /// forced to report a transient failure (not `NoEntry`). Used to assert
    /// that a locked/unavailable keychain never mints a divergent master key.
    #[cfg(test)]
    pub fn for_testing_keychain_error(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            use_keychain: true,
            fallback_used: AtomicBool::new(false),
            master_keys: Mutex::new(HashMap::new()),
            simulate_keychain_error: true,
            test_keychain_payload: None,
        }
    }

    /// Test-only constructor that makes the keychain read return `payload` as
    /// the stored entry, so the real decode + 32-byte length validation runs
    /// against a (typically malformed) value.
    #[cfg(test)]
    pub fn for_testing_keychain_payload(base_dir: PathBuf, payload: String) -> Self {
        Self {
            base_dir,
            use_keychain: true,
            fallback_used: AtomicBool::new(false),
            master_keys: Mutex::new(HashMap::new()),
            simulate_keychain_error: false,
            test_keychain_payload: Some(payload),
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

    /// Read the per-account master key from the OS keychain, keeping the three
    /// outcomes distinct (see [`KeychainRead`]). A malformed entry (present but
    /// not a valid 32-byte key) is a hard `Err`: we refuse to silently overwrite
    /// whatever key material occupies that slot.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn read_keychain(&self, account: &str) -> Result<KeychainRead, String> {
        #[cfg(test)]
        if self.simulate_keychain_error {
            return Ok(KeychainRead::Unavailable);
        }
        #[cfg(test)]
        if let Some(payload) = self.test_keychain_payload.clone() {
            // Exercise the real decode + length validation against the injected
            // (typically malformed) entry.
            return parse_keychain_key(account, &payload).map(KeychainRead::Found);
        }
        let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, account) {
            Ok(e) => e,
            // Could not even open the entry — treat as a transient failure, not
            // "absent", so we never mint a divergent key on top of it.
            Err(_) => return Ok(KeychainRead::Unavailable),
        };
        match entry.get_password() {
            // Stored as base64 of the raw 32-byte key. A decode failure or a
            // wrong length means the slot is occupied by something we don't
            // understand — surface it rather than clobbering it.
            Ok(encoded) => parse_keychain_key(account, &encoded).map(KeychainRead::Found),
            Err(keyring::Error::NoEntry) => Ok(KeychainRead::Absent),
            // Locked / access-denied / service-down: transient, NOT absent.
            Err(_) => Ok(KeychainRead::Unavailable),
        }
    }

    /// Persist a freshly-minted master key to the keychain.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn write_keychain(&self, account: &str, k: &[u8; KEY_LEN]) -> Result<(), String> {
        let entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| format!("keychain open: {e}"))?;
        entry
            .set_password(&b64_encode(k))
            .map_err(|e| format!("keychain set: {e}"))
    }

    /// Read the existing 0600 fallback master-key file, if present and valid.
    /// Returns `None` when the file is absent or not exactly `KEY_LEN` bytes.
    fn read_fallback_mk(&self, account: &str) -> Option<[u8; KEY_LEN]> {
        let bytes = std::fs::read(self.mk_path(account)).ok()?;
        if bytes.len() != KEY_LEN {
            return None;
        }
        let mut k = [0u8; KEY_LEN];
        k.copy_from_slice(&bytes);
        Some(k)
    }

    fn load_or_create_master_key(&self, account: &str) -> Result<[u8; KEY_LEN], String> {
        // 1) Keychain path (desktop only; mobile has no `keyring` dep).
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if self.use_keychain {
            match self.read_keychain(account)? {
                // Valid key present — use it.
                KeychainRead::Found(k) => return Ok(k),
                // Genuine first use: keychain works but is empty. Mint + persist.
                KeychainRead::Absent => {
                    let k = random_key();
                    self.write_keychain(account, &k)?;
                    return Ok(k);
                }
                // Transient failure (locked / access-denied / service-down). Do
                // NOT mint a fresh keychain key: it would diverge from the real
                // (temporarily inaccessible) one and permanently orphan anything
                // sealed under it. Only fall back to the 0600 file if it ALREADY
                // exists; otherwise surface the failure so the caller can retry
                // next session (a returned Err is recoverable; a minted divergent
                // key is not).
                KeychainRead::Unavailable => {
                    if let Some(k) = self.read_fallback_mk(account) {
                        self.fallback_used.store(true, Ordering::Relaxed);
                        return Ok(k);
                    }
                    return Err(format!(
                        "keychain unavailable for account '{account}' and no fallback key present"
                    ));
                }
            }
        }

        // 2) 0600 master-key file fallback (keychain disabled for this Store —
        //    mobile, or the no-keychain test constructor).
        self.fallback_used.store(true, Ordering::Relaxed);
        self.dir().map_err(|e| e.to_string())?;
        if let Some(k) = self.read_fallback_mk(account) {
            return Ok(k);
        }
        let k = random_key();
        write_0600(&self.mk_path(account), &k).map_err(|e| format!("write fallback mk: {e}"))?;
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

/// Decode + validate a keychain master-key payload (base64 of the raw 32-byte
/// key). A decode failure or wrong length is a hard `Err`: the slot holds
/// something we don't understand and must not silently overwrite.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn parse_keychain_key(account: &str, encoded: &str) -> Result<[u8; KEY_LEN], String> {
    let bytes = b64_decode(encoded.trim()).map_err(|e| {
        format!("keychain entry for '{account}' is malformed (invalid base64: {e})")
    })?;
    if bytes.len() != KEY_LEN {
        return Err(format!(
            "keychain entry for '{account}' is malformed (expected {KEY_LEN} bytes, got {})",
            bytes.len()
        ));
    }
    let mut k = [0u8; KEY_LEN];
    k.copy_from_slice(&bytes);
    Ok(k)
}

fn random_key() -> [u8; KEY_LEN] {
    let mut k = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut k);
    k
}

/// Write `bytes` to `path` with 0600 permissions, atomically: the data lands in
/// a sibling `<path>.tmp` (created 0600 up front, before any bytes are written)
/// and is then `rename`d into place. A crash mid-write leaves the temp file but
/// never a truncated/partial `path`, so an interrupted write can't corrupt the
/// whole per-account JSON (which would block get/list for ALL keys) or the
/// fallback master key. `rename` is atomic on the same filesystem.
fn write_0600(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)?;
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

    #[test]
    fn transient_keychain_error_without_fallback_is_err_and_mints_nothing() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let s = Store::for_testing_keychain_error(dir.path().to_path_buf());
        // No .mk file exists: a transient keychain failure must surface as Err,
        // never mint a fresh (divergent) key. Any operation that needs the key
        // fails. (`get` on an ABSENT key legitimately returns Ok(None) without
        // ever touching the key — so we assert on the key-requiring paths.)
        assert!(s.master_key("a@x").is_err());
        assert!(s.put("a@x", "k", &[1, 2, 3]).is_err());
        // Crucially, no fallback key file was created and no keychain key minted.
        assert!(
            !s.mk_path("a@x").exists(),
            "transient error must not create a .mk fallback"
        );
        assert!(!s.fallback_used());
    }

    #[test]
    fn transient_keychain_error_with_existing_fallback_uses_it() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        // Pre-seed a valid 0600 fallback key for the account, as if a prior
        // keychain-less session had written it.
        let seeded = random_key();
        let s = Store::for_testing_keychain_error(dir.path().to_path_buf());
        write_0600(&s.mk_path("a@x"), &seeded).unwrap();

        // With the keychain transiently unavailable, values must seal/unseal via
        // the existing fallback key and the fallback flag must be surfaced.
        s.put("a@x", "k", &[9, 8, 7]).unwrap();
        assert_eq!(s.get("a@x", "k").unwrap(), Some(vec![9, 8, 7]));
        assert!(s.fallback_used());
        // The fallback file is unchanged (not re-minted).
        assert_eq!(std::fs::read(s.mk_path("a@x")).unwrap(), seeded.to_vec());
    }

    #[test]
    fn malformed_keychain_entry_is_err_and_not_overwritten() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let acct = "malformed-entry@x";
        // Seed the keychain slot with a non-32-byte payload via the read seam
        // (the keyring mock isolates its store per Entry, so a value written
        // from outside the Store would be invisible to the Store's own read).
        let bad = b64_encode(b"not-a-32-byte-key");
        let s = Store::for_testing_keychain_payload(dir.path().to_path_buf(), bad.clone());

        // A malformed entry must surface as Err, never be silently overwritten.
        // Because read validation returns Err, `load_or_create_master_key` never
        // reaches the keychain write — the existing entry is left intact — and
        // no fallback .mk is minted either.
        assert!(s.master_key(acct).is_err());
        assert!(s.put(acct, "k", &[1]).is_err());
        assert!(!s.mk_path(acct).exists());
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

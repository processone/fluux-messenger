//! Generic, protocol-agnostic at-rest KV store for E2EE plugin bytes.
//!
//! Each value is sealed with AES-256-GCM under a per-account master key held
//! in the OS keychain (`keyring`). Keychain-absent hosts fall back to a 0600
//! master-key file (with a caller-surfaced `fallback_used` flag). The store is
//! deliberately generic — opaque `key -> bytes` — so it is also the seam a
//! future Rust crypto engine would use.
//!
//! Layout, per account (JID) and optional `store` namespace:
//!   `<base_dir>/e2ee-store/<sanitized-jid>.json`             default store (`store: None`)
//!   `<base_dir>/e2ee-store/<sanitized-jid>__<store>.json`    namespaced store, e.g. a
//!                                                             plugin owning a dedicated file
//!   `<base_dir>/e2ee-store/<sanitized-jid>.mk`               raw 32-byte master key (0600
//!                                                             fallback only) — deliberately
//!                                                             NEVER namespaced; see below
//!
//! `store: None` always resolves to the legacy, un-namespaced path so existing
//! on-disk data (OMEMO's) keeps its exact file across this addition.
//!
//! The master key is read from the keychain (or fallback file) at most once per
//! account per `Store` instance and cached in memory — this keeps the hot path
//! off the keychain and makes the seal deterministic across get/put within a
//! session. There is exactly one master key per account, shared across all of
//! that account's `store` files: the key path and the `master_keys` cache are
//! keyed by account only, never by `store`, so adding a namespaced store never
//! mints a new keychain entry.
//!
//! The public surface (`Store` + get/put/delete/list and their namespaced
//! `_in` counterparts) is wrapped by the Tauri commands below
//! (`e2ee_store_get`/`put`/`delete`/`list`, M2b Task 2), which resolve the
//! per-user app data dir, base64-encode bytes across the IPC boundary,
//! validate the `account` param is a plausible bare JID and (when present)
//! the `store` param is a conservative filename slug, and serialize
//! concurrent writes to the same on-disk file (account + store).
use aes_gcm::aead::{Aead, Generate, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use std::collections::{BTreeMap, HashMap};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

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
    /// Only *read* from the `#[cfg(test)]`-gated branch in `read_keychain`, so
    /// a non-test build never touches it — narrowly silence that dead-code
    /// warning rather than allowing it module-wide.
    #[allow(dead_code)]
    simulate_keychain_error: bool,
    /// Test seam: inject a raw stored keychain payload (base64 string) so the
    /// real decode + length validation in `read_keychain` can be exercised
    /// against a malformed entry. The `keyring` mock isolates its store per
    /// `Entry`, so an entry seeded from outside the `Store` is invisible to it;
    /// this seam feeds the payload the `Store`'s own read would have seen.
    /// Always `None` in production. Same cfg(test)-only-read situation as
    /// `simulate_keychain_error` above.
    #[allow(dead_code)]
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

/// Shared `<sanitized-jid>[__<store>]` stem used by both the on-disk path
/// (`file_path_for`) and the process-wide lock key (`account_lock`). These
/// two call sites must always agree byte-for-byte, or the lock silently
/// stops guarding the file it is meant to serialize access to — so this is
/// the single definition both build on rather than two copies kept in sync
/// by hand.
fn file_stem(account: &str, store: Option<&str>) -> String {
    match store {
        None => sanitize_jid(account),
        Some(s) => format!("{}__{}", sanitize_jid(account), s),
    }
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
    ///
    /// Not yet wired to a Tauri command — M2b Task 2 only surfaces
    /// get/put/delete/list. This is an observability seam for a later
    /// command (or the tests below) to warn the user about the weaker
    /// key-protection boundary; narrowly allow the dead-code warning rather
    /// than blanket-allowing the module.
    #[allow(dead_code)]
    pub fn fallback_used(&self) -> bool {
        self.fallback_used.load(Ordering::Relaxed)
    }

    fn dir(&self) -> std::io::Result<PathBuf> {
        let d = self.base_dir.join("e2ee-store");
        std::fs::create_dir_all(&d)?;
        Ok(d)
    }

    /// Per-account, per-store sealed-value JSON file. `store: None` resolves to
    /// the legacy `<jid>.json` path so existing plugin data (OMEMO's) keeps its
    /// exact file. `dir()` creation is deferred to write time, so this is a
    /// pure path builder.
    pub fn file_path_for(&self, account: &str, store: Option<&str>) -> PathBuf {
        let stem = file_stem(account, store);
        self.base_dir
            .join("e2ee-store")
            .join(format!("{stem}.json"))
    }

    /// Back-compat wrapper: the legacy, un-namespaced path. Only the
    /// namespaced `handle_*`/command layer is wired into production callers
    /// today; this (and the other back-compat wrappers below) are kept for
    /// the module's existing tests, which exercise the public surface
    /// directly. Narrowly allow the resulting dead-code warning rather than
    /// widening the module-level lint.
    #[allow(dead_code)]
    pub fn file_path(&self, account: &str) -> PathBuf {
        self.file_path_for(account, None)
    }

    /// Master-key fallback file. Deliberately NOT namespaced: one master key
    /// per account is shared across that account's store files, so the
    /// keychain holds a single entry per account regardless of how many
    /// stores exist.
    fn mk_path_for(&self, account: &str) -> PathBuf {
        self.file_path_for(account, None).with_extension("mk")
    }

    fn mk_path(&self, account: &str) -> PathBuf {
        self.mk_path_for(account)
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
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|e| format!("keychain open: {e}"))?;
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

    fn read_map_in(
        &self,
        account: &str,
        store: Option<&str>,
    ) -> Result<BTreeMap<String, String>, String> {
        match std::fs::read(self.file_path_for(account, store)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("parse store: {e}")),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("read store: {e}")),
        }
    }

    fn write_map_in(
        &self,
        account: &str,
        store: Option<&str>,
        map: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        self.dir().map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        write_0600(&self.file_path_for(account, store), &bytes).map_err(|e| e.to_string())
    }

    /// Fetch and unseal the value for `key` in `store`, or `None` if absent.
    /// The master key is shared across stores (see [`Store::mk_path_for`]), so
    /// only the on-disk *file* is namespaced here.
    pub fn get_in(
        &self,
        account: &str,
        store: Option<&str>,
        key: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let map = self.read_map_in(account, store)?;
        match map.get(key) {
            None => Ok(None),
            Some(sealed_b64) => {
                let sealed = b64_decode(sealed_b64)?;
                Ok(Some(self.unseal(account, &sealed)?))
            }
        }
    }

    /// Seal `value` and store it under `key` in `store`, replacing any
    /// existing value.
    pub fn put_in(
        &self,
        account: &str,
        store: Option<&str>,
        key: &str,
        value: &[u8],
    ) -> Result<(), String> {
        let sealed = self.seal(account, value)?;
        let mut map = self.read_map_in(account, store)?;
        map.insert(key.to_string(), b64_encode(&sealed));
        self.write_map_in(account, store, &map)
    }

    /// Remove `key` from `store`. A missing key is a no-op (not an error).
    pub fn delete_in(&self, account: &str, store: Option<&str>, key: &str) -> Result<(), String> {
        let mut map = self.read_map_in(account, store)?;
        if map.remove(key).is_some() {
            self.write_map_in(account, store, &map)?;
        }
        Ok(())
    }

    /// List all keys in `store` for `account` whose name starts with `prefix`.
    pub fn list_in(
        &self,
        account: &str,
        store: Option<&str>,
        prefix: &str,
    ) -> Result<Vec<String>, String> {
        Ok(self
            .read_map_in(account, store)?
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect())
    }

    /// Fetch and unseal the value for `key`, or `None` if absent. Back-compat
    /// wrapper kept for the module's existing tests (see `file_path` above).
    #[allow(dead_code)]
    pub fn get(&self, account: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
        self.get_in(account, None, key)
    }

    /// Seal `value` and store it under `key`, replacing any existing value.
    /// Back-compat wrapper kept for the module's existing tests.
    #[allow(dead_code)]
    pub fn put(&self, account: &str, key: &str, value: &[u8]) -> Result<(), String> {
        self.put_in(account, None, key, value)
    }

    /// Remove `key`. A missing key is a no-op (not an error). Back-compat
    /// wrapper kept for the module's existing tests.
    #[allow(dead_code)]
    pub fn delete(&self, account: &str, key: &str) -> Result<(), String> {
        self.delete_in(account, None, key)
    }

    /// List all keys for `account` whose name starts with `prefix`.
    /// Back-compat wrapper kept for the module's existing tests.
    #[allow(dead_code)]
    pub fn list(&self, account: &str, prefix: &str) -> Result<Vec<String>, String> {
        self.list_in(account, None, prefix)
    }

    fn seal(&self, account: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let key = self.master_key(account)?;
        let key_arr: Key<Aes256Gcm> = key.into();
        let cipher = Aes256Gcm::new(&key_arr);
        // `Nonce::generate()` (the `aead::Generate` trait, `getrandom` feature)
        // draws from the OS's ambient CSPRNG — the 0.11 replacement for the
        // 0.10-era `OsRng.fill_bytes(..)`. MUST stay CSPRNG-backed: a nonce
        // MUST be unique per message under a given key, or AES-GCM confidentiality
        // (and authenticity) breaks.
        let nonce = Nonce::generate();
        let ct = cipher
            .encrypt(&nonce, plaintext)
            .map_err(|e| format!("seal: {e}"))?;
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    fn unseal(&self, account: &str, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.len() < NONCE_LEN {
            return Err("sealed value too short".into());
        }
        let key = self.master_key(account)?;
        let key_arr: Key<Aes256Gcm> = key.into();
        let cipher = Aes256Gcm::new(&key_arr);
        let nonce = Nonce::try_from(&sealed[..NONCE_LEN])
            .map_err(|_| "unseal: malformed nonce".to_string())?;
        cipher
            .decrypt(&nonce, &sealed[NONCE_LEN..])
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
    // OS-entropy CSPRNG via `aead::Generate` (the `getrandom` feature), same
    // security property as the 0.10-era `OsRng.fill_bytes(..)` this replaces.
    Generate::generate()
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

// --- Tauri command layer -----------------------------------------------
//
// This is the IPC trust boundary: `account` arrives as an arbitrary string
// from the webview. Two hazards flagged in the Task-1 review apply here:
//   (a) `sanitize_jid` can collapse distinct account strings onto the same
//       on-disk file, so we reject anything that isn't a plausible bare JID
//       before it ever reaches the store;
//   (b) a read-modify-write (`read_map` + `write_map`) is not atomic, so two
//       concurrent `put`/`delete` calls for the same account could race and
//       lose an update. `account_lock` serializes mutating calls per
//       sanitized-account (i.e. per on-disk file), process-wide.

/// Reject anything that isn't a plausible bare JID: empty, missing `@`, or
/// containing control characters (which could otherwise ride `sanitize_jid`
/// into odd filenames or log output). This does not fully re-validate JID
/// grammar — it is a cheap gate against obviously-wrong input reaching the
/// store, not a JID parser.
fn validate_account(account: &str) -> Result<(), String> {
    if account.is_empty() || !account.contains('@') || account.chars().any(|c| c.is_control()) {
        return Err("invalid account".to_string());
    }
    Ok(())
}

/// Reject anything that isn't a short, conservative slug. The value reaches a
/// filename, so this is deliberately stricter than `validate_account`.
fn validate_store(store: Option<&str>) -> Result<(), String> {
    let Some(s) = store else { return Ok(()) };
    if s.is_empty()
        || s.len() > 32
        || !s
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("invalid store".to_string());
    }
    Ok(())
}

/// Process-wide per-file locks, keyed by the sanitized on-disk file stem
/// (account + store) so writers to DIFFERENT store files do not serialize
/// against each other, while writers to the same file still do. `put`/`delete`
/// hold the relevant lock for their full read-modify-write so concurrent
/// writers to the same file can't interleave and lose an update.
static ACCOUNT_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn account_lock(account: &str, store: Option<&str>) -> Arc<Mutex<()>> {
    let registry = ACCOUNT_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = registry.lock().unwrap_or_else(|e| e.into_inner());
    let stem = file_stem(account, store);
    map.entry(stem)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Inner logic for `e2ee_store_get`, exercised directly by tests against a
/// temp-dir `Store` (no `AppHandle` needed).
fn handle_get(
    store: &Store,
    account: &str,
    store_ns: Option<&str>,
    key: &str,
) -> Result<Option<String>, String> {
    validate_account(account)?;
    validate_store(store_ns)?;
    Ok(store
        .get_in(account, store_ns, key)?
        .map(|b| b64_encode(&b)))
}

/// Inner logic for `e2ee_store_put`. Decodes `value_b64` before acquiring the
/// account lock (cheap, no I/O) and holds the lock across the store write.
fn handle_put(
    store: &Store,
    account: &str,
    store_ns: Option<&str>,
    key: &str,
    value_b64: &str,
) -> Result<(), String> {
    validate_account(account)?;
    validate_store(store_ns)?;
    let value = b64_decode(value_b64)?;
    let lock = account_lock(account, store_ns);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    store.put_in(account, store_ns, key, &value)
}

/// Inner logic for `e2ee_store_delete`.
fn handle_delete(
    store: &Store,
    account: &str,
    store_ns: Option<&str>,
    key: &str,
) -> Result<(), String> {
    validate_account(account)?;
    validate_store(store_ns)?;
    let lock = account_lock(account, store_ns);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    store.delete_in(account, store_ns, key)
}

/// Inner logic for `e2ee_store_list`. Reads are not serialized against the
/// account lock: `write_map` lands via an atomic rename, so a concurrent read
/// only ever observes a fully-old or fully-new file, never a torn one.
fn handle_list(
    store: &Store,
    account: &str,
    store_ns: Option<&str>,
    prefix: &str,
) -> Result<Vec<String>, String> {
    validate_account(account)?;
    validate_store(store_ns)?;
    store.list_in(account, store_ns, prefix)
}

fn store_for(app: &tauri::AppHandle) -> Result<Store, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(Store::new(base))
}

#[tauri::command]
pub fn e2ee_store_get(
    app: tauri::AppHandle,
    account: String,
    store: Option<String>,
    key: String,
) -> Result<Option<String>, String> {
    handle_get(&store_for(&app)?, &account, store.as_deref(), &key)
}

#[tauri::command]
pub fn e2ee_store_put(
    app: tauri::AppHandle,
    account: String,
    store: Option<String>,
    key: String,
    value_b64: String,
) -> Result<(), String> {
    handle_put(
        &store_for(&app)?,
        &account,
        store.as_deref(),
        &key,
        &value_b64,
    )
}

#[tauri::command]
pub fn e2ee_store_delete(
    app: tauri::AppHandle,
    account: String,
    store: Option<String>,
    key: String,
) -> Result<(), String> {
    handle_delete(&store_for(&app)?, &account, store.as_deref(), &key)
}

#[tauri::command]
pub fn e2ee_store_list(
    app: tauri::AppHandle,
    account: String,
    store: Option<String>,
    prefix: String,
) -> Result<Vec<String>, String> {
    handle_list(&store_for(&app)?, &account, store.as_deref(), &prefix)
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

    /// Shared temp-dir `Store` builder for tests that don't need a specific
    /// keychain-behavior variant. The `TempDir` must be kept alive by the
    /// caller for the duration of the test (it deletes the directory on drop).
    fn test_store() -> (Store, tempfile::TempDir) {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let store = Store::for_testing(dir.path().to_path_buf());
        (store, dir)
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

    // --- Command-layer (handle_*) tests -------------------------------------

    #[test]
    fn handle_functions_round_trip_via_base64() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let store = Store::for_testing(dir.path().to_path_buf());
        let value_b64 = b64_encode(b"hello e2ee");

        handle_put(&store, "alice@example.com", None, "session/1", &value_b64).unwrap();
        assert_eq!(
            handle_get(&store, "alice@example.com", None, "session/1").unwrap(),
            Some(value_b64)
        );
        assert_eq!(
            handle_list(&store, "alice@example.com", None, "session/").unwrap(),
            vec!["session/1".to_string()]
        );

        handle_delete(&store, "alice@example.com", None, "session/1").unwrap();
        assert_eq!(
            handle_get(&store, "alice@example.com", None, "session/1").unwrap(),
            None
        );
    }

    #[test]
    fn handle_functions_reject_invalid_account() {
        let dir = tempdir().unwrap();
        let store = Store::for_testing_no_keychain(dir.path().to_path_buf());
        let value_b64 = b64_encode(b"x");

        assert!(handle_get(&store, "", None, "k").is_err(), "empty account");
        assert!(
            handle_get(&store, "no-at-sign", None, "k").is_err(),
            "missing '@'"
        );
        assert!(
            handle_put(&store, "bad\u{0000}acct@x", None, "k", &value_b64).is_err(),
            "control character"
        );
        assert!(handle_delete(&store, "", None, "k").is_err());
        assert!(handle_list(&store, "", None, "prefix").is_err());
    }

    #[test]
    fn handle_put_rejects_invalid_base64() {
        let dir = tempdir().unwrap();
        let store = Store::for_testing_no_keychain(dir.path().to_path_buf());
        assert!(handle_put(&store, "a@x", None, "k", "not valid base64!!").is_err());
    }

    #[test]
    fn concurrent_puts_to_same_account_both_fully_persist() {
        install_mock_keychain();
        let dir = tempdir().unwrap();
        let store = Arc::new(Store::for_testing(dir.path().to_path_buf()));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        const N: usize = 50;

        let (s1, b1) = (store.clone(), barrier.clone());
        let t1 = std::thread::spawn(move || {
            b1.wait();
            for i in 0..N {
                handle_put(&s1, "race@x", None, &format!("k1/{i}"), &b64_encode(&[1])).unwrap();
            }
        });
        let (s2, b2) = (store.clone(), barrier.clone());
        let t2 = std::thread::spawn(move || {
            b2.wait();
            for i in 0..N {
                handle_put(&s2, "race@x", None, &format!("k2/{i}"), &b64_encode(&[2])).unwrap();
            }
        });
        t1.join().unwrap();
        t2.join().unwrap();

        // Without per-account serialization this is a classic lost-update:
        // both threads read-modify-write the same JSON map, so whichever
        // write lands last silently drops keys written by the other thread.
        assert_eq!(handle_list(&store, "race@x", None, "k1/").unwrap().len(), N);
        assert_eq!(handle_list(&store, "race@x", None, "k2/").unwrap().len(), N);
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

    // --- Namespaced `store` tests --------------------------------------------

    #[test]
    fn default_store_uses_legacy_path() {
        // Asserting `file_path_for(.., None) == file_path(..)` would be
        // tautological: `file_path` is DEFINED as `file_path_for(.., None)`,
        // so the two sides are the same expression and this could never
        // fail, including under the exact regression it's meant to guard
        // (OMEMO's live sealed data must keep resolving to `<jid>.json`).
        // Assert the concrete on-disk filename instead. "a@x" sanitizes to
        // itself (`@` is in the allowed charset), so the legacy filename is
        // literally `a@x.json`.
        let (store, _tmp) = test_store();
        let path = store.file_path_for("a@x", None);
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(
            name, "a@x.json",
            "omitting the store param must resolve to the legacy <jid>.json"
        );
        assert!(
            !name.contains("__"),
            "legacy path must not carry a namespace separator: {name}"
        );
    }

    #[test]
    fn namespaced_store_uses_separate_file() {
        let (store, _tmp) = test_store();
        let legacy = store.file_path_for("a@x", None);
        let named = store.file_path_for("a@x", Some("openpgp"));
        assert_ne!(legacy, named);
        assert!(named.to_string_lossy().contains("__openpgp"));
    }

    #[test]
    fn namespaced_and_default_stores_are_isolated() {
        let (store, _tmp) = test_store();
        store.put_in("a@x", None, "k", b"default").unwrap();
        store.put_in("a@x", Some("openpgp"), "k", b"pgp").unwrap();
        assert_eq!(store.get_in("a@x", None, "k").unwrap().unwrap(), b"default");
        assert_eq!(
            store.get_in("a@x", Some("openpgp"), "k").unwrap().unwrap(),
            b"pgp"
        );
        // list must not leak across stores
        assert_eq!(
            store.list_in("a@x", Some("openpgp"), "").unwrap(),
            vec!["k".to_string()]
        );
    }

    #[test]
    fn stores_share_one_master_key_file() {
        // `test_store()` builds the keychain-backed `Store` (a mock keyring
        // is installed for it), so the master key is never written to disk
        // and a `.mk`-count assertion against it is vacuously 0 regardless
        // of namespacing. Use the no-keychain fallback constructor instead
        // so a real 0600 `.mk` file is minted and the count means something.
        let dir = tempdir().unwrap();
        let store = Store::for_testing_no_keychain(dir.path().to_path_buf());
        store.put_in("a@x", None, "k", b"v").unwrap();
        store.put_in("a@x", Some("openpgp"), "k", b"v").unwrap();
        // The master-key path is the UN-namespaced one, so both stores resolve to
        // the same key rather than minting one per store.
        assert_eq!(
            store.mk_path_for("a@x"),
            store.file_path_for("a@x", None).with_extension("mk"),
            "master-key path must not be namespaced per store"
        );
        // On this fallback (no-keychain) host, writing to the default AND a
        // namespaced store for the same account must mint exactly ONE .mk
        // file. A strict equality (not `<= 1`) is what would actually catch
        // a regression where the .mk path became namespaced per store.
        let store_dir = store
            .file_path_for("a@x", None)
            .parent()
            .unwrap()
            .to_path_buf();
        let mk_count = std::fs::read_dir(&store_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "mk"))
            .count();
        assert_eq!(
            mk_count, 1,
            "expected exactly one master-key file, found {mk_count}"
        );
        // Both files really do exist (otherwise the assertions above are vacuous).
        assert!(store.file_path_for("a@x", None).exists());
        assert!(store.file_path_for("a@x", Some("openpgp")).exists());
    }

    #[test]
    fn validate_store_rejects_bad_slugs() {
        assert!(validate_store(Some("openpgp")).is_ok());
        assert!(validate_store(Some("omemo-2")).is_ok());
        assert!(validate_store(None).is_ok());
        let too_long = "x".repeat(33);
        let bad: [&str; 7] = [
            "../escape",
            "UPPER",
            "with space",
            "with/slash",
            "with.dot",
            "",
            too_long.as_str(),
        ];
        for b in bad {
            assert!(validate_store(Some(b)).is_err(), "should reject {b:?}");
        }
    }
}

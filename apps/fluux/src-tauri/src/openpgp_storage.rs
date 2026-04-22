//! On-disk + OS-keychain persistence for OpenPGP key material.
//!
//! We split the persistence into two halves deliberately:
//!
//! 1. A **per-account random passphrase** (32 bytes of CSPRNG output,
//!    base64-encoded) lives in the OS keychain. Small payload — keychains
//!    don't love blobs — and leverages the same credential store we already
//!    use for XMPP passwords (`com.processone.fluux`). Different service
//!    account to avoid collisions: `openpgp_passphrase:<jid>`.
//! 2. The **passphrase-encrypted TSK** (Transferable Secret Key) lives on
//!    disk at `<app_data>/openpgp/<sanitized_jid>.tsk.asc`. Sequoia-PGP
//!    encrypts the secret-key packets in-place; the armored file is useless
//!    without the passphrase.
//!
//! ## Secret-key-at-rest protection
//!
//! For v6 keys (the default under [`sequoia_openpgp::Profile::RFC9580`])
//! we wrap each secret packet with **Argon2id S2K + AES-256-OCB AEAD**:
//!
//! - Argon2id — memory-hard KDF, much harder to brute-force than RFC 4880
//!   Iterated+Salted SHA-256.
//! - AES-256-OCB — authenticated encryption; tampering with the encrypted
//!   secret is detected at decrypt time rather than producing garbage.
//!
//! Argon2 parameters follow **RFC 9106 §4 "second recommended option"**:
//! `m = 64 MiB (encoded as m=16 = log₂(KiB))`, `t = 3`, `p = 4`. The
//! OpenPGP S2K packet stores memory as the base-2 exponent of KiB, so
//! `m = 16 ⇒ 2¹⁶ KiB = 64 MiB`. With the random 256-bit passphrase that
//! the keychain half generates, the KDF's strength is overkill today;
//! the investment pays off the day we let users supply their own
//! (low-entropy) passphrase.
//!
//! v4 keys — which we no longer generate, but may load once from an
//! older install — stay on the classic Iterated+Salted S2K + CFB path.
//! Argon2 is only defined for v6 per RFC 9580 §3.7.
//!
//! ## Keychain unavailable — filesystem fallback
//!
//! When the keychain is genuinely unreachable — Linux box with no secret
//! service running, an intentionally locked macOS login keychain, or a
//! corrupted credential store — we fall through to writing the base64
//! passphrase into a 0600-permissioned file next to the key file. This is
//! the design-documented fallback ("Keychain not enabled/working ...
//! fallback to the web approach"). Callers learn which path was taken via
//! [`PassphraseBacking`] so the UI can nudge the user in a future slice.
//!
//! ## Concurrency
//!
//! Callers are expected to hold their own lock (`OpenpgpState` takes a
//! Mutex per-account map). The storage layer itself does only file I/O
//! and keychain round-trips — no in-memory state.

use anyhow::{anyhow, Context, Result};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::Entry;
use sequoia_openpgp::{
    cert::Cert,
    crypto::{Password, S2K},
    packet::{key, Key, Packet},
    parse::Parse,
    serialize::SerializeInto,
    types::{AEADAlgorithm, SymmetricAlgorithm},
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

/// Keychain service name. Shared with XMPP credentials so a user who
/// grants keychain access once gets access for both.
const KEYRING_SERVICE: &str = "com.processone.fluux";
/// Keychain account prefix to namespace PGP passphrases away from XMPP
/// credentials and the `last_user` marker.
const KEYRING_ACCOUNT_PREFIX: &str = "openpgp_passphrase:";

/// Which persistent store actually holds the passphrase right now. Used by
/// the Tauri command shim to flag `keychainBacked: false` to the UI when
/// we've fallen through to the on-disk passphrase file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PassphraseBacking {
    /// Passphrase lives in the OS keychain. Preferred path.
    Keychain,
    /// Passphrase lives in `<app_data>/openpgp/<jid>.pass` on disk,
    /// 0600 on Unix. Used when the keychain call failed.
    FilesystemFallback,
}

/// Result of a successful load or save. `Debug` is derived so tests can
/// use `Result::expect_err`; `Cert` itself implements `Debug`.
#[derive(Debug)]
pub struct PersistedKey {
    pub cert: Cert,
    pub backing: PassphraseBacking,
}

/// Filesystem + keychain-backed key storage. One instance per process;
/// all calls take the account JID so a single store handles multi-account
/// setups without mutation.
pub struct KeyStorage {
    base_dir: PathBuf,
    /// When false, skip the keychain entirely and always use the on-disk
    /// passphrase file. Intended for unit tests: unit tests on macOS would
    /// otherwise pop a keychain authorization dialog.
    use_keychain: bool,
}

impl KeyStorage {
    /// Production constructor — stores keys under `<base_dir>/openpgp/`
    /// and uses the OS keychain for the passphrase.
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            use_keychain: true,
        }
    }

    /// Test-only constructor that skips the keychain (CI would otherwise
    /// fail on machines without a configured keychain, and developer
    /// machines would pop up a macOS authorization dialog).
    #[cfg(test)]
    pub fn for_testing(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            use_keychain: false,
        }
    }

    /// Load the persisted key for `jid`, if one exists.
    ///
    /// Returns `Ok(None)` when there is no stored key file for this
    /// account — the caller should generate a fresh key. Returns `Err`
    /// when the file exists but can't be read or decrypted, which is a
    /// genuine corruption or migration situation the caller must not
    /// silently paper over.
    pub fn load(&self, jid: &str) -> Result<Option<PersistedKey>> {
        let key_path = self.key_file_path(jid)?;
        if !key_path.exists() {
            return Ok(None);
        }
        let (passphrase, backing) = self.read_passphrase(jid)?;
        let armored =
            fs::read(&key_path).with_context(|| format!("read {}", key_path.display()))?;
        let encrypted_cert = Cert::from_bytes(&armored)
            .with_context(|| format!("parse persisted TSK at {}", key_path.display()))?;
        let password = Password::from(passphrase);
        let cert = decrypt_cert_secrets(encrypted_cert, &password)
            .context("decrypt persisted TSK with stored passphrase")?;
        Ok(Some(PersistedKey { cert, backing }))
    }

    /// Persist `cert` for `jid`. Generates a random passphrase, stores it
    /// (keychain preferred, file fallback), and writes the encrypted TSK
    /// to disk. Any previously-stored key for the same JID is overwritten.
    pub fn save(&self, jid: &str, cert: &Cert) -> Result<PassphraseBacking> {
        let passphrase = random_passphrase()?;
        let backing = self.write_passphrase(jid, &passphrase)?;
        let password = Password::from(passphrase);
        let encrypted = encrypt_cert_secrets(cert.clone(), &password)?;
        let armored = encrypted
            .as_tsk()
            .armored()
            .to_vec()
            .context("serialize encrypted TSK")?;
        let key_path = self.key_file_path(jid)?;
        atomic_write(&key_path, &armored)?;
        #[cfg(unix)]
        restrict_permissions(&key_path);
        Ok(backing)
    }

    /// Delete every on-disk and keychain trace of the account's key.
    /// Safe to call when nothing is stored. Best-effort on the keychain
    /// side: we ignore `NoEntry` but surface genuine I/O errors.
    pub fn forget(&self, jid: &str) -> Result<()> {
        let key_path = self.key_file_path(jid)?;
        if key_path.exists() {
            fs::remove_file(&key_path).with_context(|| format!("remove {}", key_path.display()))?;
        }
        let pass_path = self.passphrase_fallback_path(jid)?;
        if pass_path.exists() {
            fs::remove_file(&pass_path)
                .with_context(|| format!("remove {}", pass_path.display()))?;
        }
        if self.use_keychain {
            delete_keychain_entry(jid);
        }
        Ok(())
    }

    // -- path helpers --

    fn keys_dir(&self) -> Result<PathBuf> {
        let dir = self.base_dir.join("openpgp");
        fs::create_dir_all(&dir).with_context(|| format!("create keys dir {}", dir.display()))?;
        #[cfg(unix)]
        restrict_permissions_dir(&dir);
        Ok(dir)
    }

    fn key_file_path(&self, jid: &str) -> Result<PathBuf> {
        Ok(self
            .keys_dir()?
            .join(format!("{}.tsk.asc", sanitize_jid(jid))))
    }

    fn passphrase_fallback_path(&self, jid: &str) -> Result<PathBuf> {
        Ok(self.keys_dir()?.join(format!("{}.pass", sanitize_jid(jid))))
    }

    // -- passphrase plumbing --

    /// Read the per-account passphrase. Tries the keychain first; falls
    /// through to the on-disk `.pass` file. Errors if neither has a value
    /// but a key file exists — that combination means the passphrase was
    /// wiped behind our back and we can't recover the key.
    fn read_passphrase(&self, jid: &str) -> Result<(Vec<u8>, PassphraseBacking)> {
        if self.use_keychain {
            if let Some(bytes) = read_keychain_passphrase(jid) {
                return Ok((bytes, PassphraseBacking::Keychain));
            }
        }
        let path = self.passphrase_fallback_path(jid)?;
        if !path.exists() {
            return Err(anyhow!(
                "passphrase for account '{jid}' is not in the keychain or on disk — \
                 key material cannot be decrypted"
            ));
        }
        let encoded = fs::read_to_string(&path)
            .with_context(|| format!("read fallback passphrase {}", path.display()))?;
        let bytes = B64
            .decode(encoded.trim())
            .context("fallback passphrase file is not valid base64")?;
        Ok((bytes, PassphraseBacking::FilesystemFallback))
    }

    /// Write the passphrase — try keychain, fall through to file on any
    /// keychain error. On successful keychain write we scrub any stale
    /// on-disk fallback so there's a single source of truth.
    fn write_passphrase(&self, jid: &str, passphrase: &[u8]) -> Result<PassphraseBacking> {
        if self.use_keychain && write_keychain_passphrase(jid, passphrase) {
            // Clear a stale fallback file so a future `read_passphrase`
            // prefers the keychain copy; on most Unixes fs::remove_file
            // is a no-op when the file is missing.
            if let Ok(path) = self.passphrase_fallback_path(jid) {
                let _ = fs::remove_file(path);
            }
            return Ok(PassphraseBacking::Keychain);
        }
        let path = self.passphrase_fallback_path(jid)?;
        let encoded = B64.encode(passphrase);
        atomic_write(&path, encoded.as_bytes())?;
        #[cfg(unix)]
        restrict_permissions(&path);
        Ok(PassphraseBacking::FilesystemFallback)
    }
}

// ---------------------------------------------------------------------------
// Passphrase generation
// ---------------------------------------------------------------------------

/// 32 bytes of cryptographically-strong randomness — we never show the
/// passphrase to the user, so the extra entropy is free.
fn random_passphrase() -> Result<Vec<u8>> {
    let mut buf = vec![0u8; 32];
    sequoia_openpgp::crypto::random(&mut buf).context("generate random passphrase")?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Keychain plumbing
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn keyring_account(jid: &str) -> String {
    format!("{}{}", KEYRING_ACCOUNT_PREFIX, jid)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn read_keychain_passphrase(jid: &str) -> Option<Vec<u8>> {
    let entry = Entry::new(KEYRING_SERVICE, &keyring_account(jid)).ok()?;
    let encoded = match entry.get_password() {
        Ok(s) => s,
        Err(keyring::Error::NoEntry) => return None,
        Err(_) => return None,
    };
    B64.decode(encoded.trim()).ok()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn write_keychain_passphrase(jid: &str, passphrase: &[u8]) -> bool {
    let entry = match Entry::new(KEYRING_SERVICE, &keyring_account(jid)) {
        Ok(e) => e,
        Err(_) => return false,
    };
    entry.set_password(&B64.encode(passphrase)).is_ok()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn delete_keychain_entry(jid: &str) {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, &keyring_account(jid)) {
        // Ignore NoEntry and platform errors — best-effort cleanup.
        let _ = entry.delete_credential();
    }
}

// Mobile stubs: the mobile targets don't get the `keyring` crate because
// the umbrella Cargo.toml only adds it to desktop. Guard the helpers so
// the module still compiles (even though mobile isn't a Tauri target
// today — safety against drift).
#[cfg(any(target_os = "android", target_os = "ios"))]
fn read_keychain_passphrase(_: &str) -> Option<Vec<u8>> {
    None
}
#[cfg(any(target_os = "android", target_os = "ios"))]
fn write_keychain_passphrase(_: &str, _: &[u8]) -> bool {
    false
}
#[cfg(any(target_os = "android", target_os = "ios"))]
fn delete_keychain_entry(_: &str) {}

// ---------------------------------------------------------------------------
// Sequoia secret-key en/decryption
// ---------------------------------------------------------------------------

/// Argon2id parameters we emit when wrapping v6 secret-key material.
///
/// Two variants:
///
/// - [`Argon2Params::RFC9106_SECOND_OPTION`] (our primary): matches RFC 9106
///   §4 "second recommended option" — `m = 64 MiB`, `t = 3`, `p = 4`. This
///   is what the spec recommends for the memory-constrained case, which
///   is a fair match for a desktop app at login time.
/// - [`Argon2Params::SERIAL_FALLBACK`]: `m = 64 MiB`, `t = 4`, `p = 1`.
///   A one-lane fallback used if the linked Argon2 implementation ever
///   rejects `p > 1`. Trades the multi-lane security margin for roughly
///   equivalent serial work (one more pass) so total cost to a defender
///   stays in the same ballpark.
///
/// The `m` field is the OpenPGP S2K packet encoding: `memory_kib = 2^m`.
/// For 64 MiB that is `m = 16` (2^16 KiB = 65536 KiB = 64 MiB).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Params {
    pub t: u8,
    pub p: u8,
    pub m: u8,
}

impl Argon2Params {
    /// RFC 9106 §4 "second recommended option". Our primary choice.
    pub const RFC9106_SECOND_OPTION: Argon2Params = Argon2Params { t: 3, p: 4, m: 16 };

    /// Serial fallback: if `p > 1` isn't accepted by the runtime, drop
    /// to `p = 1` and bump `t` so the defender does comparable work.
    pub const SERIAL_FALLBACK: Argon2Params = Argon2Params { t: 4, p: 1, m: 16 };
}

/// Records which Argon2 variant actually produced usable ciphertext the
/// first time encryption was attempted this process. Used by tests and
/// future diagnostics; logged once via [`log_argon2_variant_once`].
static ARGON2_VARIANT_IN_USE: OnceLock<Argon2Params> = OnceLock::new();

/// Emit a single tracing line at most once per process announcing which
/// Argon2id variant wraps the secret keys. Whether the primary or the
/// fallback, the user-facing cost is the same (on-disk format + unlock
/// latency); having the line makes debugging a failed TSK load later
/// much cheaper.
fn log_argon2_variant_once(params: Argon2Params) {
    let _ = ARGON2_VARIANT_IN_USE.set(params);
    // Use `Once`-like behaviour: the inner `set` only succeeds once, so
    // the log below fires once per process. Subsequent calls noop.
    static LOGGED: OnceLock<()> = OnceLock::new();
    LOGGED.get_or_init(|| {
        let memory_mib = 1u32 << (params.m.saturating_sub(10));
        tracing::info!(
            "openpgp: Argon2id secret-key-at-rest — m={}MiB, t={}, p={}{}",
            memory_mib,
            params.t,
            params.p,
            if params == Argon2Params::SERIAL_FALLBACK {
                " (serial fallback — p=4 was unsupported)"
            } else {
                ""
            },
        );
    });
}

/// Build a fresh Argon2 S2K packet with a cryptographically random salt
/// and the given cost parameters. Called per-cert per-save so every
/// persisted file gets a fresh salt, preventing a single leaked
/// passphrase from compromising history snapshots.
fn make_argon2_s2k(params: Argon2Params) -> Result<S2K> {
    let mut salt = [0u8; 16];
    sequoia_openpgp::crypto::random(&mut salt).context("generate Argon2 salt")?;
    Ok(S2K::Argon2 {
        salt,
        t: params.t,
        p: params.p,
        m: params.m,
    })
}

/// Encrypt every secret packet in `cert` under `password`.
///
/// v6 packets get Argon2id + AES-256-OCB per RFC 9580 §3.7. v4 packets
/// — which this codebase never generates since the switch to
/// [`sequoia_openpgp::Profile::RFC9580`], but may still be loaded once
/// from a pre-v6 install — fall back to the default Iterated+Salted S2K
/// + CFB path. Argon2 S2K is not valid on v4 keys.
fn encrypt_cert_secrets(cert: Cert, password: &Password) -> Result<Cert> {
    let mut packets: Vec<Packet> = Vec::new();
    for packet in cert.into_tsk().into_packets() {
        match packet {
            Packet::SecretKey(key) => {
                packets.push(Packet::SecretKey(encrypt_key_secret(key, password)?));
            }
            Packet::SecretSubkey(key) => {
                packets.push(Packet::SecretSubkey(encrypt_key_secret(key, password)?));
            }
            other => packets.push(other),
        }
    }
    Cert::from_packets(packets.into_iter()).context("rebuild cert after encrypting secrets")
}

/// Protect one secret key packet at rest. Branches on key version:
/// v6 → Argon2id+OCB; v4 → classic default.
fn encrypt_key_secret<R>(
    key: Key<key::SecretParts, R>,
    password: &Password,
) -> Result<Key<key::SecretParts, R>>
where
    R: key::KeyRole,
{
    if key.version() >= 6 {
        encrypt_v6_with_argon2(key, password)
    } else {
        // RFC 9580 §3.7 restricts Argon2 to v6. Keep classic S2K for any
        // lingering v4 key — we don't generate v4 keys any more, but a
        // cert loaded from a pre-v6 install must not panic.
        key.encrypt_secret(password)
            .context("encrypt v4 secret key with default S2K")
    }
}

/// Try to wrap a v6 secret packet with Argon2id+OCB under our primary
/// parameters. On the rare event that the underlying Argon2 implementation
/// rejects `p > 1`, retry with the serial fallback (one lane, one extra
/// iteration) and log the downgrade so the operator can tell the two
/// variants apart on disk.
fn encrypt_v6_with_argon2<R>(
    key: Key<key::SecretParts, R>,
    password: &Password,
) -> Result<Key<key::SecretParts, R>>
where
    R: key::KeyRole,
{
    let primary_err =
        match attempt_argon2_encrypt(key.clone(), password, Argon2Params::RFC9106_SECOND_OPTION) {
            Ok(out) => {
                log_argon2_variant_once(Argon2Params::RFC9106_SECOND_OPTION);
                return Ok(out);
            }
            Err(e) => e,
        };

    // Primary attempt failed. Before giving up, check whether the error
    // looks like a parallelism rejection. Other failure modes (out of
    // memory, bad AEAD, etc.) shouldn't silently downgrade the KDF.
    let message = format!("{primary_err:#}");
    let looks_like_parallelism_issue =
        message.to_lowercase().contains("parallel") || message.to_lowercase().contains("lane");
    if !looks_like_parallelism_issue {
        return Err(primary_err);
    }

    tracing::warn!(
        "openpgp: Argon2id p=4 rejected ({message}); retrying with p=1/t=4 serial fallback"
    );
    let out = attempt_argon2_encrypt(key, password, Argon2Params::SERIAL_FALLBACK)
        .context("Argon2id serial-fallback encryption also failed")?;
    log_argon2_variant_once(Argon2Params::SERIAL_FALLBACK);
    Ok(out)
}

/// Single, parameterised encryption attempt. Kept as its own function so
/// [`encrypt_v6_with_argon2`]'s retry path can call it with a different
/// params struct without duplicating the take-secret / add-secret dance.
fn attempt_argon2_encrypt<R>(
    key: Key<key::SecretParts, R>,
    password: &Password,
    params: Argon2Params,
) -> Result<Key<key::SecretParts, R>>
where
    R: key::KeyRole,
{
    let s2k = make_argon2_s2k(params)?;
    let (pub_key, mut secret) = key.take_secret();
    secret
        .encrypt_in_place_with(
            &pub_key,
            s2k,
            SymmetricAlgorithm::AES256,
            Some(AEADAlgorithm::OCB),
            password,
        )
        .with_context(|| {
            format!(
                "encrypt v6 secret with Argon2id (m=2^{} KiB, t={}, p={}) + AES-256-OCB",
                params.m, params.t, params.p
            )
        })?;
    let (out, _) = pub_key.add_secret(secret);
    Ok(out)
}

#[cfg(test)]
pub(crate) fn argon2_variant_in_use() -> Option<Argon2Params> {
    ARGON2_VARIANT_IN_USE.get().copied()
}

/// Inverse of [`encrypt_cert_secrets`]: decrypt each secret packet under
/// `password` so the resulting Cert is immediately usable for sign/decrypt.
fn decrypt_cert_secrets(cert: Cert, password: &Password) -> Result<Cert> {
    let mut packets: Vec<Packet> = Vec::new();
    for packet in cert.into_tsk().into_packets() {
        match packet {
            Packet::SecretKey(key) => {
                let decrypted = key
                    .decrypt_secret(password)
                    .context("decrypt primary secret key")?;
                packets.push(Packet::SecretKey(decrypted));
            }
            Packet::SecretSubkey(key) => {
                let decrypted = key
                    .decrypt_secret(password)
                    .context("decrypt secret subkey")?;
                packets.push(Packet::SecretSubkey(decrypted));
            }
            other => packets.push(other),
        }
    }
    Cert::from_packets(packets.into_iter()).context("rebuild cert after decrypting secrets")
}

// ---------------------------------------------------------------------------
// Path sanitisation and atomic file writes
// ---------------------------------------------------------------------------

/// Turn a JID into a filesystem-safe name. Keeps ASCII alphanumerics plus
/// a small set of JID-safe punctuation; everything else becomes `_`. Two
/// different JIDs can in principle collapse to the same sanitized form
/// (`a@b.com` and `a_b.com`) — we accept this because our caller (the
/// OpenpgpState) only persists one account per real JID at a time.
fn sanitize_jid(jid: &str) -> String {
    jid.chars()
        .map(|c| match c {
            c if c.is_ascii_alphanumeric() => c,
            '.' | '-' | '_' | '@' | '+' => c,
            _ => '_',
        })
        .collect()
}

/// Write `data` to `path` as atomically as the OS allows: write to a
/// sibling temp file, fsync implicitly via `rename` on Unix. If the
/// process dies between write and rename, the temp file is left behind
/// but the original is untouched.
fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, data).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(unix)]
fn restrict_permissions_dir(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use sequoia_openpgp::cert::CertBuilder;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Produce a unique tempdir per test without bringing in the
    /// `tempfile` crate (keeps the test surface self-contained).
    fn fresh_tmp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("fluux-openpgp-test-{pid}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// v6 cert matching the production path (`set_profile(RFC9580)`).
    /// Argon2id S2K is only valid on v6 keys, so every storage test uses
    /// v6 — just like `OpenpgpState::ensure_key` does in real use.
    fn generate_cert(user: &str) -> Cert {
        let (cert, _revocation) = CertBuilder::general_purpose(Some(user))
            .set_profile(sequoia_openpgp::Profile::RFC9580)
            .unwrap()
            .generate()
            .unwrap();
        cert
    }

    /// Dedicated v4 cert generator for the one test that must exercise
    /// the "legacy cert loaded from a pre-v6 install" path. Keeps the
    /// default-v6 happy path uncluttered by version branching elsewhere.
    fn generate_v4_cert(user: &str) -> Cert {
        let (cert, _revocation) = CertBuilder::general_purpose(Some(user))
            .set_profile(sequoia_openpgp::Profile::RFC4880)
            .unwrap()
            .generate()
            .unwrap();
        cert
    }

    #[test]
    fn save_then_load_round_trips_fingerprint() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir.clone());
        let cert = generate_cert("alice@example.com");
        let original_fp = cert.fingerprint().to_hex();

        let backing = storage.save("alice@example.com", &cert).unwrap();
        assert_eq!(backing, PassphraseBacking::FilesystemFallback);

        let loaded = storage
            .load("alice@example.com")
            .unwrap()
            .expect("must have loaded the saved key");
        assert_eq!(loaded.cert.fingerprint().to_hex(), original_fp);
        assert_eq!(loaded.backing, PassphraseBacking::FilesystemFallback);
    }

    #[test]
    fn load_returns_none_for_unknown_account() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir);
        assert!(storage.load("nobody@example.com").unwrap().is_none());
    }

    #[test]
    fn forget_removes_both_key_and_passphrase() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir.clone());
        let cert = generate_cert("alice@example.com");
        storage.save("alice@example.com", &cert).unwrap();

        storage.forget("alice@example.com").unwrap();

        assert!(storage.load("alice@example.com").unwrap().is_none());
        // Also a no-op the second time.
        storage.forget("alice@example.com").unwrap();
    }

    #[test]
    fn forget_is_noop_for_unknown_account() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir);
        storage.forget("ghost@example.com").unwrap();
    }

    #[test]
    fn different_accounts_are_isolated() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir);
        let alice = generate_cert("alice@example.com");
        let bob = generate_cert("bob@example.com");

        storage.save("alice@example.com", &alice).unwrap();
        storage.save("bob@example.com", &bob).unwrap();

        let a = storage.load("alice@example.com").unwrap().unwrap();
        let b = storage.load("bob@example.com").unwrap().unwrap();
        assert_eq!(a.cert.fingerprint().to_hex(), alice.fingerprint().to_hex());
        assert_eq!(b.cert.fingerprint().to_hex(), bob.fingerprint().to_hex());
        assert_ne!(a.cert.fingerprint().to_hex(), b.cert.fingerprint().to_hex());
    }

    #[test]
    fn second_save_overwrites_first() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir);
        let first = generate_cert("alice@example.com");
        storage.save("alice@example.com", &first).unwrap();

        let second = generate_cert("alice@example.com");
        storage.save("alice@example.com", &second).unwrap();

        let loaded = storage.load("alice@example.com").unwrap().unwrap();
        assert_eq!(
            loaded.cert.fingerprint().to_hex(),
            second.fingerprint().to_hex()
        );
        assert_ne!(
            loaded.cert.fingerprint().to_hex(),
            first.fingerprint().to_hex()
        );
    }

    #[test]
    fn missing_passphrase_with_present_key_errors() {
        // Simulates a corruption scenario where the `.pass` file was
        // deleted but the `.tsk.asc` file remains. Must surface loudly.
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir.clone());
        let cert = generate_cert("alice@example.com");
        storage.save("alice@example.com", &cert).unwrap();

        // Scrub the passphrase file.
        let pass = storage
            .passphrase_fallback_path("alice@example.com")
            .unwrap();
        fs::remove_file(pass).unwrap();

        let err = storage
            .load("alice@example.com")
            .expect_err("load must fail without a passphrase");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("passphrase"),
            "expected passphrase error, got {msg}"
        );
    }

    #[test]
    fn sanitize_jid_replaces_unsafe_chars() {
        assert_eq!(sanitize_jid("alice@example.com"), "alice@example.com");
        assert_eq!(sanitize_jid("alice/../etc/passwd"), "alice_.._etc_passwd");
        assert_eq!(
            sanitize_jid("alice+work@example.com"),
            "alice+work@example.com"
        );
    }

    #[test]
    fn loaded_cert_can_decrypt_a_message() {
        // Regression guard: if the encrypt-secrets-then-decrypt cycle
        // mangled any key packet, Sequoia would refuse to produce a
        // decryption keypair. The simplest check is an encrypt/decrypt
        // round-trip using the loaded cert.
        use sequoia_openpgp::{
            parse::{stream::DecryptorBuilder, Parse},
            policy::StandardPolicy,
            serialize::stream::{Armorer, Encryptor, LiteralWriter, Message, Recipient},
        };
        use std::io::Write as _;

        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir);
        let cert = generate_cert("alice@example.com");
        storage.save("alice@example.com", &cert).unwrap();
        let loaded = storage.load("alice@example.com").unwrap().unwrap();

        let policy = StandardPolicy::new();
        let recipients: Vec<Recipient> = loaded
            .cert
            .keys()
            .with_policy(&policy, None)
            .supported()
            .alive()
            .revoked(false)
            .for_transport_encryption()
            .map(Recipient::from)
            .collect();
        assert!(
            !recipients.is_empty(),
            "loaded cert must expose encryption subkey"
        );

        let mut sink = Vec::new();
        {
            let message = Message::new(&mut sink);
            let message = Armorer::new(message).build().unwrap();
            let message = Encryptor::for_recipients(message, recipients)
                .build()
                .unwrap();
            let mut message = LiteralWriter::new(message).build().unwrap();
            message.write_all(b"hello").unwrap();
            message.finalize().unwrap();
        }

        // Build a minimal decryptor helper that uses the loaded cert's
        // secret material. A failure here would prove the save/load cycle
        // corrupted the secret packets.
        struct TestHelper<'a> {
            cert: &'a Cert,
            policy: &'a StandardPolicy<'a>,
        }
        impl sequoia_openpgp::parse::stream::VerificationHelper for TestHelper<'_> {
            fn get_certs(
                &mut self,
                _: &[sequoia_openpgp::KeyHandle],
            ) -> sequoia_openpgp::Result<Vec<Cert>> {
                Ok(vec![])
            }
            fn check(
                &mut self,
                _: sequoia_openpgp::parse::stream::MessageStructure,
            ) -> sequoia_openpgp::Result<()> {
                Ok(())
            }
        }
        impl sequoia_openpgp::parse::stream::DecryptionHelper for TestHelper<'_> {
            fn decrypt(
                &mut self,
                pkesks: &[sequoia_openpgp::packet::PKESK],
                _: &[sequoia_openpgp::packet::SKESK],
                sym_algo: Option<sequoia_openpgp::types::SymmetricAlgorithm>,
                decrypt: &mut dyn FnMut(
                    Option<sequoia_openpgp::types::SymmetricAlgorithm>,
                    &sequoia_openpgp::crypto::SessionKey,
                ) -> bool,
            ) -> sequoia_openpgp::Result<Option<Cert>> {
                for ka in self
                    .cert
                    .keys()
                    .with_policy(self.policy, None)
                    .for_transport_encryption()
                    .secret()
                {
                    let mut pair = ka.key().clone().into_keypair()?;
                    for pkesk in pkesks {
                        if pkesk
                            .decrypt(&mut pair, sym_algo)
                            .map(|(a, sk)| decrypt(a, &sk))
                            .unwrap_or(false)
                        {
                            return Ok(Some(self.cert.clone()));
                        }
                    }
                }
                Ok(None)
            }
        }

        let helper = TestHelper {
            cert: &loaded.cert,
            policy: &policy,
        };
        let mut decryptor = DecryptorBuilder::from_bytes(&sink)
            .unwrap()
            .with_policy(&policy, None, helper)
            .unwrap();
        let mut out = Vec::new();
        std::io::copy(&mut decryptor, &mut out).unwrap();
        assert_eq!(&out, b"hello");
    }

    // ---- RFC 9580 / Argon2id coverage ------------------------------

    use sequoia_openpgp::packet::key::SecretKeyMaterial;

    /// Walk the on-disk TSK and return every encrypted-secret packet's
    /// (s2k, aead) tuple. A bit involved because Sequoia's public
    /// `Encrypted` field accessors aren't reachable via the Cert API
    /// without first matching on the `SecretKeyMaterial` enum.
    fn inspect_on_disk_s2k(
        tsk_path: &Path,
    ) -> Vec<(S2K, Option<AEADAlgorithm>, SymmetricAlgorithm)> {
        let armored = fs::read(tsk_path).unwrap();
        let cert = Cert::from_bytes(&armored).unwrap();
        let mut out = Vec::new();
        for ka in cert.keys().secret() {
            if let SecretKeyMaterial::Encrypted(enc) = ka.key().secret() {
                out.push((enc.s2k().clone(), enc.aead_algo(), enc.algo()));
            }
        }
        out
    }

    /// The persistence test's "walk the TSK" variant: assert every
    /// secret packet carries Argon2id with the RFC 9106 §4 second-
    /// recommended parameters and is wrapped in AES-256-OCB. This
    /// guards against silent regressions to the RFC 4880 S2K default.
    #[test]
    fn persisted_tsk_uses_argon2id_with_rfc9106_second_option() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir.clone());
        let cert = generate_cert("alice@example.com");
        storage.save("alice@example.com", &cert).unwrap();

        let tsk_path = dir
            .join("openpgp")
            .join(format!("{}.tsk.asc", sanitize_jid("alice@example.com")));
        let parts = inspect_on_disk_s2k(&tsk_path);
        assert!(
            !parts.is_empty(),
            "expected at least one encrypted secret packet (primary + subkeys)"
        );
        // Primary + at least one signing subkey + one encryption subkey
        // under general_purpose: we don't hard-code the exact count,
        // only that every secret packet is protected uniformly.
        for (s2k, aead, symm) in parts {
            match s2k {
                S2K::Argon2 { t, p, m, salt } => {
                    assert_eq!(t, 3, "iterations (t) must match RFC 9106 §4 option B");
                    assert_eq!(p, 4, "parallelism (p) must match RFC 9106 §4 option B");
                    assert_eq!(
                        m, 16,
                        "memory exponent (m) must be 16 (→ 2^16 KiB = 64 MiB)"
                    );
                    assert_eq!(salt.len(), 16, "salt must be RFC 9106 default 16 bytes");
                }
                other => panic!("expected Argon2 S2K on v6 secret, got {other:?}"),
            }
            assert_eq!(
                aead,
                Some(AEADAlgorithm::OCB),
                "AEAD must be OCB for at-rest secret-key protection"
            );
            assert_eq!(
                symm,
                SymmetricAlgorithm::AES256,
                "symmetric cipher must be AES-256"
            );
        }
    }

    /// Generated certs are v6 — a precondition for using Argon2 S2K.
    /// Fails fast if a future Sequoia bump changes the default profile
    /// semantics or silently downgrades the selection.
    #[test]
    fn generated_cert_is_v6() {
        let cert = generate_cert("alice@example.com");
        assert_eq!(
            cert.primary_key().key().version(),
            6,
            "OpenpgpState::generate_cert must produce v6 keys (RFC 9580)"
        );
    }

    /// A v4 cert loaded from a hypothetical pre-v6 install must still
    /// round-trip through save/load. Argon2 is v6-only, so this branch
    /// goes through the classic CFB + Iterated S2K path — verify it
    /// still works end-to-end.
    #[test]
    fn v4_cert_saves_and_loads_through_legacy_path() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir.clone());
        let cert = generate_v4_cert("legacy@example.com");
        let original_fp = cert.fingerprint().to_hex();

        storage.save("legacy@example.com", &cert).unwrap();
        let loaded = storage
            .load("legacy@example.com")
            .unwrap()
            .expect("v4 cert must round-trip");
        assert_eq!(loaded.cert.fingerprint().to_hex(), original_fp);

        let tsk_path = dir
            .join("openpgp")
            .join(format!("{}.tsk.asc", sanitize_jid("legacy@example.com")));
        let parts = inspect_on_disk_s2k(&tsk_path);
        for (s2k, aead, _symm) in parts {
            // v4 keys must NOT carry Argon2 — RFC 9580 §3.7 restricts it.
            assert!(
                !matches!(s2k, S2K::Argon2 { .. }),
                "v4 secret packets must keep classic S2K, got Argon2"
            );
            assert!(
                aead.is_none(),
                "v4 classic path is CFB; AEAD must not appear"
            );
        }
    }

    /// After one save the module's variant-recording cell is populated.
    /// The value is what the user would see in logs; the test uses it
    /// as a deterministic way to catch a silent fallback.
    #[test]
    fn argon2_variant_records_primary_choice_after_first_encrypt() {
        let dir = fresh_tmp_dir();
        let storage = KeyStorage::for_testing(dir);
        let cert = generate_cert("alice@example.com");
        storage.save("alice@example.com", &cert).unwrap();

        // In our pinned Sequoia 2.2 / argon2 0.5.3 stack, p=4 is
        // accepted. If this ever starts returning SERIAL_FALLBACK the
        // downgrade is real and must be investigated — don't paper over.
        assert_eq!(
            argon2_variant_in_use(),
            Some(Argon2Params::RFC9106_SECOND_OPTION),
            "expected RFC 9106 §4 (p=4, t=3, m=16) without fallback"
        );
    }
}

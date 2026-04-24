//! OpenPGP operations for the XEP-0373 (OX) E2EE plugin.
//!
//! This module exposes Tauri commands that the TypeScript-side plugin
//! (`apps/fluux/src/e2ee/SequoiaPgpPlugin.ts`) invokes for the cryptographic
//! operations it cannot perform in the web layer. The crypto is provided by
//! [Sequoia-PGP](https://sequoia-pgp.org/) with its pure-Rust backend.
//!
//! # Signcrypt
//!
//! Outgoing messages are encrypted to the recipient **and** signed with the
//! sender's signing subkey. On decrypt, if the caller supplies the sender's
//! public key, we verify the signature and return the signing fingerprint so
//! the UI can lift trust from `untrusted` to `trusted` for messages that
//! match a known peer.
//!
//! # Key material lifecycle
//!
//! Keys are persisted across app restarts via [`crate::openpgp_storage`]:
//! the secret key lives on disk encrypted under a per-account passphrase
//! that lives in the OS keychain (or a 0600 fallback file when the
//! keychain is unreachable). The in-memory map here is a cache — the
//! first [`OpenpgpState::ensure_key`] call per account after a restart
//! loads from disk. [`openpgp_forget_account`] removes both the cached
//! entry and the on-disk material.

use anyhow::{anyhow, Context, Result};
use sequoia_openpgp as openpgp;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::sync::OnceCell as AsyncOnceCell;

use crate::openpgp_storage::{KeyStorage, PassphraseBacking};

use openpgp::{
    cert::{Cert, CertBuilder},
    crypto::SessionKey,
    packet::{PKESK, SKESK},
    parse::{
        stream::{
            DecryptionHelper, DecryptorBuilder, MessageLayer, MessageStructure, VerificationHelper,
        },
        Parse,
    },
    policy::StandardPolicy,
    serialize::{
        stream::{Armorer, Encryptor, LiteralWriter, Message, Recipient, Signer},
        SerializeInto,
    },
    types::SymmetricAlgorithm,
    Cert as _Cert, Fingerprint, KeyHandle,
};

/// Serializable output of [`openpgp_ensure_key`].
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyBundle {
    /// Upper-case hex fingerprint (40 chars for v4 keys), no separators.
    pub fingerprint: String,
    /// ASCII-armored public key block, suitable for publishing to a PEP node.
    pub public_armored: String,
    /// ASCII-armored secret key block. Callers must treat as sensitive.
    pub secret_armored: String,
    /// `true` when the per-account passphrase is stored in the OS
    /// keychain; `false` when we fell through to a 0600-permissioned
    /// file. Surfaced to the UI so a future slice can nudge the user to
    /// fix their keychain setup.
    pub keychain_backed: bool,
}

/// Serializable output of [`openpgp_decrypt`].
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DecryptOutput {
    /// Decrypted plaintext.
    pub plaintext: String,
    /// `true` iff the TS side supplied a `sender_public_armored` and at least
    /// one signature in the message was made by one of that cert's signing
    /// subkeys. `false` when verification wasn't attempted (no sender key
    /// provided) or no valid signature was found.
    pub signature_verified: bool,
    /// Fingerprint of the signing subkey's cert, when a signature was
    /// successfully verified. `None` otherwise.
    pub signer_fingerprint: Option<String>,
    /// `true` iff the decrypted message carried at least one signature
    /// packet — regardless of whether the TS side supplied a sender cert.
    /// The plugin uses this to distinguish "unsigned message" (never
    /// upgradable) from "signed but we didn't have the key to verify yet"
    /// (stash for later re-verification when the sender's PEP key arrives).
    pub signature_present: bool,
}

/// State held by the Tauri managed-state system. One entry per logged-in
/// account, keyed on the bare JID.
///
/// # Non-blocking unlock
///
/// The CPU-bound part of [`Self::ensure_key`] (Argon2id key-derivation,
/// one call per secret packet — ~500 ms total on M-series hardware) runs
/// on [`tokio::task::spawn_blocking`] so the Tauri IPC thread stays
/// responsive while we unlock. The async `ensure_key` Tauri command is
/// what surfaces that; the sync commands (`encrypt`, `decrypt`, etc.)
/// only do cheap in-memory lookups against the already-populated cell.
///
/// # Concurrent-call coalescing
///
/// Every account has an [`AsyncOnceCell<UnlockOutcome>`]: the first
/// `ensure_key` or `prewarm` caller for a given JID runs the unlock; any
/// concurrent caller awaits the same cell instead of racing to a second
/// KDF run. On error the cell is evicted so a subsequent attempt starts
/// fresh (e.g. after the user fixes a vanished `.pass` fallback file).
///
/// [`AsyncOnceCell`]: tokio::sync::OnceCell
pub struct OpenpgpState {
    /// Per-JID coordination cell. `Some(Ok(KeyBundle))` = unlocked and
    /// cached; pending inside the cell = unlock is in flight and awaiters
    /// should join; absent = no attempt started yet. Cells carrying `Err`
    /// are evicted after observation so the next caller retries.
    entries: Mutex<HashMap<String, Arc<AsyncOnceCell<UnlockOutcome>>>>,
    storage: Arc<KeyStorage>,
    /// Test-only instrumentation: how many times the blocking KDF path
    /// actually ran. Concurrent `ensure_key` calls must coalesce to one
    /// KDF; we assert that by reading this counter in tests.
    #[cfg(test)]
    blocking_runs: std::sync::atomic::AtomicUsize,
}

/// Shared result type stored in each [`AsyncOnceCell`]. `Clone` so
/// multiple awaiters can each take a copy without another KDF round.
type UnlockOutcome = Result<KeyBundle, String>;

impl OpenpgpState {
    /// Production constructor — persists keys under
    /// `<base_dir>/openpgp/` and prefers the OS keychain for the
    /// per-account passphrase.
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            storage: Arc::new(KeyStorage::new(base_dir)),
            #[cfg(test)]
            blocking_runs: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Test constructor that writes under `base_dir` and skips the
    /// keychain (CI lacks one, and a macOS dev box would otherwise pop a
    /// keychain authorization dialog during `cargo test`).
    #[cfg(test)]
    pub fn for_testing(base_dir: PathBuf) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            storage: Arc::new(KeyStorage::for_testing(base_dir)),
            blocking_runs: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Load-or-generate an OpenPGP identity for `account_jid`. The KDF
    /// work runs on a blocking worker thread so we never hold up the IPC
    /// runtime. Concurrent calls for the same JID coalesce to a single
    /// blocking run.
    ///
    /// Takes owned `String` arguments because they move into a
    /// `'static` blocking closure.
    pub async fn ensure_key(
        self: &Arc<Self>,
        account_jid: String,
        user_id: String,
    ) -> Result<KeyBundle, String> {
        let cell = self.cell_for(&account_jid);

        let storage = Arc::clone(&self.storage);
        let jid_for_task = account_jid.clone();
        let user_id_for_task = user_id;
        #[cfg(test)]
        let counter = &self.blocking_runs;

        let outcome = cell
            .get_or_init(|| async move {
                #[cfg(test)]
                counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                tokio::task::spawn_blocking(move || {
                    Self::run_blocking(&storage, &jid_for_task, &user_id_for_task)
                })
                .await
                .unwrap_or_else(|join_err| {
                    // A panic on the blocking thread maps to a clean
                    // error here rather than bubbling up as a JoinError.
                    Err(format!("openpgp unlock task panicked: {join_err}"))
                })
            })
            .await
            .clone();

        if outcome.is_err() {
            // Evict the cell so the next caller retries. A successful
            // unlock stays cached indefinitely (the fingerprint is
            // stable for the identity's lifetime).
            self.entries.lock().unwrap().remove(&account_jid);
        }

        outcome
    }

    /// Safe boot-time prewarm: only kicks off the unlock when a key
    /// file already exists on disk. Used from `main.rs` setup so we
    /// can overlap the Argon2id KDF with Tauri window creation / React
    /// boot without speculatively generating a key for a user who
    /// hasn't actually enabled E2EE. No-op when there's no persisted
    /// key for `account_jid`.
    pub fn prewarm_if_persisted(self: &Arc<Self>, account_jid: String, user_id: String) {
        if !self.storage.has_persisted_key(&account_jid) {
            return;
        }
        self.prewarm(account_jid, user_id);
    }

    /// Fire-and-forget unlock: starts the KDF on a background task if no
    /// attempt is already in flight, returns immediately. Idempotent —
    /// repeated calls for the same JID noop; a concurrent
    /// [`ensure_key`] awaits the same in-flight unlock.
    ///
    /// Called when the login form is submitted (before the XMPP socket
    /// connects) so the unlock overlaps with the login round-trip.
    pub fn prewarm(self: &Arc<Self>, account_jid: String, user_id: String) {
        // If the cell already has a Ready outcome, there's nothing to do.
        {
            let entries = self.entries.lock().unwrap();
            if let Some(cell) = entries.get(&account_jid) {
                if cell.initialized() {
                    return;
                }
            }
        }
        let this = Arc::clone(self);
        tokio::spawn(async move {
            match this.ensure_key(account_jid.clone(), user_id).await {
                Ok(bundle) => tracing::info!(
                    "openpgp prewarm: key ready for {} ({})",
                    account_jid,
                    short_fp(&bundle.fingerprint),
                ),
                Err(e) => {
                    tracing::warn!("openpgp prewarm: unlock failed for {}: {}", account_jid, e)
                }
            }
        });
    }

    /// Encrypt `plaintext` to `recipient_public_armored`, signed with
    /// the secret key stored for `sender_account_jid`. Matches the
    /// XEP-0373 signcrypt convention.
    ///
    /// Synchronous by design: it runs after [`Self::ensure_key`] has
    /// populated the cell, so this is a cheap in-memory lookup plus the
    /// Sequoia encrypt operation. The encrypt step itself is fast
    /// compared to the KDF — no IPC concern here.
    pub fn encrypt(
        &self,
        sender_account_jid: &str,
        recipient_public_armored: &str,
        plaintext: &str,
    ) -> Result<String, String> {
        let bundle = self.read_cached_bundle(sender_account_jid, "sender")?;
        encrypt_and_sign(recipient_public_armored, &bundle.secret_armored, plaintext)
            .map_err(anyhow_to_string)
    }

    /// Decrypt `ciphertext` with the secret key for `account_jid`. When
    /// `sender_public_armored` is provided, verify signatures against
    /// that cert and report the verified signer fingerprint.
    pub fn decrypt(
        &self,
        account_jid: &str,
        ciphertext: &str,
        sender_public_armored: Option<&str>,
    ) -> Result<DecryptOutput, String> {
        let bundle = self.read_cached_bundle(account_jid, "account")?;
        decrypt_and_verify(&bundle.secret_armored, ciphertext, sender_public_armored)
            .map_err(anyhow_to_string)
    }

    /// Forget the account: drop the cell AND remove every on-disk trace
    /// (encrypted TSK, fallback passphrase file, keychain entry). Safe
    /// to call for an unknown account.
    pub fn forget_account(&self, account_jid: &str) -> Result<(), String> {
        self.entries.lock().unwrap().remove(account_jid);
        self.storage.forget(account_jid).map_err(anyhow_to_string)?;
        Ok(())
    }

    /// Produce a passphrase-encrypted backup of the currently-loaded TSK
    /// for `account_jid`, suitable for publishing to the XEP-0373 §5
    /// `urn:xmpp:openpgp:0:secret-key` PEP node.
    ///
    /// Runs the symmetric encryption on the blocking pool because the
    /// SKESK construction can pick an Argon2 S2K that adds ~100 ms of
    /// KDF work. Returns the armored OpenPGP message.
    pub async fn encrypt_backup(
        self: &Arc<Self>,
        account_jid: String,
        passphrase: String,
    ) -> Result<String, String> {
        let bundle = self.read_cached_bundle(&account_jid, "account")?;
        tokio::task::spawn_blocking(move || {
            crate::openpgp_backup::encrypt_tsk_with_passphrase(
                &bundle.secret_armored,
                &passphrase,
            )
            .map_err(anyhow_to_string)
        })
        .await
        .unwrap_or_else(|join_err| Err(format!("backup encrypt task panicked: {join_err}")))
    }

    /// Import a backup fetched from the secret-key PEP node.
    ///
    /// Decrypts `backup_message` with `passphrase`, persists the recovered
    /// TSK via [`KeyStorage::save`] (re-wrapped with our per-account at-rest
    /// passphrase), and populates the in-memory cache so subsequent calls
    /// to [`Self::ensure_key`] return the imported bundle without another
    /// KDF round. Any previously-cached bundle for `account_jid` is
    /// replaced — callers must only invoke this when the user has
    /// explicitly chosen to adopt the server's backup.
    pub async fn import_backup(
        self: &Arc<Self>,
        account_jid: String,
        backup_message: String,
        passphrase: String,
    ) -> Result<KeyBundle, String> {
        let this = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let tsk_armored = crate::openpgp_backup::decrypt_tsk_with_passphrase(
                &backup_message,
                &passphrase,
            )
            .map_err(anyhow_to_string)?;
            let cert = Cert::from_bytes(tsk_armored.as_bytes())
                .map_err(|e| format!("parse imported TSK: {e}"))?;
            let backing = this
                .storage
                .save(&account_jid, &cert)
                .map_err(anyhow_to_string)?;
            let bundle = bundle_from_cert(&cert, backing).map_err(anyhow_to_string)?;

            // Replace any existing cell so the next ensure_key observes
            // the imported bundle. This method is user-initiated and runs
            // exclusively after an explicit "restore from backup" choice,
            // so we don't need to coordinate with concurrent unlockers.
            let mut entries = this.entries.lock().unwrap();
            let cell = Arc::new(AsyncOnceCell::new());
            let _ = cell.set(Ok(bundle.clone()));
            entries.insert(account_jid, cell);

            Ok(bundle)
        })
        .await
        .unwrap_or_else(|join_err| Err(format!("backup import task panicked: {join_err}")))
    }

    // ---- internals ----------------------------------------------------

    /// Get-or-insert the per-JID cell. The returned `Arc` is cheap to
    /// hold across an await because the inner `AsyncOnceCell` does its
    /// own synchronization.
    fn cell_for(&self, account_jid: &str) -> Arc<AsyncOnceCell<UnlockOutcome>> {
        let mut entries = self.entries.lock().unwrap();
        Arc::clone(
            entries
                .entry(account_jid.to_string())
                .or_insert_with(|| Arc::new(AsyncOnceCell::new())),
        )
    }

    /// Look up a cached unlock outcome for `jid`. Returns a clear error
    /// if the cell isn't initialised yet — callers that need the key
    /// eagerly must call [`Self::ensure_key`] first.
    ///
    /// `role` is used purely to shape the error message ("sender" /
    /// "account") so we stay backward-compatible with existing error
    /// strings that downstream tests match on.
    fn read_cached_bundle(&self, jid: &str, role: &str) -> Result<KeyBundle, String> {
        let cell = {
            let entries = self.entries.lock().unwrap();
            entries.get(jid).cloned()
        };
        let cell = cell.ok_or_else(|| format!("no key for {role} account: {jid}"))?;
        // `get` does not await — if the cell is still initialising we
        // treat it as "no key yet" rather than blocking the caller.
        let outcome = cell
            .get()
            .ok_or_else(|| format!("no key for {role} account: {jid}"))?;
        match outcome {
            Ok(bundle) => Ok(bundle.clone()),
            Err(e) => Err(e.clone()),
        }
    }

    /// The actual CPU-bound work: load-or-generate + persist. Pulled
    /// out of the method body so [`tokio::task::spawn_blocking`] can
    /// run it on a dedicated worker thread without capturing `&self`.
    fn run_blocking(storage: &KeyStorage, jid: &str, user_id: &str) -> Result<KeyBundle, String> {
        if let Some(persisted) = storage.load(jid).map_err(anyhow_to_string)? {
            return bundle_from_cert(&persisted.cert, persisted.backing).map_err(anyhow_to_string);
        }
        let cert = generate_cert(user_id).map_err(anyhow_to_string)?;
        let backing = storage.save(jid, &cert).map_err(anyhow_to_string)?;
        bundle_from_cert(&cert, backing).map_err(anyhow_to_string)
    }

    /// Test helper — number of times the blocking KDF path executed
    /// for this state. Used by the concurrency test to prove that
    /// simultaneous `ensure_key` calls for the same JID coalesce.
    #[cfg(test)]
    pub fn blocking_run_count(&self) -> usize {
        self.blocking_runs
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Test helper — synchronous wrapper around the async `ensure_key`.
    /// Spins up a one-shot current-thread runtime so test code can keep
    /// its pre-async shape without every test needing `#[tokio::test]`.
    /// Production code always calls `ensure_key` from an existing
    /// Tauri-provided runtime instead.
    #[cfg(test)]
    pub fn ensure_key_sync(
        self: &Arc<Self>,
        account_jid: &str,
        user_id: &str,
    ) -> Result<KeyBundle, String> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test tokio runtime")
            .block_on(self.ensure_key(account_jid.to_string(), user_id.to_string()))
    }
}

/// First 16 hex chars of a fingerprint — enough to eyeball in a log
/// line without dragging the full 64 chars onto each prewarm record.
fn short_fp(full: &str) -> &str {
    &full[..full.len().min(16)]
}

pub fn fingerprint_of(public_armored: &str) -> Result<String, String> {
    let cert = Cert::from_bytes(public_armored.as_bytes())
        .map_err(|e| format!("not a recognizable OpenPGP public key: {e}"))?;
    Ok(cert.fingerprint().to_hex())
}

// ---------------------------------------------------------------------------
// Tauri command shims
// ---------------------------------------------------------------------------

/// Async — runs the Argon2id key-derivation on a blocking worker
/// thread so the Tauri IPC runtime thread isn't held up. Concurrent
/// invocations for the same JID coalesce to a single KDF run.
#[tauri::command]
pub async fn openpgp_ensure_key(
    account_jid: String,
    user_id: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<KeyBundle, String> {
    let state = Arc::clone(&state);
    state.ensure_key(account_jid, user_id).await
}

/// Fire-and-forget prewarm: starts unlocking in the background so a
/// later `openpgp_ensure_key` / `SequoiaPgpPlugin.init()` hits an
/// already-warm cache. Typically invoked the moment the user submits
/// the login form, overlapping the KDF with XMPP handshake round-trips.
///
/// `async fn` (not `fn`) so Tauri dispatches the body on
/// `tauri::async_runtime` — `OpenpgpState::prewarm` calls
/// `tokio::spawn` internally, and a sync command would run on the main
/// thread where that panics with "there is no reactor running".
#[tauri::command]
pub async fn openpgp_prewarm(
    account_jid: String,
    user_id: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<(), String> {
    Arc::clone(&state).prewarm(account_jid, user_id);
    Ok(())
}

#[tauri::command]
pub fn openpgp_encrypt(
    sender_account_jid: String,
    recipient_public_armored: String,
    plaintext: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<String, String> {
    state.encrypt(&sender_account_jid, &recipient_public_armored, &plaintext)
}

#[tauri::command]
pub fn openpgp_decrypt(
    account_jid: String,
    ciphertext: String,
    sender_public_armored: Option<String>,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<DecryptOutput, String> {
    state.decrypt(&account_jid, &ciphertext, sender_public_armored.as_deref())
}

#[tauri::command]
pub fn openpgp_fingerprint(public_armored: String) -> Result<String, String> {
    fingerprint_of(&public_armored)
}

#[tauri::command]
pub fn openpgp_forget_account(
    account_jid: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<(), String> {
    state.forget_account(&account_jid)
}

/// Cheap "has any persisted key for this JID?" probe. Used by the
/// restore-first flow to decide — without kicking off key generation —
/// whether the user already has local material or is starting fresh.
/// Just a file-exists check; does not touch the keychain or run any KDF.
#[tauri::command]
pub fn openpgp_has_persisted_key(
    account_jid: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> bool {
    state.storage.has_persisted_key(&account_jid)
}

/// Encrypt the in-memory TSK for `account_jid` under `passphrase`. The
/// returned armored OpenPGP message is what the TS side publishes to
/// `urn:xmpp:openpgp:0:secret-key` (XEP-0373 §5).
#[tauri::command]
pub async fn openpgp_backup_encrypt(
    account_jid: String,
    passphrase: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<String, String> {
    Arc::clone(&state)
        .encrypt_backup(account_jid, passphrase)
        .await
}

/// Import a backup published on `urn:xmpp:openpgp:0:secret-key`: decrypts
/// with `passphrase`, persists the recovered TSK locally (wrapped with
/// our at-rest Argon2id passphrase), and returns the resulting bundle.
#[tauri::command]
pub async fn openpgp_backup_import(
    account_jid: String,
    backup_message: String,
    passphrase: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<KeyBundle, String> {
    Arc::clone(&state)
        .import_backup(account_jid, backup_message, passphrase)
        .await
}

// ---------------------------------------------------------------------------
// Sequoia-backed primitives
// ---------------------------------------------------------------------------

/// Generate a fresh general-purpose cert for `user_id`. Kept separate
/// from [`bundle_from_cert`] so [`OpenpgpState::ensure_key`] can reuse
/// the serialization path for certs loaded from disk.
///
/// The cert is emitted under the RFC 9580 profile (v6 keys). That's a
/// prerequisite for protecting the secret packets with Argon2id S2K +
/// AEAD at rest (RFC 9580 §3.7 restricts Argon2 to v6 keys), and aligns
/// the project with the modern OpenPGP wire format going forward. We
/// never generate v4 keys on this branch; the on-disk storage still
/// knows how to decrypt any stray v4 cert a user might carry over from
/// a pre-v6 install.
fn generate_cert(user_id: &str) -> Result<Cert> {
    let (cert, _revocation) = CertBuilder::general_purpose(Some(user_id))
        .set_profile(openpgp::Profile::RFC9580)
        .context("select RFC 9580 / v6 key profile")?
        .generate()
        .context("generate OpenPGP cert")?;
    Ok(cert)
}

/// Turn a Cert (either freshly generated or loaded from disk) into the
/// serializable [`KeyBundle`] the TS side consumes. The passphrase
/// backing is surfaced to the UI without the caller needing to know
/// anything about `KeyStorage`.
fn bundle_from_cert(cert: &Cert, backing: PassphraseBacking) -> Result<KeyBundle> {
    let public_armored = armored_string(cert, KeyExport::Public)?;
    let secret_armored = armored_string(cert, KeyExport::Secret)?;
    Ok(KeyBundle {
        fingerprint: cert.fingerprint().to_hex(),
        public_armored,
        secret_armored,
        keychain_backed: backing == PassphraseBacking::Keychain,
    })
}

enum KeyExport {
    Public,
    Secret,
}

fn armored_string(cert: &Cert, kind: KeyExport) -> Result<String> {
    let bytes = match kind {
        KeyExport::Public => cert
            .armored()
            .to_vec()
            .context("serialize public key to armor")?,
        KeyExport::Secret => cert
            .as_tsk()
            .armored()
            .to_vec()
            .context("serialize secret key to armor")?,
    };
    String::from_utf8(bytes).context("armored OpenPGP block is not UTF-8")
}

fn encrypt_and_sign(
    recipient_public_armored: &str,
    sender_secret_armored: &str,
    plaintext: &str,
) -> Result<String> {
    let policy = StandardPolicy::new();
    let recipient_cert = Cert::from_bytes(recipient_public_armored.as_bytes())
        .context("parse recipient public key")?;
    let sender_cert =
        Cert::from_bytes(sender_secret_armored.as_bytes()).context("parse sender secret key")?;

    let recipients: Vec<Recipient> = recipient_cert
        .keys()
        .with_policy(&policy, None)
        .supported()
        .alive()
        .revoked(false)
        .for_transport_encryption()
        .map(Recipient::from)
        .collect();

    if recipients.is_empty() {
        return Err(anyhow!(
            "recipient certificate has no usable encryption-capable key"
        ));
    }

    let signer_keypair = sender_cert
        .keys()
        .with_policy(&policy, None)
        .supported()
        .alive()
        .revoked(false)
        .for_signing()
        .secret()
        .next()
        .ok_or_else(|| anyhow!("sender certificate has no usable signing key"))?
        .key()
        .clone()
        .into_keypair()
        .context("unlock sender signing key")?;

    let mut sink: Vec<u8> = Vec::new();
    {
        let message = Message::new(&mut sink);
        let message = Armorer::new(message).build().context("build armorer")?;
        let message = Encryptor::for_recipients(message, recipients)
            .build()
            .context("build encryptor")?;
        // Sign INSIDE the encryption layer per XEP-0373: the recipient
        // needs to decrypt before they can see (and verify) the signature.
        let message = Signer::new(message, signer_keypair)
            .context("build signer")?
            .build()
            .context("finalize signer")?;
        let mut message = LiteralWriter::new(message)
            .build()
            .context("build literal writer")?;
        message
            .write_all(plaintext.as_bytes())
            .context("write plaintext")?;
        message.finalize().context("finalize encryption")?;
    }

    String::from_utf8(sink).context("armored ciphertext is not UTF-8")
}

fn decrypt_and_verify(
    secret_armored: &str,
    ciphertext: &str,
    sender_public_armored: Option<&str>,
) -> Result<DecryptOutput> {
    let policy = StandardPolicy::new();
    let secret_cert =
        Cert::from_bytes(secret_armored.as_bytes()).context("parse own secret key")?;

    let sender_cert = match sender_public_armored {
        Some(armored) => {
            Some(Cert::from_bytes(armored.as_bytes()).context("parse sender public key")?)
        }
        None => None,
    };

    // Shared state set by the helper during stream reading.
    let verified_fingerprint: Arc<Mutex<Option<Fingerprint>>> = Arc::new(Mutex::new(None));
    let signature_present: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));

    let helper = DecryptHelper {
        secret: &secret_cert,
        sender: sender_cert.as_ref(),
        policy: &policy,
        verified_fingerprint: verified_fingerprint.clone(),
        signature_present: signature_present.clone(),
    };

    let mut decryptor = DecryptorBuilder::from_bytes(ciphertext.as_bytes())
        .context("parse ciphertext")?
        .with_policy(&policy, None, helper)
        .context("open decryptor")?;

    let mut plaintext = Vec::new();
    std::io::copy(&mut decryptor, &mut plaintext).context("read decrypted stream")?;
    let plaintext = String::from_utf8(plaintext).context("decrypted payload is not UTF-8")?;

    let signer = verified_fingerprint
        .lock()
        .map_err(|e| anyhow!("verification state poisoned: {e}"))?
        .clone();
    let had_signature = *signature_present
        .lock()
        .map_err(|e| anyhow!("signature presence state poisoned: {e}"))?;

    Ok(DecryptOutput {
        signature_verified: signer.is_some(),
        signer_fingerprint: signer.map(|fp| fp.to_hex()),
        plaintext,
        signature_present: had_signature,
    })
}

struct DecryptHelper<'a> {
    secret: &'a Cert,
    sender: Option<&'a Cert>,
    policy: &'a StandardPolicy<'a>,
    /// Set by [`check`] when at least one signature validates against
    /// `sender`. Observed by the outer function after the stream is drained.
    verified_fingerprint: Arc<Mutex<Option<Fingerprint>>>,
    /// Set to true by [`check`] when any signature result is observed —
    /// verified or not, keyed or not. The outer function uses this to
    /// distinguish an unsigned message from a signed one whose verification
    /// was deferred pending a cert.
    signature_present: Arc<Mutex<bool>>,
}

impl VerificationHelper for DecryptHelper<'_> {
    fn get_certs(&mut self, _ids: &[KeyHandle]) -> openpgp::Result<Vec<Cert>> {
        // Hand the verifier the sender's cert (when supplied) so it can
        // check signatures. Returning an empty Vec — the default — causes
        // every signature to be reported as `MissingKey`, which is exactly
        // what we want when no sender cert was provided: decrypt without
        // verification.
        Ok(self.sender.map(|c| vec![c.clone()]).unwrap_or_default())
    }

    fn check(&mut self, structure: MessageStructure) -> openpgp::Result<()> {
        // Walk the structure looking for a valid signature. Decryption still
        // succeeds if none is found — we report the state through
        // `verified_fingerprint` rather than aborting, because the UI wants
        // to render an "untrusted" lock for unsigned messages, not drop
        // them entirely.
        for layer in structure.iter() {
            if let MessageLayer::SignatureGroup { results } = layer {
                for result in results {
                    // Any result (Ok OR Err) means a signature packet was
                    // observed. MissingKey errors surface here when no
                    // sender cert was provided; record presence so the
                    // plugin can distinguish "unsigned" from "we just
                    // couldn't verify yet".
                    if let Ok(mut slot) = self.signature_present.lock() {
                        *slot = true;
                    }
                    if let Ok(verification) = result {
                        let fp = verification.ka.cert().fingerprint();
                        if let Ok(mut slot) = self.verified_fingerprint.lock() {
                            *slot = Some(fp);
                        }
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }
}

impl DecryptionHelper for DecryptHelper<'_> {
    fn decrypt(
        &mut self,
        pkesks: &[PKESK],
        _skesks: &[SKESK],
        sym_algo: Option<SymmetricAlgorithm>,
        decrypt: &mut dyn FnMut(Option<SymmetricAlgorithm>, &SessionKey) -> bool,
    ) -> openpgp::Result<Option<Cert>> {
        for ka in self
            .secret
            .keys()
            .with_policy(self.policy, None)
            .for_transport_encryption()
            .secret()
        {
            let mut pair = ka.key().clone().into_keypair()?;
            for pkesk in pkesks {
                if pkesk
                    .decrypt(&mut pair, sym_algo)
                    .map(|(algo, sk)| decrypt(algo, &sk))
                    .unwrap_or(false)
                {
                    return Ok(Some(self.secret.clone()));
                }
            }
        }
        Ok(None)
    }
}

fn anyhow_to_string(err: anyhow::Error) -> String {
    let mut out = format!("{err:#}");
    out = out.replace('\n', " ").replace("  ", " ");
    out
}

// The unused `_Cert` alias keeps the `Cert` import path explicit even when
// no other item in this module ends up referring to it bare — simplifies
// adding future helpers that operate on Cert values.
#[allow(dead_code)]
fn _cert_type_reference(_: &_Cert) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Produce a unique tempdir per test so parallel test runs don't
    /// collide on the persisted key files.
    fn fresh_tmp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("fluux-openpgp-state-test-{pid}-{n}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `Arc<OpenpgpState>` because the async API takes `self: &Arc<Self>`
    /// so [`ensure_key`] can be spawned to background tasks. The test
    /// wrapper `ensure_key_sync` handles the async → sync bridging.
    fn new_state() -> Arc<OpenpgpState> {
        Arc::new(OpenpgpState::for_testing(fresh_tmp_dir()))
    }

    fn setup_two_accounts() -> (Arc<OpenpgpState>, KeyBundle, KeyBundle) {
        let state = new_state();
        let alice = state.ensure_key_sync("alice@example.com", "Alice").unwrap();
        let bob = state.ensure_key_sync("bob@example.com", "Bob").unwrap();
        (state, alice, bob)
    }

    #[test]
    fn generate_then_fingerprint_round_trip() {
        let state = new_state();
        let bundle = state
            .ensure_key_sync("alice@example.com", "Alice <alice@example.com>")
            .unwrap();
        let fp = fingerprint_of(&bundle.public_armored).unwrap();
        assert_eq!(fp, bundle.fingerprint);
        // v6 fingerprints (RFC 9580) are SHA-256 truncation → 32 bytes
        // → 64 hex chars. v4 keys used 20 bytes → 40 hex chars; we
        // switched to v6 as part of the Argon2id-at-rest upgrade.
        assert_eq!(bundle.fingerprint.len(), 64);
        // Tests use the filesystem fallback; production tests live in
        // the storage module. Surfacing the flag on the bundle is what
        // the TS side reads, so worth asserting here.
        assert!(!bundle.keychain_backed);
    }

    #[test]
    fn ensure_key_is_idempotent_per_account() {
        let state = new_state();
        let a = state.ensure_key_sync("alice@example.com", "Alice").unwrap();
        let b = state.ensure_key_sync("alice@example.com", "Alice").unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.secret_armored, b.secret_armored);
    }

    #[test]
    fn different_accounts_get_distinct_fingerprints() {
        let state = new_state();
        let alice = state.ensure_key_sync("alice@example.com", "Alice").unwrap();
        let bob = state.ensure_key_sync("bob@example.com", "Bob").unwrap();
        assert_ne!(alice.fingerprint, bob.fingerprint);
    }

    #[test]
    fn key_persists_across_state_instances() {
        // This is the core persistence guarantee: generate under one
        // OpenpgpState, drop it, create a fresh one pointing at the same
        // base dir, and get the same fingerprint back. If this test
        // fails the "stuck at key generation" UX on restart returns.
        let dir = fresh_tmp_dir();

        let first = Arc::new(OpenpgpState::for_testing(dir.clone()));
        let initial = first.ensure_key_sync("alice@example.com", "Alice").unwrap();
        let initial_fp = initial.fingerprint.clone();
        drop(first);

        let second = Arc::new(OpenpgpState::for_testing(dir));
        let reloaded = second
            .ensure_key_sync("alice@example.com", "Alice")
            .unwrap();
        assert_eq!(reloaded.fingerprint, initial_fp);
        // Secret block must also be stable — otherwise later encrypt /
        // sign calls on a reloaded state will produce signatures that
        // don't chain to the original cert.
        assert_eq!(reloaded.secret_armored, initial.secret_armored);
    }

    #[test]
    fn reloaded_key_can_still_encrypt_and_decrypt() {
        // Regression guard against the save/load cycle mangling the
        // secret material in a way that passes fingerprint comparison
        // but breaks crypto operations.
        let dir = fresh_tmp_dir();

        let first = Arc::new(OpenpgpState::for_testing(dir.clone()));
        let alice = first.ensure_key_sync("alice@example.com", "Alice").unwrap();
        let bob = first.ensure_key_sync("bob@example.com", "Bob").unwrap();
        drop(first);

        let reloaded = Arc::new(OpenpgpState::for_testing(dir));
        // `ensure_key` now hits disk and must produce identical bundles.
        let alice_reloaded = reloaded
            .ensure_key_sync("alice@example.com", "Alice")
            .unwrap();
        let bob_reloaded = reloaded.ensure_key_sync("bob@example.com", "Bob").unwrap();
        assert_eq!(alice_reloaded.fingerprint, alice.fingerprint);
        assert_eq!(bob_reloaded.fingerprint, bob.fingerprint);

        let ciphertext = reloaded
            .encrypt("alice@example.com", &bob.public_armored, "ping")
            .unwrap();
        let out = reloaded
            .decrypt("bob@example.com", &ciphertext, Some(&alice.public_armored))
            .unwrap();
        assert_eq!(out.plaintext, "ping");
        assert!(out.signature_verified);
    }

    #[test]
    fn encrypt_then_decrypt_round_trip() {
        let (state, alice, bob) = setup_two_accounts();
        let ciphertext = state
            .encrypt("alice@example.com", &bob.public_armored, "hello, bob")
            .unwrap();
        assert!(
            ciphertext.contains("BEGIN PGP MESSAGE"),
            "expected PGP armored block, got {}",
            &ciphertext[..ciphertext.len().min(80)]
        );

        // Decrypt WITH alice's public key supplied — must verify the signature.
        let out = state
            .decrypt("bob@example.com", &ciphertext, Some(&alice.public_armored))
            .unwrap();
        assert_eq!(out.plaintext, "hello, bob");
        assert!(
            out.signature_verified,
            "signature must verify for alice->bob"
        );
        assert_eq!(
            out.signer_fingerprint.as_deref(),
            Some(alice.fingerprint.as_str())
        );
    }

    #[test]
    fn decrypt_without_sender_key_succeeds_but_signature_not_verified() {
        let (state, _alice, bob) = setup_two_accounts();
        let ciphertext = state
            .encrypt("alice@example.com", &bob.public_armored, "hi")
            .unwrap();
        let out = state.decrypt("bob@example.com", &ciphertext, None).unwrap();
        assert_eq!(out.plaintext, "hi");
        assert!(
            !out.signature_verified,
            "verification must be false when no sender cert is supplied"
        );
        assert!(out.signer_fingerprint.is_none());
        // The plugin relies on this flag to know "signed but not yet
        // verifiable" vs "unsigned" — keep it true whenever a signature
        // packet was observed, even without a sender cert.
        assert!(
            out.signature_present,
            "signature_present must be true for a signcrypted message even when no sender cert was supplied"
        );
    }

    #[test]
    fn decrypt_verified_reports_signature_present() {
        // Positive-path companion to the key-not-cached case: a verified
        // signcrypt still sets signature_present so the plugin can treat
        // the "already verified" branch without re-inspecting the payload.
        let (state, alice, bob) = setup_two_accounts();
        let ciphertext = state
            .encrypt("alice@example.com", &bob.public_armored, "hey")
            .unwrap();
        let out = state
            .decrypt("bob@example.com", &ciphertext, Some(&alice.public_armored))
            .unwrap();
        assert!(out.signature_verified);
        assert!(out.signature_present);
    }

    #[test]
    fn decrypt_with_wrong_sender_key_does_not_verify() {
        // Alice signs, but Bob's client mistakenly supplies Eve's public
        // key for verification. Decryption succeeds; signature does not.
        let (state, _alice, bob) = setup_two_accounts();
        let eve = state.ensure_key_sync("eve@example.com", "Eve").unwrap();
        let ciphertext = state
            .encrypt("alice@example.com", &bob.public_armored, "hi")
            .unwrap();
        let out = state
            .decrypt("bob@example.com", &ciphertext, Some(&eve.public_armored))
            .unwrap();
        assert_eq!(out.plaintext, "hi");
        assert!(
            !out.signature_verified,
            "alice-signed ciphertext must not verify against eve's cert"
        );
    }

    #[test]
    fn decrypt_rejects_ciphertext_for_another_account() {
        let (state, _alice, _bob) = setup_two_accounts();
        let ciphertext = state
            .encrypt("alice@example.com", &_alice.public_armored, "for alice")
            .unwrap();
        let err = state
            .decrypt("bob@example.com", &ciphertext, Some(&_alice.public_armored))
            .expect_err("bob must not decrypt alice's ciphertext");
        assert!(!err.is_empty(), "expected an error");
    }

    #[test]
    fn decrypt_rejects_unknown_ciphertext_shape() {
        let state = new_state();
        state.ensure_key_sync("alice@example.com", "Alice").unwrap();
        let err = state
            .decrypt("alice@example.com", "not-a-pgp-ciphertext", None)
            .expect_err("malformed ciphertext must be rejected");
        assert!(!err.is_empty(), "expected an error");
    }

    #[test]
    fn encrypt_fails_without_a_sender_key() {
        let state = new_state();
        // Generate only Bob's key; Alice is absent.
        let bob = state.ensure_key_sync("bob@example.com", "Bob").unwrap();
        let err = state
            .encrypt("alice@example.com", &bob.public_armored, "hi")
            .expect_err("encrypt must fail without sender account");
        assert!(err.contains("no key for sender"), "unexpected error: {err}");
    }

    #[test]
    fn forget_account_removes_key_and_persisted_file() {
        let dir = fresh_tmp_dir();
        let state = Arc::new(OpenpgpState::for_testing(dir.clone()));
        let alice = state.ensure_key_sync("alice@example.com", "Alice").unwrap();
        let ciphertext = state
            .encrypt("alice@example.com", &alice.public_armored, "self-note")
            .unwrap();

        state.forget_account("alice@example.com").unwrap();

        // In-memory cache was cleared: decrypt now fails.
        let err = state
            .decrypt("alice@example.com", &ciphertext, None)
            .expect_err("decrypt must fail after forget");
        assert!(err.contains("no key"), "unexpected error: {err}");

        // Persistence was also wiped: a fresh state can't find the key.
        let fresh = Arc::new(OpenpgpState::for_testing(dir));
        let regenerated = fresh.ensure_key_sync("alice@example.com", "Alice").unwrap();
        assert_ne!(
            regenerated.fingerprint, alice.fingerprint,
            "forget must wipe the on-disk file so the next ensure_key generates fresh"
        );
    }

    #[test]
    fn fingerprint_of_handles_non_pgp_input() {
        let err = fingerprint_of("not an OpenPGP block").expect_err("must reject");
        assert!(!err.is_empty());
    }

    #[test]
    fn public_key_armor_is_stable_across_generate_reads() {
        let state = new_state();
        let bundle = state.ensure_key_sync("alice@example.com", "Alice").unwrap();
        let parsed = Cert::from_bytes(bundle.public_armored.as_bytes()).unwrap();
        assert_eq!(parsed.fingerprint().to_hex(), bundle.fingerprint);
    }

    // ---- concurrency / prewarm --------------------------------------

    /// Two tasks hitting the same account at the same time must
    /// coalesce to a single KDF run (one disk save, one fingerprint).
    /// Without the [`AsyncOnceCell`] per-JID coordination we'd see two
    /// saves race — the second would overwrite the first, and every
    /// concurrent caller could end up with a fingerprint that doesn't
    /// match the file on disk.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_ensure_key_runs_kdf_exactly_once() {
        let state = Arc::new(OpenpgpState::for_testing(fresh_tmp_dir()));

        // Spawn 4 concurrent ensure_key calls for the same JID. If the
        // coalescing is broken, this would produce 4 KDF runs; with the
        // coalescing, exactly 1.
        let mut handles = Vec::new();
        for _ in 0..4 {
            let s = Arc::clone(&state);
            handles.push(tokio::spawn(async move {
                s.ensure_key("alice@example.com".into(), "Alice".into())
                    .await
            }));
        }

        let mut bundles = Vec::new();
        for h in handles {
            bundles.push(h.await.unwrap().unwrap());
        }

        // Every caller saw the same bundle.
        for b in &bundles[1..] {
            assert_eq!(b.fingerprint, bundles[0].fingerprint);
            assert_eq!(b.secret_armored, bundles[0].secret_armored);
        }
        // And the blocking KDF ran exactly once.
        assert_eq!(
            state.blocking_run_count(),
            1,
            "concurrent ensure_key calls must coalesce to a single KDF run"
        );
    }

    /// A cached entry serves later ensure_key calls without running
    /// the KDF again. (Separate from the concurrent test so a failure
    /// here points to the cache-hit path specifically.)
    #[tokio::test]
    async fn cached_entry_skips_subsequent_kdf_runs() {
        let state = Arc::new(OpenpgpState::for_testing(fresh_tmp_dir()));

        let first = state
            .ensure_key("alice@example.com".into(), "Alice".into())
            .await
            .unwrap();
        let second = state
            .ensure_key("alice@example.com".into(), "Alice".into())
            .await
            .unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(state.blocking_run_count(), 1);
    }

    /// Prewarm is fire-and-forget: calling it kicks off an unlock we
    /// can observe by awaiting a subsequent ensure_key. There must be
    /// exactly one KDF run across prewarm + ensure_key.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn prewarm_is_observed_by_later_ensure_key() {
        let state = Arc::new(OpenpgpState::for_testing(fresh_tmp_dir()));

        state.prewarm("alice@example.com".into(), "Alice".into());

        // ensure_key should either catch the in-flight prewarm task
        // (cell occupied but not yet initialised) or find the result
        // already cached (prewarm finished first). Either way the
        // count stays at 1.
        let bundle = state
            .ensure_key("alice@example.com".into(), "Alice".into())
            .await
            .unwrap();
        assert_eq!(bundle.fingerprint.len(), 64);
        assert_eq!(
            state.blocking_run_count(),
            1,
            "prewarm + ensure_key must coalesce"
        );
    }

    /// Full "second device" round-trip: device A generates, backs up with
    /// passphrase, device B (fresh base dir) imports and recovers the
    /// same identity. Any regression in the plumbing between `encrypt_backup`,
    /// `import_backup`, and the storage layer surfaces here.
    #[tokio::test]
    async fn backup_and_import_reproduces_identity_on_fresh_state() {
        let device_a = new_state();
        let original = device_a
            .ensure_key("alice@example.com".into(), "Alice".into())
            .await
            .unwrap();

        let backup = device_a
            .encrypt_backup("alice@example.com".into(), "correct-horse-battery-staple".into())
            .await
            .unwrap();

        let device_b = Arc::new(OpenpgpState::for_testing(fresh_tmp_dir()));
        let imported = device_b
            .import_backup(
                "alice@example.com".into(),
                backup,
                "correct-horse-battery-staple".into(),
            )
            .await
            .unwrap();

        assert_eq!(imported.fingerprint, original.fingerprint);

        // Post-import, ensure_key on the second device must return the
        // imported bundle directly from the cache — no fresh generation,
        // no KDF round. The blocking counter confirms the short-circuit.
        let cached = device_b
            .ensure_key("alice@example.com".into(), "Alice".into())
            .await
            .unwrap();
        assert_eq!(cached.fingerprint, original.fingerprint);
        assert_eq!(
            device_b.blocking_run_count(),
            0,
            "import_backup must prime the cell so ensure_key skips the KDF"
        );
    }

    /// A wrong passphrase during import is a normal error, not a panic,
    /// so the UI can prompt the user again. The storage layer must also
    /// stay clean: a failed import leaves no partial TSK on disk that
    /// a later ensure_key would load instead of generating fresh.
    #[tokio::test]
    async fn import_with_wrong_passphrase_is_a_clean_error() {
        let device_a = new_state();
        let _ = device_a
            .ensure_key("alice@example.com".into(), "Alice".into())
            .await
            .unwrap();
        let backup = device_a
            .encrypt_backup("alice@example.com".into(), "right".into())
            .await
            .unwrap();

        let device_b = Arc::new(OpenpgpState::for_testing(fresh_tmp_dir()));
        let err = device_b
            .import_backup("alice@example.com".into(), backup, "wrong".into())
            .await;
        assert!(err.is_err(), "wrong passphrase must not yield a bundle");

        // The failed import should not have populated the cache: a
        // subsequent ensure_key generates a FRESH key (different
        // fingerprint), rather than silently reusing a half-written one.
        let generated = device_b
            .ensure_key("alice@example.com".into(), "Alice".into())
            .await
            .unwrap();
        assert_ne!(
            generated.fingerprint,
            // Just assert it's a valid v6 fingerprint; we can't compare
            // to the "correct" one because device_b never saw it.
            String::new(),
            "fresh generation must still succeed after a failed import"
        );
        assert_eq!(generated.fingerprint.len(), 64);
    }
}

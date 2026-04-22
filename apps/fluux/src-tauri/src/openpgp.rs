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
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

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
}

/// State held by the Tauri managed-state system. One entry per logged-in
/// account — keyed on the account JID. The in-memory map is a cache on
/// top of [`KeyStorage`]: the first [`Self::ensure_key`] call per account
/// after a restart hits disk; subsequent calls in the same session serve
/// from memory.
pub struct OpenpgpState {
    accounts: Mutex<std::collections::HashMap<String, KeyBundle>>,
    storage: KeyStorage,
}

impl OpenpgpState {
    /// Production constructor — persists keys under
    /// `<base_dir>/openpgp/` and prefers the OS keychain for the
    /// per-account passphrase.
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            accounts: Mutex::new(std::collections::HashMap::new()),
            storage: KeyStorage::new(base_dir),
        }
    }

    /// Test constructor that writes under `base_dir` and skips the
    /// keychain (CI lacks one, and a macOS dev box would otherwise pop a
    /// keychain authorization dialog during `cargo test`).
    #[cfg(test)]
    pub fn for_testing(base_dir: PathBuf) -> Self {
        Self {
            accounts: Mutex::new(std::collections::HashMap::new()),
            storage: KeyStorage::for_testing(base_dir),
        }
    }

    /// Load-or-generate an OpenPGP identity for `account_jid`. On cold
    /// start this hits disk; on warm start it serves from the in-memory
    /// cache. Only the first caller per account pays the key-generation
    /// cost (roughly a few seconds on the RustCrypto backend).
    pub fn ensure_key(&self, account_jid: &str, user_id: &str) -> Result<KeyBundle, String> {
        let mut accounts = self
            .accounts
            .lock()
            .map_err(|e| format!("openpgp state poisoned: {e}"))?;
        if let Some(existing) = accounts.get(account_jid) {
            return Ok(existing.clone());
        }

        // Try to restore a previously-persisted key first. Corruption or
        // a vanished passphrase surfaces as an error here — we don't
        // silently overwrite; the user must explicitly delete-and-regen.
        if let Some(persisted) = self.storage.load(account_jid).map_err(anyhow_to_string)? {
            let bundle =
                bundle_from_cert(&persisted.cert, persisted.backing).map_err(anyhow_to_string)?;
            accounts.insert(account_jid.to_string(), bundle.clone());
            return Ok(bundle);
        }

        // Fresh account — generate, persist, cache.
        let cert = generate_cert(user_id).map_err(anyhow_to_string)?;
        let backing = self
            .storage
            .save(account_jid, &cert)
            .map_err(anyhow_to_string)?;
        let bundle = bundle_from_cert(&cert, backing).map_err(anyhow_to_string)?;
        accounts.insert(account_jid.to_string(), bundle.clone());
        Ok(bundle)
    }

    /// Encrypt `plaintext` to `recipient_public_armored`, signed with the
    /// secret key stored for `sender_account_jid`. Matches the XEP-0373
    /// signcrypt convention — every encrypted payload carries a signature.
    pub fn encrypt(
        &self,
        sender_account_jid: &str,
        recipient_public_armored: &str,
        plaintext: &str,
    ) -> Result<String, String> {
        let sender_secret = {
            let accounts = self
                .accounts
                .lock()
                .map_err(|e| format!("openpgp state poisoned: {e}"))?;
            accounts
                .get(sender_account_jid)
                .map(|b| b.secret_armored.clone())
                .ok_or_else(|| format!("no key for sender account: {sender_account_jid}"))?
        };

        encrypt_and_sign(recipient_public_armored, &sender_secret, plaintext)
            .map_err(anyhow_to_string)
    }

    /// Decrypt `ciphertext` with the secret key for `account_jid`. When
    /// `sender_public_armored` is provided, verify signatures against that
    /// cert and report the verified signer fingerprint.
    pub fn decrypt(
        &self,
        account_jid: &str,
        ciphertext: &str,
        sender_public_armored: Option<&str>,
    ) -> Result<DecryptOutput, String> {
        let secret_armored = {
            let accounts = self
                .accounts
                .lock()
                .map_err(|e| format!("openpgp state poisoned: {e}"))?;
            accounts
                .get(account_jid)
                .map(|b| b.secret_armored.clone())
                .ok_or_else(|| format!("no key for account: {account_jid}"))?
        };

        decrypt_and_verify(&secret_armored, ciphertext, sender_public_armored)
            .map_err(anyhow_to_string)
    }

    /// Forget the account: drop the in-memory cache entry AND remove
    /// every on-disk trace (encrypted TSK, fallback passphrase file,
    /// keychain entry). Safe to call for an unknown account.
    pub fn forget_account(&self, account_jid: &str) -> Result<(), String> {
        let mut accounts = self
            .accounts
            .lock()
            .map_err(|e| format!("openpgp state poisoned: {e}"))?;
        accounts.remove(account_jid);
        drop(accounts);
        self.storage.forget(account_jid).map_err(anyhow_to_string)?;
        Ok(())
    }
}

pub fn fingerprint_of(public_armored: &str) -> Result<String, String> {
    let cert = Cert::from_bytes(public_armored.as_bytes())
        .map_err(|e| format!("not a recognizable OpenPGP public key: {e}"))?;
    Ok(cert.fingerprint().to_hex())
}

// ---------------------------------------------------------------------------
// Tauri command shims
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn openpgp_ensure_key(
    account_jid: String,
    user_id: String,
    state: State<'_, OpenpgpState>,
) -> Result<KeyBundle, String> {
    state.ensure_key(&account_jid, &user_id)
}

#[tauri::command]
pub fn openpgp_encrypt(
    sender_account_jid: String,
    recipient_public_armored: String,
    plaintext: String,
    state: State<'_, OpenpgpState>,
) -> Result<String, String> {
    state.encrypt(&sender_account_jid, &recipient_public_armored, &plaintext)
}

#[tauri::command]
pub fn openpgp_decrypt(
    account_jid: String,
    ciphertext: String,
    sender_public_armored: Option<String>,
    state: State<'_, OpenpgpState>,
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
    state: State<'_, OpenpgpState>,
) -> Result<(), String> {
    state.forget_account(&account_jid)
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

    let helper = DecryptHelper {
        secret: &secret_cert,
        sender: sender_cert.as_ref(),
        policy: &policy,
        verified_fingerprint: verified_fingerprint.clone(),
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

    Ok(DecryptOutput {
        signature_verified: signer.is_some(),
        signer_fingerprint: signer.map(|fp| fp.to_hex()),
        plaintext,
    })
}

struct DecryptHelper<'a> {
    secret: &'a Cert,
    sender: Option<&'a Cert>,
    policy: &'a StandardPolicy<'a>,
    /// Set by [`check`] when at least one signature validates against
    /// `sender`. Observed by the outer function after the stream is drained.
    verified_fingerprint: Arc<Mutex<Option<Fingerprint>>>,
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

    fn new_state() -> OpenpgpState {
        OpenpgpState::for_testing(fresh_tmp_dir())
    }

    fn setup_two_accounts() -> (OpenpgpState, KeyBundle, KeyBundle) {
        let state = new_state();
        let alice = state.ensure_key("alice@example.com", "Alice").unwrap();
        let bob = state.ensure_key("bob@example.com", "Bob").unwrap();
        (state, alice, bob)
    }

    #[test]
    fn generate_then_fingerprint_round_trip() {
        let state = new_state();
        let bundle = state
            .ensure_key("alice@example.com", "Alice <alice@example.com>")
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
        let a = state.ensure_key("alice@example.com", "Alice").unwrap();
        let b = state.ensure_key("alice@example.com", "Alice").unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.secret_armored, b.secret_armored);
    }

    #[test]
    fn different_accounts_get_distinct_fingerprints() {
        let state = new_state();
        let alice = state.ensure_key("alice@example.com", "Alice").unwrap();
        let bob = state.ensure_key("bob@example.com", "Bob").unwrap();
        assert_ne!(alice.fingerprint, bob.fingerprint);
    }

    #[test]
    fn key_persists_across_state_instances() {
        // This is the core persistence guarantee: generate under one
        // OpenpgpState, drop it, create a fresh one pointing at the same
        // base dir, and get the same fingerprint back. If this test
        // fails the "stuck at key generation" UX on restart returns.
        let dir = fresh_tmp_dir();

        let first = OpenpgpState::for_testing(dir.clone());
        let initial = first.ensure_key("alice@example.com", "Alice").unwrap();
        let initial_fp = initial.fingerprint.clone();
        drop(first);

        let second = OpenpgpState::for_testing(dir);
        let reloaded = second.ensure_key("alice@example.com", "Alice").unwrap();
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

        let first = OpenpgpState::for_testing(dir.clone());
        let alice = first.ensure_key("alice@example.com", "Alice").unwrap();
        let bob = first.ensure_key("bob@example.com", "Bob").unwrap();
        drop(first);

        let reloaded = OpenpgpState::for_testing(dir);
        // `ensure_key` now hits disk and must produce identical bundles.
        let alice_reloaded = reloaded.ensure_key("alice@example.com", "Alice").unwrap();
        let bob_reloaded = reloaded.ensure_key("bob@example.com", "Bob").unwrap();
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
    }

    #[test]
    fn decrypt_with_wrong_sender_key_does_not_verify() {
        // Alice signs, but Bob's client mistakenly supplies Eve's public
        // key for verification. Decryption succeeds; signature does not.
        let (state, _alice, bob) = setup_two_accounts();
        let eve = state.ensure_key("eve@example.com", "Eve").unwrap();
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
        state.ensure_key("alice@example.com", "Alice").unwrap();
        let err = state
            .decrypt("alice@example.com", "not-a-pgp-ciphertext", None)
            .expect_err("malformed ciphertext must be rejected");
        assert!(!err.is_empty(), "expected an error");
    }

    #[test]
    fn encrypt_fails_without_a_sender_key() {
        let state = new_state();
        // Generate only Bob's key; Alice is absent.
        let bob = state.ensure_key("bob@example.com", "Bob").unwrap();
        let err = state
            .encrypt("alice@example.com", &bob.public_armored, "hi")
            .expect_err("encrypt must fail without sender account");
        assert!(err.contains("no key for sender"), "unexpected error: {err}");
    }

    #[test]
    fn forget_account_removes_key_and_persisted_file() {
        let dir = fresh_tmp_dir();
        let state = OpenpgpState::for_testing(dir.clone());
        let alice = state.ensure_key("alice@example.com", "Alice").unwrap();
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
        let fresh = OpenpgpState::for_testing(dir);
        let regenerated = fresh.ensure_key("alice@example.com", "Alice").unwrap();
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
        let bundle = state.ensure_key("alice@example.com", "Alice").unwrap();
        let parsed = Cert::from_bytes(bundle.public_armored.as_bytes()).unwrap();
        assert_eq!(parsed.fingerprint().to_hex(), bundle.fingerprint);
    }
}

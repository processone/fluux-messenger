//! OpenPGP operations for the XEP-0373 (OX) E2EE plugin.
//!
//! This module exposes Tauri commands that the TypeScript-side plugin
//! (`apps/fluux/src/e2ee/SequoiaPgpPlugin.ts`) invokes for the cryptographic
//! operations it cannot perform in the web layer. The crypto is provided by
//! [Sequoia-PGP](https://sequoia-pgp.org/) with its pure-Rust backend.
//!
//! # Key material lifecycle
//!
//! Keys live only in process memory, keyed on the account JID. The TS
//! plugin calls [`openpgp_forget_account`] on shutdown so secrets don't
//! outlive a session. OS keyring integration (for persistence across app
//! restarts) is a follow-up.

use anyhow::{anyhow, Context, Result};
use sequoia_openpgp as openpgp;
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use std::sync::Mutex;
use tauri::State;

use openpgp::{
    cert::{Cert, CertBuilder},
    crypto::SessionKey,
    packet::{PKESK, SKESK},
    parse::{
        stream::{
            DecryptionHelper, DecryptorBuilder, MessageStructure, VerificationHelper,
        },
        Parse,
    },
    policy::StandardPolicy,
    serialize::{
        stream::{Armorer, Encryptor, LiteralWriter, Message, Recipient},
        SerializeInto,
    },
    types::SymmetricAlgorithm,
    Fingerprint, KeyHandle,
};

/// Serializable output of [`openpgp_generate_key`].
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyBundle {
    /// Upper-case hex fingerprint (40 chars for v4 keys), no separators.
    pub fingerprint: String,
    /// ASCII-armored public key block, suitable for publishing to a PEP node.
    pub public_armored: String,
    /// ASCII-armored secret key block. Callers must treat as sensitive.
    pub secret_armored: String,
}

/// State held by the Tauri managed-state system. One entry per logged-in
/// account — keyed on the account JID. Cleared by
/// [`openpgp_forget_account`] on shutdown.
#[derive(Default)]
pub struct OpenpgpState {
    accounts: Mutex<std::collections::HashMap<String, KeyBundle>>,
}

impl OpenpgpState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn generate_key(&self, account_jid: &str, user_id: &str) -> Result<KeyBundle, String> {
        let mut accounts = self
            .accounts
            .lock()
            .map_err(|e| format!("openpgp state poisoned: {e}"))?;
        if let Some(existing) = accounts.get(account_jid) {
            return Ok(existing.clone());
        }

        let bundle = build_new_key(user_id).map_err(anyhow_to_string)?;
        accounts.insert(account_jid.to_string(), bundle.clone());
        Ok(bundle)
    }

    pub fn decrypt(&self, account_jid: &str, ciphertext: &str) -> Result<String, String> {
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

        decrypt_message(&secret_armored, ciphertext).map_err(anyhow_to_string)
    }

    pub fn forget_account(&self, account_jid: &str) -> Result<(), String> {
        let mut accounts = self
            .accounts
            .lock()
            .map_err(|e| format!("openpgp state poisoned: {e}"))?;
        accounts.remove(account_jid);
        Ok(())
    }
}

pub fn encrypt_for_recipient(
    recipient_public_armored: &str,
    plaintext: &str,
) -> Result<String, String> {
    encrypt_message(recipient_public_armored, plaintext).map_err(anyhow_to_string)
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
pub fn openpgp_generate_key(
    account_jid: String,
    user_id: String,
    state: State<'_, OpenpgpState>,
) -> Result<KeyBundle, String> {
    state.generate_key(&account_jid, &user_id)
}

#[tauri::command]
pub fn openpgp_encrypt(
    recipient_public_armored: String,
    plaintext: String,
) -> Result<String, String> {
    encrypt_for_recipient(&recipient_public_armored, &plaintext)
}

#[tauri::command]
pub fn openpgp_decrypt(
    account_jid: String,
    ciphertext: String,
    state: State<'_, OpenpgpState>,
) -> Result<String, String> {
    state.decrypt(&account_jid, &ciphertext)
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

fn build_new_key(user_id: &str) -> Result<KeyBundle> {
    let (cert, _revocation) = CertBuilder::general_purpose(Some(user_id))
        .generate()
        .context("generate OpenPGP cert")?;

    let public_armored = armored_string(&cert, KeyExport::Public)?;
    let secret_armored = armored_string(&cert, KeyExport::Secret)?;
    let fingerprint = cert.fingerprint().to_hex();

    Ok(KeyBundle {
        fingerprint,
        public_armored,
        secret_armored,
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

fn encrypt_message(recipient_public_armored: &str, plaintext: &str) -> Result<String> {
    let policy = StandardPolicy::new();
    let recipient_cert = Cert::from_bytes(recipient_public_armored.as_bytes())
        .context("parse recipient public key")?;

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

    let mut sink: Vec<u8> = Vec::new();
    {
        let message = Message::new(&mut sink);
        let message = Armorer::new(message).build().context("build armorer")?;
        let message = Encryptor::for_recipients(message, recipients)
            .build()
            .context("build encryptor")?;
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

fn decrypt_message(secret_armored: &str, ciphertext: &str) -> Result<String> {
    let policy = StandardPolicy::new();
    let secret_cert = Cert::from_bytes(secret_armored.as_bytes())
        .context("parse own secret key")?;

    let helper = DecryptHelper {
        secret: &secret_cert,
        policy: &policy,
    };

    let mut decryptor = DecryptorBuilder::from_bytes(ciphertext.as_bytes())
        .context("parse ciphertext")?
        .with_policy(&policy, None, helper)
        .context("open decryptor")?;

    let mut plaintext = Vec::new();
    std::io::copy(&mut decryptor, &mut plaintext).context("read decrypted stream")?;

    String::from_utf8(plaintext).context("decrypted payload is not UTF-8")
}

struct DecryptHelper<'a> {
    secret: &'a Cert,
    policy: &'a StandardPolicy<'a>,
}

impl VerificationHelper for DecryptHelper<'_> {
    fn get_certs(&mut self, _ids: &[KeyHandle]) -> openpgp::Result<Vec<Cert>> {
        // Signature verification is a Phase 1 follow-up (XEP-0373 defines
        // signcrypt). For now we accept any envelope — Chat still renders
        // a lock indicator but trust level stays at "trusted" / "untrusted"
        // based on peer-key presence, not cryptographic signatures.
        Ok(Vec::new())
    }

    fn check(&mut self, _structure: MessageStructure) -> openpgp::Result<()> {
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
    // Flatten chained error contexts onto one line so the TS side gets a
    // readable message.
    out = out.replace('\n', " ").replace("  ", " ");
    out
}

// Keep a `Fingerprint` import bound so we can add signature verification
// later without touching the uses block. Silencing dead-code for now.
#[allow(dead_code)]
fn _fingerprint_type_reference(_: &Fingerprint) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_then_fingerprint_round_trip() {
        let state = OpenpgpState::new();
        let bundle = state
            .generate_key("alice@example.com", "Alice <alice@example.com>")
            .unwrap();
        let fp = fingerprint_of(&bundle.public_armored).unwrap();
        assert_eq!(fp, bundle.fingerprint);
        // v4 Sequoia fingerprints are 40 hex chars.
        assert_eq!(bundle.fingerprint.len(), 40);
    }

    #[test]
    fn generate_is_idempotent_per_account() {
        let state = OpenpgpState::new();
        let a = state.generate_key("alice@example.com", "Alice").unwrap();
        let b = state.generate_key("alice@example.com", "Alice").unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.secret_armored, b.secret_armored);
    }

    #[test]
    fn different_accounts_get_distinct_fingerprints() {
        let state = OpenpgpState::new();
        let alice = state.generate_key("alice@example.com", "Alice").unwrap();
        let bob = state.generate_key("bob@example.com", "Bob").unwrap();
        assert_ne!(alice.fingerprint, bob.fingerprint);
    }

    #[test]
    fn encrypt_then_decrypt_round_trip() {
        let state = OpenpgpState::new();
        let bundle = state.generate_key("bob@example.com", "Bob").unwrap();
        let ciphertext = encrypt_for_recipient(&bundle.public_armored, "hello, bob").unwrap();
        // Real OpenPGP armored messages start with this header.
        assert!(
            ciphertext.contains("BEGIN PGP MESSAGE"),
            "expected PGP armored block, got {}",
            &ciphertext[..ciphertext.len().min(80)]
        );
        let plaintext = state.decrypt("bob@example.com", &ciphertext).unwrap();
        assert_eq!(plaintext, "hello, bob");
    }

    #[test]
    fn decrypt_rejects_ciphertext_for_another_account() {
        let state = OpenpgpState::new();
        let alice = state.generate_key("alice@example.com", "Alice").unwrap();
        let _bob = state.generate_key("bob@example.com", "Bob").unwrap();
        let ciphertext = encrypt_for_recipient(&alice.public_armored, "for alice").unwrap();
        let err = state
            .decrypt("bob@example.com", &ciphertext)
            .expect_err("bob must not decrypt alice's ciphertext");
        // Sequoia reports decryption failure; the exact wording isn't stable
        // across versions, so we just assert we got some error and that it's
        // not a false positive returning the wrong plaintext.
        assert!(!err.is_empty(), "expected an error");
    }

    #[test]
    fn decrypt_rejects_unknown_ciphertext_shape() {
        let state = OpenpgpState::new();
        state.generate_key("alice@example.com", "Alice").unwrap();
        let err = state
            .decrypt("alice@example.com", "not-a-pgp-ciphertext")
            .expect_err("malformed ciphertext must be rejected");
        assert!(!err.is_empty(), "expected an error");
    }

    #[test]
    fn forget_account_removes_key() {
        let state = OpenpgpState::new();
        let alice = state.generate_key("alice@example.com", "Alice").unwrap();
        let ciphertext = encrypt_for_recipient(&alice.public_armored, "x").unwrap();
        state.forget_account("alice@example.com").unwrap();
        let err = state
            .decrypt("alice@example.com", &ciphertext)
            .expect_err("decrypt must fail after forget");
        assert!(err.contains("no key"), "unexpected error: {err}");
    }

    #[test]
    fn fingerprint_of_handles_non_pgp_input() {
        let err = fingerprint_of("not an OpenPGP block").expect_err("must reject");
        assert!(!err.is_empty());
    }

    #[test]
    fn public_key_armor_is_stable_across_generate_reads() {
        // Generated armored blocks must parse back into a Cert with the
        // same fingerprint — the TS side relies on publish→fetch round-trip.
        let state = OpenpgpState::new();
        let bundle = state.generate_key("alice@example.com", "Alice").unwrap();
        let parsed = Cert::from_bytes(bundle.public_armored.as_bytes()).unwrap();
        assert_eq!(parsed.fingerprint().to_hex(), bundle.fingerprint);
    }
}

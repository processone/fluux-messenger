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
//! Keys live only in process memory, keyed on the account JID. The TS
//! plugin calls [`openpgp_forget_account`] on shutdown so secrets don't
//! outlive a session. OS keyring integration (for persistence across app
//! restarts) is a follow-up.

use anyhow::{anyhow, Context, Result};
use sequoia_openpgp as openpgp;
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use std::sync::{Arc, Mutex};
use tauri::State;

use openpgp::{
    cert::{Cert, CertBuilder},
    crypto::SessionKey,
    packet::{PKESK, SKESK},
    parse::{
        stream::{
            DecryptionHelper, DecryptorBuilder, MessageLayer, MessageStructure,
            VerificationHelper,
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

    pub fn forget_account(&self, account_jid: &str) -> Result<(), String> {
        let mut accounts = self
            .accounts
            .lock()
            .map_err(|e| format!("openpgp state poisoned: {e}"))?;
        accounts.remove(account_jid);
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
pub fn openpgp_generate_key(
    account_jid: String,
    user_id: String,
    state: State<'_, OpenpgpState>,
) -> Result<KeyBundle, String> {
    state.generate_key(&account_jid, &user_id)
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

fn encrypt_and_sign(
    recipient_public_armored: &str,
    sender_secret_armored: &str,
    plaintext: &str,
) -> Result<String> {
    let policy = StandardPolicy::new();
    let recipient_cert = Cert::from_bytes(recipient_public_armored.as_bytes())
        .context("parse recipient public key")?;
    let sender_cert = Cert::from_bytes(sender_secret_armored.as_bytes())
        .context("parse sender secret key")?;

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
    let secret_cert = Cert::from_bytes(secret_armored.as_bytes())
        .context("parse own secret key")?;

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

    fn setup_two_accounts() -> (OpenpgpState, KeyBundle, KeyBundle) {
        let state = OpenpgpState::new();
        let alice = state.generate_key("alice@example.com", "Alice").unwrap();
        let bob = state.generate_key("bob@example.com", "Bob").unwrap();
        (state, alice, bob)
    }

    #[test]
    fn generate_then_fingerprint_round_trip() {
        let state = OpenpgpState::new();
        let bundle = state
            .generate_key("alice@example.com", "Alice <alice@example.com>")
            .unwrap();
        let fp = fingerprint_of(&bundle.public_armored).unwrap();
        assert_eq!(fp, bundle.fingerprint);
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
        assert!(out.signature_verified, "signature must verify for alice->bob");
        assert_eq!(out.signer_fingerprint.as_deref(), Some(alice.fingerprint.as_str()));
    }

    #[test]
    fn decrypt_without_sender_key_succeeds_but_signature_not_verified() {
        let (state, _alice, bob) = setup_two_accounts();
        let ciphertext = state
            .encrypt("alice@example.com", &bob.public_armored, "hi")
            .unwrap();
        let out = state
            .decrypt("bob@example.com", &ciphertext, None)
            .unwrap();
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
        let eve = state.generate_key("eve@example.com", "Eve").unwrap();
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
        let state = OpenpgpState::new();
        state.generate_key("alice@example.com", "Alice").unwrap();
        let err = state
            .decrypt("alice@example.com", "not-a-pgp-ciphertext", None)
            .expect_err("malformed ciphertext must be rejected");
        assert!(!err.is_empty(), "expected an error");
    }

    #[test]
    fn encrypt_fails_without_a_sender_key() {
        let state = OpenpgpState::new();
        // Generate only Bob's key; Alice is absent.
        let bob = state.generate_key("bob@example.com", "Bob").unwrap();
        let err = state
            .encrypt("alice@example.com", &bob.public_armored, "hi")
            .expect_err("encrypt must fail without sender account");
        assert!(err.contains("no key for sender"), "unexpected error: {err}");
    }

    #[test]
    fn forget_account_removes_key() {
        let (state, alice, _bob) = setup_two_accounts();
        let ciphertext = state
            .encrypt("alice@example.com", &alice.public_armored, "self-note")
            .unwrap();
        state.forget_account("alice@example.com").unwrap();
        let err = state
            .decrypt("alice@example.com", &ciphertext, None)
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
        let state = OpenpgpState::new();
        let bundle = state.generate_key("alice@example.com", "Alice").unwrap();
        let parsed = Cert::from_bytes(bundle.public_armored.as_bytes()).unwrap();
        assert_eq!(parsed.fingerprint().to_hex(), bundle.fingerprint);
    }
}

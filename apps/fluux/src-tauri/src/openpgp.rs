//! OpenPGP plugin skeleton for XEP-0373 (OX) end-to-end encryption.
//!
//! This module is the Rust side of the E2EE plugin architecture described
//! in `private/E2EE_PLUGIN_ARCHITECTURE.md`. The TypeScript side lives in
//! `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts` and invokes the commands
//! defined here via Tauri's IPC.
//!
//! # TODO(sequoia): swap stubs for real Sequoia-PGP operations
//!
//! Every `#[tauri::command]` below currently performs a pass-through
//! operation so the end-to-end architecture (TS plugin → Tauri IPC →
//! Rust → response → TS) can be validated. The cryptographic operations
//! are intentionally NOT secure. Real Sequoia wiring is a dedicated
//! follow-up slice (Phase 1 of the architecture doc).
//!
//! Stub contract:
//! - `openpgp_generate_key` produces a UUID fingerprint and opaque key
//!   material strings shaped like armored OpenPGP blocks.
//! - `openpgp_encrypt` wraps plaintext as `OPENPGP-STUB:<b64>` so the
//!   payload is unambiguous to the matching `openpgp_decrypt`.
//! - `openpgp_decrypt` unwraps the same prefix.
//! - `openpgp_fingerprint` returns the fingerprint embedded in our stub
//!   public-key blob.
//!
//! The TS plugin does not know any of this — it just invokes and reads
//! armored strings back. Replacing this file with Sequoia is drop-in.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

const STUB_ENCRYPT_PREFIX: &str = "OPENPGP-STUB:";
const STUB_PUBLIC_HEADER: &str = "-----BEGIN PGP PUBLIC KEY BLOCK (STUB)-----";
const STUB_PUBLIC_FOOTER: &str = "-----END PGP PUBLIC KEY BLOCK (STUB)-----";
const STUB_SECRET_HEADER: &str = "-----BEGIN PGP PRIVATE KEY BLOCK (STUB)-----";
const STUB_SECRET_FOOTER: &str = "-----END PGP PRIVATE KEY BLOCK (STUB)-----";
const STUB_FINGERPRINT_TAG: &str = "Fingerprint:";

/// Serializable output of [`openpgp_generate_key`].
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyBundle {
    /// Hex fingerprint, no separators. Matches the Sequoia-PGP convention.
    pub fingerprint: String,
    /// ASCII-armored public key block, suitable for publishing to a PEP node.
    pub public_armored: String,
    /// ASCII-armored secret key block. Callers must treat as sensitive.
    pub secret_armored: String,
}

/// State held by the Tauri managed-state system. One entry per logged-in
/// account — keyed on the account JID. Cleared on disconnect by the TS
/// plugin via [`openpgp_forget_account`].
#[derive(Default)]
pub struct OpenpgpState {
    /// Per-account secret key material. Mutex is coarse on purpose — the
    /// number of accounts is small and operations are short. Real Sequoia
    /// will want finer-grained access to avoid serializing long crypto
    /// calls.
    accounts: Mutex<std::collections::HashMap<String, KeyBundle>>,
}

impl OpenpgpState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Core logic, separated from the Tauri command shim so unit tests can
/// exercise it without spinning up a Tauri app.
impl OpenpgpState {
    pub fn generate_key(&self, account_jid: &str, user_id: &str) -> Result<KeyBundle, String> {
        let mut accounts = self
            .accounts
            .lock()
            .map_err(|e| format!("openpgp state poisoned: {e}"))?;
        if let Some(existing) = accounts.get(account_jid) {
            return Ok(existing.clone());
        }

        // TODO(sequoia): replace with CertBuilder::general_purpose(None, Some(user_id)).generate()
        let fingerprint = Uuid::new_v4().simple().to_string().to_uppercase();
        let bundle = KeyBundle {
            fingerprint: fingerprint.clone(),
            public_armored: stub_armored_block(
                STUB_PUBLIC_HEADER,
                STUB_PUBLIC_FOOTER,
                &fingerprint,
                user_id,
                "public",
            ),
            secret_armored: stub_armored_block(
                STUB_SECRET_HEADER,
                STUB_SECRET_FOOTER,
                &fingerprint,
                user_id,
                "secret",
            ),
        };
        accounts.insert(account_jid.to_string(), bundle.clone());
        Ok(bundle)
    }

    pub fn decrypt(&self, account_jid: &str, ciphertext: &str) -> Result<String, String> {
        let accounts = self
            .accounts
            .lock()
            .map_err(|e| format!("openpgp state poisoned: {e}"))?;
        let bundle = accounts
            .get(account_jid)
            .ok_or_else(|| format!("no key for account: {account_jid}"))?;

        // TODO(sequoia): open Cert from secret_armored, decrypt message, return plaintext.
        let rest = ciphertext
            .strip_prefix(STUB_ENCRYPT_PREFIX)
            .ok_or_else(|| "ciphertext not produced by this stub build".to_string())?;
        let (target_fp, payload) = rest
            .split_once(':')
            .ok_or_else(|| "ciphertext missing recipient marker".to_string())?;
        if target_fp != bundle.fingerprint {
            return Err(format!(
                "ciphertext is addressed to {target_fp}, this account holds {}",
                bundle.fingerprint
            ));
        }
        let bytes = BASE64
            .decode(payload)
            .map_err(|e| format!("decode: {e}"))?;
        String::from_utf8(bytes).map_err(|e| format!("utf8: {e}"))
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
    // TODO(sequoia): parse recipient Cert, build Encryptor, stream plaintext.
    let recipient_fp = extract_fingerprint(recipient_public_armored)
        .ok_or_else(|| "recipient key is not a valid stub bundle".to_string())?;
    let encoded = BASE64.encode(plaintext.as_bytes());
    Ok(format!("{STUB_ENCRYPT_PREFIX}{recipient_fp}:{encoded}"))
}

pub fn fingerprint_of(public_armored: &str) -> Result<String, String> {
    // TODO(sequoia): parse Cert, return cert.fingerprint().to_hex().
    extract_fingerprint(public_armored)
        .ok_or_else(|| "not a recognizable stub public key".to_string())
}

/// Generate a fresh OpenPGP identity for `account_jid` with the given
/// primary user ID, persist it in in-process memory, and return the
/// armored public/secret blocks + fingerprint.
///
/// If the account already has a key, the existing bundle is returned
/// unchanged (idempotent — matches the `ensureIdentity` contract on the
/// TS plugin).
#[tauri::command]
pub fn openpgp_generate_key(
    account_jid: String,
    user_id: String,
    state: State<'_, OpenpgpState>,
) -> Result<KeyBundle, String> {
    state.generate_key(&account_jid, &user_id)
}

/// Encrypt `plaintext` for the holder of `recipient_public_armored`.
///
/// The returned string is an armored OpenPGP message body suitable for
/// embedding in a XEP-0373 `<openpgp/>` element.
#[tauri::command]
pub fn openpgp_encrypt(
    recipient_public_armored: String,
    plaintext: String,
) -> Result<String, String> {
    encrypt_for_recipient(&recipient_public_armored, &plaintext)
}

/// Decrypt `ciphertext` with the secret key identified by `account_jid`.
#[tauri::command]
pub fn openpgp_decrypt(
    account_jid: String,
    ciphertext: String,
    state: State<'_, OpenpgpState>,
) -> Result<String, String> {
    state.decrypt(&account_jid, &ciphertext)
}

/// Return the fingerprint embedded in an armored public key block.
#[tauri::command]
pub fn openpgp_fingerprint(public_armored: String) -> Result<String, String> {
    fingerprint_of(&public_armored)
}

/// Forget the in-memory key material for `account_jid`. Called by the TS
/// plugin on shutdown / disconnect so secrets don't outlive a session.
#[tauri::command]
pub fn openpgp_forget_account(
    account_jid: String,
    state: State<'_, OpenpgpState>,
) -> Result<(), String> {
    state.forget_account(&account_jid)
}

fn stub_armored_block(
    header: &str,
    footer: &str,
    fingerprint: &str,
    user_id: &str,
    kind: &str,
) -> String {
    // The fingerprint line must be parseable by `extract_fingerprint`.
    // User id is informative only.
    format!(
        "{header}\n{STUB_FINGERPRINT_TAG} {fingerprint}\nUID: {user_id}\nKind: {kind}\n{footer}",
    )
}

fn extract_fingerprint(armored: &str) -> Option<String> {
    for line in armored.lines() {
        if let Some(rest) = line.strip_prefix(STUB_FINGERPRINT_TAG) {
            return Some(rest.trim().to_string());
        }
    }
    None
}

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
        assert!(err.contains("addressed to"), "unexpected error: {err}");
    }

    #[test]
    fn decrypt_rejects_unknown_ciphertext_shape() {
        let state = OpenpgpState::new();
        state.generate_key("alice@example.com", "Alice").unwrap();
        let err = state
            .decrypt("alice@example.com", "not-a-stub-ciphertext")
            .expect_err("malformed ciphertext must be rejected");
        assert!(err.contains("stub build"), "unexpected error: {err}");
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
    fn fingerprint_of_handles_missing_marker() {
        let err = fingerprint_of("-----BEGIN PGP PUBLIC KEY BLOCK-----\nno marker here\n-----END-----").expect_err("must reject");
        assert!(err.contains("not a recognizable"));
    }
}

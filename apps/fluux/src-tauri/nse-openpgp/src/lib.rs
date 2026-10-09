//! A bounded, read-only XMPP/MAM fetch and authenticated OX preview for the iOS NSE.
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use pgp::cert::amalgamation::key::PrimaryKey;
use pgp::{
    crypto::SessionKey,
    packet::{PKESK, SKESK},
    parse::{stream::*, Parse},
    policy::StandardPolicy,
    types::SymmetricAlgorithm,
    Cert, KeyHandle,
};
use sequoia_openpgp as pgp;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
mod xml;
mod xmpp;
const LIMIT: usize = 64 * 1024;
#[derive(Clone, Deserialize, Serialize)]
pub struct Endpoint {
    pub address: String,
    pub tls_name: String,
    pub direct_tls: bool,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Verifier {
    pub fingerprint: String,
    #[serde(rename = "publicArmored")]
    pub public_armored: String,
}
#[derive(Deserialize, Serialize)]
pub struct Request {
    pub account: String,
    pub domain: String,
    pub password: String,
    pub endpoints: Vec<Endpoint>,
    pub sender: String,
    pub secret_b64: String,
    pub peers: HashMap<String, Vec<Verifier>>,
    #[serde(default)]
    pub opt_in: bool,
    #[serde(default = "budget")]
    pub deadline_ms: u64,
    #[cfg(feature = "synthetic-lab")]
    pub root_b64: String,
}
fn budget() -> u64 {
    8000
}
#[derive(Serialize)]
pub struct Outcome {
    pub preview: Option<String>,
    pub elapsed_ms: f64,
}
struct Helper {
    secret: Cert,
    senders: Vec<Cert>,
}
impl VerificationHelper for Helper {
    fn get_certs(&mut self, _: &[KeyHandle]) -> pgp::Result<Vec<Cert>> {
        Ok(self.senders.clone())
    }
    fn check(&mut self, structure: MessageStructure) -> pgp::Result<()> {
        let mut valid = false;
        for layer in structure.iter() {
            if let MessageLayer::SignatureGroup { results } = layer {
                for result in results {
                    result
                        .as_ref()
                        .map_err(|_| anyhow::anyhow!("signature invalid or unknown"))?;
                    valid = true;
                }
            }
        }
        ensure!(valid, "unsigned");
        Ok(())
    }
}
impl DecryptionHelper for Helper {
    fn decrypt(
        &mut self,
        pkesks: &[PKESK],
        _: &[SKESK],
        algo: Option<SymmetricAlgorithm>,
        decrypt: &mut dyn FnMut(Option<SymmetricAlgorithm>, &SessionKey) -> bool,
    ) -> pgp::Result<Option<Cert>> {
        for ka in self
            .secret
            .keys()
            .with_policy(&StandardPolicy::new(), None)
            .alive()
            .revoked(false)
            .for_transport_encryption()
            .secret()
        {
            ensure!(!ka.primary(), "primary secret forbidden");
            let mut pair = ka.key().clone().into_keypair()?;
            for pkesk in pkesks {
                if pkesk
                    .decrypt(&mut pair, algo)
                    .map(|(a, k)| decrypt(a, &k))
                    .unwrap_or(false)
                {
                    return Ok(Some(self.secret.clone()));
                }
            }
        }
        bail!("no decrypting subkey")
    }
}
pub fn decrypt_ox(ciphertext: &[u8], r: &Request) -> Result<String> {
    ensure!(ciphertext.len() <= LIMIT, "ciphertext size");
    ensure!(r.secret_b64.len() <= 32 * 1024, "subkey size");
    let secret = Cert::from_bytes(&B64.decode(&r.secret_b64)?)?;
    let entries = r.peers.get(&r.sender).context("unknown sender")?;
    ensure!(!entries.is_empty() && entries.len() <= 4, "verifier count");
    let policy = StandardPolicy::new();
    let mut senders = Vec::new();
    for entry in entries {
        ensure!(entry.public_armored.len() <= 32 * 1024, "certificate size");
        let sender = Cert::from_bytes(entry.public_armored.as_bytes())?;
        ensure!(!sender.is_tsk(), "sender must be public");
        let valid = sender.with_policy(&policy, None)?;
        valid.alive()?;
        ensure!(
            matches!(
                valid.revocation_status(),
                pgp::types::RevocationStatus::NotAsFarAsWeKnow
            ),
            "revoked sender"
        );
        ensure!(
            sender.fingerprint().to_hex() == entry.fingerprint,
            "fingerprint mismatch"
        );
        ensure!(
            sender
                .with_policy(&StandardPolicy::new(), None)?
                .userids()
                .any(|u| u.userid().value() == format!("xmpp:{}", r.sender).as_bytes()),
            "sender UID"
        );
        senders.push(sender);
    }
    for ka in secret.keys().secret() {
        ensure!(!ka.primary(), "primary secret forbidden");
        ensure!(
            secret
                .keys()
                .with_policy(&StandardPolicy::new(), None)
                .for_transport_encryption()
                .any(|k| k.key().fingerprint() == ka.key().fingerprint()
                    && k.key_flags().is_some_and(|flags| !flags.for_signing()
                        && !flags.for_certification()
                        && !flags.for_authentication())),
            "non-encryption secret forbidden"
        );
    }
    let p = StandardPolicy::new();
    let mut dec = DecryptorBuilder::from_bytes(ciphertext)?
        .buffer_size(LIMIT)
        .with_policy(&p, None, Helper { secret, senders })?;
    let mut plain = Vec::new();
    dec.by_ref()
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut plain)?;
    ensure!(plain.len() <= LIMIT, "plaintext size");
    // Drain through the authenticated EOF before returning any preview.
    let mut extra = [0u8; 1];
    ensure!(dec.read(&mut extra)? == 0, "plaintext overflow");
    ox_body(&plain, &r.account)
}
fn ox_body(xml: &[u8], account: &str) -> Result<String> {
    xml::ox_body(xml, account)
}
pub fn run(r: &Request, cancelled: Arc<AtomicBool>) -> Outcome {
    let start = Instant::now();
    let end = start + Duration::from_millis(r.deadline_ms.min(8000));
    let result = (|| {
        ensure!(
            r.opt_in && xml::bare_jid(&r.account) && xml::bare_jid(&r.sender),
            "disabled or invalid account"
        );
        ensure!(r.peers.contains_key(&r.sender), "unknown sender");
        ensure!(!cancelled.load(Ordering::Relaxed), "cancelled");
        let cipher = xmpp::fetch(r, end, cancelled.clone())?;
        ensure!(
            Instant::now() < end && !cancelled.load(Ordering::Relaxed),
            "deadline"
        );
        let body = decrypt_ox(&cipher, r)?;
        ensure!(
            Instant::now() < end && !cancelled.load(Ordering::Relaxed),
            "deadline"
        );
        Ok::<_, anyhow::Error>(body)
    })();
    Outcome {
        preview: result.ok(),
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.,
    }
}
/// Allocates an independently cancellable invocation.
#[no_mangle]
pub extern "C" fn fluux_nse_new() -> *mut Arc<AtomicBool> {
    Box::into_raw(Box::new(Arc::new(AtomicBool::new(false))))
}
/// # Safety
/// `handle` is a live handle returned by `fluux_nse_new`.
#[no_mangle]
pub unsafe extern "C" fn fluux_nse_cancel(handle: *mut Arc<AtomicBool>) {
    if let Some(flag) = handle.as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}
/// # Safety
/// Release a live handle exactly once, after all run/cancel calls have ended.
#[no_mangle]
pub unsafe extern "C" fn fluux_nse_free(handle: *mut Arc<AtomicBool>) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}
/// # Safety
/// `handle` is live. Input/output are non-overlapping readable/writable regions
/// of their respective lengths and remain valid until the call returns.
#[no_mangle]
pub unsafe extern "C" fn fluux_nse_preview(
    handle: *mut Arc<AtomicBool>,
    input: *const u8,
    len: usize,
    output: *mut u8,
    capacity: usize,
) -> usize {
    if handle.is_null() || input.is_null() || output.is_null() || len > 512 * 1024 {
        return 0;
    }
    let Ok(request) = serde_json::from_slice::<Request>(std::slice::from_raw_parts(input, len))
    else {
        return 0;
    };
    let Ok(bytes) = serde_json::to_vec(&run(&request, (*handle).clone())) else {
        return 0;
    };
    if bytes.len() > capacity {
        return 0;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
    bytes.len()
}
#[cfg(test)]
mod envelope_tests {
    use super::*;
    #[test]
    fn nested_recipient_cannot_authorize_a_preview() {
        let xml = b"<signcrypt xmlns='urn:xmpp:openpgp:0'><payload xmlns='jabber:client'><to xmlns='urn:xmpp:openpgp:0' jid='bob@nse.invalid'/><time xmlns='urn:xmpp:openpgp:0' stamp='2026-10-09T09:00:00Z'/><body>synthetic</body></payload></signcrypt>";
        assert!(ox_body(xml, "bob@nse.invalid").is_err());
    }
    #[test]
    fn nested_body_is_not_a_message_body() {
        let xml = b"<signcrypt xmlns='urn:xmpp:openpgp:0'><to jid='bob@nse.invalid'/><time stamp='2026-10-09T09:00:00Z'/><payload xmlns='jabber:client'><extra><body>synthetic</body></extra></payload></signcrypt>";
        assert!(ox_body(xml, "bob@nse.invalid").is_err());
    }
}

#[cfg(test)]
mod tests;

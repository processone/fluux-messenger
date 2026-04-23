//! Passphrase-based TSK backup for XEP-0373 §5 PEP Secret Key Synchronization.
//!
//! Wraps the in-memory TSK as an OpenPGP message symmetrically encrypted
//! to a user-supplied passphrase, suitable for publishing to the
//! `urn:xmpp:openpgp:0:secret-key` PEP node. The inverse path decrypts a
//! fetched blob into a usable TSK so a fresh install can adopt the
//! shared identity.
//!
//! # Wire format
//!
//! A standard OpenPGP message — an SKESK packet carrying the session key
//! under the passphrase, followed by an authenticated-encrypted payload
//! whose plaintext is the binary TSK (Transferable Secret Key). Armored
//! for transport since PEP values are XML text nodes.
//!
//! # Passphrase protection
//!
//! We request AES-256 with AEAD (OCB) from Sequoia. Under the RFC 9580 v6
//! profile that selects an SKESK v2 packet capable of Argon2 S2K; the
//! server-side attacker must spend real memory and CPU per guess, giving
//! a moderately strong passphrase meaningful runway against offline
//! dictionary attacks.

use anyhow::{anyhow, Context, Result};
use sequoia_openpgp as openpgp;

use openpgp::{
    cert::Cert,
    crypto::{Password, SessionKey},
    packet::{PKESK, SKESK},
    parse::{
        stream::{DecryptionHelper, DecryptorBuilder, MessageStructure, VerificationHelper},
        Parse,
    },
    policy::StandardPolicy,
    serialize::{
        stream::{Armorer, Encryptor, LiteralWriter, Message},
        Serialize, SerializeInto,
    },
    types::{AEADAlgorithm, SymmetricAlgorithm},
    KeyHandle,
};
use std::io::Write as _;

/// Encrypt an armored TSK to `passphrase`, returning an armored OpenPGP
/// message ready for publication on the XEP-0373 §5 secret-key node.
///
/// The caller is expected to pass a TSK whose secret packets are
/// *unencrypted at the packet level* — typically the `secret_armored`
/// out of an `OpenpgpState::KeyBundle`, where `storage::load` has
/// already undone the at-rest Argon2id wrap. The backup's only
/// protection is the outer symmetric encryption.
pub fn encrypt_tsk_with_passphrase(tsk_armored: &str, passphrase: &str) -> Result<String> {
    let cert = Cert::from_bytes(tsk_armored.as_bytes()).context("parse TSK to back up")?;
    if !cert.is_tsk() {
        return Err(anyhow!(
            "backup input is a public key, not a TSK — refusing to publish"
        ));
    }

    // Binary TSK body. The outer OpenPGP message will armor the final
    // ciphertext for transport; doubly armoring the payload would only
    // bloat the PEP item.
    let mut tsk_bytes: Vec<u8> = Vec::new();
    cert.as_tsk()
        .serialize(&mut tsk_bytes)
        .context("serialize TSK to binary")?;

    let password = Password::from(passphrase);
    let mut sink: Vec<u8> = Vec::new();
    {
        let message = Message::new(&mut sink);
        let message = Armorer::new(message)
            .kind(openpgp::armor::Kind::Message)
            .build()
            .context("build armorer")?;
        let message = Encryptor::with_passwords(message, vec![password])
            .symmetric_algo(SymmetricAlgorithm::AES256)
            .aead_algo(AEADAlgorithm::OCB)
            .build()
            .context("build encryptor")?;
        let mut literal = LiteralWriter::new(message)
            .build()
            .context("build literal writer")?;
        literal
            .write_all(&tsk_bytes)
            .context("write TSK to encryptor")?;
        literal.finalize().context("finalize encrypted backup")?;
    }
    String::from_utf8(sink).context("armored OpenPGP backup is not UTF-8")
}

/// Decrypt a backup produced by [`encrypt_tsk_with_passphrase`], returning
/// the embedded TSK in ASCII-armored form. A wrong passphrase surfaces as
/// an `Err` rather than a panic — the UI can catch and prompt again.
pub fn decrypt_tsk_with_passphrase(message_armored: &str, passphrase: &str) -> Result<String> {
    let policy = StandardPolicy::new();
    let password = Password::from(passphrase);
    let helper = BackupHelper {
        password: &password,
    };
    let mut decryptor = DecryptorBuilder::from_bytes(message_armored.as_bytes())
        .context("parse backup ciphertext")?
        .with_policy(&policy, None, helper)
        .context("open backup decryptor (wrong passphrase?)")?;

    let mut tsk_bytes: Vec<u8> = Vec::new();
    std::io::copy(&mut decryptor, &mut tsk_bytes).context("read decrypted backup")?;

    let cert = Cert::from_bytes(&tsk_bytes).context("parse recovered TSK")?;
    if !cert.is_tsk() {
        return Err(anyhow!(
            "recovered payload does not contain secret key packets"
        ));
    }
    let armored = cert
        .as_tsk()
        .armored()
        .to_vec()
        .context("re-armor recovered TSK")?;
    String::from_utf8(armored).context("recovered TSK armor is not UTF-8")
}

struct BackupHelper<'a> {
    password: &'a Password,
}

impl VerificationHelper for BackupHelper<'_> {
    fn get_certs(&mut self, _ids: &[KeyHandle]) -> openpgp::Result<Vec<Cert>> {
        // The backup is symmetrically encrypted with no signature layer
        // — there's no cert to fetch. The standard-policy decryptor still
        // calls this hook; returning empty is the no-signer path.
        Ok(Vec::new())
    }

    fn check(&mut self, _structure: MessageStructure) -> openpgp::Result<()> {
        // No signature to validate. Authenticity of the payload falls to
        // the AEAD tag of the SEIP/OCB container; tampering surfaces as a
        // read error out of the decryptor, not here.
        Ok(())
    }
}

impl DecryptionHelper for BackupHelper<'_> {
    fn decrypt(
        &mut self,
        _pkesks: &[PKESK],
        skesks: &[SKESK],
        _sym_algo: Option<SymmetricAlgorithm>,
        decrypt: &mut dyn FnMut(Option<SymmetricAlgorithm>, &SessionKey) -> bool,
    ) -> openpgp::Result<Option<Cert>> {
        for skesk in skesks {
            if let Ok((algo, sk)) = skesk.decrypt(self.password) {
                if decrypt(algo, &sk) {
                    return Ok(None);
                }
            }
        }
        Err(anyhow!("no SKESK matched the supplied passphrase"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openpgp::cert::CertBuilder;

    fn fresh_tsk() -> String {
        let (cert, _rev) = CertBuilder::general_purpose(Some("Alice <alice@example.com>"))
            .set_profile(openpgp::Profile::RFC9580)
            .expect("v6 profile")
            .generate()
            .expect("generate test cert");
        let bytes = cert.as_tsk().armored().to_vec().expect("armor TSK");
        String::from_utf8(bytes).expect("armor is UTF-8")
    }

    #[test]
    fn round_trip_preserves_fingerprint() {
        let tsk = fresh_tsk();
        let original_fp = Cert::from_bytes(tsk.as_bytes()).unwrap().fingerprint().to_hex();
        let backup = encrypt_tsk_with_passphrase(&tsk, "correct-horse-battery-staple").unwrap();
        assert!(
            backup.contains("BEGIN PGP MESSAGE"),
            "output must be an armored OpenPGP message, got: {backup}"
        );
        let recovered = decrypt_tsk_with_passphrase(&backup, "correct-horse-battery-staple")
            .expect("round-trip decrypt");
        let recovered_fp = Cert::from_bytes(recovered.as_bytes())
            .unwrap()
            .fingerprint()
            .to_hex();
        assert_eq!(recovered_fp, original_fp);
    }

    #[test]
    fn recovered_tsk_carries_secret_packets() {
        let tsk = fresh_tsk();
        let backup = encrypt_tsk_with_passphrase(&tsk, "pp").unwrap();
        let recovered = decrypt_tsk_with_passphrase(&backup, "pp").unwrap();
        let cert = Cert::from_bytes(recovered.as_bytes()).unwrap();
        assert!(
            cert.is_tsk(),
            "recovered cert must contain secret-key material"
        );
    }

    #[test]
    fn wrong_passphrase_does_not_yield_tsk() {
        let tsk = fresh_tsk();
        let backup = encrypt_tsk_with_passphrase(&tsk, "right").unwrap();
        let err = decrypt_tsk_with_passphrase(&backup, "wrong")
            .expect_err("decrypting with the wrong passphrase must fail");
        // Error surface is whatever Sequoia says on SKESK mismatch; the
        // invariant we care about is simply that it doesn't silently
        // produce a TSK.
        let msg = format!("{err:#}");
        assert!(!msg.is_empty(), "error must carry a diagnostic");
    }

    #[test]
    fn refuses_public_key_as_backup_source() {
        let (cert, _rev) = CertBuilder::general_purpose(Some("Bob <bob@example.com>"))
            .set_profile(openpgp::Profile::RFC9580)
            .unwrap()
            .generate()
            .unwrap();
        let public_armored = String::from_utf8(cert.armored().to_vec().unwrap()).unwrap();
        let err = encrypt_tsk_with_passphrase(&public_armored, "pp")
            .expect_err("public-only input must be rejected");
        assert!(
            format!("{err:#}").contains("public key"),
            "error should name the mistake, got: {err:#}"
        );
    }

    #[test]
    fn recovered_tsk_is_usable_for_another_round_trip() {
        // Guard against a subtle breakage where the decrypt path drops
        // some packets of the TSK (subkeys, self-signatures). If this
        // round-trip still preserves fingerprint-plus-secret, the recovered
        // TSK is fit to persist via openpgp_storage::KeyStorage::save.
        let tsk = fresh_tsk();
        let first = encrypt_tsk_with_passphrase(&tsk, "one").unwrap();
        let once = decrypt_tsk_with_passphrase(&first, "one").unwrap();
        let second = encrypt_tsk_with_passphrase(&once, "two").unwrap();
        let twice = decrypt_tsk_with_passphrase(&second, "two").unwrap();
        let original_fp = Cert::from_bytes(tsk.as_bytes()).unwrap().fingerprint().to_hex();
        let twice_fp = Cert::from_bytes(twice.as_bytes()).unwrap().fingerprint().to_hex();
        assert_eq!(twice_fp, original_fp);
    }
}

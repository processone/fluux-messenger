//! Export the account's TSK as a standard OpenPGP PRIVATE KEY BLOCK,
//! for use with external OpenPGP tooling (gpg, OpenKeychain, Kleopatra,
//! ...).
//!
//! Distinct from [`crate::openpgp_backup`], which targets XEP-0373 §5
//! and wraps the TSK in a symmetrically-encrypted OpenPGP MESSAGE.
//! Third-party key managers do not recognise that envelope as a key
//! import — they expect ASCII armor of kind `PRIVATE KEY BLOCK` whose
//! contents are the TSK packets, optionally with the secret packets
//! encrypted by S2K.
//!
//! Two output flavours:
//!   * **passphrase-protected** — every secret packet wrapped with the
//!     default Iterated+Salted S2K + AES-256/CFB. That's the format
//!     `gpg --export-secret-keys` produces and the most interoperable
//!     choice across implementations.
//!   * **unprotected** — secret packets are armored as-is. The caller
//!     (UI) MUST gate this behind an explicit "I know what I'm doing"
//!     acknowledgement — the file is a plaintext private key on disk.
//!
//! Passphrase normalisation is intentionally *not* applied here:
//! external tools won't NFKD/lowercase the user's input, so we must
//! pass through whatever they typed verbatim or the decrypt side would
//! never match.

use anyhow::{anyhow, Context, Result};
use sequoia_openpgp as openpgp;

use openpgp::{
    cert::Cert,
    crypto::Password,
    packet::Packet,
    parse::Parse,
    serialize::SerializeInto,
};

/// Serialise `tsk_armored` (the account's unlocked TSK as stored in a
/// `KeyBundle::secret_armored`) as an ASCII-armored PRIVATE KEY BLOCK.
///
/// When `passphrase` is `Some`, every secret packet is encrypted in
/// place with the default S2K (Iterated+Salted, SHA-256, AES-256, CFB)
/// — the universally interoperable format that `gpg --export-secret-keys`
/// produces. When `None`, the secret packets are armored verbatim and the
/// resulting file is a plaintext private key.
///
/// Refuses a public-only cert as input — exporting a public key as if
/// it were a TSK would silently hand the user an unusable file.
pub fn export_tsk_as_private_key_block(
    tsk_armored: &str,
    passphrase: Option<&str>,
) -> Result<String> {
    let cert = Cert::from_bytes(tsk_armored.as_bytes()).context("parse TSK to export")?;
    if !cert.is_tsk() {
        return Err(anyhow!(
            "export input is a public key, not a TSK — refusing to write a non-key file"
        ));
    }

    let cert_to_serialize = match passphrase {
        Some(pp) if !pp.is_empty() => encrypt_secret_packets(cert, &Password::from(pp))?,
        Some(_) => {
            return Err(anyhow!("export passphrase is empty"));
        }
        None => cert,
    };

    let armored = cert_to_serialize
        .as_tsk()
        .armored()
        .to_vec()
        .context("serialize TSK to PRIVATE KEY BLOCK armor")?;
    String::from_utf8(armored).context("armored PRIVATE KEY BLOCK is not UTF-8")
}

/// Wrap each secret packet of `cert` with the default S2K. We let
/// Sequoia choose the S2K algorithm (Iterated+Salted on v4, the
/// RFC 9580-compliant default on v6) so the output works in any
/// modern OpenPGP implementation that handles the cert's key version.
fn encrypt_secret_packets(cert: Cert, password: &Password) -> Result<Cert> {
    let mut packets: Vec<Packet> = Vec::new();
    for packet in cert.into_tsk().into_packets() {
        match packet {
            Packet::SecretKey(key) => {
                let encrypted = key
                    .encrypt_secret(password)
                    .context("encrypt primary secret key with S2K")?;
                packets.push(Packet::SecretKey(encrypted));
            }
            Packet::SecretSubkey(key) => {
                let encrypted = key
                    .encrypt_secret(password)
                    .context("encrypt secret subkey with S2K")?;
                packets.push(Packet::SecretSubkey(encrypted));
            }
            other => packets.push(other),
        }
    }
    Cert::from_packets(packets.into_iter()).context("rebuild cert after S2K-wrapping secrets")
}

#[cfg(test)]
mod tests {
    use super::*;
    use openpgp::cert::CertBuilder;
    use openpgp::packet::key::SecretKeyMaterial;

    fn fresh_tsk() -> String {
        let (cert, _rev) = CertBuilder::general_purpose(Some("Alice <alice@example.com>"))
            .set_profile(openpgp::Profile::RFC9580)
            .expect("v6 profile")
            .generate()
            .expect("generate test cert");
        let bytes = cert.as_tsk().armored().to_vec().expect("armor TSK");
        String::from_utf8(bytes).expect("armor is UTF-8")
    }

    fn primary_secret_is_encrypted(cert: &Cert) -> bool {
        match cert.primary_key().key().optional_secret() {
            Some(SecretKeyMaterial::Encrypted(_)) => true,
            Some(SecretKeyMaterial::Unencrypted(_)) => false,
            None => false,
        }
    }

    #[test]
    fn unprotected_export_round_trips_fingerprint_and_keeps_secrets_clear() {
        let tsk = fresh_tsk();
        let original_fp = Cert::from_bytes(tsk.as_bytes()).unwrap().fingerprint().to_hex();

        let exported = export_tsk_as_private_key_block(&tsk, None).expect("export with no passphrase");
        assert!(
            exported.contains("BEGIN PGP PRIVATE KEY BLOCK"),
            "output must be an armored PRIVATE KEY BLOCK, got: {exported}"
        );

        let recovered = Cert::from_bytes(exported.as_bytes()).expect("recovered cert parses");
        assert!(recovered.is_tsk(), "exported cert must still carry secret-key packets");
        assert_eq!(recovered.fingerprint().to_hex(), original_fp);
        assert!(
            !primary_secret_is_encrypted(&recovered),
            "secret packet must be unencrypted in the unprotected export"
        );
    }

    #[test]
    fn protected_export_encrypts_secret_packets_and_can_be_decrypted_back() {
        let tsk = fresh_tsk();
        let original_fp = Cert::from_bytes(tsk.as_bytes()).unwrap().fingerprint().to_hex();

        let exported = export_tsk_as_private_key_block(&tsk, Some("ext-tool-passphrase"))
            .expect("export with passphrase");
        assert!(exported.contains("BEGIN PGP PRIVATE KEY BLOCK"));

        let recovered = Cert::from_bytes(exported.as_bytes()).unwrap();
        assert_eq!(recovered.fingerprint().to_hex(), original_fp);
        assert!(
            primary_secret_is_encrypted(&recovered),
            "secret packet must be S2K-protected in the protected export"
        );

        // Decrypting the secret with the same passphrase must yield
        // usable key material — proves the wrap is well-formed end to
        // end, not just that an encrypted packet exists.
        let password = Password::from("ext-tool-passphrase");
        let primary = recovered.primary_key().key().clone();
        let parts = primary.parts_into_secret().expect("primary carries secret");
        parts
            .decrypt_secret(&password)
            .expect("S2K-wrapped primary must decrypt with the chosen passphrase");
    }

    #[test]
    fn protected_export_with_wrong_passphrase_fails_to_decrypt() {
        let tsk = fresh_tsk();
        let exported =
            export_tsk_as_private_key_block(&tsk, Some("right-passphrase")).unwrap();
        let recovered = Cert::from_bytes(exported.as_bytes()).unwrap();

        let primary = recovered.primary_key().key().clone();
        let parts = primary.parts_into_secret().unwrap();
        parts
            .decrypt_secret(&Password::from("wrong-passphrase"))
            .expect_err("decrypting with a wrong passphrase must fail");
    }

    #[test]
    fn refuses_public_key_as_export_source() {
        let (cert, _rev) = CertBuilder::general_purpose(Some("Bob <bob@example.com>"))
            .set_profile(openpgp::Profile::RFC9580)
            .unwrap()
            .generate()
            .unwrap();
        let public_armored = String::from_utf8(cert.armored().to_vec().unwrap()).unwrap();
        let err = export_tsk_as_private_key_block(&public_armored, None)
            .expect_err("public-only input must be rejected");
        assert!(
            format!("{err:#}").contains("public key"),
            "error should name the mistake, got: {err:#}"
        );
    }

    #[test]
    fn empty_passphrase_is_rejected() {
        let tsk = fresh_tsk();
        let err = export_tsk_as_private_key_block(&tsk, Some(""))
            .expect_err("empty passphrase must be rejected — caller should pass None instead");
        assert!(format!("{err:#}").contains("empty"));
    }
}

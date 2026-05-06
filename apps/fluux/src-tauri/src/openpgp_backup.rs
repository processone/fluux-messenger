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
use unicode_normalization::UnicodeNormalization;

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

/// Normalize a backup passphrase to a canonical byte sequence before
/// handing it to Argon2id + SKESK unlock. Applied identically on the
/// encrypt and decrypt paths so whatever round-trips through keyboards,
/// clipboards, password managers, or hand-transcription still derives
/// the same key.
///
/// Pipeline:
///   1. **NFKD** — required by BIP-39 and the general fix for
///      precomposed-vs-combining diacritic mismatches ("é" as U+00E9
///      vs. "e" + U+0301). Compatibility decomposition also maps
///      width-variant ASCII (full-width digits etc.) to plain ASCII.
///   2. **Lowercase** — BIP-39 wordlists are all-lowercase by
///      convention; folding case tolerates a stuck caps-lock on
///      restore without weakening entropy (the passphrase alphabet is
///      already lowercase at generation).
///   3. **Whitespace collapse** — trim leading/trailing, squash any
///      run of Unicode whitespace (newlines from password-manager
///      paste, NBSP U+00A0, ideographic space U+3000) to a single
///      ASCII space.
fn normalize_passphrase(raw: &str) -> String {
    let nfkd: String = raw.nfkd().collect::<String>().to_lowercase();
    // Split on *any* Unicode whitespace, then rejoin with single ASCII
    // space. `split_whitespace` already skips empty components, so
    // leading/trailing/duplicate separators are handled in one step.
    nfkd.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Encrypt an armored TSK to `passphrase`, returning an armored OpenPGP
/// message ready for publication on the XEP-0373 §5 secret-key node.
///
/// When `use_aead` is true the message uses SEIPD v2 (AES-256 + OCB)
/// with Argon2id S2K (RFC 9580). When false it falls back to SEIPD v1
/// (AES-256 + CFB) with iterated-salted S2K (RFC 4880), which
/// interoperates with Gajim and other current XEP-0373 implementations.
///
/// The caller is expected to pass a TSK whose secret packets are
/// *unencrypted at the packet level* — typically the `secret_armored`
/// out of an `OpenpgpState::KeyBundle`, where `storage::load` has
/// already undone the at-rest Argon2id wrap. The backup's only
/// protection is the outer symmetric encryption.
pub fn encrypt_tsk_with_passphrase(
    tsk_armored: &str,
    passphrase: &str,
    use_aead: bool,
) -> Result<String> {
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

    let normalized = normalize_passphrase(passphrase);
    if normalized.is_empty() {
        return Err(anyhow!("backup passphrase is empty after normalization"));
    }
    let password = Password::from(normalized);
    let mut sink: Vec<u8> = Vec::new();
    {
        let message = Message::new(&mut sink);
        let message = Armorer::new(message)
            .kind(openpgp::armor::Kind::Message)
            .build()
            .context("build armorer")?;
        let enc = Encryptor::with_passwords(message, vec![password])
            .symmetric_algo(SymmetricAlgorithm::AES256);
        let message = if use_aead {
            enc.aead_algo(AEADAlgorithm::OCB)
                .build()
                .context("build AEAD encryptor")?
        } else {
            enc.build().context("build CFB encryptor")?
        };
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
    let password = Password::from(normalize_passphrase(passphrase));
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
        let backup = encrypt_tsk_with_passphrase(&tsk, "correct-horse-battery-staple", true).unwrap();
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
        let backup = encrypt_tsk_with_passphrase(&tsk, "pp", true).unwrap();
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
        let backup = encrypt_tsk_with_passphrase(&tsk, "right", true).unwrap();
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
        let err = encrypt_tsk_with_passphrase(&public_armored, "pp", true)
            .expect_err("public-only input must be rejected");
        assert!(
            format!("{err:#}").contains("public key"),
            "error should name the mistake, got: {err:#}"
        );
    }

    // ---------- passphrase normalization ----------

    #[test]
    fn normalize_is_idempotent() {
        // Applying the normalizer twice must be a no-op — otherwise a
        // caller who pre-normalizes then we re-normalize could drift.
        let samples = [
            "correct horse battery staple",
            "  trim   me   ",
            "MiXeD CaSe",
            "café", // precomposed é
        ];
        for s in samples {
            let once = normalize_passphrase(s);
            let twice = normalize_passphrase(&once);
            assert_eq!(once, twice, "normalize must be idempotent for {s:?}");
        }
    }

    #[test]
    fn normalize_unifies_nfc_and_nfd_forms() {
        // "café" — precomposed é (U+00E9) vs. e + combining acute
        // (U+0065 U+0301). Both sequences print the same; NFKD must
        // fold them to the same byte string so the KDF can't tell
        // which keyboard or clipboard produced the input.
        let nfc = "caf\u{00E9}";
        let nfd = "cafe\u{0301}";
        assert_ne!(nfc.as_bytes(), nfd.as_bytes(), "inputs must differ pre-normalization");
        assert_eq!(normalize_passphrase(nfc), normalize_passphrase(nfd));
    }

    #[test]
    fn normalize_lowercases() {
        assert_eq!(normalize_passphrase("CAFÉ"), normalize_passphrase("café"));
        assert_eq!(normalize_passphrase("Hello World"), "hello world");
    }

    #[test]
    fn normalize_collapses_and_trims_whitespace() {
        // Triple space, leading/trailing space, tab, newline, non-
        // breaking space (U+00A0), ideographic space (U+3000) — all
        // must reduce to a single ASCII space between words.
        assert_eq!(normalize_passphrase("  a    b  "), "a b");
        assert_eq!(normalize_passphrase("a\tb\nc"), "a b c");
        assert_eq!(normalize_passphrase("a\u{00A0}b"), "a b");
        assert_eq!(normalize_passphrase("a\u{3000}b"), "a b");
    }

    #[test]
    fn encrypt_empty_passphrase_is_rejected() {
        // An all-whitespace passphrase normalizes to empty; we refuse
        // to encrypt rather than produce a backup that unlocks on any
        // whitespace-only guess.
        let tsk = fresh_tsk();
        let err = encrypt_tsk_with_passphrase(&tsk, "   \t\n  ", true)
            .expect_err("whitespace-only passphrase must be rejected");
        assert!(format!("{err:#}").contains("empty"));
    }

    #[test]
    fn round_trip_survives_unicode_form_mismatch() {
        // End-to-end: encrypt with NFC, decrypt with NFD of the same
        // visible string. Before normalization landed this would fail
        // with "no SKESK matched".
        let tsk = fresh_tsk();
        let nfc_pp = "caf\u{00E9} soleil"; // é precomposed
        let nfd_pp = "cafe\u{0301} soleil"; // é decomposed
        let backup = encrypt_tsk_with_passphrase(&tsk, nfc_pp, true).unwrap();
        let recovered = decrypt_tsk_with_passphrase(&backup, nfd_pp)
            .expect("NFD input must unlock an NFC-encrypted backup");
        assert!(Cert::from_bytes(recovered.as_bytes()).unwrap().is_tsk());
    }

    #[test]
    fn round_trip_survives_case_and_whitespace_variants() {
        // User transcribed onto another device with double spaces and
        // a stuck shift key. Normalization must make this succeed.
        let tsk = fresh_tsk();
        let generated = "able bacon chair daisy eagle";
        let typed = "  ABLE  bacon\tchair  daisy eagle  ";
        let backup = encrypt_tsk_with_passphrase(&tsk, generated, true).unwrap();
        let recovered = decrypt_tsk_with_passphrase(&backup, typed)
            .expect("whitespace/case variants must unlock");
        assert!(Cert::from_bytes(recovered.as_bytes()).unwrap().is_tsk());
    }

    #[test]
    fn recovered_tsk_is_usable_for_another_round_trip() {
        // Guard against a subtle breakage where the decrypt path drops
        // some packets of the TSK (subkeys, self-signatures). If this
        // round-trip still preserves fingerprint-plus-secret, the recovered
        // TSK is fit to persist via openpgp_storage::KeyStorage::save.
        let tsk = fresh_tsk();
        let first = encrypt_tsk_with_passphrase(&tsk, "one", true).unwrap();
        let once = decrypt_tsk_with_passphrase(&first, "one").unwrap();
        let second = encrypt_tsk_with_passphrase(&once, "two", true).unwrap();
        let twice = decrypt_tsk_with_passphrase(&second, "two").unwrap();
        let original_fp = Cert::from_bytes(tsk.as_bytes()).unwrap().fingerprint().to_hex();
        let twice_fp = Cert::from_bytes(twice.as_bytes()).unwrap().fingerprint().to_hex();
        assert_eq!(twice_fp, original_fp);
    }

    #[test]
    fn round_trip_without_aead_uses_cfb() {
        let tsk = fresh_tsk();
        let original_fp = Cert::from_bytes(tsk.as_bytes()).unwrap().fingerprint().to_hex();
        let backup = encrypt_tsk_with_passphrase(&tsk, "v4-compat-test", false).unwrap();
        assert!(backup.contains("BEGIN PGP MESSAGE"));
        let recovered = decrypt_tsk_with_passphrase(&backup, "v4-compat-test")
            .expect("non-AEAD round-trip must succeed");
        let recovered_fp = Cert::from_bytes(recovered.as_bytes())
            .unwrap()
            .fingerprint()
            .to_hex();
        assert_eq!(recovered_fp, original_fp);
    }
}

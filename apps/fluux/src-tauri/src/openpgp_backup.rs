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
//! whose plaintext is the binary TSK (Transferable Secret Key). The Rust
//! boundary returns ASCII armor for IPC; the TypeScript XEP-0373 publisher
//! strips that armor and stores Base64-encoded raw OpenPGP bytes in PEP.
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
    cert::{Cert, CertParser},
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

/// Prepare a backup passphrase for the SKESK S2K: use it **verbatim**,
/// minus surrounding whitespace.
///
/// The passphrase shown to the user is what every XEP-0373 client feeds
/// its KDF byte-for-byte — Gajim, Profanity, OpenKeychain all use it
/// as-is. Fluux ≤0.17.1 normalized it (NFKD → lowercase → whitespace
/// collapse), so backups created here could not be opened elsewhere with
/// the displayed code (#1021). No case folding, no Unicode normalization:
/// the only forgiveness is trimming edge whitespace dragged along by
/// copy-paste. Mirrors `prepareBackupPassphrase` in the app's
/// `backupPassphrase.ts` — the two must stay byte-identical.
///
/// Legacy backups encrypted with the old normalized form are still
/// restorable: the TypeScript layer retries with the legacy form and
/// re-publishes the backup under the verbatim passphrase (heal-on-restore).
fn prepare_passphrase(raw: &str) -> &str {
    raw.trim()
}

/// Encrypt an armored TSK to `passphrase`, returning an armored OpenPGP
/// message. The TypeScript XEP-0373 boundary converts it to raw OpenPGP
/// bytes encoded as Base64 before publishing to the secret-key node.
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

    let prepared = prepare_passphrase(passphrase);
    if prepared.is_empty() {
        return Err(anyhow!("backup passphrase is empty"));
    }
    let password = Password::from(prepared);
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
    let password = Password::from(prepare_passphrase(passphrase));
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

/// Decrypt a backup and return **all** TSKs found inside. A well-behaved
/// client publishes exactly one, but inter-op with Gajim or Profanity may
/// produce backups that bundle multiple certificates. Callers should
/// auto-select the right one (e.g. match against published metadata) or
/// present a picker UI.
pub fn decrypt_all_tsks_with_passphrase(
    message_armored: &str,
    passphrase: &str,
) -> Result<Vec<String>> {
    let policy = StandardPolicy::new();
    let password = Password::from(prepare_passphrase(passphrase));
    let helper = BackupHelper {
        password: &password,
    };
    let mut decryptor = DecryptorBuilder::from_bytes(message_armored.as_bytes())
        .context("parse backup ciphertext")?
        .with_policy(&policy, None, helper)
        .context("open backup decryptor (wrong passphrase?)")?;

    let mut tsk_bytes: Vec<u8> = Vec::new();
    std::io::copy(&mut decryptor, &mut tsk_bytes).context("read decrypted backup")?;

    let mut tsks: Vec<String> = Vec::new();
    for cert_result in CertParser::from_bytes(&tsk_bytes)? {
        let cert = cert_result.context("parse cert from backup")?;
        if !cert.is_tsk() {
            continue;
        }
        let armored = cert
            .as_tsk()
            .armored()
            .to_vec()
            .context("re-armor recovered TSK")?;
        tsks.push(String::from_utf8(armored).context("recovered TSK armor is not UTF-8")?);
    }

    if tsks.is_empty() {
        return Err(anyhow!(
            "recovered payload does not contain any secret key packets"
        ));
    }
    Ok(tsks)
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

    // ---------- passphrase is used verbatim (#1021) ----------

    #[test]
    fn passphrase_is_case_sensitive() {
        // The displayed XEP-0373 §5.4 backup code is upper-case. Gajim and
        // other clients feed it to the S2K verbatim — so must we. A backup
        // encrypted with the displayed code must NOT unlock with a
        // case-folded variant, proving no normalization happens.
        let tsk = fresh_tsk();
        let code = "TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW";
        let backup = encrypt_tsk_with_passphrase(&tsk, code, true).unwrap();
        decrypt_tsk_with_passphrase(&backup, code)
            .expect("exact displayed code must unlock");
        decrypt_tsk_with_passphrase(&backup, &code.to_lowercase())
            .expect_err("case-folded code must NOT unlock — passphrase is verbatim");
    }

    #[test]
    fn passphrase_preserves_unicode_form() {
        // NFC vs NFD spellings of the same visible string are different
        // byte sequences; a verbatim passphrase treats them as different
        // passphrases, exactly like other XEP-0373 clients do.
        let tsk = fresh_tsk();
        let nfc_pp = "caf\u{00E9} soleil"; // é precomposed
        let nfd_pp = "cafe\u{0301} soleil"; // é decomposed
        let backup = encrypt_tsk_with_passphrase(&tsk, nfc_pp, true).unwrap();
        decrypt_tsk_with_passphrase(&backup, nfc_pp).expect("exact form must unlock");
        decrypt_tsk_with_passphrase(&backup, nfd_pp)
            .expect_err("different Unicode form must NOT unlock — passphrase is verbatim");
    }

    #[test]
    fn passphrase_trims_surrounding_whitespace_only() {
        // Copy-paste often drags a newline or spaces along. Both sides trim
        // the edges, but interior content — case included — stays verbatim.
        let tsk = fresh_tsk();
        let backup = encrypt_tsk_with_passphrase(&tsk, "  ABCD-1234\n", true).unwrap();
        decrypt_tsk_with_passphrase(&backup, "ABCD-1234")
            .expect("edge whitespace must be forgiven");
        decrypt_tsk_with_passphrase(&backup, " ABCD-1234 ")
            .expect("edge whitespace must be forgiven on decrypt too");
    }

    #[test]
    fn encrypt_empty_passphrase_is_rejected() {
        // An all-whitespace passphrase trims to empty; we refuse to
        // encrypt rather than produce a backup that unlocks on any
        // whitespace-only guess.
        let tsk = fresh_tsk();
        let err = encrypt_tsk_with_passphrase(&tsk, "   \t\n  ", true)
            .expect_err("whitespace-only passphrase must be rejected");
        assert!(format!("{err:#}").contains("empty"));
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

    // ---------- multi-TSK backup ----------

    fn encrypt_multi_tsk_backup(tsks: &[&str], passphrase: &str) -> String {
        let mut combined_bytes: Vec<u8> = Vec::new();
        for tsk in tsks {
            let cert = Cert::from_bytes(tsk.as_bytes()).unwrap();
            assert!(cert.is_tsk());
            cert.as_tsk().serialize(&mut combined_bytes).unwrap();
        }
        let password = Password::from(prepare_passphrase(passphrase));
        let mut sink: Vec<u8> = Vec::new();
        {
            let message = Message::new(&mut sink);
            let message = Armorer::new(message)
                .kind(openpgp::armor::Kind::Message)
                .build()
                .unwrap();
            let message = Encryptor::with_passwords(message, vec![password])
                .symmetric_algo(SymmetricAlgorithm::AES256)
                .aead_algo(AEADAlgorithm::OCB)
                .build()
                .unwrap();
            let mut literal = LiteralWriter::new(message).build().unwrap();
            literal.write_all(&combined_bytes).unwrap();
            literal.finalize().unwrap();
        }
        String::from_utf8(sink).unwrap()
    }

    #[test]
    fn multi_tsk_round_trip() {
        let tsk_a = fresh_tsk();
        let tsk_b = fresh_tsk();
        let fp_a = Cert::from_bytes(tsk_a.as_bytes()).unwrap().fingerprint().to_hex();
        let fp_b = Cert::from_bytes(tsk_b.as_bytes()).unwrap().fingerprint().to_hex();
        assert_ne!(fp_a, fp_b, "test certs must differ");

        let backup = encrypt_multi_tsk_backup(&[&tsk_a, &tsk_b], "multi");
        let recovered = decrypt_all_tsks_with_passphrase(&backup, "multi")
            .expect("multi-TSK decrypt must succeed");
        assert_eq!(recovered.len(), 2, "must recover both TSKs");

        let recovered_fps: Vec<String> = recovered
            .iter()
            .map(|a| Cert::from_bytes(a.as_bytes()).unwrap().fingerprint().to_hex())
            .collect();
        assert!(recovered_fps.contains(&fp_a), "must contain first key");
        assert!(recovered_fps.contains(&fp_b), "must contain second key");
    }

    #[test]
    fn single_tsk_via_decrypt_all_returns_one() {
        let tsk = fresh_tsk();
        let original_fp = Cert::from_bytes(tsk.as_bytes()).unwrap().fingerprint().to_hex();
        let backup = encrypt_tsk_with_passphrase(&tsk, "single", true).unwrap();
        let recovered = decrypt_all_tsks_with_passphrase(&backup, "single")
            .expect("single-TSK via decrypt_all must succeed");
        assert_eq!(recovered.len(), 1);
        let fp = Cert::from_bytes(recovered[0].as_bytes())
            .unwrap()
            .fingerprint()
            .to_hex();
        assert_eq!(fp, original_fp);
    }

    #[test]
    fn decrypt_all_with_wrong_passphrase_fails() {
        let tsk = fresh_tsk();
        let backup = encrypt_tsk_with_passphrase(&tsk, "right", true).unwrap();
        decrypt_all_tsks_with_passphrase(&backup, "wrong")
            .expect_err("wrong passphrase must fail");
    }

    // Desktop interop guard: a real OpenKeychain (Android) `numeric9x4` backup.
    // Its decrypted payload is an armored PUBLIC KEY BLOCK followed by a PRIVATE
    // KEY BLOCK — confirm Sequoia's CertParser path recovers the secret key (the
    // shared fixture is also consumed by the web-side consumeMigrationVectors).
    #[test]
    fn imports_real_openkeychain_numeric9x4_backup() {
        let backup = include_str!(
            "../../../../packages/openpgp-plugin/src/fixtures/openkeychain_numeric9x4_backup.asc"
        );
        let recovered = decrypt_all_tsks_with_passphrase(
            backup,
            "0228-6308-1219-5990-0322-8950-3981-3061-6394",
        )
        .expect("Sequoia must recover the secret key from an OpenKeychain numeric9x4 backup");
        assert_eq!(recovered.len(), 1, "expected exactly one secret key");
        let fp = Cert::from_bytes(recovered[0].as_bytes())
            .unwrap()
            .fingerprint()
            .to_hex()
            .to_lowercase();
        assert_eq!(fp, "82973553e2708df2928c1118089050309406e77f");
    }
}

//! The notification extension receives no secret primary or signing key.
use anyhow::{ensure, Result};
use sequoia_openpgp::cert::amalgamation::key::PrimaryKey;
use sequoia_openpgp::{policy::StandardPolicy, serialize::SerializeInto, Cert, Packet};
pub fn reduce(cert: Cert) -> Result<Vec<u8>> {
    let policy = StandardPolicy::new();
    let retained: Vec<_> = cert
        .keys()
        .with_policy(&policy, None)
        .alive()
        .revoked(false)
        .for_transport_encryption()
        .filter(|key| {
            !key.primary()
                && key.key_flags().is_some_and(|flags| {
                    !flags.for_signing()
                        && !flags.for_certification()
                        && !flags.for_authentication()
                })
        })
        .map(|key| key.key().fingerprint())
        .collect();
    ensure!(!retained.is_empty(), "No decryption-only subkey");
    let packets = cert.into_tsk().into_packets().map(|packet| match packet {
        Packet::SecretKey(key) => Packet::PublicKey(key.take_secret().0),
        Packet::SecretSubkey(key) if !retained.contains(&key.fingerprint()) => {
            Packet::PublicSubkey(key.take_secret().0)
        }
        other => other,
    });
    let reduced = Cert::from_packets(packets)?;
    let bytes = reduced.as_tsk().to_vec()?;
    ensure!(bytes.len() <= 24 * 1024, "Notification subkeys too large");
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    use sequoia_openpgp::{cert::CertBuilder, parse::Parse, Profile};
    #[test]
    fn v4_export_preserves_identity_but_removes_every_signing_secret() {
        let (cert, _) = CertBuilder::general_purpose(Some("xmpp:synthetic@nse.invalid"))
            .set_profile(Profile::RFC4880)
            .unwrap()
            .generate()
            .unwrap();
        let fingerprint = cert.fingerprint();
        let reduced = Cert::from_bytes(&reduce(cert).unwrap()).unwrap();
        assert_eq!(reduced.fingerprint(), fingerprint);
        assert_eq!(reduced.keys().secret().count(), 1);
        assert!(!reduced.primary_key().key().has_secret());
        for key in reduced
            .keys()
            .with_policy(&StandardPolicy::new(), None)
            .secret()
        {
            assert!(!key.primary());
            assert!(!key.key_flags().unwrap().for_signing());
        }
    }
}

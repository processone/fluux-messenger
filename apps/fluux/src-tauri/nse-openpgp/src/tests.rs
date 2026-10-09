use super::*;
use pgp::{
    cert::CertBuilder,
    serialize::{stream::*, Serialize},
};
use std::io::Write;
fn keys() -> (Cert, Cert) {
    let (bob, _) = CertBuilder::general_purpose(Some("xmpp:bob@nse.invalid"))
        .set_profile(pgp::Profile::RFC4880)
        .unwrap()
        .generate()
        .unwrap();
    let (alice, _) = CertBuilder::general_purpose(Some("xmpp:alice@nse.invalid"))
        .set_profile(pgp::Profile::RFC4880)
        .unwrap()
        .generate()
        .unwrap();
    (bob, alice)
}
fn request(bob: &Cert, alice: &Cert) -> Request {
    let policy = StandardPolicy::new();
    let ids: Vec<_> = bob
        .keys()
        .with_policy(&policy, None)
        .for_transport_encryption()
        .map(|k| k.key().fingerprint())
        .collect();
    let reduced = Cert::from_packets(bob.clone().into_tsk().into_packets().map(|p| match p {
        pgp::Packet::SecretKey(k) => pgp::Packet::PublicKey(k.take_secret().0),
        pgp::Packet::SecretSubkey(k) if !ids.contains(&k.fingerprint()) => {
            pgp::Packet::PublicSubkey(k.take_secret().0)
        }
        other => other,
    }))
    .unwrap();
    let mut secret = Vec::new();
    reduced.as_tsk().serialize(&mut secret).unwrap();
    let mut public = Vec::new();
    alice.armored().serialize(&mut public).unwrap();
    let mut json = serde_json::json!({"account":"bob@nse.invalid", "domain":"nse.invalid", "password":"synthetic",
        "endpoints": [], "sender":"alice@nse.invalid", "secret_b64":B64.encode(secret), "opt_in":true,
        "peers":{"alice@nse.invalid":[{"fingerprint":alice.fingerprint().to_hex(), "publicArmored":String::from_utf8(public).unwrap()}]}});
    #[cfg(feature = "synthetic-lab")]
    {
        json["root_b64"] = serde_json::Value::String(String::new());
    }
    #[cfg(not(feature = "synthetic-lab"))]
    let _ = &mut json;
    serde_json::from_value(json).unwrap()
}
fn encrypt(
    bob: &Cert,
    alice: &Cert,
    body: &str,
    signed: bool,
    corrupt: bool,
    compressed: bool,
) -> Vec<u8> {
    let policy = StandardPolicy::new();
    let mut literal_packet = Vec::new();
    if signed {
        let pair = alice
            .keys()
            .with_policy(&policy, None)
            .for_signing()
            .secret()
            .next()
            .unwrap()
            .key()
            .clone()
            .into_keypair()
            .unwrap();
        let signer = Signer::new(Message::new(&mut literal_packet), pair)
            .unwrap()
            .build()
            .unwrap();
        let mut literal = LiteralWriter::new(signer).build().unwrap();
        literal.write_all(body.as_bytes()).unwrap();
        literal.finalize().unwrap();
    } else {
        let mut literal = LiteralWriter::new(Message::new(&mut literal_packet))
            .build()
            .unwrap();
        literal.write_all(body.as_bytes()).unwrap();
        literal.finalize().unwrap();
    }
    if corrupt {
        let index = literal_packet
            .windows(9)
            .position(|b| b == b"synthetic")
            .unwrap();
        literal_packet[index] = b'X';
    }
    let mut cipher = Vec::new();
    let encryptor = Encryptor::for_recipients(
        Message::new(&mut cipher),
        bob.keys()
            .with_policy(&policy, None)
            .for_transport_encryption(),
    )
    .build()
    .unwrap();
    if compressed {
        let mut compressed = Compressor::new(encryptor)
            .algo(pgp::types::CompressionAlgorithm::Zip)
            .build()
            .unwrap();
        compressed.write_all(&literal_packet).unwrap();
        compressed.finalize().unwrap();
    } else {
        let mut encryptor = encryptor;
        encryptor.write_all(&literal_packet).unwrap();
        encryptor.finalize().unwrap();
    }
    cipher
}
fn envelope(recipient: &str, body: &str) -> String {
    format!("<signcrypt xmlns='urn:xmpp:openpgp:0'><to jid='{recipient}'/><time stamp='2026-10-09T09:00:00Z'/><rpad>synthetic padding</rpad><payload xmlns='jabber:client'><body>{body}</body></payload></signcrypt>")
}
#[test]
fn v4_authentication_and_bounded_plaintext() {
    let (bob, alice) = keys();
    let mut r = request(&bob, &alice);
    let xml = envelope(&r.account, "synthetic &amp; preview");
    let valid = encrypt(&bob, &alice, &xml, true, false, false);
    assert_eq!(decrypt_ox(&valid, &r).unwrap(), "synthetic & preview");
    for malformed in [
        xml.replace(
            "<payload xmlns='jabber:client'>",
            "<payload xmlns='urn:xmpp:openpgp:0'>",
        ),
        xml.replace("<body>", "<body xmlns='urn:xmpp:openpgp:0'>"),
        xml.replace("<body>", "<extra><body>")
            .replace("</body>", "</body></extra>"),
        xml.replace("</payload>", "<body>second</body></payload>"),
        xml.replace(
            "</signcrypt>",
            "<payload xmlns='jabber:client'><body>second</body></payload></signcrypt>",
        ),
    ] {
        assert!(decrypt_ox(&encrypt(&bob, &alice, &malformed, true, false, false), &r).is_err());
    }
    assert!(decrypt_ox(&encrypt(&bob, &alice, &xml, false, false, false), &r).is_err());
    assert!(decrypt_ox(&encrypt(&bob, &alice, &xml, true, true, false), &r).is_err());
    assert!(decrypt_ox(
        &encrypt(
            &bob,
            &alice,
            &envelope("mallory@nse.invalid", "synthetic"),
            true,
            false,
            false
        ),
        &r
    )
    .is_err());
    assert!(decrypt_ox(
        &encrypt(
            &bob,
            &alice,
            &envelope(&r.account, &"x".repeat(2 * 1024 * 1024)),
            true,
            false,
            true
        ),
        &r
    )
    .is_err());
    let (_, unknown) = keys();
    r.peers = request(&bob, &unknown).peers;
    assert!(decrypt_ox(&valid, &r).is_err());
    r.peers = request(&bob, &alice).peers;
    let mut full = Vec::new();
    bob.as_tsk().serialize(&mut full).unwrap();
    r.secret_b64 = B64.encode(full);
    assert!(decrypt_ox(&valid, &r).is_err());
}
#[test]
fn opt_in_absent_and_cancelled_requests_never_connect() {
    let (bob, alice) = keys();
    let mut r = request(&bob, &alice);
    r.opt_in = false;
    assert!(run(&r, Arc::new(AtomicBool::new(false))).preview.is_none());
    r.opt_in = true;
    assert!(run(&r, Arc::new(AtomicBool::new(true))).preview.is_none());
}

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
fn authenticated_bodyless_reaction_is_classified() {
    let (bob, alice) = keys();
    let r = request(&bob, &alice);
    let xml = envelope(&r.account, "synthetic").replace(
        "<body>synthetic</body>",
        "<reactions xmlns='urn:xmpp:reactions:0' id='message-1'><reaction>👍</reaction></reactions>",
    );
    assert!(
        decrypt_ox(&encrypt(&bob, &alice, &xml, true, false, false), &r).is_ok(),
        "authenticated metadata must be classified rather than rejected as a missing body"
    );
}
#[test]
fn authenticated_mutations_preserve_kind_target_and_hide_retracted_text() {
    let (bob, alice) = keys();
    let r = request(&bob, &alice);
    for (payload, mutation, target, text) in [
        ("<body>changed</body><replace xmlns='urn:xmpp:message-correct:0' id='target'/>", "edit", "target", "changed"),
        ("<body>never expose this</body><retract xmlns='urn:xmpp:message-retract:1' id='target'/>", "retraction", "target", ""),
        ("<body>never expose this</body><apply-to xmlns='urn:xmpp:fasten:0' id='target'><retract xmlns='urn:xmpp:message-retract:0'/></apply-to>", "retraction", "target", ""),
        ("<reactions xmlns='urn:xmpp:reactions:0' id='target'/>", "reaction", "target", ""),
        ("<apply-to xmlns='urn:xmpp:fasten:0' id='target'><meta xmlns='http://www.w3.org/1999/xhtml' property='og:url' content='https://example.invalid'/></apply-to>", "other", "target", ""),
    ] {
        let xml = envelope(&r.account, "synthetic").replace("<body>synthetic</body>", payload);
        assert_eq!(decrypt_ox(&encrypt(&bob, &alice, &xml, true, false, false), &r).unwrap(),
            EventKind::Metadata { mutation: mutation.into(), target: target.into(), text: text.into() });
        assert!(decrypt_ox(&encrypt(&bob, &alice, &xml, false, false, false), &r).is_err());
    }
    let new = EventKind::NewMessage {
        body: "changed".into(),
    };
    let unknown_fasten = envelope(&r.account, "synthetic").replace(
        "<body>synthetic</body>",
        "<apply-to xmlns='urn:xmpp:fasten:0' id='target'><unknown xmlns='urn:unknown'/></apply-to>",
    );
    assert_eq!(
        decrypt_ox(
            &encrypt(&bob, &alice, &unknown_fasten, true, false, false),
            &r
        )
        .unwrap(),
        EventKind::Unknown
    );
    assert_eq!(
        event::outer_correction(new, Some("target".into())),
        EventKind::Metadata {
            mutation: "outerEdit".into(),
            target: "target".into(),
            text: "changed".into()
        }
    );
    assert_eq!(
        event::outer_correction(EventKind::Unknown, Some("target".into())),
        EventKind::Unknown
    );
    for payload in [
        "<body>text</body><replace xmlns='urn:spoof' id='target'/>",
        "<body>text</body><retract xmlns='urn:xmpp:message-retract:1' id='target'/><replace xmlns='urn:xmpp:message-correct:0' id='target'/>",
        "<reactions xmlns='urn:xmpp:reactions:0' id='target'><reaction><body>spoof</body></reaction></reactions>",
        "<reactions xmlns='urn:xmpp:reactions:0' id=''/>",
        "<body>text</body><unknown xmlns='urn:unknown'/>",
    ] {
        let xml = envelope(&r.account, "synthetic").replace("<body>synthetic</body>", payload);
        assert!(decrypt_ox(&encrypt(&bob, &alice, &xml, true, false, false), &r).is_err());
    }
}
#[test]
fn v4_authentication_and_bounded_plaintext() {
    let (bob, alice) = keys();
    let mut r = request(&bob, &alice);
    let xml = envelope(&r.account, "synthetic &amp; preview");
    let valid = encrypt(&bob, &alice, &xml, true, false, false);
    assert_eq!(
        decrypt_ox(&valid, &r).unwrap(),
        EventKind::NewMessage {
            body: "synthetic & preview".into()
        }
    );
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
    assert!(run(&r, Arc::new(AtomicBool::new(false))).events.is_empty());
    r.opt_in = true;
    assert!(run(&r, Arc::new(AtomicBool::new(true))).events.is_empty());
}

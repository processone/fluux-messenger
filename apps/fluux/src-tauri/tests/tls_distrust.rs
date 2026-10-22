// FLM-28: both lockfiles must reject the compromised eMudhra keys, even
// with their public roots explicitly trusted (including the AAA cross-sign).
// Shared with nse-openpgp so its independently resolved verifier is exercised.
use base64::Engine;
use rustls::{
    client::WebPkiServerVerifier,
    pki_types::{CertificateDer, ServerName, UnixTime},
    RootCertStore,
};
use std::{sync::Arc, time::Duration};

fn certificates(pem: &str) -> Vec<CertificateDer<'static>> {
    pem.split("-----BEGIN CERTIFICATE-----")
        .skip(1)
        .map(|part| {
            let body = part.split("-----END CERTIFICATE-----").next().unwrap();
            let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
            CertificateDer::from(
                base64::engine::general_purpose::STANDARD
                    .decode(body)
                    .unwrap(),
            )
        })
        .collect()
}

#[test]
fn compromised_emudhra_keys_are_distrusted_including_aaa_cross_signs() {
    use rustls::client::danger::ServerCertVerifier;
    let mut roots = RootCertStore::empty();
    for cert in certificates(include_str!("fixtures/emudhra/roots.pem")) {
        roots.add(cert).unwrap();
    }
    let verifier = WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .build()
    .unwrap();
    // Capture time, not wall time: leaf expiry must not turn this into a false pass.
    let now = UnixTime::since_unix_epoch(Duration::from_secs(1792594452));
    macro_rules! reject {
        ($host:literal) => {{
            let chain = certificates(include_str!(concat!("fixtures/emudhra/", $host, ".pem")));
            let error = verifier
                .verify_server_cert(
                    &chain[0],
                    &chain[1..],
                    &ServerName::try_from($host).unwrap(),
                    &[],
                    now,
                )
                .unwrap_err();
            assert!(
                format!("{error:?}").contains("CertDistrusted"),
                "{}: {error:?}",
                $host
            );
        }};
    }
    reject!("dv-g3b-aaa-emudhra.we-have-a-problem.com");
    reject!("dv-g3b-emudhra.we-have-a-problem.com");
    reject!("dv-g3c-aaa-emudhra.we-have-a-problem.com");
    reject!("dv-g3c-emudhra.we-have-a-problem.com");
    reject!("ov-g3b-aaa-emudhra.we-have-a-problem.com");
    reject!("ov-g3b-emudhra.we-have-a-problem.com");
    reject!("ov-g3c-aaa-emudhra.we-have-a-problem.com");
    reject!("ov-g3c-emudhra.we-have-a-problem.com");
    reject!("ev-g3b-aaa-emudhra.we-have-a-problem.com");
    reject!("ev-g3b-emudhra.we-have-a-problem.com");
    reject!("ev-g3c-aaa-emudhra.we-have-a-problem.com");
    reject!("ev-g3c-emudhra.we-have-a-problem.com");
}

#[test]
fn legitimate_fluux_chain_still_validates() {
    use rustls::client::danger::ServerCertVerifier;
    let mut roots = RootCertStore::empty();
    for cert in certificates(include_str!("fixtures/emudhra/control-root.pem")) {
        roots.add(cert).unwrap();
    }
    let verifier = WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .build()
    .unwrap();
    let chain = certificates(include_str!("fixtures/emudhra/control.pem"));
    verifier
        .verify_server_cert(
            &chain[0],
            &chain[1..],
            &ServerName::try_from("demo.fluux.io").unwrap(),
            &[],
            UnixTime::since_unix_epoch(Duration::from_secs(1792594452)),
        )
        .unwrap();
}

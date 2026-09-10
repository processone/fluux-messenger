// A separate test executable keeps rustls' process-global provider independent
// of proxy tests and plugins that might initialize it before this assertion.
#[path = "../src/tls.rs"]
mod tls;

#[test]
fn initializes_the_builds_provider_before_any_network_client() {
    use rustls::crypto::CryptoProvider;

    assert!(CryptoProvider::get_default().is_none());
    tls::init_crypto_provider();
    tls::init_crypto_provider();

    let provider = CryptoProvider::get_default().expect("startup must install a TLS provider");
    let expected_group = if cfg!(feature = "production-tls") {
        rustls::NamedGroup::X25519MLKEM768
    } else {
        rustls::NamedGroup::X25519
    };
    assert_eq!(
        provider.kx_groups[0].name(),
        expected_group,
        "the selected provider must match the build, including post-quantum preference in production"
    );

    // reqwest's no-provider mode panics here if the application only enabled
    // Cargo features without installing the provider before its first client.
    reqwest::blocking::Client::builder()
        .build()
        .expect("native uploads, downloads and link previews must work before XMPP connects");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        reqwest::Client::builder()
            .build()
            .expect("async HTTP clients must use the same startup provider");
    });
}

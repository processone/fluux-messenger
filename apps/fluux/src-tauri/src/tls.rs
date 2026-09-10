//! Process-wide TLS provider shared by reqwest, Tauri plugins and the XMPP proxy.

/// Install before any network client is created. Fail immediately if another
/// initializer has selected a provider, rather than silently changing the
/// production TLS policy according to which component makes the first request.
pub fn init_crypto_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        #[cfg(feature = "production-tls")]
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        #[cfg(not(feature = "production-tls"))]
        let provider = rustls::crypto::ring::default_provider();

        provider
            .install_default()
            .expect("Fluux must install its TLS provider before creating network clients");
    });
}

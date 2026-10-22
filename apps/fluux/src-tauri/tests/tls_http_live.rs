// FLM-28: test the HTTP plugin's reqwest 0.12 and native reqwest 0.13
// independently. A timeout/DNS error must never count as certificate rejection.
#[path = "../src/tls.rs"]
mod tls;

#[tokio::test]
#[ignore = "public network probe; run explicitly for TLS security updates"]
async fn emudhra_live_http_clients() {
    tls::init_crypto_provider();
    let plugin = tauri_plugin_http::reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap();
    let native = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap();
    for host in [
        "dv-g3b-emudhra.we-have-a-problem.com",
        "dv-g3b-aaa-emudhra.we-have-a-problem.com",
        "demo.fluux.io",
    ] {
        let url = format!("https://{host}/");
        let plugin_result = plugin.get(&url).send().await;
        let native_result = native.get(&url).send().await;
        if host == "demo.fluux.io" {
            assert!(plugin_result.is_ok(), "{plugin_result:?}");
            assert!(native_result.is_ok(), "{native_result:?}");
            println!("{host}: both HTTP clients accepted legitimate chain");
        } else {
            let plugin_error = format!("{:?}", plugin_result.unwrap_err());
            let native_error = format!("{:?}", native_result.unwrap_err());
            println!("{host}: plugin={plugin_error}; native={native_error}");
            assert!(plugin_error.contains("CertDistrusted"), "{plugin_error}");
            // Native HTTP uses the platform verifier on Apple platforms.
            assert!(
                native_error.contains("certificate") || native_error.contains("Certificate"),
                "{native_error}"
            );
        }
    }
}

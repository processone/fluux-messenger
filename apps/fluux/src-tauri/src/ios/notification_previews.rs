//! Prepares a decryption-only capability; the push plugin owns its shared-keychain write.
#[cfg(target_os = "ios")]
use crate::openpgp::OpenpgpState;
use crate::xmpp_proxy::dns::{parse_server_input, resolve_xmpp_server, ParsedServer, XmppEndpoint};
#[cfg(any(target_os = "ios", test))]
use crate::xmpp_proxy::dns::{to_ascii_host, ConnectionMode};
#[cfg(target_os = "ios")]
use serde::Serialize;
#[cfg(target_os = "ios")]
use std::sync::Arc;
#[cfg(target_os = "ios")]
use tauri::State;

#[cfg(target_os = "ios")]
#[derive(Serialize)]
pub struct Endpoint {
    address: String,
    tls_name: String,
    direct_tls: bool,
}
#[cfg(target_os = "ios")]
#[derive(Serialize)]
pub struct Material {
    domain: String,
    endpoints: Vec<Endpoint>,
    secret_b64: String,
}
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn ios_notification_preview_material(
    account_jid: String,
    server: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<Material, String> {
    use base64::Engine;
    crate::credentials::secret_account(crate::credentials::SecretKind::FastToken, &account_jid)?;
    let domain = account_jid
        .split('@')
        .nth(1)
        .ok_or("Invalid account")?
        .to_owned();
    let secret = state.notification_subkeys(&account_jid)?;
    let resolution = async {
        let input = if server.starts_with("ws://") || server.starts_with("wss://") {
            &domain
        } else {
            &server
        };
        let candidates = preview_candidates(input, &domain).await?;
        let mut endpoints = Vec::new();
        for endpoint in candidates.into_iter().take(4) {
            let host = to_ascii_host(&endpoint.host)?;
            let tls_name = to_ascii_host(endpoint.tls_name())?;
            let addresses = tokio::net::lookup_host((host.as_str(), endpoint.port))
                .await
                .map_err(|_| "Endpoint resolution failed".to_string())?;
            for address in addresses.take(2) {
                endpoints.push(Endpoint {
                    address: address.to_string(),
                    tls_name: tls_name.clone(),
                    direct_tls: endpoint.mode == ConnectionMode::DirectTls,
                });
            }
        }
        if endpoints.is_empty() {
            return Err("No notification fetch endpoint".to_string());
        }
        Ok(endpoints)
    };
    let endpoints = tokio::time::timeout(std::time::Duration::from_secs(8), resolution)
        .await
        .map_err(|_| "Endpoint resolution timed out")??;
    Ok(Material {
        domain,
        endpoints,
        secret_b64: base64::engine::general_purpose::STANDARD.encode(secret),
    })
}

async fn preview_candidates(
    input: &str,
    account_domain: &str,
) -> Result<Vec<XmppEndpoint>, String> {
    match parse_server_input(input) {
        ParsedServer::Domain(domain) => resolve_xmpp_server(&domain).await,
        ParsedServer::Direct(host, port, mode, domain) => Ok(vec![XmppEndpoint {
            host,
            port,
            mode,
            domain: domain.or_else(|| Some(account_domain.to_owned())),
        }]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn direct_preview_endpoint_preserves_tls_domain_precedence() {
        for (input, expected) in [
            (
                "tls://gateway.example:5223?domain=service.example",
                "service.example",
            ),
            ("tls://gateway.example:5223", "account.example"),
        ] {
            let endpoints = preview_candidates(input, "account.example").await.unwrap();
            assert_eq!(endpoints.len(), 1);
            assert_eq!(endpoints[0].host, "gateway.example");
            assert_eq!(endpoints[0].port, 5223);
            assert_eq!(endpoints[0].mode, ConnectionMode::DirectTls);
            assert_eq!(to_ascii_host(endpoints[0].tls_name()).unwrap(), expected);
        }
    }
}

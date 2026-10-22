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
/// Failure codes the settings screen maps to an explanation.
#[cfg(target_os = "ios")]
const KEY_UNAVAILABLE: &str = "key-unavailable";
#[cfg(target_os = "ios")]
const SERVER_UNREACHABLE: &str = "server-unreachable";
#[cfg(target_os = "ios")]
const CREDENTIAL_REFUSED: &str = "credential-refused";
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn ios_notification_preview_material(
    account_jid: String,
    server: String,
    state: State<'_, Arc<OpenpgpState>>,
) -> Result<Material, String> {
    use base64::Engine;
    let domain = account_domain(&account_jid)?;
    let secret = state
        .notification_subkeys(&account_jid)
        .map_err(|_| KEY_UNAVAILABLE.to_string())?;
    Ok(Material {
        endpoints: resolve_endpoints(&domain, &server).await?,
        domain,
        secret_b64: base64::engine::general_purpose::STANDARD.encode(secret),
    })
}

/// Obtains the notification extension's FAST token with the account password.
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn ios_notification_preview_provision(
    account_jid: String,
    server: String,
    password: String,
    user_agent_id: String,
) -> Result<fluux_nse_openpgp::FastToken, String> {
    let request = engine_request(
        &account_jid,
        &server,
        password,
        &user_agent_id,
        String::new(),
    )
    .await?;
    run_engine(move || fluux_nse_openpgp::provision(&request)).await
}

/// Has the server drop the notification extension's FAST token (XEP-0484 §6).
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn ios_notification_preview_invalidate(
    account_jid: String,
    server: String,
    user_agent_id: String,
    token: String,
) -> Result<(), String> {
    let request =
        engine_request(&account_jid, &server, String::new(), &user_agent_id, token).await?;
    run_engine(move || fluux_nse_openpgp::invalidate(&request)).await
}

#[cfg(target_os = "ios")]
fn account_domain(account_jid: &str) -> Result<String, String> {
    crate::credentials::secret_account(crate::credentials::SecretKind::FastToken, account_jid)?;
    Ok(account_jid
        .split('@')
        .nth(1)
        .ok_or("Invalid account")?
        .to_owned())
}

#[cfg(target_os = "ios")]
async fn engine_request(
    account_jid: &str,
    server: &str,
    password: String,
    user_agent_id: &str,
    fast_token: String,
) -> Result<fluux_nse_openpgp::Request, String> {
    let domain = account_domain(account_jid)?;
    let endpoints = resolve_endpoints(&domain, server).await?;
    serde_json::from_value(serde_json::json!({
        "account": account_jid,
        "domain": domain,
        "password": password,
        "user_agent_id": user_agent_id,
        "fast_token": fast_token,
        "endpoints": endpoints,
    }))
    .map_err(|_| "Invalid notification preview request".to_string())
}

/// Runs a blocking engine sign-in off the async runtime; a refusal is reported apart from a
/// server that could not be reached.
#[cfg(target_os = "ios")]
async fn run_engine<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| SERVER_UNREACHABLE.to_string())?
        .map_err(|error| {
            if error.is::<fluux_nse_openpgp::Refused>() {
                CREDENTIAL_REFUSED.to_string()
            } else {
                SERVER_UNREACHABLE.to_string()
            }
        })
}

#[cfg(target_os = "ios")]
async fn resolve_endpoints(domain: &str, server: &str) -> Result<Vec<Endpoint>, String> {
    let resolution = async {
        let input =
            if server.is_empty() || server.starts_with("ws://") || server.starts_with("wss://") {
                domain
            } else {
                server
            };
        let candidates = preview_candidates(input, domain).await?;
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
    tokio::time::timeout(std::time::Duration::from_secs(8), resolution)
        .await
        .map_err(|_| SERVER_UNREACHABLE.to_string())?
        .map_err(|_: String| SERVER_UNREACHABLE.to_string())
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

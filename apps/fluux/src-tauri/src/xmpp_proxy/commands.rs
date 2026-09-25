use crate::xmpp_proxy;

/// Upper bound for one start/stop proxy IPC command.
///
/// Normal operation is expected to complete quickly; these are circuit breakers
/// so a wedged proxy command cannot block the frontend indefinitely.
const START_XMPP_PROXY_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const STOP_XMPP_PROXY_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Start XMPP WebSocket-to-TCP proxy.
/// The `server` parameter supports: `tls://host:port`, `tcp://host:port`, `host:port`, or bare `domain`.
#[tauri::command]
pub(crate) async fn start_xmpp_proxy(
    app: tauri::AppHandle,
    server: String,
) -> Result<xmpp_proxy::ProxyStartResult, String> {
    tokio::time::timeout(
        START_XMPP_PROXY_COMMAND_TIMEOUT,
        async {
            #[cfg(target_os = "android")]
            xmpp_proxy::android::initialize_dns_context(&app).await?;
            xmpp_proxy::start_proxy(server, Some(app)).await
        },
    )
    .await
    .map_err(|_| {
        tracing::warn!(
            timeout_secs = START_XMPP_PROXY_COMMAND_TIMEOUT.as_secs(),
            "start_xmpp_proxy command timed out"
        );
        format!(
            "start_xmpp_proxy timed out after {}s",
            START_XMPP_PROXY_COMMAND_TIMEOUT.as_secs()
        )
    })?
}

/// Stop XMPP WebSocket-to-TCP proxy
#[tauri::command]
pub(crate) async fn stop_xmpp_proxy() -> Result<(), String> {
    tokio::time::timeout(STOP_XMPP_PROXY_COMMAND_TIMEOUT, xmpp_proxy::stop_proxy())
        .await
        .map_err(|_| {
            tracing::warn!(
                timeout_secs = STOP_XMPP_PROXY_COMMAND_TIMEOUT.as_secs(),
                "stop_xmpp_proxy command timed out"
            );
            format!(
                "stop_xmpp_proxy timed out after {}s",
                STOP_XMPP_PROXY_COMMAND_TIMEOUT.as_secs()
            )
        })?
}

use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::Serialize;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use super::protocol::{handle_request, JsonRpcRequest, JsonRpcResponse, ToolExecutor};

/// Returned to the frontend when the server starts and surfaced through the
/// Settings panel's copy button. The token persists in the OS keychain (so a
/// configured MCP client keeps working across restarts) — deliberately never
/// in a plaintext file, so there is nothing for another process or a
/// backup/sync tool to pick up. The port is sticky on a best-effort basis:
/// the webview passes back the last bound port and we try to reuse it.
#[derive(Debug, Clone, Serialize)]
pub struct McpServerInfo {
    pub port: u16,
    pub token: String,
}

struct McpAppState {
    token: String,
    executor: Arc<dyn ToolExecutor>,
}

fn build_router(state: Arc<McpAppState>) -> Router {
    Router::new().route("/mcp", post(handle_mcp_request)).with_state(state)
}

/// Takes the body as raw `Bytes` (never rejects) instead of `Json<T>` so the
/// bearer-token check runs BEFORE any parsing: with the `Json` extractor an
/// unauthenticated caller sending a malformed body would get a 400/422 from
/// the extractor instead of the intended 401, and would burn parse work
/// pre-auth. Parse failures from AUTHORIZED callers get a proper JSON-RPC
/// -32700 Parse error instead of axum's plain HTTP rejection.
async fn handle_mcp_request(
    State(state): State<Arc<McpAppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<axum::response::Response, StatusCode> {
    let expected = format!("Bearer {}", state.token);
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == expected)
        .unwrap_or(false);

    if !authorized {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let request: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(e) => {
            return Ok(Json(JsonRpcResponse::error(
                serde_json::Value::Null,
                -32700,
                format!("Parse error: {e}"),
            ))
            .into_response())
        }
    };

    match handle_request(request, state.executor.as_ref()).await {
        Some(response) => Ok(Json(response).into_response()),
        None => Ok(StatusCode::ACCEPTED.into_response()),
    }
}

/// A running MCP server instance. Dropping/`stop`-ing it aborts the serve task.
pub struct McpServerHandle {
    pub info: McpServerInfo,
    task: JoinHandle<()>,
}

impl McpServerHandle {
    /// Abort the serve task and wait for it to actually terminate, so the
    /// listening socket is released before this returns — a caller that stops
    /// then immediately restarts (sticky-port rebind) must not race the drop.
    pub async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

/// Bind a loopback listener, preferring `preferred_port` (so a user's MCP
/// client config keeps working across restarts) and falling back to an
/// OS-assigned port when it is unavailable. `SO_REUSEADDR` (non-Windows only:
/// on Windows that flag would let another process hijack an active port)
/// allows an immediate rebind of the same port after a disable/enable cycle.
async fn bind_listener(preferred_port: Option<u16>) -> Result<TcpListener, String> {
    async fn try_bind(port: u16) -> std::io::Result<TcpListener> {
        let socket = tokio::net::TcpSocket::new_v4()?;
        #[cfg(not(windows))]
        socket.set_reuseaddr(true)?;
        socket.bind(std::net::SocketAddr::from(([127, 0, 0, 1], port)))?;
        socket.listen(1024)
    }

    if let Some(port) = preferred_port {
        if let Ok(listener) = try_bind(port).await {
            return Ok(listener);
        }
        // Preferred port taken by another process — fall back to a fresh one;
        // the caller persists whatever port we actually bound.
    }
    try_bind(0).await.map_err(|e| format!("Failed to bind MCP server: {e}"))
}

/// Bind and start serving MCP JSON-RPC requests with the given bearer token.
/// Does not touch the module-level singleton — see `start`/`stop` below for
/// the idempotent, Tauri-command-facing wrapper.
pub(crate) async fn bind_and_serve(
    executor: Arc<dyn ToolExecutor>,
    preferred_port: Option<u16>,
    token: String,
) -> Result<McpServerHandle, String> {
    let listener = bind_listener(preferred_port).await?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read MCP server port: {e}"))?
        .port();

    let state = Arc::new(McpAppState { token: token.clone(), executor });
    let router = build_router(state);

    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    Ok(McpServerHandle { info: McpServerInfo { port, token }, task })
}

/// Global MCP server singleton, mirroring `xmpp_proxy`'s `PROXY` static
/// (see xmpp_proxy/mod.rs). Idempotent: starting again stops the old one first.
static MCP_SERVER: tokio::sync::RwLock<Option<McpServerHandle>> = tokio::sync::RwLock::const_new(None);

/// Start (or restart) the MCP server. Exposed to the `mcp_start_server` Tauri
/// command, which owns token persistence (OS keychain) and hands us the token.
pub async fn start(
    executor: Arc<dyn ToolExecutor>,
    preferred_port: Option<u16>,
    token: String,
) -> Result<McpServerInfo, String> {
    let mut guard = MCP_SERVER.write().await;
    if let Some(old) = guard.take() {
        old.stop().await;
    }
    let handle = bind_and_serve(executor, preferred_port, token).await?;
    let info = handle.info.clone();
    *guard = Some(handle);
    Ok(info)
}

/// Stop the MCP server if running. Exposed to the `mcp_stop_server` Tauri command.
pub async fn stop() -> Result<(), String> {
    let mut guard = MCP_SERVER.write().await;
    if let Some(handle) = guard.take() {
        handle.stop().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    struct EchoExecutor;

    #[async_trait::async_trait]
    impl ToolExecutor for EchoExecutor {
        async fn call_tool(&self, name: &str, _arguments: serde_json::Value) -> Result<serde_json::Value, String> {
            Ok(serde_json::json!({ "called": name }))
        }
    }

    fn test_router(token: &str) -> Router {
        let state = Arc::new(McpAppState { token: token.to_string(), executor: Arc::new(EchoExecutor) });
        build_router(state)
    }

    #[tokio::test]
    async fn rejects_missing_bearer_token() {
        let router = test_router("secret");
        let request = Request::post("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_wrong_bearer_token() {
        let router = test_router("secret");
        let request = Request::post("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, "Bearer wrong")
            .body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn accepts_correct_bearer_token() {
        let router = test_router("secret");
        let request = Request::post("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn notification_gets_202_with_no_body() {
        let router = test_router("secret");
        let request = Request::post("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::from(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn malformed_body_without_token_gets_401_not_a_parse_rejection() {
        let router = test_router("secret");
        let request = Request::post("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("this is not json"))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        // Auth must be checked before the body is parsed: an unauthenticated
        // caller learns nothing about the expected request shape.
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn malformed_body_with_valid_token_gets_jsonrpc_parse_error() {
        let router = test_router("secret");
        let request = Request::post("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::from("this is not json"))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["error"]["code"], -32700);
    }

    #[tokio::test]
    async fn bind_and_serve_returns_a_nonzero_loopback_port_and_token() {
        let handle = bind_and_serve(Arc::new(EchoExecutor), None, "tok".to_string())
            .await
            .expect("server should start");
        assert!(handle.info.port > 0);
        assert_eq!(handle.info.token, "tok");
        handle.stop().await;
    }

    #[tokio::test]
    async fn bind_and_serve_reuses_the_preferred_port_when_free() {
        // Learn a free port, release it, then ask for it back.
        let probe = bind_and_serve(Arc::new(EchoExecutor), None, "tok".to_string())
            .await
            .expect("probe server should start");
        let port = probe.info.port;
        probe.stop().await;

        let handle = bind_and_serve(Arc::new(EchoExecutor), Some(port), "tok".to_string())
            .await
            .expect("server should rebind the preferred port");
        assert_eq!(handle.info.port, port, "the preferred port should be honored when available");
        handle.stop().await;
    }

    #[tokio::test]
    async fn bind_and_serve_falls_back_when_the_preferred_port_is_taken() {
        // Occupy a port with a plain listener, then prefer that same port.
        let blocker = TcpListener::bind("127.0.0.1:0").await.expect("blocker should bind");
        let taken = blocker.local_addr().expect("blocker addr").port();

        let handle = bind_and_serve(Arc::new(EchoExecutor), Some(taken), "tok".to_string())
            .await
            .expect("server should fall back to a fresh port");
        assert_ne!(handle.info.port, taken, "a taken preferred port must fall back, not fail");
        assert!(handle.info.port > 0);
        handle.stop().await;
    }
}

use axum::{
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

use super::protocol::{handle_request, JsonRpcRequest, ToolExecutor};

/// Returned to the frontend (and written to the connection info file) when
/// the server starts.
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

async fn handle_mcp_request(
    State(state): State<Arc<McpAppState>>,
    headers: HeaderMap,
    Json(request): Json<JsonRpcRequest>,
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
    pub fn stop(self) {
        self.task.abort();
    }
}

/// Bind a random loopback port and start serving MCP JSON-RPC requests.
/// Does not touch the module-level singleton — see `start`/`stop` below for
/// the idempotent, Tauri-command-facing wrapper.
pub(crate) async fn bind_and_serve(executor: Arc<dyn ToolExecutor>) -> Result<McpServerHandle, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind MCP server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read MCP server port: {e}"))?
        .port();
    let token = uuid::Uuid::new_v4().to_string();

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

/// Start (or restart) the MCP server. Exposed to the `mcp_start_server` Tauri command.
pub async fn start(executor: Arc<dyn ToolExecutor>) -> Result<McpServerInfo, String> {
    let mut guard = MCP_SERVER.write().await;
    if let Some(old) = guard.take() {
        old.stop();
    }
    let handle = bind_and_serve(executor).await?;
    let info = handle.info.clone();
    *guard = Some(handle);
    Ok(info)
}

/// Stop the MCP server if running. Exposed to the `mcp_stop_server` Tauri command.
pub async fn stop() -> Result<(), String> {
    let mut guard = MCP_SERVER.write().await;
    if let Some(handle) = guard.take() {
        handle.stop();
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
    async fn bind_and_serve_returns_a_nonzero_loopback_port_and_token() {
        let handle = bind_and_serve(Arc::new(EchoExecutor)).await.expect("server should start");
        assert!(handle.info.port > 0);
        assert!(!handle.info.token.is_empty());
        handle.stop();
    }
}

# Fluux MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a local MCP (Model Context Protocol) server in the Tauri desktop app so Claude Desktop/Code can list conversations, read history, and send messages through Fluux.

**Architecture:** Rust hosts a Streamable-HTTP JSON-RPC endpoint on a random loopback port, bearer-token protected. Tool calls (`tools/call`) are proxied live to the webview via a Tauri event + a matching `mcp_respond` command (request/response correlated by id, with a timeout), because the actual conversation data lives in the SDK's Zustand stores inside the webview, not in Rust. The JS side reads `chatStore`/`roomStore` directly and calls the real `Chat.sendMessage()`, so encryption, rate-limit-worthy side effects, and error handling all reuse existing SDK behavior instead of being reimplemented.

**Tech Stack:** Rust (`tauri` v2, `tokio`, new: `axum`, `uuid`, `async-trait`), TypeScript/React (`@fluux/sdk`, Zustand, `@tauri-apps/api`).

## Global Constraints

- Loopback-only: the HTTP server binds `127.0.0.1:0` (OS-assigned port) — never `0.0.0.0` or a fixed port.
- Every request must carry `Authorization: Bearer <token>`, where `<token>` is regenerated each time the server starts.
- No bulk "dump everything" tool: `get_history` requires an explicit `conversationId` and caps `limit` at 200.
- `send_message` must call the SDK's real `Chat.sendMessage()` (via `client.chat.sendMessage`) — never a lower-level stanza-building shortcut — so it inherits the existing E2EE invariant in `Chat.ts` for free (see [Chat.ts:518](../../../packages/fluux-sdk/src/core/modules/Chat.ts)).
- The feature is off by default (`fluux-mcp-enabled` defaults to `false`) and Tauri-desktop-only (gated by `isTauri()`).
- Every new/changed user-facing string must be added to `apps/fluux/src/i18n/locales/en.json` AND translated into the other 32 locale files in that directory — no English placeholders left behind (see Task 11).

---

### Task 1: MCP JSON-RPC protocol (pure logic, no HTTP yet)

**Files:**
- Create: `apps/fluux/src-tauri/src/mcp/mod.rs`
- Create: `apps/fluux/src-tauri/src/mcp/protocol.rs`
- Modify: `apps/fluux/src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `mcp::protocol::{JsonRpcRequest, JsonRpcResponse, JsonRpcErrorObject, ToolExecutor, tool_definitions, handle_request}` — consumed by Task 2 (HTTP transport) and Task 3 (bridge executor).
- `ToolExecutor` trait: `async fn call_tool(&self, name: &str, arguments: serde_json::Value) -> Result<serde_json::Value, String>`.
- `handle_request(request: JsonRpcRequest, executor: &dyn ToolExecutor) -> Option<JsonRpcResponse>` — `None` means "notification, no response body expected" (e.g. `notifications/initialized`).

- [ ] **Step 1: Add dependencies to Cargo.toml**

In `apps/fluux/src-tauri/Cargo.toml`, add to the `[dependencies]` section (right after the existing `serde = { version = "1", features = ["derive"] }` line):

```toml
serde_json = "1"
async-trait = "0.1"
```

(`serde_json` is already a dev-dependency only — promote it to a real dependency since `mcp/protocol.rs` needs it outside tests too. If cargo complains about a duplicate key when it's already listed under `[dev-dependencies]`, that's fine — dev-dependencies and dependencies are independent sections.)

- [ ] **Step 2: Create the module root**

Create `apps/fluux/src-tauri/src/mcp/mod.rs`:

```rust
pub mod protocol;
```

(Task 2 and Task 3 will add `pub mod server;` and `pub mod bridge;` here.)

- [ ] **Step 3: Write the failing tests**

Create `apps/fluux/src-tauri/src/mcp/protocol.rs`:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON-RPC 2.0 request, as sent by an MCP client.
#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// A JSON-RPC 2.0 response.
#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcErrorObject>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcErrorObject {
    pub code: i32,
    pub message: String,
}

impl JsonRpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self { jsonrpc: "2.0".to_string(), id, result: Some(result), error: None }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcErrorObject { code, message: message.into() }),
        }
    }
}

/// Executes a named MCP tool with the given arguments, returning the tool's
/// JSON result or an error message. Implemented for real by
/// `TauriBridgeExecutor` (mcp/bridge.rs, Task 3) and by a mock in tests.
#[async_trait::async_trait]
pub trait ToolExecutor: Send + Sync {
    async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, String>;
}

/// The three tools this MCP server exposes, as MCP `tools/list` entries.
pub fn tool_definitions() -> Value {
    serde_json::json!([
        {
            "name": "list_conversations",
            "description": "List all 1:1 chats and group chat rooms, with encryption status and last-message time.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "get_history",
            "description": "Get message history for one conversation, paginated from newest backward.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "conversationId": { "type": "string", "description": "The conversation or room JID returned by list_conversations." },
                    "limit": { "type": "integer", "description": "Max messages to return (default 50, max 200)." },
                    "before": { "type": "string", "description": "ISO 8601 timestamp; only return messages before this time." }
                },
                "required": ["conversationId"]
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "send_message",
            "description": "Send a message into a conversation or room. Encrypted automatically if the conversation uses E2EE.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "conversationId": { "type": "string" },
                    "body": { "type": "string" }
                },
                "required": ["conversationId", "body"]
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false }
        }
    ])
}

const PROTOCOL_VERSION: &str = "2025-06-18";

/// Handle one JSON-RPC request. `executor` is only invoked for `tools/call`.
/// Returns `None` for notifications (no `id` in the wire message, no response expected).
pub async fn handle_request(
    request: JsonRpcRequest,
    executor: &dyn ToolExecutor,
) -> Option<JsonRpcResponse> {
    match request.method.as_str() {
        "initialize" => Some(JsonRpcResponse::success(
            request.id,
            serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "fluux", "version": env!("CARGO_PKG_VERSION") }
            }),
        )),
        "notifications/initialized" => None,
        "tools/list" => Some(JsonRpcResponse::success(
            request.id,
            serde_json::json!({ "tools": tool_definitions() }),
        )),
        "tools/call" => {
            let name = request.params.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let arguments = request
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            match executor.call_tool(name, arguments).await {
                Ok(result) => Some(JsonRpcResponse::success(
                    request.id,
                    serde_json::json!({
                        "content": [{ "type": "text", "text": serde_json::to_string(&result).unwrap_or_default() }]
                    }),
                )),
                Err(message) => Some(JsonRpcResponse::error(request.id, -32000, message)),
            }
        }
        other => Some(JsonRpcResponse::error(
            request.id,
            -32601,
            format!("Method not found: {other}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct MockToolExecutor {
        response: Result<Value, String>,
    }

    #[async_trait::async_trait]
    impl ToolExecutor for MockToolExecutor {
        async fn call_tool(&self, _name: &str, _arguments: Value) -> Result<Value, String> {
            self.response.clone()
        }
    }

    fn request(id: i64, method: &str, params: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: serde_json::json!(id),
            method: method.to_string(),
            params,
        }
    }

    #[tokio::test]
    async fn initialize_returns_protocol_version() {
        let executor = MockToolExecutor { response: Ok(serde_json::json!({})) };
        let response = handle_request(request(1, "initialize", serde_json::json!({})), &executor)
            .await
            .unwrap();
        assert_eq!(response.result.unwrap()["protocolVersion"], PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn notifications_initialized_returns_none() {
        let executor = MockToolExecutor { response: Ok(serde_json::json!({})) };
        let response = handle_request(
            request(0, "notifications/initialized", serde_json::json!({})),
            &executor,
        )
        .await;
        assert!(response.is_none());
    }

    #[tokio::test]
    async fn tools_list_returns_three_tools() {
        let executor = MockToolExecutor { response: Ok(serde_json::json!({})) };
        let response = handle_request(request(2, "tools/list", serde_json::json!({})), &executor)
            .await
            .unwrap();
        let tools = response.result.unwrap()["tools"].as_array().unwrap().len();
        assert_eq!(tools, 3);
    }

    #[tokio::test]
    async fn tools_call_delegates_to_executor_and_wraps_error() {
        let executor = MockToolExecutor { response: Err("boom".to_string()) };
        let response = handle_request(
            request(3, "tools/call", serde_json::json!({ "name": "send_message", "arguments": {} })),
            &executor,
        )
        .await
        .unwrap();
        assert_eq!(response.error.unwrap().message, "boom");
    }

    #[tokio::test]
    async fn unknown_method_returns_error() {
        let executor = MockToolExecutor { response: Ok(serde_json::json!({})) };
        let response = handle_request(request(4, "bogus", serde_json::json!({})), &executor)
            .await
            .unwrap();
        assert_eq!(response.error.unwrap().code, -32601);
    }
}
```

- [ ] **Step 4: Register the module and run the tests**

Modify `apps/fluux/src-tauri/src/main.rs`: add `mod mcp;` right after the existing `mod notifications;` line ([main.rs:203](../../../apps/fluux/src-tauri/src/main.rs)):

```rust
mod notifications;
mod mcp;
```

Run: `cd apps/fluux/src-tauri && cargo test mcp::protocol`
Expected: 5 tests pass (`initialize_returns_protocol_version`, `notifications_initialized_returns_none`, `tools_list_returns_three_tools`, `tools_call_delegates_to_executor_and_wraps_error`, `unknown_method_returns_error`).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src-tauri/Cargo.toml apps/fluux/src-tauri/src/mcp/mod.rs apps/fluux/src-tauri/src/mcp/protocol.rs apps/fluux/src-tauri/src/main.rs
git commit -m "feat(mcp): add MCP JSON-RPC protocol layer"
```

---

### Task 2: axum HTTP transport (loopback bind + bearer auth)

**Files:**
- Create: `apps/fluux/src-tauri/src/mcp/server.rs`
- Modify: `apps/fluux/src-tauri/src/mcp/mod.rs`
- Modify: `apps/fluux/src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `mcp::protocol::{JsonRpcRequest, JsonRpcResponse, ToolExecutor, handle_request}` (Task 1).
- Produces: `mcp::server::{McpServerInfo, McpServerHandle, start, stop}` — `start`/`stop` (the idempotent, module-static-backed versions) are consumed by Task 4's Tauri commands.

- [ ] **Step 1: Add dependencies**

In `apps/fluux/src-tauri/Cargo.toml`, add to `[dependencies]` (after the `async-trait` line added in Task 1):

```toml
axum = "0.8"
uuid = { version = "1", features = ["v4"] }
```

Add to `[dev-dependencies]` (alongside the existing `tokio = { version = "1", features = ["test-util"] }` line):

```toml
tower = { version = "0.5", features = ["util"] }
```

If `cargo build` reports a version conflict between axum's `http`/`hyper` and another dependency, drop the axum version pin down to the newest `0.7.x` release instead — the router/handler code in this task doesn't use anything version-specific.

- [ ] **Step 2: Write the failing tests**

Create `apps/fluux/src-tauri/src/mcp/server.rs`:

```rust
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

use super::protocol::{handle_request, JsonRpcRequest, JsonRpcResponse, ToolExecutor};

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
```

- [ ] **Step 3: Register the new submodule and run the tests**

Modify `apps/fluux/src-tauri/src/mcp/mod.rs`:

```rust
pub mod protocol;
pub mod server;
```

Run: `cd apps/fluux/src-tauri && cargo test mcp::server`
Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src-tauri/Cargo.toml apps/fluux/src-tauri/src/mcp/mod.rs apps/fluux/src-tauri/src/mcp/server.rs
git commit -m "feat(mcp): add loopback HTTP transport with bearer auth"
```

---

### Task 3: Rust↔JS bridge (pending requests + Tauri event executor)

**Files:**
- Create: `apps/fluux/src-tauri/src/mcp/bridge.rs`
- Modify: `apps/fluux/src-tauri/src/mcp/mod.rs`

**Interfaces:**
- Consumes: `mcp::protocol::ToolExecutor` (Task 1).
- Produces: `mcp::bridge::{PendingRequests, TauriBridgeExecutor, McpToolCallEvent, mcp_respond}` — consumed by Task 4 (`main.rs` wiring) and by the JS side (Task 8) which listens for the `mcp:tool-call` event this module emits and calls the `mcp_respond` command it exposes.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src-tauri/src/mcp/bridge.rs`:

```rust
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::oneshot;

use super::protocol::ToolExecutor;

const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Tracks in-flight MCP tool calls waiting on a reply from the webview.
#[derive(Default)]
pub struct PendingRequests {
    inner: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
}

impl PendingRequests {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new pending call, returning its id and a receiver that
    /// resolves when `resolve` is called with the same id.
    pub fn register(&self) -> (String, oneshot::Receiver<serde_json::Value>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.inner.lock().expect("PendingRequests mutex poisoned").insert(id.clone(), tx);
        (id, rx)
    }

    /// Resolve a pending call by id. Returns false if no such call is pending
    /// (already resolved, forgotten, or an unknown id).
    pub fn resolve(&self, id: &str, value: serde_json::Value) -> bool {
        let sender = self.inner.lock().expect("PendingRequests mutex poisoned").remove(id);
        match sender {
            Some(tx) => tx.send(value).is_ok(),
            None => false,
        }
    }

    fn forget(&self, id: &str) {
        self.inner.lock().expect("PendingRequests mutex poisoned").remove(id);
    }
}

/// Payload emitted to the webview for each incoming MCP tool call.
#[derive(Debug, Clone, Serialize)]
pub struct McpToolCallEvent {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// `ToolExecutor` that hands tool calls to the webview via a Tauri event and
/// awaits the matching `mcp_respond` command, with a timeout so a stalled or
/// closed webview cannot hang an MCP client forever.
pub struct TauriBridgeExecutor {
    app: tauri::AppHandle,
    pending: Arc<PendingRequests>,
}

impl TauriBridgeExecutor {
    pub fn new(app: tauri::AppHandle, pending: Arc<PendingRequests>) -> Self {
        Self { app, pending }
    }
}

#[async_trait::async_trait]
impl ToolExecutor for TauriBridgeExecutor {
    async fn call_tool(&self, name: &str, arguments: serde_json::Value) -> Result<serde_json::Value, String> {
        let (id, receiver) = self.pending.register();

        let event = McpToolCallEvent { id: id.clone(), name: name.to_string(), arguments };
        if let Err(e) = self.app.emit("mcp:tool-call", event) {
            self.pending.forget(&id);
            return Err(format!("Failed to dispatch tool call: {e}"));
        }

        match tokio::time::timeout(TOOL_CALL_TIMEOUT, receiver).await {
            Ok(Ok(value)) => match value.get("error").and_then(|e| e.as_str()) {
                Some(error_message) => Err(error_message.to_string()),
                None => Ok(value),
            },
            Ok(Err(_)) => Err("MCP bridge dropped the request".to_string()),
            Err(_) => {
                self.pending.forget(&id);
                Err(format!("Tool call timed out after {}s", TOOL_CALL_TIMEOUT.as_secs()))
            }
        }
    }
}

/// Tauri command: the webview calls this once it has a result for a tool
/// call it received via the `mcp:tool-call` event. `result` is either the
/// raw tool result or `{"error": "message"}` on failure.
#[tauri::command]
pub fn mcp_respond(
    id: String,
    result: serde_json::Value,
    pending: tauri::State<'_, Arc<PendingRequests>>,
) -> Result<(), String> {
    if pending.resolve(&id, result) {
        Ok(())
    } else {
        Err(format!("No pending MCP request with id {id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_delivers_the_value_to_the_waiting_receiver() {
        let pending = PendingRequests::new();
        let (id, receiver) = pending.register();

        assert!(pending.resolve(&id, serde_json::json!({ "ok": true })));

        let value = receiver.await.expect("receiver should resolve");
        assert_eq!(value, serde_json::json!({ "ok": true }));
    }

    #[tokio::test]
    async fn resolve_returns_false_for_unknown_id() {
        let pending = PendingRequests::new();
        assert!(!pending.resolve("does-not-exist", serde_json::json!({})));
    }

    #[tokio::test]
    async fn resolve_returns_false_after_the_request_is_forgotten() {
        let pending = PendingRequests::new();
        let (id, _receiver) = pending.register();
        pending.forget(&id);
        assert!(!pending.resolve(&id, serde_json::json!({})));
    }

    #[tokio::test(start_paused = true)]
    async fn a_never_resolved_request_times_out() {
        let pending = PendingRequests::new();
        let (_id, receiver) = pending.register();

        let result = tokio::time::timeout(Duration::from_secs(1), receiver).await;
        assert!(result.is_err(), "expected a timeout since nothing resolved the request");
    }
}
```

Note: `TauriBridgeExecutor::call_tool`'s event-emit path is not unit tested here — it needs a real `tauri::AppHandle`, which requires a running app. The `PendingRequests` logic it depends on (register/resolve/timeout) is fully covered above; the thin emit wrapper is covered by Task 4's manual build/run verification.

- [ ] **Step 2: Register the new submodule and run the tests**

Modify `apps/fluux/src-tauri/src/mcp/mod.rs`:

```rust
pub mod protocol;
pub mod server;
pub mod bridge;
```

Run: `cd apps/fluux/src-tauri && cargo test mcp::bridge`
Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src-tauri/src/mcp/mod.rs apps/fluux/src-tauri/src/mcp/bridge.rs
git commit -m "feat(mcp): add Rust-to-webview tool-call bridge"
```

---

### Task 4: Wire Tauri commands into main.rs

**Files:**
- Modify: `apps/fluux/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `mcp::server::{start, stop, McpServerInfo}` (Task 2), `mcp::bridge::{PendingRequests, TauriBridgeExecutor, mcp_respond}` (Task 3).
- Produces: Tauri commands `mcp_start_server`, `mcp_stop_server`, `mcp_respond` — consumed by the JS side (Task 8) via `invoke(...)`.

- [ ] **Step 1: Add the managed state**

Modify `apps/fluux/src-tauri/src/main.rs`: inside the `.setup(move |app| { ... })` closure, right after the existing `app.manage(Arc::clone(&openpgp_state));` line ([main.rs:1549](../../../apps/fluux/src-tauri/src/main.rs)), add:

```rust
app.manage(Arc::new(mcp::bridge::PendingRequests::new()));
```

- [ ] **Step 2: Add the two lifecycle commands**

Modify `apps/fluux/src-tauri/src/main.rs`: right after the existing `stop_xmpp_proxy` function ([main.rs:611-618](../../../apps/fluux/src-tauri/src/main.rs)), add:

```rust
/// Start the local MCP server (Model Context Protocol) for Claude
/// Desktop/Code to read history and send messages through Fluux.
#[tauri::command]
async fn mcp_start_server(
    app: tauri::AppHandle,
    pending: tauri::State<'_, Arc<mcp::bridge::PendingRequests>>,
) -> Result<mcp::server::McpServerInfo, String> {
    let executor = Arc::new(mcp::bridge::TauriBridgeExecutor::new(app, pending.inner().clone()));
    mcp::server::start(executor).await
}

/// Stop the local MCP server.
#[tauri::command]
async fn mcp_stop_server() -> Result<(), String> {
    mcp::server::stop().await
}
```

- [ ] **Step 3: Register the three commands**

Modify `apps/fluux/src-tauri/src/main.rs`: in the `invoke_handler!` list ([main.rs:1399-1431](../../../apps/fluux/src-tauri/src/main.rs)), add right after `stop_xmpp_proxy,`:

```rust
            stop_xmpp_proxy,
            mcp_start_server,
            mcp_stop_server,
            mcp::bridge::mcp_respond,
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd apps/fluux/src-tauri && cargo build`
Expected: builds successfully with no errors (warnings about unused imports, if any, should be cleaned up before commit).

- [ ] **Step 5: Run the full Rust test suite**

Run: `cd apps/fluux/src-tauri && cargo test`
Expected: all tests pass, including the `mcp::*` tests from Tasks 1–3.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src-tauri/src/main.rs
git commit -m "feat(mcp): wire MCP server lifecycle commands into the Tauri app"
```

---

### Task 5: JS tool handlers — list_conversations + get_history

**Files:**
- Create: `apps/fluux/src/utils/mcpTools.ts`
- Test: `apps/fluux/src/utils/mcpTools.test.ts`

**Interfaces:**
- Consumes: `chatStore`, `roomStore` from `@fluux/sdk` (vanilla, non-React store access — both expose `.getState().conversations` / `.getState().rooms` and `.getState().loadMessagesFromCache(id, { limit, before, peek })`).
- Produces: `mcpTools.{listConversations, getHistory, McpConversationSummary, McpHistoryMessage}` — consumed by Task 8's `useMcpBridge` dispatcher.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/utils/mcpTools.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatStore, roomStore, type Conversation, type Message, type Room } from '@fluux/sdk'
import { listConversations, getHistory } from './mcpTools'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    type: 'chat',
    id: 'msg-1',
    from: 'alice@example.com',
    body: 'hello',
    timestamp: new Date('2026-07-01T10:00:00Z'),
    isOutgoing: false,
    ...overrides,
  } as Message
}

describe('mcpTools', () => {
  beforeEach(() => {
    chatStore.getState().reset()
    roomStore.getState().reset()
  })

  describe('listConversations', () => {
    it('returns chat conversations with encryption status from the last message', () => {
      const conversation = {
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        unreadCount: 0,
        lastMessage: makeMessage({ securityContext: { protocolId: 'omemo:2', trust: 'verified' } }),
      } as Conversation
      chatStore.setState({ conversations: new Map([[conversation.id, conversation]]) })

      const result = listConversations()

      expect(result).toEqual([
        expect.objectContaining({
          conversationId: 'alice@example.com',
          displayName: 'Alice',
          type: 'chat',
          isEncrypted: true,
        }),
      ])
    })

    it('returns groupchat rooms, falling back to the room jid for the display name', () => {
      const room = { jid: 'room@conference.example.com', name: undefined, lastMessage: undefined } as unknown as Room
      roomStore.setState({ rooms: new Map([[room.jid, room]]) })

      const result = listConversations()

      expect(result).toEqual([
        expect.objectContaining({
          conversationId: 'room@conference.example.com',
          displayName: 'room@conference.example.com',
          type: 'groupchat',
          isEncrypted: false,
        }),
      ])
    })
  })

  describe('getHistory', () => {
    it('reads chat history via a peek load and reports per-message encryption', async () => {
      chatStore.setState({
        conversations: new Map([['alice@example.com', { id: 'alice@example.com' } as Conversation]]),
      })
      const loadSpy = vi
        .spyOn(chatStore.getState(), 'loadMessagesFromCache')
        .mockResolvedValue([makeMessage({ securityContext: { protocolId: 'openpgp', trust: 'tofu' } })])

      const result = await getHistory('alice@example.com', 10)

      expect(loadSpy).toHaveBeenCalledWith('alice@example.com', { limit: 10, before: undefined, peek: true })
      expect(result).toEqual([
        expect.objectContaining({ from: 'alice@example.com', body: 'hello', isEncrypted: true }),
      ])
    })

    it('caps the limit at 200 and routes room ids to roomStore', async () => {
      roomStore.setState({
        rooms: new Map([['room@conference.example.com', { jid: 'room@conference.example.com' } as Room]]),
      })
      const loadSpy = vi.spyOn(roomStore.getState(), 'loadMessagesFromCache').mockResolvedValue([])

      await getHistory('room@conference.example.com', 500)

      expect(loadSpy).toHaveBeenCalledWith('room@conference.example.com', {
        limit: 200,
        before: undefined,
        peek: true,
      })
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/mcpTools.test.ts`
Expected: FAIL with "Cannot find module './mcpTools'".

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/utils/mcpTools.ts`:

```typescript
import { chatStore, roomStore } from '@fluux/sdk'
import type { Message, RoomMessage } from '@fluux/sdk'

export interface McpConversationSummary {
  conversationId: string
  displayName: string
  type: 'chat' | 'groupchat'
  isEncrypted: boolean
  lastMessageTimestamp: string | null
}

export interface McpHistoryMessage {
  from: string
  body: string
  timestamp: string
  isOutgoing: boolean
  isEncrypted: boolean
}

const MAX_HISTORY_LIMIT = 200
const DEFAULT_HISTORY_LIMIT = 50

export function listConversations(): McpConversationSummary[] {
  const chats: McpConversationSummary[] = Array.from(chatStore.getState().conversations.values()).map((conv) => ({
    conversationId: conv.id,
    displayName: conv.name,
    type: 'chat',
    isEncrypted: conv.lastMessage?.securityContext !== undefined,
    lastMessageTimestamp: conv.lastMessage?.timestamp.toISOString() ?? null,
  }))

  const rooms: McpConversationSummary[] = Array.from(roomStore.getState().rooms.values()).map((room) => ({
    conversationId: room.jid,
    displayName: room.name ?? room.jid,
    type: 'groupchat',
    isEncrypted: room.lastMessage?.securityContext !== undefined,
    lastMessageTimestamp: room.lastMessage?.timestamp.toISOString() ?? null,
  }))

  return [...chats, ...rooms].sort((a, b) => {
    if (!a.lastMessageTimestamp) return 1
    if (!b.lastMessageTimestamp) return -1
    return b.lastMessageTimestamp.localeCompare(a.lastMessageTimestamp)
  })
}

function toHistoryMessage(message: Message | RoomMessage): McpHistoryMessage {
  return {
    from: message.from,
    body: message.body,
    timestamp: message.timestamp.toISOString(),
    isOutgoing: message.isOutgoing,
    isEncrypted: message.securityContext !== undefined,
  }
}

export async function getHistory(
  conversationId: string,
  limit?: number,
  before?: string
): Promise<McpHistoryMessage[]> {
  const cappedLimit = Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)
  const beforeDate = before ? new Date(before) : undefined
  const isRoom = roomStore.getState().rooms.has(conversationId)

  const messages = isRoom
    ? await roomStore.getState().loadMessagesFromCache(conversationId, { limit: cappedLimit, before: beforeDate, peek: true })
    : await chatStore.getState().loadMessagesFromCache(conversationId, { limit: cappedLimit, before: beforeDate, peek: true })

  return messages.map(toHistoryMessage)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/mcpTools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/mcpTools.ts apps/fluux/src/utils/mcpTools.test.ts
git commit -m "feat(mcp): add list_conversations and get_history tool handlers"
```

---

### Task 6: JS tool handler — send_message (+ rate limit)

**Files:**
- Modify: `apps/fluux/src/utils/mcpTools.ts`
- Modify: `apps/fluux/src/utils/mcpTools.test.ts`

**Interfaces:**
- Consumes: `client.chat.sendMessage(to, body, type)` from an `XMPPClient` instance (`@fluux/sdk/core`), `chatStore`/`roomStore` (Task 5).
- Produces: `mcpTools.{sendMessageTool, __resetSendRateLimitForTests}` — consumed by Task 8.

- [ ] **Step 1: Write the failing tests**

Append to `apps/fluux/src/utils/mcpTools.test.ts` (add the import and new `describe` blocks):

```typescript
import type { XMPPClient } from '@fluux/sdk/core'
import { sendMessageTool, __resetSendRateLimitForTests } from './mcpTools'
```

```typescript
describe('sendMessageTool', () => {
  beforeEach(() => {
    __resetSendRateLimitForTests()
  })

  it('sends to a known chat conversation as type chat', async () => {
    chatStore.setState({ conversations: new Map([['alice@example.com', { id: 'alice@example.com' } as Conversation]]) })
    const sendMessage = vi.fn().mockResolvedValue('msg-123')
    const client = { chat: { sendMessage } } as unknown as XMPPClient

    const result = await sendMessageTool(client, 'alice@example.com', 'hi')

    expect(sendMessage).toHaveBeenCalledWith('alice@example.com', 'hi', 'chat')
    expect(result).toEqual({ messageId: 'msg-123' })
  })

  it('sends to a known room as type groupchat', async () => {
    roomStore.setState({ rooms: new Map([['room@conference.example.com', { jid: 'room@conference.example.com' } as Room]]) })
    const sendMessage = vi.fn().mockResolvedValue('msg-456')
    const client = { chat: { sendMessage } } as unknown as XMPPClient

    await sendMessageTool(client, 'room@conference.example.com', 'hi room')

    expect(sendMessage).toHaveBeenCalledWith('room@conference.example.com', 'hi room', 'groupchat')
  })

  it('rejects an unknown conversationId', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient
    await expect(sendMessageTool(client, 'ghost@example.com', 'hi')).rejects.toThrow('Unknown conversationId')
  })

  it('throws after 10 sends within a 60s window and recovers once it passes', async () => {
    vi.useFakeTimers()
    chatStore.setState({ conversations: new Map([['alice@example.com', { id: 'alice@example.com' } as Conversation]]) })
    const sendMessage = vi.fn().mockResolvedValue('msg-id')
    const client = { chat: { sendMessage } } as unknown as XMPPClient

    for (let i = 0; i < 10; i++) {
      await sendMessageTool(client, 'alice@example.com', `msg ${i}`)
    }
    await expect(sendMessageTool(client, 'alice@example.com', 'one too many')).rejects.toThrow('Rate limit exceeded')

    vi.advanceTimersByTime(60_001)
    await expect(sendMessageTool(client, 'alice@example.com', 'ok now')).resolves.toEqual({ messageId: 'msg-id' })

    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/mcpTools.test.ts`
Expected: FAIL — `sendMessageTool` and `__resetSendRateLimitForTests` are not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `apps/fluux/src/utils/mcpTools.ts`:

```typescript
import type { XMPPClient } from '@fluux/sdk/core'

const SEND_RATE_LIMIT = 10
const SEND_RATE_WINDOW_MS = 60_000
let sendTimestamps: number[] = []

function checkSendRateLimit(): void {
  const now = Date.now()
  sendTimestamps = sendTimestamps.filter((t) => now - t < SEND_RATE_WINDOW_MS)
  if (sendTimestamps.length >= SEND_RATE_LIMIT) {
    throw new Error(`Rate limit exceeded: max ${SEND_RATE_LIMIT} messages per minute via MCP`)
  }
  sendTimestamps.push(now)
}

/** Test-only: clears the in-memory send-rate-limit window between tests. */
export function __resetSendRateLimitForTests(): void {
  sendTimestamps = []
}

export async function sendMessageTool(
  client: XMPPClient,
  conversationId: string,
  body: string
): Promise<{ messageId: string }> {
  checkSendRateLimit()

  const isRoom = roomStore.getState().rooms.has(conversationId)
  const isChat = chatStore.getState().conversations.has(conversationId)
  if (!isRoom && !isChat) {
    throw new Error(`Unknown conversationId: ${conversationId}`)
  }

  const messageId = await client.chat.sendMessage(conversationId, body, isRoom ? 'groupchat' : 'chat')
  return { messageId }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/mcpTools.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/mcpTools.ts apps/fluux/src/utils/mcpTools.test.ts
git commit -m "feat(mcp): add send_message tool handler with rate limiting"
```

---

### Task 7: mcpBridgeStore (enable flag + activity log)

**Files:**
- Create: `apps/fluux/src/stores/mcpBridgeStore.ts`
- Test: `apps/fluux/src/stores/mcpBridgeStore.test.ts`

**Interfaces:**
- Produces: `useMcpBridgeStore`, `McpActivityEntry` — consumed by Task 8 (`useMcpBridge`) and Task 10 (`McpSettings.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/stores/mcpBridgeStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useMcpBridgeStore } from './mcpBridgeStore'

describe('useMcpBridgeStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useMcpBridgeStore.setState({ enabled: false, serverInfo: null, activityLog: [] })
  })

  it('persists enabled to localStorage', () => {
    useMcpBridgeStore.getState().setEnabled(true)
    expect(localStorage.getItem('fluux-mcp-enabled')).toBe('true')
    expect(useMcpBridgeStore.getState().enabled).toBe(true)
  })

  it('defaults to disabled when localStorage has nothing set', () => {
    expect(useMcpBridgeStore.getState().enabled).toBe(false)
  })

  it('stores the port and token reported by mcp_start_server', () => {
    useMcpBridgeStore.getState().setServerInfo({ port: 4123, token: 'secret-token' })
    expect(useMcpBridgeStore.getState().serverInfo).toEqual({ port: 4123, token: 'secret-token' })
  })

  it('keeps only the most recent 100 activity entries, newest first', () => {
    for (let i = 0; i < 105; i++) {
      useMcpBridgeStore.getState().logActivity({ tool: 'get_history', conversationId: `c${i}`, timestamp: new Date() })
    }
    const log = useMcpBridgeStore.getState().activityLog
    expect(log).toHaveLength(100)
    expect(log[0].conversationId).toBe('c104')
  })

  it('clears the activity log', () => {
    useMcpBridgeStore.getState().logActivity({ tool: 'list_conversations', timestamp: new Date() })
    useMcpBridgeStore.getState().clearActivityLog()
    expect(useMcpBridgeStore.getState().activityLog).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/stores/mcpBridgeStore.test.ts`
Expected: FAIL with "Cannot find module './mcpBridgeStore'".

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/stores/mcpBridgeStore.ts`:

```typescript
import { create } from 'zustand'

/**
 * MCP bridge state — mirrors the pattern used by advancedModeStore.ts.
 * `enabled` gates whether the local MCP server runs at all; off by default.
 */

const MCP_ENABLED_KEY = 'fluux-mcp-enabled'
const MAX_ACTIVITY_ENTRIES = 100

export interface McpActivityEntry {
  tool: 'list_conversations' | 'get_history' | 'send_message'
  conversationId?: string
  timestamp: Date
}

function getInitialEnabled(): boolean {
  try {
    return localStorage.getItem(MCP_ENABLED_KEY) === 'true'
  } catch {
    return false
  }
}

interface McpBridgeState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  serverInfo: { port: number; token: string } | null
  setServerInfo: (info: { port: number; token: string } | null) => void
  activityLog: McpActivityEntry[]
  logActivity: (entry: McpActivityEntry) => void
  clearActivityLog: () => void
}

export const useMcpBridgeStore = create<McpBridgeState>((set, get) => ({
  enabled: getInitialEnabled(),
  setEnabled: (enabled) => {
    try {
      localStorage.setItem(MCP_ENABLED_KEY, enabled ? 'true' : 'false')
    } catch {
      // localStorage not available
    }
    set({ enabled })
  },

  serverInfo: null,
  setServerInfo: (serverInfo) => set({ serverInfo }),

  activityLog: [],
  logActivity: (entry) => {
    const next = [entry, ...get().activityLog].slice(0, MAX_ACTIVITY_ENTRIES)
    set({ activityLog: next })
  },
  clearActivityLog: () => set({ activityLog: [] }),
}))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/stores/mcpBridgeStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/stores/mcpBridgeStore.ts apps/fluux/src/stores/mcpBridgeStore.test.ts
git commit -m "feat(mcp): add mcpBridgeStore for the enable flag and activity log"
```

---

### Task 8: useMcpBridge hook (event listener + dispatch + server lifecycle)

**Files:**
- Create: `apps/fluux/src/hooks/useMcpBridge.ts`
- Test: `apps/fluux/src/hooks/useMcpBridge.test.ts`

**Interfaces:**
- Consumes: `isTauri` ([tauri.ts:8](../../../apps/fluux/src/utils/tauri.ts)), `useMcpBridgeStore` (Task 7), `listConversations`/`getHistory`/`sendMessageTool` (Tasks 5–6), `@tauri-apps/api/core` (`invoke`), `@tauri-apps/api/event` (`listen`).
- Produces: `useMcpBridge(client: XMPPClient): void` — consumed by Task 9 (mounted in `App.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/hooks/useMcpBridge.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { chatStore } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { useMcpBridge } from './useMcpBridge'
import { useMcpBridgeStore } from '@/stores/mcpBridgeStore'

vi.mock('@/utils/tauri', () => ({ isTauri: () => true }))

const invokeMock = vi.fn()
const listenMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listenMock(...args) }))

describe('useMcpBridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    invokeMock.mockResolvedValue({ port: 4123, token: 'secret' })
    listenMock.mockResolvedValue(() => {})
    useMcpBridgeStore.setState({ enabled: true, serverInfo: null, activityLog: [] })
    chatStore.getState().reset()
  })

  it('starts the MCP server and subscribes to tool-call events when enabled', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    renderHook(() => useMcpBridge(client))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_start_server')
      expect(listenMock).toHaveBeenCalledWith('mcp:tool-call', expect.any(Function))
    })
    expect(useMcpBridgeStore.getState().serverInfo).toEqual({ port: 4123, token: 'secret' })
  })

  it('dispatches a list_conversations tool call and responds via mcp_respond', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient
    renderHook(() => useMcpBridge(client))
    await waitFor(() => expect(listenMock).toHaveBeenCalled())

    const handler = listenMock.mock.calls[0][1] as (event: { payload: unknown }) => void
    await handler({ payload: { id: 'req-1', name: 'list_conversations', arguments: {} } })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_respond', { id: 'req-1', result: [] })
    })
    expect(useMcpBridgeStore.getState().activityLog).toHaveLength(1)
  })

  it('responds with an error payload when a tool call throws', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient
    renderHook(() => useMcpBridge(client))
    await waitFor(() => expect(listenMock).toHaveBeenCalled())

    const handler = listenMock.mock.calls[0][1] as (event: { payload: unknown }) => void
    await handler({
      payload: { id: 'req-2', name: 'send_message', arguments: { conversationId: 'ghost@example.com', body: 'hi' } },
    })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_respond', {
        id: 'req-2',
        result: { error: 'Unknown conversationId: ghost@example.com' },
      })
    })
  })

  it('stops the server when disabled', () => {
    useMcpBridgeStore.setState({ enabled: false })
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    renderHook(() => useMcpBridge(client))

    expect(invokeMock).toHaveBeenCalledWith('mcp_stop_server')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/hooks/useMcpBridge.test.ts`
Expected: FAIL with "Cannot find module './useMcpBridge'".

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/hooks/useMcpBridge.ts`:

```typescript
import { useEffect } from 'react'
import type { XMPPClient } from '@fluux/sdk/core'
import { isTauri } from '@/utils/tauri'
import { useMcpBridgeStore, type McpActivityEntry } from '@/stores/mcpBridgeStore'
import { listConversations, getHistory, sendMessageTool } from '@/utils/mcpTools'

interface McpToolCallEvent {
  id: string
  name: string
  arguments: Record<string, unknown>
}

async function dispatchTool(client: XMPPClient, event: McpToolCallEvent): Promise<unknown> {
  switch (event.name) {
    case 'list_conversations':
      return listConversations()
    case 'get_history':
      return getHistory(
        event.arguments.conversationId as string,
        event.arguments.limit as number | undefined,
        event.arguments.before as string | undefined
      )
    case 'send_message':
      return sendMessageTool(client, event.arguments.conversationId as string, event.arguments.body as string)
    default:
      throw new Error(`Unknown MCP tool: ${event.name}`)
  }
}

/**
 * Bridges incoming MCP tool calls (from the Rust-hosted local MCP server) to
 * the SDK stores and the live XMPP client, and starts/stops the Rust MCP
 * server as the user toggles it in Settings. Desktop (Tauri) only — a no-op
 * in the web build.
 */
export function useMcpBridge(client: XMPPClient): void {
  const enabled = useMcpBridgeStore((s) => s.enabled)
  const setServerInfo = useMcpBridgeStore((s) => s.setServerInfo)
  const logActivity = useMcpBridgeStore((s) => s.logActivity)

  useEffect(() => {
    if (!isTauri()) return

    if (!enabled) {
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('mcp_stop_server'))
      setServerInfo(null)
      return
    }

    let unlisten: (() => void) | undefined

    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')

      const info = await invoke<{ port: number; token: string }>('mcp_start_server')
      setServerInfo({ port: info.port, token: info.token })

      unlisten = await listen<McpToolCallEvent>('mcp:tool-call', (tauriEvent) => {
        void (async () => {
          const payload = tauriEvent.payload
          try {
            const result = await dispatchTool(client, payload)
            logActivity({
              tool: payload.name as McpActivityEntry['tool'],
              conversationId: payload.arguments.conversationId as string | undefined,
              timestamp: new Date(),
            })
            await invoke('mcp_respond', { id: payload.id, result })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await invoke('mcp_respond', { id: payload.id, result: { error: message } })
          }
        })()
      })
    })()

    return () => {
      unlisten?.()
    }
  }, [client, enabled, setServerInfo, logActivity])
}
```

Note: `get_history` for an unknown conversationId does not throw — it resolves to an empty array (per Task 5's implementation, an unrecognized id just means "no cached messages"). `send_message` is stricter and does throw for an unknown conversationId (Task 6), since silently no-op-ing there could look like a message was sent when it wasn't — that's the scenario the test above exercises.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/hooks/useMcpBridge.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useMcpBridge.ts apps/fluux/src/hooks/useMcpBridge.test.ts
git commit -m "feat(mcp): add useMcpBridge hook to dispatch tool calls from Rust"
```

---

### Task 9: Mount useMcpBridge in App.tsx

**Files:**
- Modify: `apps/fluux/src/App.tsx`

**Interfaces:**
- Consumes: `useMcpBridge` (Task 8), the existing `client` from `useXMPPContext()` already destructured at [App.tsx:66](../../../apps/fluux/src/App.tsx).

- [ ] **Step 1: Add the import**

Modify `apps/fluux/src/App.tsx`: near the existing `import { usePlatformState } from './hooks/usePlatformState'` line ([App.tsx:30](../../../apps/fluux/src/App.tsx)), add:

```typescript
import { useMcpBridge } from './hooks/useMcpBridge'
```

- [ ] **Step 2: Call the hook**

Modify `apps/fluux/src/App.tsx`: right after the existing `const { client } = useXMPPContext()` line ([App.tsx:66](../../../apps/fluux/src/App.tsx)), add:

```typescript
  useMcpBridge(client)
```

- [ ] **Step 3: Run the app test suite to check for regressions**

Run: `cd apps/fluux && npx vitest run src/App.test.tsx`
Expected: PASS — no change to App's rendered output (the hook only sets up event listeners; it renders nothing).

If `App.test.tsx` doesn't mock `@tauri-apps/api/core`/`@tauri-apps/api/event`, add the same two `vi.mock(...)` calls used in Task 8's test (or confirm `isTauri()` is already `false` in the test environment via `test-setup.ts`, in which case `useMcpBridge`'s effect returns immediately and no mocking is needed).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/App.tsx
git commit -m "feat(mcp): mount the MCP bridge at the app root"
```

---

### Task 10: Settings UI — MCP category + panel

**Files:**
- Modify: `apps/fluux/src/components/settings-components/types.ts`
- Create: `apps/fluux/src/components/settings-components/McpSettings.tsx`
- Test: `apps/fluux/src/components/settings-components/McpSettings.test.tsx`
- Modify: `apps/fluux/src/components/settings-components/index.ts`
- Modify: `apps/fluux/src/components/SettingsView.tsx`

**Interfaces:**
- Consumes: `useMcpBridgeStore` (Task 7), `SettingsSection` ([SettingsSection.tsx](../../../apps/fluux/src/components/ui/SettingsSection.tsx)).
- Produces: `'mcp'` added to the `SettingsCategory` union and `SETTINGS_CATEGORIES` — rendered by `SettingsView`.

- [ ] **Step 1: Add the category**

Modify `apps/fluux/src/components/settings-components/types.ts`: add `Bot` to the lucide-react import:

```typescript
import { User, Palette, Globe, Bell, Download, Ban, HardDrive, Lock, ShieldCheck, Wrench, Accessibility, Bot } from 'lucide-react'
```

Add `'mcp'` to the `SettingsCategory` union, right before `'advanced'`:

```typescript
export type SettingsCategory =
  | 'profile'
  | 'appearance'
  | 'accessibility'
  | 'language'
  | 'notifications'
  | 'privacy'
  | 'updates'
  | 'blocked'
  | 'storage'
  | 'encryption'
  | 'mcp'
  | 'advanced'
```

Add the config entry to `SETTINGS_CATEGORIES`, right before the `'advanced'` entry:

```typescript
  { id: 'mcp', labelKey: 'settings.categories.mcp', icon: Bot, tauriOnly: true, group: 'system' },
  { id: 'advanced', labelKey: 'settings.categories.advanced', icon: Wrench, group: 'system' },
```

- [ ] **Step 2: Write the failing test**

Create `apps/fluux/src/components/settings-components/McpSettings.test.tsx`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { McpSettings } from './McpSettings'
import { useMcpBridgeStore } from '@/stores/mcpBridgeStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}))

beforeEach(() => {
  useMcpBridgeStore.setState({ enabled: false, serverInfo: null, activityLog: [] })
})

describe('McpSettings', () => {
  it('shows the enable button when off', () => {
    render(<McpSettings />)
    expect(screen.getByRole('button', { name: 'settings.mcp.enable' })).toBeInTheDocument()
  })

  it('enables the bridge when clicked', () => {
    render(<McpSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.enable' }))
    expect(useMcpBridgeStore.getState().enabled).toBe(true)
  })

  it('shows the empty activity state with no log entries', () => {
    useMcpBridgeStore.setState({ enabled: true })
    render(<McpSettings />)
    expect(screen.getByText('settings.mcp.activityEmpty')).toBeInTheDocument()
  })

  it('lists activity entries when present', () => {
    useMcpBridgeStore.setState({
      enabled: true,
      activityLog: [{ tool: 'get_history', conversationId: 'alice@example.com', timestamp: new Date() }],
    })
    render(<McpSettings />)
    expect(screen.getByText(/alice@example.com/)).toBeInTheDocument()
  })

  it('shows connection details and copies them when the server is running', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    useMcpBridgeStore.setState({ enabled: true, serverInfo: { port: 4123, token: 'secret-token' } })

    render(<McpSettings />)
    expect(screen.getByText('http://127.0.0.1:4123/mcp')).toBeInTheDocument()
    expect(screen.getByText('secret-token')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.copy' }))
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:4123/mcp\nsecret-token')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/settings-components/McpSettings.test.tsx`
Expected: FAIL with "Cannot find module './McpSettings'".

- [ ] **Step 4: Write the implementation**

Create `apps/fluux/src/components/settings-components/McpSettings.tsx`:

```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { useMcpBridgeStore } from '@/stores/mcpBridgeStore'

export function McpSettings() {
  const { t } = useTranslation()
  const enabled = useMcpBridgeStore((s) => s.enabled)
  const setEnabled = useMcpBridgeStore((s) => s.setEnabled)
  const serverInfo = useMcpBridgeStore((s) => s.serverInfo)
  const activityLog = useMcpBridgeStore((s) => s.activityLog)
  const clearActivityLog = useMcpBridgeStore((s) => s.clearActivityLog)
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!serverInfo) return
    const url = `http://127.0.0.1:${serverInfo.port}/mcp`
    void navigator.clipboard.writeText(`${url}\n${serverInfo.token}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className="w-full max-w-md">
      <SettingsSection title={t('settings.mcp.title')} description={t('settings.mcp.description')}>
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          className="px-4 py-2 rounded-lg bg-fluux-brand text-fluux-text-on-accent"
        >
          {enabled ? t('settings.mcp.disable') : t('settings.mcp.enable')}
        </button>

        {enabled && (
          <div className="mt-2 text-sm text-fluux-muted">
            {serverInfo ? (
              <>
                <p>{t('settings.mcp.statusRunning', { port: serverInfo.port })}</p>
                <p className="font-mono text-xs mt-1 break-all">{`http://127.0.0.1:${serverInfo.port}/mcp`}</p>
                <p className="font-mono text-xs break-all">{serverInfo.token}</p>
                <button type="button" onClick={handleCopy} className="text-xs underline mt-1">
                  {copied ? t('settings.mcp.copied') : t('settings.mcp.copy')}
                </button>
              </>
            ) : (
              <p>{t('settings.mcp.statusStarting')}</p>
            )}
          </div>
        )}

        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-fluux-text">{t('settings.mcp.activityTitle')}</h3>
            {activityLog.length > 0 && (
              <button type="button" onClick={clearActivityLog} className="text-xs text-fluux-muted underline">
                {t('settings.mcp.activityClear')}
              </button>
            )}
          </div>
          {activityLog.length === 0 ? (
            <p className="text-sm text-fluux-muted mt-2">{t('settings.mcp.activityEmpty')}</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {activityLog.map((entry, index) => (
                <li key={index} className="text-xs text-fluux-muted">
                  {t(`settings.mcp.tool.${entry.tool}`)}
                  {entry.conversationId ? ` (${entry.conversationId})` : ''}
                  {' · '}
                  {entry.timestamp.toLocaleTimeString()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>
    </section>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/settings-components/McpSettings.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Export and wire into SettingsView**

Modify `apps/fluux/src/components/settings-components/index.ts`: add, right after `export { AdvancedSettings } from './AdvancedSettings'`:

```typescript
export { McpSettings } from './McpSettings'
```

Modify `apps/fluux/src/components/SettingsView.tsx`: add `McpSettings` to the import block from `./settings-components` (right after `AdvancedSettings,`):

```typescript
  AdvancedSettings,
  McpSettings,
```

Add the case, right after `case 'advanced': return <AdvancedSettings />` (or wherever that case appears near [SettingsView.tsx:70](../../../apps/fluux/src/components/SettingsView.tsx)):

```typescript
      case 'mcp':
        return <McpSettings />
```

- [ ] **Step 7: Run the settings view test suite**

Run: `cd apps/fluux && npx vitest run src/components/SettingsView.test.tsx`
Expected: PASS — no regressions to existing categories.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/settings-components/types.ts apps/fluux/src/components/settings-components/McpSettings.tsx apps/fluux/src/components/settings-components/McpSettings.test.tsx apps/fluux/src/components/settings-components/index.ts apps/fluux/src/components/SettingsView.tsx
git commit -m "feat(mcp): add MCP Settings panel"
```

---

### Task 11: i18n — add and translate the new strings

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json`
- Modify: all 32 other files in `apps/fluux/src/i18n/locales/` (`ar.json`, `be.json`, `bg.json`, `ca.json`, `cs.json`, `da.json`, `de.json`, `el.json`, `es.json`, `et.json`, `fi.json`, `fr.json`, `ga.json`, `he.json`, `hr.json`, `hu.json`, `is.json`, `it.json`, `lt.json`, `lv.json`, `mt.json`, `nb.json`, `nl.json`, `pl.json`, `pt.json`, `ro.json`, `ru.json`, `sk.json`, `sl.json`, `sv.json`, `uk.json`, `zh-CN.json`)

- [ ] **Step 1: Add the English keys**

Modify `apps/fluux/src/i18n/locales/en.json`: inside the `settings.categories` object, add `"mcp"` right before `"advanced"` (matching the existing `"encryption": "Encryption",` style at [en.json:606](../../../apps/fluux/src/i18n/locales/en.json)):

```json
            "mcp": "Claude Integration",
            "advanced": "Advanced"
```

Add a new top-level `"mcp"` object inside `settings`, right before the existing `"advanced": { ... }` block ([en.json:613](../../../apps/fluux/src/i18n/locales/en.json)):

```json
        "mcp": {
            "title": "Claude Integration (MCP)",
            "description": "Let Claude read your conversation history and send messages through Fluux via the Model Context Protocol. Each request is still approved individually in your MCP client (e.g. Claude Desktop) before it runs.",
            "enable": "Enable Claude access",
            "disable": "Disable Claude access",
            "statusStarting": "Starting local server…",
            "statusRunning": "Running on 127.0.0.1:{{port}}",
            "copy": "Copy connection details",
            "copied": "Copied",
            "activityTitle": "Recent activity",
            "activityEmpty": "No Claude activity yet.",
            "activityClear": "Clear",
            "tool": {
                "list_conversations": "Listed conversations",
                "get_history": "Read history",
                "send_message": "Sent a message"
            }
        },
```

- [ ] **Step 2: Translate into all 32 other locale files**

For each of the 32 locale files listed above, add the same two additions at the same nested path (`settings.categories.mcp` and `settings.mcp.*`), translating the English text into that locale's language. Follow the codebase's established surgical-edit convention: parse the JSON, set the new keys at the matching nested path, then `JSON.stringify(data, null, 4) + '\n'` — never run a whole-file reformat (existing files are 4-space-indented with a trailing newline; a reformatting round-trip changes unrelated lines and makes the diff unreviewable). Keep `{{port}}` and `…`/em-dash-free punctuation consistent with each locale's existing style — check a neighboring key in the same file (e.g. `settings.advanced.warning`) for tone/register before translating.

Do this as one small script (e.g. a temporary Node script using `JSON.parse`/`JSON.stringify` per file) rather than 32 manual edits, to guarantee the indentation/newline convention is preserved exactly.

- [ ] **Step 3: Verify all locale files still parse and the key set matches**

Run:

```bash
cd apps/fluux/src/i18n/locales && for f in *.json; do node -e "JSON.parse(require('fs').readFileSync('$f'))" || echo "INVALID: $f"; done
```

Expected: no output (all files parse).

Run a quick key-coverage check:

```bash
cd apps/fluux/src/i18n/locales && for f in *.json; do node -e "
const d = JSON.parse(require('fs').readFileSync('$f'));
if (!d.settings?.mcp || !d.settings?.categories?.mcp) console.log('MISSING mcp keys in $f');
"; done
```

Expected: no output (every locale has the new keys).

- [ ] **Step 4: Run the i18n-related test suite**

Run: `cd apps/fluux && npx vitest run -t i18n`
Expected: PASS. Also run the McpSettings/SettingsView tests again since they render real `t()` output only if their `react-i18next` mock is removed — with the mock in place (Tasks 8/10 use a stubbed `t`), no change is expected here; this step just guards against an unrelated i18n regression.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales/*.json
git commit -m "i18n(mcp): add and translate Claude Integration settings strings"
```

---

## Manual Verification (not covered by automated tests)

After Task 11, the automated test suite covers every unit in isolation, but the full loop — a real MCP client (Claude Desktop or Claude Code) actually calling into a running Fluux desktop build — needs manual verification per the spec's Testing section:

1. `npm run tauri:dev` to launch the desktop app, log in, enable "Claude Integration" in Settings.
2. Use the "Copy connection details" button in Settings (Task 10) to get the local URL and bearer token in one copy.
3. Configure Claude Desktop's MCP server list with the copied URL (`http://127.0.0.1:<port>/mcp`) and the token as a bearer header (exact config mechanism depends on Claude Desktop's current MCP config format at the time of testing).
4. Ask Claude to list conversations, read history for one, and send a test message; confirm each shows up in the Settings activity log and that the sent message actually arrives at the recipient.
5. Toggle "Claude Integration" off mid-session and confirm the next tool call fails (server stopped).

This step has no fixed pass/fail assertion in this plan — it's exploratory confirmation that the wiring works end-to-end, since none of the automated tests exercise the real HTTP socket + real Claude Desktop MCP client together.

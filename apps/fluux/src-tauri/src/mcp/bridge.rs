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

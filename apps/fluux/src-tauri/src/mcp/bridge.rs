use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::oneshot;

use super::protocol::ToolExecutor;

const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Rust-side send_message rate limit, mirroring the webview's limiter in
/// `apps/fluux/src/utils/mcpTools.ts`. The webview copy resets whenever the
/// page reloads (its module state is re-evaluated), so this process-lifetime
/// static is the cap that actually holds across reloads.
const SEND_RATE_LIMIT: usize = 10;
const SEND_RATE_WINDOW: Duration = Duration::from_secs(60);
static SEND_TIMESTAMPS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

/// Sliding-window check: keeps timestamps younger than the window, rejects
/// once the cap is reached, records the attempt otherwise. Pure over `now`
/// and the timestamp vec so tests can drive it without sleeping.
fn check_send_rate_limit_at(timestamps: &mut Vec<Instant>, now: Instant) -> Result<(), String> {
    timestamps.retain(|t| now.duration_since(*t) < SEND_RATE_WINDOW);
    if timestamps.len() >= SEND_RATE_LIMIT {
        return Err(format!(
            "Rate limit exceeded: max {SEND_RATE_LIMIT} messages per minute via MCP"
        ));
    }
    timestamps.push(now);
    Ok(())
}

fn check_send_rate_limit() -> Result<(), String> {
    let mut timestamps = SEND_TIMESTAMPS.lock().expect("SEND_TIMESTAMPS mutex poisoned");
    check_send_rate_limit_at(&mut timestamps, Instant::now())
}

/// The webview's reply envelope for a tool call. A typed shape (rather than
/// sniffing the result JSON for an "error" field) so a legitimate tool result
/// that happens to contain an `error` key can never be misread as a failure.
#[derive(Debug, Deserialize)]
struct ToolResponseEnvelope {
    ok: bool,
    #[serde(default)]
    result: serde_json::Value,
    #[serde(default)]
    error: Option<String>,
}

/// Unwrap the webview's `{ok, result}` / `{ok: false, error}` envelope into
/// the executor's `Result`. A reply that isn't envelope-shaped is a bridge
/// contract violation and reported as such, never passed through as data.
fn unwrap_envelope(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let envelope: ToolResponseEnvelope = serde_json::from_value(value)
        .map_err(|e| format!("Malformed bridge response envelope: {e}"))?;
    if envelope.ok {
        Ok(envelope.result)
    } else {
        Err(envelope.error.unwrap_or_else(|| "Tool call failed".to_string()))
    }
}

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
        // Enforce the send cap here, at the authenticated boundary, so it
        // holds even when the webview (and its own limiter) reloads.
        if name == "send_message" {
            check_send_rate_limit()?;
        }

        let (id, receiver) = self.pending.register();

        let event = McpToolCallEvent { id: id.clone(), name: name.to_string(), arguments };
        if let Err(e) = self.app.emit("mcp:tool-call", event) {
            self.pending.forget(&id);
            return Err(format!("Failed to dispatch tool call: {e}"));
        }

        match tokio::time::timeout(TOOL_CALL_TIMEOUT, receiver).await {
            Ok(Ok(value)) => unwrap_envelope(value),
            Ok(Err(_)) => Err("MCP bridge dropped the request".to_string()),
            Err(_) => {
                self.pending.forget(&id);
                // The webview-side dispatch is not cancelled by this timeout and
                // may still complete (e.g. a slow send_message that already went
                // out) — say so, or an LLM client will blindly retry and send a
                // duplicate message to a real recipient.
                Err(format!(
                    "Tool call timed out after {}s. The operation may still have completed; do not retry a send_message call without checking the conversation history first.",
                    TOOL_CALL_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

/// Tauri command: the webview calls this once it has a result for a tool
/// call it received via the `mcp:tool-call` event. `result` is the typed
/// envelope `{"ok": true, "result": ...}` on success or
/// `{"ok": false, "error": "message"}` on failure (see `unwrap_envelope`).
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

    #[test]
    fn envelope_ok_unwraps_the_result() {
        let value = serde_json::json!({ "ok": true, "result": [1, 2, 3] });
        assert_eq!(unwrap_envelope(value).unwrap(), serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn envelope_error_becomes_a_tool_failure() {
        let value = serde_json::json!({ "ok": false, "error": "boom" });
        assert_eq!(unwrap_envelope(value).unwrap_err(), "boom");
    }

    #[test]
    fn a_result_containing_an_error_field_is_not_misread_as_failure() {
        // The old duck-typed check sniffed for a top-level "error" string; the
        // envelope keeps payloads like this intact as legitimate data.
        let value = serde_json::json!({ "ok": true, "result": { "error": "none", "status": "fine" } });
        assert_eq!(
            unwrap_envelope(value).unwrap(),
            serde_json::json!({ "error": "none", "status": "fine" })
        );
    }

    #[test]
    fn a_non_envelope_reply_is_a_bridge_contract_error() {
        let value = serde_json::json!(["bare", "array"]);
        assert!(unwrap_envelope(value).unwrap_err().starts_with("Malformed bridge response envelope"));
    }

    #[test]
    fn send_rate_limit_rejects_the_eleventh_send_and_recovers_after_the_window() {
        let mut timestamps = Vec::new();
        let start = Instant::now();

        for i in 0..SEND_RATE_LIMIT {
            assert!(
                check_send_rate_limit_at(&mut timestamps, start).is_ok(),
                "send {i} within the cap should pass"
            );
        }
        assert!(check_send_rate_limit_at(&mut timestamps, start).is_err(), "the 11th send must be rejected");

        let after_window = start + SEND_RATE_WINDOW + Duration::from_secs(1);
        assert!(
            check_send_rate_limit_at(&mut timestamps, after_window).is_ok(),
            "a send after the window expires should pass again"
        );
    }
}

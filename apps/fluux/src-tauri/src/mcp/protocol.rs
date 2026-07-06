use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON-RPC 2.0 request, as sent by an MCP client.
#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    /// Deserialized to keep the request shape complete, but not validated in v1 —
    /// every MCP client we target sends "2.0" and there's no second protocol version to reject.
    #[allow(dead_code)]
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

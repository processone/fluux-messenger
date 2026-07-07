# MCP Server (Claude Integration)

Fluux can act as a local [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, letting an MCP client such as Claude Code read your conversation history and send messages through your XMPP account.

Desktop only: the server runs inside the Tauri app. The web build does not offer this feature.

## How it works

When enabled, the Rust backend serves MCP JSON-RPC over HTTP on `127.0.0.1` (loopback only, never exposed to the network). Every request must carry a bearer token. Each tool call is forwarded to the app's webview, answered from the same stores the UI reads, so what Claude sees is exactly what you see, including messages already decrypted by your E2EE keys.

Three tools are exposed:

| Tool | Effect |
|---|---|
| `list_conversations` | Lists 1:1 chats and joined rooms, with encryption status and last-message time. Read-only. |
| `get_history` | Paginated message history for one conversation (default 50, max 200 per call). Read-only. |
| `send_message` | Sends a message as you. Routed through the app's normal send path, so E2EE conversations are encrypted exactly as if you had typed the message. Rate-limited to 10 sends per minute. |

There is no per-conversation allowlist: your MCP client asks you to approve each tool call, and that per-call consent is the intended control point. Fluux itself provides the global on/off switch and a local activity log of every call.

## Enabling

1. Open **Settings → Claude Integration (MCP)** and click **Enable Claude access**.
2. The panel shows the server URL (`http://127.0.0.1:<port>/mcp`) and the bearer token. Use **Copy connection details** to copy both.

The token is stored in your OS keychain and the port is remembered, so the connection details survive app restarts and your client configuration keeps working. **Reset token** revokes access for every client configured with the old token.

The server only runs while Fluux is open and the toggle is on. Quitting the app or disabling the toggle tears it down immediately.

## Connecting a client

### Claude Code

```bash
claude mcp add --transport http fluux http://127.0.0.1:<port>/mcp \
  --header "Authorization: Bearer <token>"
```

Then ask things like "list my Fluux conversations", "what did Alice send me yesterday", or "send Bob a message saying I'll be late". Claude Code prompts for approval on each tool call; `send_message` is marked destructive so it always asks.

### MCP Inspector

For interactive exploration without an LLM:

```bash
npx @modelcontextprotocol/inspector
```

Choose the *Streamable HTTP* transport, enter the URL, and add an `Authorization: Bearer <token>` header.

### Claude Desktop

Claude Desktop's connector UI currently expects OAuth for remote servers and has no custom-header field, so the bearer token cannot be configured there directly. Use Claude Code or a gateway that injects the header.

## Security model

- **Loopback + bearer token.** The server binds `127.0.0.1` exclusively; even local processes need the token, which is kept in the OS keychain and never written to a plaintext file.
- **Kill switch.** Disabling the toggle stops the HTTP server entirely; the port closes.
- **Per-call consent.** Approval happens in the MCP client for each tool call. Fluux additionally logs every call in the Settings panel.
- **E2EE preserved on send.** `send_message` goes through the same code path as the composer, so a conversation with encryption enabled is never sent in cleartext (the call fails rather than downgrading).
- **Send rate limit.** 10 messages per minute, enforced in both the webview and the Rust server.

Note that `get_history` returns decrypted message bodies for E2EE conversations, since the local store holds them decrypted. The `isEncrypted` flag in results tells the client (and you, in the consent prompt context) that a conversation is end-to-end encrypted; it reflects the most recent message.

## Troubleshooting

- **Connection refused**: Fluux is not running, or the toggle is off.
- **401 Unauthorized**: wrong or stale token. Copy the current one from Settings, or reset it and reconfigure your client.
- **Port changed**: the preferred port was taken by another program at startup, so Fluux fell back to a new one. Check Settings for the current URL and update your client config.
- **Tool calls time out after 15s**: the app's webview is not responding (for example, a modal error state). A timed-out `send_message` may still have completed; check the conversation before retrying.
- **`Not joined to room`**: the room is bookmarked but you are not currently in it. Open it in Fluux first.

## What's New in v0.13.2

### Added

- SDK: Connection state machine for more predictable connection lifecycle
- `--dangerous-insecure-tls` CLI flag to disable TLS certificate verification
- SDK diagnostic logging for user troubleshooting, with shortcut to access log file
- Russian, Belarusian, Ukrainian, and Simplified Chinese translations (31 languages total)
- Linux system tray support with close-to-tray functionality
- Mod+Q full quit shortcut on Windows/Linux
- SCRAM authentication mechanism support with browser polyfills and UI display
- Windows drag and drop support

### Changed

- Beta release process for pre-release testing
- Separated SM resumption and fresh session initialization paths
- Optimized active conversation rendering with `useChatActive` hook
- MAM guards to skip unnecessary operations during SM resumption
- Improved connection fallback: proper WebSocket URL resolution and proxy restart
- XMPP Console performance with `useCallback`/`React.memo`
- Reduced MAM traffic on connect
- Use system DNS as default with fallback to Tokio resolver

### Fixed

- Connection error handling with firewall hint for proxy mode failures
- harden shutdown/cleanup flow and add DNS timing logs
- Proxy memory handling with buffer size limits and better stanza extraction
- Reconnection logic and login display optimizations
- Connection error message formatting
- Multiple freeze conditions on reconnect after sleep/network change or server restart
- SRV priority sorting and TLS SNI domain handling
- Room avatar loss when occupant goes offline
- Duplicate messages from IRC bridges in MAM queries
- Avatar blob URL memory leak with deduplication pool
- Status message updates while staying online
- MUC nick preserved on reconnect short-circuit
- Linux logout lockups on proxy disconnect
- Non-fatal errors now keep reconnecting with capped backoff
- WebSocket protocol header compliance (RFC 7395) preventing browser rejection on Windows
- Try all SRV record endpoints on connection failure instead of only the first
- macOS reconnect reliability during sleep and focus events
- Flatpak build updated for system tray support

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)

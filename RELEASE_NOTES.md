## What's New in v0.13.2-beta.3

### Added

- SDK: Connection state machine for more predictable connection lifecycle
- `--dangerous-insecure-tls` CLI flag to disable TLS certificate verification
- SDK diagnostic logging for user troubleshooting, with shortcut to access log file
- Russian, Belarusian, Ukrainian, and Simplified Chinese translations (31 languages total)

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

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)

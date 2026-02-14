## What's New in v0.13.2-beta.1

### Added

- SDK: Connection state machine for more predictable connection lifecycle

### Changed

- Beta release process for pre-release testing
- Separated SM resumption and fresh session initialization paths
- Optimized active conversation rendering with `useChatActive` hook
- MAM guards to skip unnecessary operations during SM resumption
- Improved connection fallback: proper WebSocket URL resolution and proxy restart
- XMPP Console performance with `useCallback`/`React.memo`
- Reduced MAM traffic on connect

### Fixed

- Connection error handling with firewall hint for proxy mode failures
- Proxy memory handling with buffer size limits and better stanza extraction
- Reconnection logic and login display optimizations
- Connection error message formatting

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)

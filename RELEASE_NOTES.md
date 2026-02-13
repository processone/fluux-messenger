## What's New in v0.13.1

### Added

- Enhanced logging and diagnostics for connection troubleshooting
- Tracing for keychain, idle detection, link preview, and startup operations

### Changed

- Improved XMPP proxy robustness and TCP streaming error handling
- Streamlined avatar restoration logic

### Fixed

- Memory and CPU leaks on connection loss
- SRV flip and double-connect on reconnect after sleep
- Background MAM catchup after reconnection
- New message marker rewinding to earlier position
- Room sorting after connection
- Occupant avatar negative cache handling
- Stuck tooltips on rapid hover
- Room members sidebar state lost across view switches
- HTTP upload discovery on server domain
- Pointer cursor missing on interactive buttons
- Windows code signing

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)

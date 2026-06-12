## What's New in v0.16.1

### Added

- Login screen validates JID format locally before attempting to connect
- Enhanced freeze-triage diagnostic probes in fluux.log for troubleshooting

### Changed

- Message list performance: off-screen rows skipped with content-visibility for reduced CPU on long histories
- Empty state screens use consistent icons from the icon rail

### Fixed

- Reconnection details (spinner, retry countdown, cancel) moved back to the sidebar status area — the top connection banner made the UI jump on unstable connections
- OpenPGP: fingerprint case normalized in peer-verification trust checks (green lock now reliable across clients)
- MUC occupant avatar preserved across presence updates
- Desktop: system proxy bypassed for loopback XMPP bridge hop to prevent connection failures
- Whisper: allow continuing a whispered conversation from its conversation frame
- Whisper menu action uses correct verb form across all locales
- Reply-quote bubble uses the same sender color as the original message
- Message list: fixed undefined React key on certain message rows
- Reply-quote previews render as nested vertical bars instead of raw quote markers
- Composer resize scroll correction coalesced into animation frame for smoother behavior
- Content ResizeObserver correctly created on same-commit mounts
- Image attachment placeholder reserved in error state to prevent layout shift
- MAM: bodiless encrypted messages from archive surfaced instead of dropped
- MAM: backward-pagination cursor corrected for scroll-up history loading
- Bundle ID uses correct domain identifier (net.processone.fluux)

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)

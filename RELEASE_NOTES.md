## What's New in v0.15.2

### Added

- Right-to-left (RTL) layout support for RTL languages
- Arabic and Hebrew translations (beta quality, please report any error or issue to help improve them)
- Decorative quotation marks for blockquotes

### Changed

- SASL2 user-agent identifier and server-side FAST token invalidation on logout
- Faster reconnection: skip redundant MAM queries on stream-management resume
- Perf: Per-conversation typing and draft subscriptions for smoother list rendering during background sync
- Security updates for several dependencies (brace-expansion, rustls-webpki, tar, rand, serialize-javascript; trust-dns-resolver migrated to hickory-resolver)

### Fixed

- Preserve MUC room state across stream-management resume and interrupted fresh sessions
- Prevent reconnection loops and UI freezes after system sleep/wake
- Keep FAST token rotation working across page-reload reconnect
- Retry FAST token authentication when the server field was initially empty
- Suppress spurious FAST token deletion log message on first login
- Set websocket stream "from" attribute so SASL2 is accepted on compliant servers
- Hydrate outbound stream-management state on resume to avoid ackQueue crash
- Recover Tauri reconnect stalls via native keepalive with proxy fallback
- fetchBookmarks no longer wipes stored room messages on reconnect
- Write live room messages directly to IndexedDB to prevent loss on reconnect
- Restore saved rooms through the connect call so history loads after SM resume
- Skip unnecessary webview reload when the app was hidden but the machine stayed awake
- Lightbox displays the full-resolution original without upscaling past its natural size
- Run discovery calls before the serial session-setup chain
- Recover when post-wake auto-connect stalls after SASL
- Handle superseded connection attempts with a dedicated error class
- Grow reconnect attempt counter past the backoff ceiling
- Probe runtime before reloading on dynamic import failure; auto-reload otherwise
- Fall back to direct URL when the web image cache fetch fails
- Display upload errors in the UI and allow HTTP upload URLs
- Use inert instead of aria-hidden on the scroll-to-bottom FAB (accessibility)
- Use ServiceWorker.showNotification() on web for reliable notifications
- Fix vertical alignment of the message toolbar "more" menu button

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)

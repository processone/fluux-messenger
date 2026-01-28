# Changelog

All notable changes to Fluux Messenger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.1] - 2026-01-28

### Added

- Background refresh of conversation previews after connect
- Windows system tray with hide-to-tray on close
- Native save dialog for console log export on desktop

### Changed

- Verifying connection status indicator when waking from sleep
- Quick Chat room history is now transient (XEP-0334 noStore hint)
- Linux Flatpak distribution (replaces AppImage)

### Fixed

- XEP-0446 File Metadata for image dimensions (prevents layout shift)
- Room avatar caching restored for bookmarked rooms
- Various cosmetic and mobile UX improvements

## [0.11.0] - 2026-01-26

### Added

- Room MAM detection: rooms supporting message archives skip MUC history (faster joins)
- Loading indicator while fetching message history
- Priority shown in contact profile connected devices

### Changed

- Message toolbar locks when emoji picker or menu is open
- Event-based SDK infrastructure to make the app more reactive

### Fixed

- Tooltips hide immediately when their trigger menu opens

## [0.0.1] - 2025-12-19

### Added

- First commit: Initial XMPP web client with React SDK


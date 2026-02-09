## What's New in v0.12.1

### Added

- Time format preference (12-hour, 24-hour, or auto)
- Collapsible long messages with Show more/less
- Negative avatar cache to reduce redundant vCard queries
- Azure Trusted Signing for Windows builds

### Changed

- Skip MAM preview refresh on SM resume (performance)
- File attachment card styling improvements in both themes

### Fixed

- Typing indicators for group chats (room:typing event)
- Socket error handling improved with reduced redundant logs
- Failed media URLs cached to prevent repeated retry loops
- Wide horizontal images limited to prevent thin strips
- Link preview card border softened in dark mode
- Stable IDs generated for messages without ID (prevents duplicates)
- MUC occupant avatar event listener improved
- Autoscroll and input alignment improvements

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)

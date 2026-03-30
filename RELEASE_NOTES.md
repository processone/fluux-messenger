## What's New in v0.15.0

### Added

- Reaction-based polls for MUC rooms with deadlines, custom emojis, close/reopen, unanswered banner, and result visualization
- Full-text message search across all conversations and rooms with local IndexedDB inverted index, prefix matching, and highlighted snippets
- Font size adjustment buttons in Appearance settings
- Theme system with 3-tier CSS design tokens (Foundation, Semantic, Component), theme picker, CSS snippets, and 12 built-in themes (Fluux, Dracula, Nord, Gruvbox, Catppuccin Mocha, Solarized, One Dark, Tokyo Night, Monokai, Rosé Pine, Kanagawa, GitHub)
- Theme import and CSS snippets
- Add reaction and vote summary to the activity log
- XEP-0388: SASL2 and XEP-0484: FAST token authentication for faster reconnection
- XEP-0012: Last Activity — display how long ago offline contacts were last seen
- Full emoji picker (emoji-mart) with dynamic viewport positioning
- Media cache: downloaded images cached to filesystem to avoid re-downloading, with storage management screen
- Per-tab XMPP resources and BroadcastChannel tab coordination for multi-tab support
- Proto-XEP drafts for appearance sync, conversation sync, ignored users, and @all mentions
- Unread message badge on scroll-to-bottom button with two-step scroll: first click jumps to new message marker, second click to bottom
- IRC-style mention detection with fallback highlighting in MUC rooms
- Highlight effect when navigating to a specific message from activity log
- Activity log events are clickable and navigate to the relevant conversation and message
- Scoped reaction muting in activity log (per-conversation instead of global)
- Ability to disable push notifications from settings
- Syntax highlighting for code blocks with theme integration
- Expandable code block modal with fullscreen mobile support
- MAM server archive search to supplement local IndexedDB results
- Find-on-page search within conversations (Cmd+F)
- Search rebuild progress UI and empty state improvements
- XEP-0359: Origin-id support for outgoing stanzas
- Global accent color picker with theme-specific presets
- Own nick and avatar use accent color instead of hardcoded green
- Message send slide-up animation
- Particle burst animation on reaction add
- Sidebar view fade-in transition on view switch
- VCard info popover on occupant and member list nicks
- Lazy-loaded syntax highlighting grammars per language
- Web persistent media cache with improved unavailable media UI
- Inline context preview for reaction and vote events in activity log
- Interactive demo mode with guided tutorial, room browsing, mock IQ responses, and admin panel
- Show ignored users section in MUC occupant panel
- Render markdown headings as rich messages

### Changed

- Room sorting by latest message with muted room flag
- Inline reactions limited to 9 with overflow indicator, sorted by count
- Inline hat badges limited to 3 with overflow tooltip
- Reaction tooltips limited to 9 names in large rooms
- Plural-aware "months ago" and "years ago" duration formatting across all locales
- External links now open in system default browser instead of Tauri webview
- Upgraded to React 19 with React Compiler for automatic memoization
- Upgraded to Vite 8 with lazy-loaded infrequent views
- Color @mentions with per-user consistent colors / XEP-0392
- Hide reactions UI in chat rooms when disco#info fails

### Fixed

- SM session resumption now properly attempts <resume/> on reconnect
- Draft text no longer leaks to active room on conversation switch
- Message retraction and moderation in MUC rooms
- Avatar falls back to letter display when image fails to load
- Hide typing indicator for ignored users in MUC rooms
- Prevent continuous video flickering on Linux/KDE by stabilizing dimensions
- XMPP Console blanking prevented with restored memoization and virtualization
- Resolve display name via occupant-id when message nick mismatches
- Blank screen on re-login after data clear prevented by resetting URL hash
- Message correction uses replace target ID when original is missing
- Reconnect backoff reset on wake from sleep
- Cached MUC occupant avatars restored across sessions
- More-options dropdown no longer overlaps bottom of chat on last message
- New message marker shown for conversations not yet opened in session
- Header misalignment and sidebar item spacing consistency
- Tauri control characters filtered from text input fields
- Delayed messages skipped when computing MAM catch-up cursor
- Admin user list refreshed after closing completed command
- New messages marker cleared when user scrolls past it
- Wire destroy room button to SDK MUC implementation
- Exclude ignored users from MUC room sidebar preview 

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)

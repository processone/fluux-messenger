/**
 * Changelog data for the app.
 * Update this file before each release with new features and fixes.
 */

export interface ChangelogEntry {
  version: string
  date: string
  sections: {
    type: 'added' | 'changed' | 'fixed' | 'removed'
    items: string[]
  }[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.15.0',
    date: '2026-03-26',
    sections: [
      {
        type: 'added',
        items: [
          'Reaction-based polls for MUC rooms with deadlines, custom emojis, close/reopen, unanswered banner, and result visualization',
          'Full-text message search across all conversations and rooms with local IndexedDB inverted index, prefix matching, and highlighted snippets',
          'Font size adjustment buttons in Appearance settings',
          'Theme system with 3-tier CSS design tokens (Foundation, Semantic, Component), theme picker, CSS snippets, and 12 built-in themes (Fluux, Dracula, Nord, Gruvbox, Catppuccin Mocha, Solarized, One Dark, Tokyo Night, Monokai, Rosé Pine, Kanagawa, GitHub)',
          'Theme import and CSS snippets',
          'Add reaction and vote summary to the activity log',
          'XEP-0388: SASL2 and XEP-0484: FAST token authentication for faster reconnection',
          'XEP-0012: Last Activity — display how long ago offline contacts were last seen',
          'Full emoji picker (emoji-mart) with dynamic viewport positioning',
          'Media cache: downloaded images cached to filesystem to avoid re-downloading, with storage management screen',
          'Per-tab XMPP resources and BroadcastChannel tab coordination for multi-tab support',
          'Proto-XEP drafts for appearance sync, conversation sync, ignored users, and @all mentions',
          'Unread message badge on scroll-to-bottom button with two-step scroll: first click jumps to new message marker, second click to bottom',
          'IRC-style mention detection with fallback highlighting in MUC rooms',
          'Highlight effect when navigating to a specific message from activity log',
          'Activity log events are clickable and navigate to the relevant conversation and message',
          'Scoped reaction muting in activity log (per-conversation instead of global)',
          'Ability to disable push notifications from settings',
          'Syntax highlighting for code blocks with theme integration',
          'Expandable code block modal with fullscreen mobile support',
          'MAM server archive search to supplement local IndexedDB results',
          'Find-on-page search within conversations (Cmd+F)',
          'Search rebuild progress UI and empty state improvements',
          'XEP-0359: Origin-id support for outgoing stanzas',
          'Global accent color picker with theme-specific presets',
          'Own nick and avatar use accent color instead of hardcoded green',
          'Message send slide-up animation',
          'Particle burst animation on reaction add',
          'Sidebar view fade-in transition on view switch',
          'VCard info popover on occupant and member list nicks',
          'Lazy-loaded syntax highlighting grammars per language',
          'Web persistent media cache with improved unavailable media UI',
          'Inline context preview for reaction and vote events in activity log',
          'Interactive demo mode with guided tutorial, room browsing, mock IQ responses, and admin panel',
          'Show ignored users section in MUC occupant panel',
          'Render markdown headings as rich messages',
        ],
      },
      {
        type: 'changed',
        items: [
          'Room sorting by latest message with muted room flag',
          'Inline reactions limited to 9 with overflow indicator, sorted by count',
          'Inline hat badges limited to 3 with overflow tooltip',
          'Reaction tooltips limited to 9 names in large rooms',
          'Plural-aware "months ago" and "years ago" duration formatting across all locales',
          'External links now open in system default browser instead of Tauri webview',
          'Upgraded to React 19 with React Compiler for automatic memoization',
          'Upgraded to Vite 8 with lazy-loaded infrequent views',
          'Color @mentions with per-user consistent colors / XEP-0392',
          'Hide reactions UI in chat rooms when disco#info fails',
                  ],
      },
      {
        type: 'fixed',
        items: [
          'SM session resumption now properly attempts <resume/> on reconnect',
          'Draft text no longer leaks to active room on conversation switch',
          'Message retraction and moderation in MUC rooms',
          'Avatar falls back to letter display when image fails to load',
          'Hide typing indicator for ignored users in MUC rooms',
          'Prevent continuous video flickering on Linux/KDE by stabilizing dimensions',
          'XMPP Console blanking prevented with restored memoization and virtualization',
          'Resolve display name via occupant-id when message nick mismatches',
          'Blank screen on re-login after data clear prevented by resetting URL hash',
          'Message correction uses replace target ID when original is missing',
          'Reconnect backoff reset on wake from sleep',
          'Cached MUC occupant avatars restored across sessions',
          'More-options dropdown no longer overlaps bottom of chat on last message',
          'New message marker shown for conversations not yet opened in session',
          'Header misalignment and sidebar item spacing consistency',
          'Tauri control characters filtered from text input fields',
          'Delayed messages skipped when computing MAM catch-up cursor',
          'Admin user list refreshed after closing completed command',
          'New messages marker cleared when user scrolls past it',
          'Wire destroy room button to SDK MUC implementation',
          'Exclude ignored users from MUC room sidebar preview ',
        ],
      },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-03-16',
    sections: [
      {
        type: 'added',
        items: [
          'XEP-0425: Message Moderation — moderators can retract other users\' messages in MUC rooms, with moderator attribution and reason display',
          'MUC room creation, configuration, and destruction support',
          'MUC room user management: affiliation/role changes, kick, and ban',
          'MUC hat management UI for room owners (XEP-0317): define, assign, and remove hats via ad-hoc commands',
          'Per-room ignored user management with server-side storage (XEP-0223)',
          'RSM pagination support for MUC room browsing',
          'Contact management dropdown in the occupant room sidebar',
          'Contact addition button in profile screen',
          'Occupant context menu on right-click/long-press of nicknames in room messages',
          'Suppress sound and desktop notifications when presence is Do Not Disturb',
          'Open external links in Tauri webview popup instead of system browser',
          'XEP-0054: vCard info display in contact popover (full name, organisation, email, country)',
          'XEP-0054: vCard editing in profile settings — add, edit, and remove vCard fields (full name, company, email, country)',
          'XEP-0054: vCard info display in contact profile view',
          'Avatar lightbox overlay on click in message view',
          'Full-screen occupant panel on small screens',
          'Font size setting in appearance preferences',
          'PEP-based conversation list synchronisation (ConversationSync module)',
          'XEP-0202: Entity Time — display contact local time in chat header and contact popover',
          'Display message delivery errors, and offer the options to retry sending the message',
          'Add modal to join a room using its JID'
        ],
      },
      {
        type: 'changed',
        items: [
          'Improved mobile rendering layout',
          'Context menus close on scroll for better UX',
          'Reply arrow moved to avatar column in reply context for better visual alignment',
          'Dropdown menus aligned to the left on small screens',
          'Extracted reusable ModalShell, ConfirmDialog, and useNotificationPermission components',
          'Switched to HashRouter and relative asset paths for sub-path deployable static builds',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Active room not moving to top of sidebar on new messages',
          'New message marker lagging behind when switching conversations',
          'Blank window in MUC rooms caused by stale ResizeObserver ref',
          'Reactions UI disabled in rooms without stable occupant identity',
          'Lazy loading pagination in room discovery',
          'Ignored user filtering improved by cross-matching JIDs and occupant IDs',
          'Notifications suppressed for replies quoting ignored users in MUC rooms',
          'Native window theme syncing for \'system\' mode in Tauri',
          'Contacts sidebar button alignment',
          'Navigation stack management to help on mobile',
          'Chevron rotation logic in RoomHeader',
          'Modals closing when click-dragging from inside to outside',
          'Notification lastSeenMessageId not advancing on outgoing messages',
          'Devices section rendering in UserInfoPopover',
          'Fallback to occupant JID username when contact JID is unavailable',
          'Owner showing as moderator in chat view',
        ],
      },
    ],
  },
  {
    version: '0.13.3',
    date: '2026-03-04',
    sections: [
      {
        type: 'added',
        items: [
          'MUC room member affiliation discovery for avatars, panel, and mentions',
          'MUC message history authors included in mention autocomplete',
          'Session persistence scoped by JID for multi-account isolation',
          'XMPP Console log batching with increased entry limit',
        ],
      },
      {
        type: 'changed',
        items: [
          'Windows installer defaults to passive install mode',
          'Keyboard shortcut listener dependencies stabilized',
          'Stanza-id references enforced in MUCs when available',
        ],
      },
      {
        type: 'fixed',
        items: [
          'SM resumption now detects cache clear and triggers full sync',
          'Roster subscription refusal no longer creates ghost entries',
          'Message reactions normalized for consistent reactor identifiers',
          'Viewport pending reports flushed on conversation switch to avoid stale states',
          'Reply behavior uses client-generated IDs for chat messages (XEP-0461)',
          'Unicode normalization improved for MUC nickname mention matching',
          'Media URLs with special characters in path handled correctly',
          'Linux keyring uses Secret Service backend for persistent credential storage',
          'Linux WebKitGTK dmabuf renderer disabled to prevent Wayland crash',
          'iOS safe area insets for camera cutout and home indicator (PWA)',
          'Deep link async URI processing errors handled explicitly',
          'Service worker install and audio notification guards hardened',
          'Clear-storage event listener made unmount-safe',
          'Flatpak runtime updated to GNOME 49',
        ],
      },
    ],
  },
  {
    version: '0.13.2',
    date: '2026-02-19',
    sections: [
      {
        type: 'added',
        items: [
          'SDK: Connection state machine for more predictable connection lifecycle',
          '`--dangerous-insecure-tls` CLI flag to disable TLS certificate verification',
          'SDK diagnostic logging for user troubleshooting, with shortcut to access log file',
          'Russian, Belarusian, Ukrainian, and Simplified Chinese translations (31 languages total)',
          'Linux system tray support with close-to-tray functionality',
          'Mod+Q full quit shortcut on Windows/Linux',
          'SCRAM authentication mechanism support with browser polyfills and UI display',
          'Windows drag and drop support',
        ],
      },
      {
        type: 'changed',
        items: [
          'Beta release process for pre-release testing',
          'Separated SM resumption and fresh session initialization paths',
          'Optimized active conversation rendering with `useChatActive` hook',
          'MAM guards to skip unnecessary operations during SM resumption',
          'Improved connection fallback: proper WebSocket URL resolution and proxy restart',
          'XMPP Console performance with `useCallback`/`React.memo`',
          'Reduced MAM traffic on connect',
          'Use system DNS as default with fallback to Tokio resolver',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Connection error handling with firewall hint for proxy mode failures',
          'harden shutdown/cleanup flow and add DNS timing logs',
          'Proxy memory handling with buffer size limits and better stanza extraction',
          'Reconnection logic and login display optimizations',
          'Connection error message formatting',
          'Multiple freeze conditions on reconnect after sleep/network change or server restart',
          'SRV priority sorting and TLS SNI domain handling',
          'Room avatar loss when occupant goes offline',
          'Duplicate messages from IRC bridges in MAM queries',
          'Avatar blob URL memory leak with deduplication pool',
          'Status message updates while staying online',
          'MUC nick preserved on reconnect short-circuit',
          'Linux logout lockups on proxy disconnect',
          'Non-fatal errors now keep reconnecting with capped backoff',
          'WebSocket protocol header compliance (RFC 7395) preventing browser rejection on Windows',
          'Try all SRV record endpoints on connection failure instead of only the first',
          'macOS reconnect reliability during sleep and focus events',
          'Flatpak build updated for system tray support',
        ],
      },
    ],
  },
  {
    version: '0.13.1',
    date: '2026-02-13',
    sections: [
      {
        type: 'added',
        items: [
          'Enhanced logging and diagnostics for connection troubleshooting',
          'Tracing for keychain, idle detection, link preview, and startup operations',
        ],
      },
      {
        type: 'changed',
        items: [
          'Improved XMPP proxy robustness and TCP streaming error handling',
          'Streamlined avatar restoration logic',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Memory and CPU leaks on connection loss',
          'SRV flip and double-connect on reconnect after sleep',
          'Background MAM catchup after reconnection',
          'New message marker rewinding to earlier position',
          'Room sorting after connection',
          'Occupant avatar negative cache handling',
          'Stuck tooltips on rapid hover',
          'Room members sidebar state lost across view switches',
          'HTTP upload discovery on server domain',
          'Pointer cursor missing on interactive buttons',
          'Windows code signing',
        ],
      },
    ],
  },
  {
    version: '0.13.0',
    date: '2026-02-12',
    sections: [
      {
        type: 'added',
        items: [
          'Native TCP connection support via WebSocket proxy (desktop)',
          'Clipboard image paste support (Cmd+V / Ctrl+V)',
          'Clear local data option on logout',
          'Complete EU language coverage (26 languages)',
          'Improved Linux packaging with native distro tools',
        ],
      },
      {
        type: 'changed',
        items: [
          'Smarter MAM strategy for better message history loading',
          'Dynamic locale loading for faster initial load',
          'Centralized notification state with viewport observer',
          'Windows tray behavior improvements',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Attachment styling consistency across themes',
          'Sidebar switching with Cmd+U',
          'Scroll-to-bottom reliability on media load',
          '"Copy Image" paste support (only tested with Safari)',
          'New message marker position on conversation switch',
          'Duplicate avatar fetches for unchanged hashes',
          'macOS layout corruption after sleep',
          'Markdown bold/strikethrough stripped from message previews',
          'Context menu positioning within viewport bounds',
        ],
      },
    ],
  },
  {
    version: '0.12.1',
    date: '2026-02-09',
    sections: [
      {
        type: 'added',
        items: [
          'Time format preference (12-hour, 24-hour, or auto)',
          'Collapsible long messages with Show more/less',
          'Negative avatar cache to reduce redundant vCard queries',
          'Azure Trusted Signing for Windows builds',
        ],
      },
      {
        type: 'changed',
        items: [
          'Skip MAM preview refresh on SM resume (performance)',
          'File attachment card styling improvements in both themes',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Typing indicators for group chats (room:typing event)',
          'Socket error handling improved with reduced redundant logs',
          'Failed media URLs cached to prevent repeated retry loops',
          'Wide horizontal images limited to prevent thin strips',
          'Link preview card border softened in dark mode',
          'Stable IDs generated for messages without ID (prevents duplicates)',
          'MUC occupant avatar event listener improved',
          'Autoscroll and input alignment improvements',
        ],
      },
    ],
  },
  {
    version: '0.12.0',
    date: '2026-02-06',
    sections: [
      {
        type: 'added',
        items: [
          'XEP-0398: MUC occupant avatars displayed in room participant list',
          'Message styling for bullet points and support for markdown bold',
          'Toast notifications for room invites and error feedback',
        ],
      },
      {
        type: 'changed',
        items: [
          'File drag-and-drop now stages files for preview before sending',
          'XMPP Console keyboard interaction and feedback improvements',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Scroll behavior for typing indicators and reactions',
          'Performance: improvements',
          'URL parsing for angle-bracketed URLs',
          'Profile editing disabled when offline',
          'Disabled room menu items render at full width',
          'Missing media files handled gracefully (404 errors)',
          'Update check no longer auto-triggers when viewing settings',
        ],
      },
    ],
  },
  {
    version: '0.11.3',
    date: '2026-02-03',
    sections: [
      {
        type: 'added',
        items: [
          'ARM64 builds for Linux',
          'Password visibility toggle on login screen',
        ],
      },
      {
        type: 'changed',
        items: [
          'Reply quote border uses quoted person\'s XEP-0392 consistent color and user\'s avatar',
          'MUC rooms now sorted by last message time',
          'Copy behavior preserved for single message selection',
          'Show room info in tooltip instead of inline preview',
          'Standardized release asset names across platforms',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Rooms with MAM disabled no longer fallback to service-level MAM',
          'Scroll to new message marker when entering room with unread messages',
          'Emoji picker buttons no longer submit form accidentally',
          'Own MUC message detection improved for unread clearing',
          'Double reconnection race condition after wake from sleep',
          'Restored keychain credentials saving on login',
          'Android status bar color syncs with app theme',
          'Mobile layout improvements for e/OS/ and Android',
          'Image loading no longer proxied via Tauri HTTP plugin',
          'Date separator and cursor alignment in message list',
          'MAM catchup reliability improvements',
          'Sidebar message preview shows correct content',
          'OOB attachment URL stripped from message body',
          'Room avatar fetch no longer logs error when avatar missing',
          'Reply quotes show avatar for own messages',
          'Quick Chats section spacing in sidebar',
        ],
      },
    ],
  },
  {
    version: '0.11.2',
    date: '2026-01-31',
    sections: [
      {
        type: 'added',
        items: [
          'Keyboard shortcut improvements (Cmd+K in composer, better macOS Alt shortcuts)',
          'Debian packaging and aarch64 Linux support',
          'Developer documentation (DEVELOPMENT.md)',
        ],
      },
      {
        type: 'changed',
        items: [
          'Command palette selection is now more visually distinct',
          'Reply quote text size increased for better readability',
          'Thumbnail resolution increased from 256px to 512px',
          'Fonts embedded locally (removed Google Fonts dependency)',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Connection stability: fixed reconnection loops and race conditions',
          'MAM loading race conditions in both chats and rooms',
          'Wake-from-sleep detection when app stays in background (macOS)',
          'Scroll-to-original message with special characters in IDs',
          'Message view alignment when clicking notification to open conversation',
          'German and Polish translation diacritics',
          'Reaction tooltip now shows localized "you" with proper nickname',
        ],
      },
    ],
  },
  {
    version: '0.11.1',
    date: '2026-01-28',
    sections: [
      {
        type: 'added',
        items: [
          'Background refresh of conversation previews after connect',
          'Windows system tray with hide-to-tray on close',
          'Native save dialog for console log export on desktop',
        ],
      },
      {
        type: 'changed',
        items: [
          'Verifying connection status indicator when waking from sleep',
          'Quick Chat room history is now transient (XEP-0334 noStore hint)',
          'Linux Flatpak distribution (replaces AppImage)',
        ],
      },
      {
        type: 'fixed',
        items: [
          'XEP-0446 File Metadata for image dimensions (prevents layout shift)',
          'Room avatar caching restored for bookmarked rooms',
          'Various cosmetic and mobile UX improvements',
        ],
      },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-01-26',
    sections: [
      {
        type: 'added',
        items: [
          'Room MAM detection: rooms supporting message archives skip MUC history (faster joins)',
          'Loading indicator while fetching message history',
          'Priority shown in contact profile connected devices',
        ],
      },
      {
        type: 'changed',
        items: [
          'Message toolbar locks when emoji picker or menu is open',
          'Event-based SDK infrastructure to make the app more reactive',
        ],
      },
      {
        type: 'fixed',
        items: [
          'Tooltips hide immediately when their trigger menu opens',
        ],
      },
    ],
  },
  {
    version: '0.0.1',
    date: '2025-12-19',
    sections: [
      {
        type: 'added',
        items: [
          'First commit: Initial XMPP web client with React SDK',
        ],
      },
    ],
  },
]

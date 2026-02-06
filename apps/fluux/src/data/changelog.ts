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

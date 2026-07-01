/**
 * English translations for tutorial tooltips.
 *
 * Keys match tutorial step IDs from tutorialSteps.ts.
 * Each step has a `content` (main text) and optional `actionHint` (bold CTA).
 */
const tutorialEN = {
  'welcome-hint': {
    content: 'Welcome to Fluux! This is your messaging workspace — conversations on the left, messages on the right.',
    actionHint: 'Let\'s start by exploring your conversations',
  },
  'conversations-hint': {
    content: 'The Messages tab shows your 1-on-1 conversations. Emma just sent you a screenshot.',
    actionHint: 'Click on a conversation to catch up',
  },
  'rooms-hint': {
    content: 'Rooms are group conversations where your team collaborates in real time.',
    actionHint: 'Click the Rooms icon to see what your team is up to',
  },
  'image-hint': {
    content: 'Images can be viewed full-screen with download options.',
    actionHint: 'Click on any image to open the lightbox',
  },
  'file-upload-hint': {
    content: 'You can share files, images, and documents with contacts.',
    actionHint: 'Try the attach button to send a file',
  },
  'search-hint': {
    content: 'Search messages across all conversations. Use type filters or "in:Team" to narrow results.',
    actionHint: 'Click the Search icon and try typing "SDK" or "in:Team"',
  },
  'mention-hint': {
    content: 'You were @mentioned in Team Chat — the badge shows unread mentions.',
    actionHint: 'Click on Team Chat to jump to your mention',
  },
  'keyboard-shortcuts-hint': {
    content: 'Fluux has full keyboard navigation. Use Cmd+K to switch panels quickly, or press ? to see all shortcuts.',
    actionHint: 'Try pressing ? to see the keyboard shortcuts',
  },
  'theme-hint': {
    content: 'Make Fluux yours — themes, accent colors, fonts, and 30+ languages are just a click away.',
    actionHint: 'Open Settings to try accent colors, themes, and language switching',
  },
  'admin-hint': {
    content: 'The Admin dashboard lets server operators manage users, rooms, and server settings.',
    actionHint: 'Click the Admin icon in the sidebar to explore',
  },
  'xmpp-console-hint': {
    content: 'For developers: the XMPP console shows all protocol traffic — stanzas in and out.',
    actionHint: 'Open Settings > XMPP Console to see live XMPP packets',
  },
  'tour-complete': {
    content: "That's the tour! All features are live — explore freely. Enjoy Fluux! ✨",
  },
  skip: 'Skip',
} as const

export default tutorialEN

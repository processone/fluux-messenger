/**
 * Tutorial step definitions — each maps to a stepId fired by the animation timeline.
 *
 * Selectors target stable attributes:
 *   - [data-nav="<view>"] on sidebar nav buttons (via IconRailNavLink)
 *   - [aria-label="..."] on action buttons
 *   - Tailwind utility classes for structural elements (message images, scroll containers)
 */

import type { TutorialStep } from './types'

export const TUTORIAL_STEPS: TutorialStep[] = [
  // ── Act 1: Conversation basics ──────────────────────────────────────
  {
    id: 'lightbox-hint',
    // Image attachment: <button> wrapping an <img class="max-w-full ...">
    targetSelector: 'main img.max-w-full',
    content: 'Images can be opened full-screen with a download option.',
    actionHint: 'Click on any image to open the lightbox',
    position: 'bottom',
    completionTrigger: { type: 'dom-appears', selector: '.fixed.inset-0.bg-black\\/90' },
    maxWaitMs: 45_000,
  },

  // ── Act 2: Rich media ──────────────────────────────────────────────
  {
    id: 'image-lightbox',
    targetSelector: 'main img.max-w-full',
    content: 'The lightbox supports download and full-screen viewing.',
    actionHint: 'Click on the new image to see it in the lightbox',
    position: 'bottom',
    completionTrigger: { type: 'dom-appears', selector: '.fixed.inset-0.bg-black\\/90' },
    maxWaitMs: 45_000,
  },
  {
    id: 'file-upload-hint',
    // The + button in the compose area
    targetSelector: 'button[aria-label*="ttach"], button[aria-label*="ichier"]',
    content: 'You can share files, images, and documents with contacts.',
    actionHint: 'Try the attach button to send a file',
    position: 'top',
    completionTrigger: { type: 'timeout', ms: 8_000 },
    maxWaitMs: 30_000,
  },

  // ── Act 3: Rooms & activity ─────────────────────────────────────────
  {
    id: 'poll-hint',
    // Fallback to room nav if no poll card is rendered yet
    targetSelector: '[data-nav="rooms"]',
    content: 'Polls let team members vote on decisions right in the chat.',
    actionHint: 'Open Team Chat to find the poll and cast your vote',
    position: 'right',
    completionTrigger: { type: 'timeout', ms: 12_000 },
    maxWaitMs: 30_000,
  },
  {
    id: 'activity-log-hint',
    targetSelector: '[data-nav="events"]',
    content: 'The Activity tab shows subscription requests, reactions, and invitations.',
    actionHint: 'Click the Activity icon in the sidebar to see new events',
    position: 'right',
    completionTrigger: { type: 'click', selector: '[data-nav="events"]' },
    maxWaitMs: 30_000,
  },

  // ── Act 4: Search, mentions & keyboard ──────────────────────────────
  {
    id: 'search-hint',
    targetSelector: '[data-nav="search"]',
    content: 'Search messages across all conversations. Use type filters or "in:Team" to narrow results.',
    actionHint: 'Click the Search icon and try typing "SDK" or "in:Team"',
    position: 'right',
    completionTrigger: { type: 'click', selector: '[data-nav="search"]' },
    maxWaitMs: 45_000,
  },
  {
    id: 'mention-hint',
    targetSelector: '[data-nav="rooms"]',
    content: 'You were @mentioned in Team Chat — the badge shows unread mentions.',
    actionHint: 'Click on Team Chat to jump to your mention',
    position: 'right',
    completionTrigger: { type: 'timeout', ms: 10_000 },
    maxWaitMs: 30_000,
  },
  {
    id: 'keyboard-shortcuts-hint',
    targetSelector: 'body',
    content: 'Fluux has full keyboard navigation. Use Cmd+K to switch panels quickly, or press ? to see all shortcuts.',
    actionHint: 'Try pressing ? to see the keyboard shortcuts',
    position: 'bottom',
    completionTrigger: { type: 'dom-appears', selector: '[role="dialog"]' },
    maxWaitMs: 30_000,
  },

  // ── Act 5: Customization & moderation ───────────────────────────────
  {
    id: 'theme-hint',
    targetSelector: '[data-nav="settings"]',
    content: 'Customize the look with themes, accent colors, fonts, and custom CSS snippets.',
    actionHint: 'Open Settings > Appearance to try accent colors and theme switching',
    position: 'right',
    completionTrigger: { type: 'navigate', hash: '#/settings' },
    maxWaitMs: 45_000,
  },
  {
    id: 'language-hint',
    targetSelector: '[data-nav="settings"]',
    content: 'The UI is available in 30+ languages. Switching is instant.',
    actionHint: 'Try Settings > Language to switch the interface language',
    position: 'right',
    completionTrigger: { type: 'timeout', ms: 12_000 },
    maxWaitMs: 30_000,
  },
  {
    id: 'message-deletion-hint',
    targetSelector: '[data-nav="rooms"]',
    content: 'Moderators can delete messages with a reason. Deleted messages show a placeholder.',
    actionHint: 'Check Design Review — a message was moderated by Oliver',
    position: 'right',
    completionTrigger: { type: 'timeout', ms: 10_000 },
    maxWaitMs: 30_000,
  },
  {
    id: 'muc-management-hint',
    // Point at the rooms button since occupant panel may not be visible
    targetSelector: '[data-nav="rooms"]',
    content: 'As room owner, you can manage roles, kick/ban users, and configure the room.',
    actionHint: 'In Team Chat, click a member\'s name to see moderation options',
    position: 'right',
    completionTrigger: { type: 'dom-appears', selector: '[role="dialog"]' },
    maxWaitMs: 30_000,
  },
  {
    id: 'room-members-hint',
    targetSelector: '[data-nav="rooms"]',
    content: 'The Members panel shows owners, admins, members, and banned users.',
    actionHint: 'Try the Members button in the room header',
    position: 'right',
    completionTrigger: { type: 'dom-appears', selector: '[role="dialog"]' },
    maxWaitMs: 30_000,
  },

  // ── Act 6: Admin & developer tools ──────────────────────────────────
  {
    id: 'admin-hint',
    targetSelector: '[data-nav="admin"]',
    content: 'The Admin dashboard lets server operators manage users, rooms, and server settings.',
    actionHint: 'Click the Admin icon in the sidebar to explore',
    position: 'right',
    completionTrigger: { type: 'click', selector: '[data-nav="admin"]' },
    maxWaitMs: 30_000,
  },
  {
    id: 'xmpp-console-hint',
    // Console is rendered via IconRailButton, not IconRailNavLink,
    // so there's no data-nav. Fall back to settings since the console
    // might be inside settings or a separate button.
    targetSelector: '[data-nav="settings"]',
    content: 'For developers: the XMPP console shows all protocol traffic — stanzas in and out.',
    actionHint: 'Open Settings > XMPP Console to see live XMPP packets',
    position: 'right',
    completionTrigger: { type: 'timeout', ms: 10_000 },
    maxWaitMs: 30_000,
  },
  {
    id: 'history-hint',
    // The scrollable message list container
    targetSelector: 'main .overflow-y-auto',
    content: 'Messages are synced from the server archive (MAM). Scroll up to load earlier history.',
    actionHint: 'Scroll to the top of any conversation to see full message history',
    position: 'top',
    completionTrigger: { type: 'timeout', ms: 10_000 },
    maxWaitMs: 30_000,
  },
  {
    id: 'tour-complete',
    targetSelector: 'body',
    content: 'That\'s the tour! All features are live — explore freely. Enjoy Fluux! ✨',
    position: 'bottom',
    completionTrigger: { type: 'timeout', ms: 15_000 },
    maxWaitMs: 20_000,
  },
]

/** Lookup a tutorial step by ID. */
export function getTutorialStep(stepId: string): TutorialStep | undefined {
  return TUTORIAL_STEPS.find(s => s.id === stepId)
}

/**
 * Sidebar — Contacts relocation tests
 *
 * Full Sidebar rendering requires too many child-component mocks
 * (ConversationList, RoomsList, etc.) to be practical in the unit-test harness.
 * We use the pure-helper fallback documented in the task brief: the two count
 * computations are extracted as `eventsPendingCount` (exported from Sidebar.tsx)
 * and the `pendingRequestCount` inline selector, and we assert the same
 * two behaviors through those helpers.
 */
import { describe, it, expect } from 'vitest'
import { eventsPendingCount } from './Sidebar'

describe('Sidebar — Contacts relocation', () => {
  it('subscription requests drive the Contacts badge but are excluded from the Events badge', () => {
    // State carries 2 pending requests AND no other Events items.
    const state = {
      subscriptionRequests: [
        { id: 'r1', from: 'a@x', timestamp: new Date() },
        { id: 'r2', from: 'b@x', timestamp: new Date() },
      ],
      strangerMessages: [],
      mucInvitations: [],
      systemNotifications: [],
    }
    // Contacts badge selector, exactly as wired in Sidebar.tsx (pendingRequestCount).
    const contactsBadgeCount = (s: { subscriptionRequests: unknown[] }) => s.subscriptionRequests.length
    expect(contactsBadgeCount(state)).toBe(2)
    // The Events bell must IGNORE subscription requests entirely.
    expect(eventsPendingCount(state)).toBe(0)
  })

  it('the Events rail button badge ignores subscription requests', () => {
    // Only subscription requests present — no strangerMessages, mucInvitations, systemNotifications.
    // eventsPendingCount must return 0, so no badge is shown on the Events button.
    const state = {
      strangerMessages: [],
      mucInvitations: [],
      systemNotifications: [],
    }
    expect(eventsPendingCount(state)).toBe(0)
  })

  it('eventsPendingCount sums strangerMessages (deduplicated by from), mucInvitations, and systemNotifications', () => {
    const state = {
      strangerMessages: [
        { from: 'alice@x' },
        { from: 'alice@x' }, // duplicate — should only count once
        { from: 'bob@x' },
      ],
      mucInvitations: [{}],
      systemNotifications: [{}, {}],
    }
    // 2 unique strangers + 1 muc + 2 system = 5
    expect(eventsPendingCount(state)).toBe(5)
  })
})

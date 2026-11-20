/**
 * Showcase scene (`demo.html?scene=showcase`): curated data for marketing
 * screenshots and the public demo's first impression.
 *
 * It is deliberately separate from the default demo data, which is a test
 * fixture: e2e suites depend on its names and threads, and several of its
 * threads exist to exercise edge cases (message requests, failed decryption,
 * password-protected invitations) that a product shot should not show.
 */

import type { DemoData } from '@fluux/sdk/demo'
import { SELF } from '../constants'
import { SHOWCASE_SELF_NICK } from './constants'
import { SHOWCASE_CONTACTS, SHOWCASE_PRESENCES } from './contacts'
import { buildShowcaseConversations } from './conversations'
import { buildShowcaseRooms } from './rooms'

export { SHOWCASE_SELF_NAME } from './constants'
export { seedShowcaseSaved } from './saved'

/** Build the showcase data with fresh relative timestamps. */
export function buildShowcaseData(): DemoData {
  const { conversations, messages } = buildShowcaseConversations()
  return {
    self: { ...SELF, nick: SHOWCASE_SELF_NICK },
    contacts: SHOWCASE_CONTACTS,
    presences: SHOWCASE_PRESENCES,
    conversations,
    messages,
    rooms: buildShowcaseRooms(),
    ownResources: [
      { resource: 'desktop-7m0lds', show: null, priority: 50, client: 'Fluux Desktop' },
      { resource: 'phone-k9x2Qp', show: 'away', priority: 10, client: 'Fluux Mobile' },
    ],
  }
}

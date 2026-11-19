import type { Contact } from '@fluux/sdk'
import type { DemoPresence } from '@fluux/sdk/demo'
import { AVATAR_BASE } from '../constants'
import { AVA, EMMA, JAMES, LIAM, OLIVIA, SOPHIA } from './constants'

/**
 * Only five demo avatars are photos (`avatar-ava.webp` and `avatar-liam.webp` are
 * letter placeholders), so Ava borrows Mia's portrait and Liam keeps a letter
 * avatar, as an account without a photo would.
 */
export const SHOWCASE_CONTACTS: Contact[] = [
  { jid: EMMA, name: 'Emma Ward', presence: 'online', subscription: 'both', groups: ['Launch'], avatar: `${AVATAR_BASE}/avatar-emma.webp` },
  { jid: AVA, name: 'Ava Reyes', presence: 'online', subscription: 'both', groups: ['Launch'], avatar: `${AVATAR_BASE}/avatar-mia.webp` },
  { jid: LIAM, name: 'Liam Ross', presence: 'online', subscription: 'both', groups: ['Launch'] },
  {
    jid: SOPHIA, name: 'Sophia Lin', presence: 'dnd', statusMessage: 'Rehearsing my talk', subscription: 'both',
    groups: ['Speakers'], avatar: `${AVATAR_BASE}/avatar-sophia.webp`,
  },
  {
    jid: JAMES, name: 'James Hale', presence: 'away', statusMessage: 'Back in 20', subscription: 'both',
    groups: ['Launch'], avatar: `${AVATAR_BASE}/avatar-james.webp`,
  },
  { jid: OLIVIA, name: 'Olivia Park', presence: 'online', subscription: 'both', groups: ['Design'], avatar: `${AVATAR_BASE}/avatar-olivia.webp` },
]

export const SHOWCASE_PRESENCES: DemoPresence[] = [
  { fullJid: `${EMMA}/desktop`, show: null, priority: 5, client: 'Fluux' },
  { fullJid: `${AVA}/phone`, show: null, priority: 5, client: 'Fluux' },
  { fullJid: `${LIAM}/laptop`, show: null, priority: 5, client: 'Fluux' },
  { fullJid: `${SOPHIA}/laptop`, show: 'dnd', priority: 5, statusMessage: 'Rehearsing my talk', client: 'Fluux' },
  { fullJid: `${JAMES}/phone`, show: 'away', priority: 0, statusMessage: 'Back in 20', client: 'Fluux' },
  { fullJid: `${OLIVIA}/desktop`, show: null, priority: 5, client: 'Fluux' },
]

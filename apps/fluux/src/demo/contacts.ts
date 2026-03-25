/**
 * Demo contacts and per-resource presence data.
 */

import type { Contact } from '@fluux/sdk'
import type { DemoPresence } from '@fluux/sdk'
import { hoursAgo } from '@fluux/sdk'
import { DOMAIN, AVATAR_BASE } from './constants'

export const DEMO_CONTACTS: Contact[] = [
  {
    jid: `emma@${DOMAIN}`,
    name: 'Emma Wilson',
    presence: 'online',
    subscription: 'both',
    groups: ['Team'],
    avatar: `${AVATAR_BASE}/avatar-emma.webp`,
  },
  {
    jid: `james@${DOMAIN}`,
    name: 'James Chen',
    presence: 'away',
    statusMessage: 'In a meeting until 3pm',
    subscription: 'both',
    groups: ['Team'],
    avatar: `${AVATAR_BASE}/avatar-james.webp`,
  },
  {
    jid: `sophia@${DOMAIN}`,
    name: 'Sophia Rodriguez',
    presence: 'dnd',
    statusMessage: 'Deep work — ping me only if urgent',
    subscription: 'both',
    groups: ['Team'],
    avatar: `${AVATAR_BASE}/avatar-sophia.webp`,
  },
  {
    jid: `oliver@${DOMAIN}`,
    name: 'Oliver Park',
    presence: 'online',
    subscription: 'both',
    groups: ['Design'],
    avatar: `${AVATAR_BASE}/avatar-oliver.webp`,
  },
  {
    jid: `mia@${DOMAIN}`,
    name: 'Mia Thompson',
    presence: 'offline',
    subscription: 'both',
    groups: ['Design'],
    lastSeen: hoursAgo(3),
    avatar: `${AVATAR_BASE}/avatar-mia.webp`,
  },
  {
    jid: `liam@${DOMAIN}`,
    name: 'Liam Brooks',
    presence: 'online',
    subscription: 'both',
    groups: ['Team'],
    avatar: `${AVATAR_BASE}/avatar-liam.webp`,
  },
  {
    jid: `ava@${DOMAIN}`,
    name: 'Ava Martinez',
    presence: 'away',
    statusMessage: 'Roadmap review — back at 4',
    subscription: 'both',
    groups: ['Product'],
    avatar: `${AVATAR_BASE}/avatar-ava.webp`,
  },
]

export const DEMO_PRESENCES: DemoPresence[] = [
  { fullJid: `emma@${DOMAIN}/desktop`, show: null, priority: 5, client: 'Fluux' },
  { fullJid: `james@${DOMAIN}/mobile`, show: 'away', priority: 0, statusMessage: 'In a meeting until 3pm', client: 'Fluux' },
  { fullJid: `sophia@${DOMAIN}/laptop`, show: 'dnd', priority: 5, statusMessage: 'Deep work — ping me only if urgent', client: 'Fluux' },
  { fullJid: `oliver@${DOMAIN}/desktop`, show: null, priority: 5, client: 'Fluux' },
  { fullJid: `liam@${DOMAIN}/desktop`, show: null, priority: 5, client: 'Fluux' },
  { fullJid: `ava@${DOMAIN}/laptop`, show: 'away', priority: 5, statusMessage: 'Roadmap review — back at 4', client: 'Fluux' },
]

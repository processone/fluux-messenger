/**
 * Demo data orchestrator — assembles all demo content from modular files.
 *
 * All data uses relative timestamps so the demo always looks fresh.
 * Called from demo.tsx and passed to DemoClient.
 */

import type { DemoData, DemoAnimationStep } from '@fluux/sdk'
import { SELF } from './constants'
import { DEMO_CONTACTS, DEMO_PRESENCES } from './contacts'
import { getDemoConversations, getDemoMessages } from './conversations'
import { getDemoRooms } from './rooms'
import { getDemoActivityEvents } from './activityEvents'
import { buildDemoAnimation } from './animation'

/** Build all demo data with fresh relative timestamps. */
export function buildDemoData(): DemoData {
  return {
    self: SELF,
    contacts: DEMO_CONTACTS,
    presences: DEMO_PRESENCES,
    conversations: getDemoConversations(),
    messages: getDemoMessages(),
    rooms: getDemoRooms(),
    activityEvents: getDemoActivityEvents(),
  }
}

export { buildDemoAnimation }
export type { DemoAnimationStep }

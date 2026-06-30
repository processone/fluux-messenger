/**
 * Verifies that DemoClient.populateDemo seeds eventsStore.subscriptionRequests
 * so the Contacts destination shows pending add-contact requests.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DemoClient } from './DemoClient'
import { eventsStore } from '../stores/eventsStore'
import type { DemoData } from './types'

function makeClient(): DemoClient {
  const client = new DemoClient()
  ;(client as unknown as { currentJid: string | null }).currentJid = 'you@fluux.chat'
  ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'
  return client
}

/** Minimal valid DemoData with just enough fields to not throw. */
function makeMinimalDemoData(subscriptionRequests: string[]): DemoData {
  return {
    self: { jid: 'you@fluux.chat', nick: 'You', domain: 'fluux.chat' },
    contacts: [],
    presences: [],
    conversations: [],
    messages: new Map(),
    rooms: [],
    activityEvents: [],
    subscriptionRequests,
  }
}

describe('DemoClient subscription request seeding', () => {
  beforeEach(() => {
    // Reset eventsStore before each test to avoid cross-test bleed
    eventsStore.setState({ subscriptionRequests: [] })
  })

  it('populateDemo seeds subscriptionRequests into eventsStore', () => {
    const client = makeClient()
    const jids = ['olivia@fluux.chat', 'alex@fluux.chat']
    client.populateDemo(makeMinimalDemoData(jids))

    const requests = eventsStore.getState().subscriptionRequests
    expect(requests).toHaveLength(2)
    expect(requests.map((r) => r.from)).toContain('olivia@fluux.chat')
    expect(requests.map((r) => r.from)).toContain('alex@fluux.chat')
  })

  it('populateDemo with no subscriptionRequests leaves eventsStore empty', () => {
    const client = makeClient()
    client.populateDemo(makeMinimalDemoData([]))

    const requests = eventsStore.getState().subscriptionRequests
    expect(requests).toHaveLength(0)
  })

  it('populateDemo with undefined subscriptionRequests leaves eventsStore empty', () => {
    const client = makeClient()
    const data = makeMinimalDemoData([])
    delete data.subscriptionRequests
    client.populateDemo(data)

    const requests = eventsStore.getState().subscriptionRequests
    expect(requests).toHaveLength(0)
  })
})

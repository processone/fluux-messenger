/**
 * Verifies that DemoClient.populateDemo seeds eventsStore.mucInvitations and
 * eventsStore.strangerMessages so the redistributed Rooms "Invitations" and
 * Messages "Message requests" banners are visible in demo mode.
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

/** Minimal valid DemoData suitable for events-seeding tests. */
function makeMinimalDemoData(
  overrides: Partial<Pick<DemoData, 'mucInvitations' | 'strangerMessages'>> = {}
): DemoData {
  return {
    self: { jid: 'you@fluux.chat', nick: 'You', domain: 'fluux.chat' },
    contacts: [],
    presences: [],
    conversations: [],
    messages: new Map(),
    rooms: [],
    activityEvents: [],
    ...overrides,
  }
}

describe('DemoClient events store seeding', () => {
  beforeEach(() => {
    eventsStore.setState({ mucInvitations: [], strangerMessages: [] })
  })

  // --- mucInvitations ---

  it('populateDemo seeds mucInvitations into eventsStore', () => {
    const client = makeClient()
    client.populateDemo(
      makeMinimalDemoData({
        mucInvitations: [
          { roomJid: 'design-team@conference.fluux.chat', from: 'ava@fluux.chat', reason: 'Join us' },
        ],
      })
    )

    const invitations = eventsStore.getState().mucInvitations
    expect(invitations).toHaveLength(1)
    expect(invitations[0].roomJid).toBe('design-team@conference.fluux.chat')
    expect(invitations[0].from).toBe('ava@fluux.chat')
    expect(invitations[0].reason).toBe('Join us')
  })

  it('populateDemo seeds multiple mucInvitations', () => {
    const client = makeClient()
    client.populateDemo(
      makeMinimalDemoData({
        mucInvitations: [
          { roomJid: 'room-a@conference.fluux.chat', from: 'alice@fluux.chat' },
          { roomJid: 'room-b@conference.fluux.chat', from: 'bob@fluux.chat', reason: 'Come join' },
        ],
      })
    )

    const invitations = eventsStore.getState().mucInvitations
    expect(invitations).toHaveLength(2)
    expect(invitations.map((i) => i.roomJid)).toContain('room-a@conference.fluux.chat')
    expect(invitations.map((i) => i.roomJid)).toContain('room-b@conference.fluux.chat')
  })

  it('populateDemo with no mucInvitations leaves eventsStore empty', () => {
    const client = makeClient()
    client.populateDemo(makeMinimalDemoData({ mucInvitations: [] }))

    expect(eventsStore.getState().mucInvitations).toHaveLength(0)
  })

  it('populateDemo with undefined mucInvitations leaves eventsStore empty', () => {
    const client = makeClient()
    client.populateDemo(makeMinimalDemoData())

    expect(eventsStore.getState().mucInvitations).toHaveLength(0)
  })

  // --- strangerMessages ---

  it('populateDemo seeds strangerMessages into eventsStore', () => {
    const client = makeClient()
    client.populateDemo(
      makeMinimalDemoData({
        strangerMessages: [
          { from: 'recruiter@fluux.chat', body: 'Hi! Are you open to new roles?' },
          { from: 'newcomer@fluux.chat', body: 'Hello, found you via the community list.' },
        ],
      })
    )

    const messages = eventsStore.getState().strangerMessages
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.from)).toContain('recruiter@fluux.chat')
    expect(messages.map((m) => m.from)).toContain('newcomer@fluux.chat')
  })

  it('populateDemo with no strangerMessages leaves eventsStore empty', () => {
    const client = makeClient()
    client.populateDemo(makeMinimalDemoData({ strangerMessages: [] }))

    expect(eventsStore.getState().strangerMessages).toHaveLength(0)
  })

  it('populateDemo with undefined strangerMessages leaves eventsStore empty', () => {
    const client = makeClient()
    client.populateDemo(makeMinimalDemoData())

    expect(eventsStore.getState().strangerMessages).toHaveLength(0)
  })

  // --- combined ---

  it('populateDemo seeds both mucInvitations and strangerMessages together', () => {
    const client = makeClient()
    client.populateDemo(
      makeMinimalDemoData({
        mucInvitations: [{ roomJid: 'design-team@conference.fluux.chat', from: 'ava@fluux.chat', reason: 'Join us for the redesign kickoff' }],
        strangerMessages: [
          { from: 'recruiter@fluux.chat', body: 'Hi! Are you open to new roles?' },
          { from: 'newcomer@fluux.chat', body: 'Hello, found you via the community list.' },
        ],
      })
    )

    expect(eventsStore.getState().mucInvitations).toHaveLength(1)
    expect(eventsStore.getState().strangerMessages).toHaveLength(2)
  })
})

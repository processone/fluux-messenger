import { describe, expect, it } from 'vitest'
import { DemoClient } from './DemoClient'
import { connectionStore } from '../stores/connectionStore'

describe('DemoClient session metadata', () => {
  it('provides fixture transport and authentication for the profile on first paint', () => {
    connectionStore.setState({ connectionMethod: null, authMechanism: null })
    const client = new DemoClient()
    client.populateDemo({
      self: { jid: 'you@fluux.chat', nick: 'You', domain: 'fluux.chat' },
      contacts: [], presences: [], conversations: [], messages: new Map(), rooms: [],
    })

    expect(connectionStore.getState().connectionMethod).toBe('websocket')
    expect(connectionStore.getState().authMechanism).toBe('SCRAM-SHA-256')
  })
})

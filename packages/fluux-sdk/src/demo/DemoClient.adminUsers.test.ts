/**
 * Demo-mode admin user directory: the friendly admin user list calls live IQ
 * methods (fetchAllUsers / fetchOnlineUserJids / fetchLastActivity). DemoClient
 * must simulate XEP-0133 get-registered-users-list, get-online-users-list, and
 * XEP-0012 jabber:iq:last so the list, presence dots, and last-login column
 * render without a server.
 */
import { describe, it, expect } from 'vitest'
import { DemoClient } from './DemoClient'

function makeClient(): DemoClient {
  const client = new DemoClient()
  ;(client as unknown as { currentJid: string | null }).currentJid = 'you@fluux.chat'
  ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'
  return client
}

describe('DemoClient admin user directory', () => {
  it('fetchAllUsers returns the full demo roster in a single page', async () => {
    const client = makeClient()
    const { users, truncated } = await client.admin.fetchAllUsers()
    expect(users.length).toBe(30)
    expect(truncated).toBe(false)
    // JIDs are well-formed and carry the demo domain.
    expect(users.every((u) => u.jid.endsWith('@fluux.chat'))).toBe(true)
    expect(users.some((u) => u.jid === 'emma@fluux.chat')).toBe(true)
  })

  it('fetchOnlineUserJids returns a strict, non-empty subset of the roster', async () => {
    const client = makeClient()
    const { users } = await client.admin.fetchAllUsers()
    const online = await client.admin.fetchOnlineUserJids()
    expect(online.size).toBeGreaterThan(0)
    expect(online.size).toBeLessThan(users.length)
    expect([...online].every((j) => users.some((u) => u.jid === j))).toBe(true)
  })

  it('fetchLastActivity returns a deterministic, supported interval per JID', async () => {
    const client = makeClient()
    const a = await client.admin.fetchLastActivity('mia@fluux.chat')
    const b = await client.admin.fetchLastActivity('mia@fluux.chat')
    expect(a.unsupported).toBe(false)
    expect(typeof a.seconds).toBe('number')
    expect((a.seconds ?? 0) > 0).toBe(true)
    expect(a.seconds).toBe(b.seconds) // deterministic
  })
})

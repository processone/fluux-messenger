import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { XMPPClient, bindStoresForTesting } from './XMPPClient'
import { createMockXmppClient, createMockStores, type MockXmppClient } from './test-utils'
import * as index from '../utils/searchIndex'

let transport: MockXmppClient
vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => transport),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({ name, attrs: attrs ?? {}, children, toString: () => `<${name}/>` })),
}))
vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))
vi.mock('../utils/searchIndex', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/searchIndex')>(),
  initSearchIndex: vi.fn().mockResolvedValue(undefined),
  backfillFromMessageCache: vi.fn().mockResolvedValue(undefined),
  migrateSearchPostings: vi.fn().mockResolvedValue(undefined),
  migrateSearchFilters: vi.fn().mockResolvedValue(undefined),
}))

describe('search preparation during sign-in', () => {
  let client: XMPPClient
  beforeEach(() => {
    vi.clearAllMocks()
    index._resetDBForTesting()
    transport = createMockXmppClient()
    client = new XMPPClient({ debug: false })
    bindStoresForTesting(client, createMockStores())
  })
  afterEach(() => { client.destroy() })

  async function signIn() {
    const connected = client.connect({ jid: 'search@example.test', password: 'fixture-password', server: 'example.test', skipDiscovery: true })
    transport._emit('online')
    await connected
  }

  it.each(['initSearchIndex', 'backfillFromMessageCache', 'migrateSearchPostings'] as const)(
    'still prepares filters after %s fails', async step => {
      vi.mocked(index[step]).mockRejectedValueOnce(new Error('Earlier preparation failed'))
      let reached!: () => void
      const prepared = new Promise<void>(resolve => { reached = resolve })
      vi.mocked(index.migrateSearchFilters).mockImplementationOnce(async () => { reached() })
      await signIn()
      await prepared
      expect(index.migrateSearchFilters).toHaveBeenCalledOnce()
    },
  )
})

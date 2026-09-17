/**
 * XMPPClient entity capabilities driven by registered E2EE plugins.
 *
 * XEP-0374 §2.1: `urn:xmpp:openpgp:im:0` announces that OpenPGP messaging
 * works, so it is advertised only while a plugin declaring it is registered,
 * and the XEP-0115 hash in our presence follows it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient, bindStoresForTesting } from './XMPPClient'
import { calculateCapsHash } from './caps'
import { NS_CAPS, NS_OPENPGP_IM } from './namespaces'
import { DummyPlaintextPlugin } from './e2ee/DummyPlaintextPlugin'
import {
  createMockXmppClient,
  createMockStores,
  type MockXmppClient,
  type MockStoreBindings,
} from './test-utils'

let mockXmppClientInstance: MockXmppClient

vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

import { client as xmppClientFactory } from '@xmpp/client'

interface MockElement {
  name: string
  attrs: Record<string, string>
  children: unknown[]
}

class OxImPlugin extends DummyPlaintextPlugin {
  override readonly descriptor = {
    ...new DummyPlaintextPlugin().descriptor,
    id: 'openpgp',
    discoFeatures: [NS_OPENPGP_IM],
  }
}

describe('XMPPClient E2EE entity capabilities', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)
    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    bindStoresForTesting(xmppClient, mockStores)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  async function connectOnline(): Promise<void> {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.mocked(mockStores.connection.getStatus).mockReturnValue('online')
  }

  function advertisedFeatures(): string[] {
    const result = mockXmppClientInstance.iqCallee._call(
      'http://jabber.org/protocol/disco#info',
      'query',
      { stanza: {} },
      'get',
    )
    return result.children
      .filter((c: MockElement) => c.name === 'feature')
      .map((f: MockElement) => f.attrs.var)
  }

  function sentCapsVersions(): string[] {
    return vi
      .mocked(mockXmppClientInstance.send)
      .mock.calls.map(([stanza]) => stanza as MockElement)
      .filter((stanza) => stanza.name === 'presence')
      .flatMap((stanza) =>
        stanza.children.filter(
          (c): c is MockElement => !!c && (c as MockElement).attrs?.xmlns === NS_CAPS,
        ),
      )
      .map((c) => c.attrs.ver)
  }

  it('does not advertise OX-IM while no OpenPGP plugin is registered', async () => {
    await connectOnline()

    expect(advertisedFeatures()).not.toContain(NS_OPENPGP_IM)
    const baseVer = await calculateCapsHash()
    await vi.waitFor(() => expect(sentCapsVersions().at(-1)).toBe(baseVer))
  })

  it('advertises OX-IM and re-announces the caps hash when the plugin registers and unregisters', async () => {
    await connectOnline()
    const baseVer = await calculateCapsHash()
    const oxVer = await calculateCapsHash([NS_OPENPGP_IM])
    await vi.waitFor(() => expect(sentCapsVersions().at(-1)).toBe(baseVer))

    await xmppClient.e2ee!.register(new OxImPlugin())

    expect(advertisedFeatures()).toContain(NS_OPENPGP_IM)
    await vi.waitFor(() => expect(sentCapsVersions().at(-1)).toBe(oxVer))

    await xmppClient.e2ee!.unregister('openpgp')

    expect(advertisedFeatures()).not.toContain(NS_OPENPGP_IM)
    await vi.waitFor(() => expect(sentCapsVersions().at(-1)).toBe(baseVer))
  })

  it('keeps the base caps hash after an immediate OpenPGP unregister', async () => {
    await connectOnline()
    const baseVer = await calculateCapsHash()
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
    let releaseOxDigest!: () => void
    let oxDigestCompleted = false
    const oxDigest = new Promise<void>((resolve) => {
      releaseOxDigest = resolve
    })
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      if (new TextDecoder().decode(data).includes(NS_OPENPGP_IM)) {
        await oxDigest
        oxDigestCompleted = true
      }
      return originalDigest(algorithm, data)
    })

    try {
      await xmppClient.e2ee!.register(new OxImPlugin())
      await xmppClient.e2ee!.unregister('openpgp')
      releaseOxDigest()

      await vi.waitFor(() => expect(oxDigestCompleted).toBe(true))
      expect(sentCapsVersions().at(-1)).toBe(baseVer)
    } finally {
      digestSpy.mockRestore()
    }
  })
})

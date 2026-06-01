/**
 * Integration tests for the E2EE wiring in the MAM module.
 *
 * These mirror `Chat.e2ee.test.ts`: they drive {@link MAM.queryArchive}
 * end-to-end with the real `@xmpp/client` XML builder and the
 * {@link DummyPlaintextPlugin}, covering the archive collector, the async
 * decrypt step, hint-body replacement, and security-context propagation.
 *
 * The main regression guarded here — the one the user hit in production —
 * is that an encrypted message replayed from MAM (offline delivery) is
 * decrypted before being emitted, instead of being surfaced with the
 * sender's XEP-0373 hint body and no decrypt attempt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import {
  E2EEManager,
  InMemoryStorageBackend,
  type XMPPPrimitives,
} from '../e2ee'
import { DummyPlaintextPlugin } from '../e2ee/DummyPlaintextPlugin'

function stubXmppPrimitives(): XMPPPrimitives {
  return {
    sendStanza: async () => {},
    queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    deletePEP: async () => {},
    queryPEP: async () => [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
}

async function makeManagerWithDummyPlugin(selfJid: string): Promise<E2EEManager> {
  const manager = new E2EEManager({
    storage: new InMemoryStorageBackend(),
    xmpp: stubXmppPrimitives(),
    account: { jid: selfJid },
  })
  await manager.register(new DummyPlaintextPlugin())
  return manager
}

/**
 * Build a MAM result stanza wrapping a forwarded <message>. Matches the
 * server shape: `<message><result queryid><forwarded><delay/><message/>`.
 * `queryid` is filled in later (runQuery sets it to match whatever
 * queryArchive generated).
 */
function buildMAMResult(options: {
  archiveId: string
  forwardedMessage: Element
  delayStamp?: string
}): Element {
  return xml(
    'message',
    {},
    xml(
      'result',
      { xmlns: 'urn:xmpp:mam:2', id: options.archiveId, queryid: 'placeholder' },
      xml(
        'forwarded',
        { xmlns: 'urn:xmpp:forward:0' },
        xml('delay', { xmlns: 'urn:xmpp:delay', stamp: options.delayStamp ?? new Date().toISOString() }),
        options.forwardedMessage,
      ),
    ),
  )
}

interface TestHarness {
  mam: MAM
  collectors: Map<string, (stanza: Element) => void>
  /** Resolver for the next sendIQ call. Test drives it manually so it can
   *  feed archive entries through the collector before the query returns. */
  resolveNextIQ: (fin: Element) => void
  iqPending: () => Promise<void>
}

function makeHarness(options: {
  jid: string
  manager: E2EEManager
}): TestHarness {
  const collectors = new Map<string, (stanza: Element) => void>()
  let pendingResolve: ((value: Element) => void) | null = null
  let pendingReady: (() => void) | null = null
  const readyPromise = new Promise<void>((r) => {
    pendingReady = r
  })

  const deps: ModuleDependencies = {
    stores: null,
    sendStanza: async () => {},
    sendIQ: () =>
      new Promise<Element>((resolve) => {
        pendingResolve = resolve
        pendingReady?.()
      }),
    getCurrentJid: () => options.jid,
    emit: () => {},
    emitSDK: () => {},
    getXmpp: () => null,
    getE2EEManager: () => options.manager,
    registerMAMCollector: (queryId, collector) => {
      collectors.set(queryId, collector)
      return () => collectors.delete(queryId)
    },
  }

  const mam = new MAM(deps)
  return {
    mam,
    collectors,
    iqPending: () => readyPromise,
    resolveNextIQ: (fin: Element) => {
      if (!pendingResolve) throw new Error('No pending sendIQ')
      const r = pendingResolve
      pendingResolve = null
      r(fin)
    },
  }
}

/**
 * Run a MAM 1:1 query, feed it a single archive entry, and return the
 * parsed messages. The harness stalls sendIQ so we can inject the entry
 * into the collector before the query resolves.
 */
async function runQueryWithEntry(
  harness: TestHarness,
  peer: string,
  archiveEntry: Element,
): Promise<{ body: string; from: string; securityContext?: { protocolId: string; trust: string; notes?: string[] } }[]> {
  const resultPromise = harness.mam.queryArchive({ with: peer, max: 10 })
  // Wait for queryArchive to register its collector AND call sendIQ.
  await harness.iqPending()
  const entries = [...harness.collectors.entries()]
  if (entries.length === 0) throw new Error('No collector registered')
  const [queryId, collector] = entries[0]
  archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
  collector(archiveEntry)
  // Now let sendIQ resolve with a "complete" fin. The drain loop will run.
  harness.resolveNextIQ(
    xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
  )
  const result = await resultPromise
  return result.messages.map((m) => ({
    body: m.body,
    from: m.from,
    ...(m.securityContext && { securityContext: m.securityContext }),
  }))
}

describe('MAM E2EE wiring', () => {
  const ME = 'me@example.com'
  const PEER = 'bob@example.com'

  let manager: E2EEManager
  let harness: TestHarness

  beforeEach(async () => {
    manager = await makeManagerWithDummyPlugin(ME)
    harness = makeHarness({ jid: ME, manager })
  })

  it('decrypts an incoming encrypted MAM entry and surfaces the plaintext body', async () => {
    // Build a real encrypted stanza (peer → me) by round-tripping through
    // a peer-scoped manager: peer encrypts to `ME` using its own manager.
    const peerManager = await makeManagerWithDummyPlugin(PEER)
    const payload = await peerManager.encryptOutbound(
      { kind: 'direct', peer: ME },
      new TextEncoder().encode('Encrypted archive body'),
    )
    if (!payload) throw new Error('Test setup: encryptOutbound returned null')

    const forwardedMessage = xml(
      'message',
      { from: PEER + '/res', to: ME, type: 'chat', id: 'mam-1' },
      xml('body', {}, payload.payload.fallbackBody ?? '[encrypted]'),
      xml(
        payload.payload.stanzaElement.name,
        payload.payload.stanzaElement.attrs,
        ...(payload.payload.stanzaElement.children as (string | Element)[]),
      ),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-1',
      forwardedMessage,
    })

    const messages = await runQueryWithEntry(harness, PEER, archiveEntry)

    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.body).toBe('Encrypted archive body')
    expect(msg.from).toBe(PEER)
    expect(msg.securityContext).toBeDefined()
    expect(msg.securityContext!.protocolId).toBe('dummy-plaintext')
    // Dummy plugin reports untrusted; presence of securityContext at all
    // proves the decrypt pipeline ran (cleartext path leaves it undefined).
    expect(msg.securityContext!.trust).toBe('untrusted')
  })

  it('falls back to the XEP-0373 hint body and marks untrusted when decrypt fails', async () => {
    const spy = vi
      .spyOn(manager, 'decryptArchive')
      .mockRejectedValue(new Error('broken ciphertext'))

    const forwardedMessage = xml(
      'message',
      { from: PEER + '/res', to: ME, type: 'chat', id: 'mam-fail' },
      xml('body', {}, '[OpenPGP-encrypted message]'),
      xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'not-a-real-payload'),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-fail',
      forwardedMessage,
    })

    const messages = await runQueryWithEntry(harness, PEER, archiveEntry)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.body).toBe('[OpenPGP-encrypted message]')
    expect(msg.securityContext).toBeDefined()
    expect(msg.securityContext!.trust).toBe('untrusted')
    expect(msg.securityContext!.notes).toContain('Could not decrypt')
  })

  it('decrypts self-outgoing archive entries (encrypt-to-self for MAM replay)', async () => {
    // Self-outgoing encrypted stanza — the archive replayed one of our
    // own sent messages. Since we encrypt-to-self (XEP-0373 multi-device),
    // the plugin must run on the archived payload just like an inbound
    // one, so the plaintext body is surfaced instead of the fallback.
    const payload = await manager.encryptOutbound(
      { kind: 'direct', peer: PEER },
      new TextEncoder().encode('outgoing, replayed from archive'),
    )
    if (!payload) throw new Error('Test setup: encryptOutbound returned null')

    const spy = vi.spyOn(manager, 'decryptArchive')

    const forwardedMessage = xml(
      'message',
      { from: ME + '/r', to: PEER, type: 'chat', id: 'mam-self' },
      xml('body', {}, payload.payload.fallbackBody ?? '[encrypted]'),
      xml(
        payload.payload.stanzaElement.name,
        payload.payload.stanzaElement.attrs,
        ...(payload.payload.stanzaElement.children as (string | Element)[]),
      ),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-self',
      forwardedMessage,
    })

    const messages = await runQueryWithEntry(harness, PEER, archiveEntry)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.body).toBe('outgoing, replayed from archive')
    expect(msg.securityContext).toBeDefined()
    expect(msg.securityContext!.protocolId).toBe('dummy-plaintext')
  })

  it('passes cleartext archive entries straight through without a security context', async () => {
    const forwardedMessage = xml(
      'message',
      { from: PEER + '/r', to: ME, type: 'chat', id: 'mam-plain' },
      xml('body', {}, 'hello plaintext'),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-plain',
      forwardedMessage,
    })

    const messages = await runQueryWithEntry(harness, PEER, archiveEntry)

    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('hello plaintext')
    expect(messages[0].securityContext).toBeUndefined()
  })

  it('threads isSelfOutgoing: true when the archive entry was sent by us (from === ownBareJid)', async () => {
    // MAM auto-detects self-outgoing entries by comparing the message's
    // bare `from` to the account's own bare JID. The signal must reach
    // the plugin via `decryptArchive`'s context so it can branch its
    // signature-key lookup and addressees reflection check. Without it,
    // the OpenPGP plugin would reject our own archived sends as
    // reflection attacks.
    const payload = await manager.encryptOutbound(
      { kind: 'direct', peer: PEER },
      new TextEncoder().encode('archived self-outgoing'),
    )
    if (!payload) throw new Error('Test setup: encryptOutbound returned null')

    const decryptSpy = vi.spyOn(manager, 'decryptArchive')

    const forwardedMessage = xml(
      'message',
      { from: ME + '/device-A', to: PEER, type: 'chat', id: 'mam-self-flag' },
      xml('body', {}, payload.payload.fallbackBody ?? '[encrypted]'),
      xml(
        payload.payload.stanzaElement.name,
        payload.payload.stanzaElement.attrs,
        ...(payload.payload.stanzaElement.children as (string | Element)[]),
      ),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-self-flag',
      forwardedMessage,
    })

    await runQueryWithEntry(harness, PEER, archiveEntry)

    expect(decryptSpy).toHaveBeenCalledTimes(1)
    const [, , context] = decryptSpy.mock.calls[0]
    expect(context?.isSelfOutgoing).toBe(true)
  })

  it('does NOT set isSelfOutgoing for an inbound archive entry (from === peer)', async () => {
    // Regression guard symmetric to the live carbon test: inbound
    // archive entries (the peer sent the message TO us) must not get
    // the flag, otherwise the plugin's reflection check would be
    // inverted on legitimate peer messages.
    const peerManager = await makeManagerWithDummyPlugin(PEER)
    const payload = await peerManager.encryptOutbound(
      { kind: 'direct', peer: ME },
      new TextEncoder().encode('archived inbound'),
    )
    if (!payload) throw new Error('Test setup: encryptOutbound returned null')

    const decryptSpy = vi.spyOn(manager, 'decryptArchive')

    const forwardedMessage = xml(
      'message',
      { from: PEER + '/res', to: ME, type: 'chat', id: 'mam-inbound-flag' },
      xml('body', {}, payload.payload.fallbackBody ?? '[encrypted]'),
      xml(
        payload.payload.stanzaElement.name,
        payload.payload.stanzaElement.attrs,
        ...(payload.payload.stanzaElement.children as (string | Element)[]),
      ),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-inbound-flag',
      forwardedMessage,
    })

    await runQueryWithEntry(harness, PEER, archiveEntry)

    expect(decryptSpy).toHaveBeenCalledTimes(1)
    const [, , context] = decryptSpy.mock.calls[0]
    // Either undefined or explicitly false — never true for inbound.
    expect(context?.isSelfOutgoing).not.toBe(true)
  })

  it('forwards the archived stanza messageId to plugin.decrypt', async () => {
    // Same race-window guarantee as the live path: the SDK must thread the
    // messageId of the forwarded stanza into the plugin's decrypt call so
    // a deferred re-verify can target the right rendered message later.
    const peerManager = await makeManagerWithDummyPlugin(PEER)
    const payload = await peerManager.encryptOutbound(
      { kind: 'direct', peer: ME },
      new TextEncoder().encode('archived with id'),
    )
    if (!payload) throw new Error('Test setup: encryptOutbound returned null')

    const decryptSpy = vi.spyOn(manager, 'decryptArchive')

    const forwardedMessage = xml(
      'message',
      { from: PEER + '/res', to: ME, type: 'chat', id: 'mam-msg-id' },
      xml('body', {}, payload.payload.fallbackBody ?? '[encrypted]'),
      xml(
        payload.payload.stanzaElement.name,
        payload.payload.stanzaElement.attrs,
        ...(payload.payload.stanzaElement.children as (string | Element)[]),
      ),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-id',
      forwardedMessage,
    })

    await runQueryWithEntry(harness, PEER, archiveEntry)

    const lastCall = decryptSpy.mock.calls[decryptSpy.mock.calls.length - 1]
    expect(lastCall[2]).toMatchObject({ messageId: 'mam-msg-id', fromArchive: true })
    expect(lastCall[2].archiveTimestamp).toBeInstanceOf(Date)
  })
})

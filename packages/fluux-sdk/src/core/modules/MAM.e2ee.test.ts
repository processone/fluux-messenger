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
  /** Every emitSDK(event, payload) call, in order — lets tests assert on
   *  modifications emitted against messages not present in the queried page. */
  emitted: { event: string; payload: Record<string, unknown> }[]
}

function makeHarness(options: {
  jid: string
  manager: E2EEManager
}): TestHarness {
  const collectors = new Map<string, (stanza: Element) => void>()
  const emitted: { event: string; payload: Record<string, unknown> }[] = []
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
    emitSDK: ((event: string, payload: Record<string, unknown>) => {
      emitted.push({ event, payload })
    }) as ModuleDependencies['emitSDK'],
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
    emitted,
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
 * Variant of makeHarness where getE2EEManager returns undefined.
 * Used to test the no-manager early-return path in decryptArchiveEntryIfNeeded.
 */
function makeHarnessNoManager(jid: string): TestHarness {
  const collectors = new Map<string, (stanza: Element) => void>()
  const emitted: { event: string; payload: Record<string, unknown> }[] = []
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
    getCurrentJid: () => jid,
    emit: () => {},
    emitSDK: ((event: string, payload: Record<string, unknown>) => {
      emitted.push({ event, payload })
    }) as ModuleDependencies['emitSDK'],
    getXmpp: () => null,
    getE2EEManager: () => null,
    registerMAMCollector: (queryId, collector) => {
      collectors.set(queryId, collector)
      return () => collectors.delete(queryId)
    },
  }

  const mam = new MAM(deps)
  return {
    mam,
    collectors,
    emitted,
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

  it('tags archived OMEMO messages with unsupportedEncryption and no encryptedPayload', async () => {
    // Simulate an OMEMO-encrypted message from a peer. The DummyPlaintextPlugin
    // is registered (hasPlugins() === true) but does NOT claim the OMEMO
    // namespace, so decryptStanzaInPlace calls recordUnclaimedEME which stashes
    // the unsupportedEncryption tag. parseArchiveMessage must read that tag
    // onto the returned Message.
    const forwardedMessage = xml(
      'message',
      { from: PEER + '/mobile', to: ME, type: 'chat', id: 'mam-omemo' },
      xml('body', {}, 'I sent you an OMEMO-encrypted message but your client does not seem to support that.'),
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' },
        xml('header', { sid: '123456' }),
        xml('payload', {}, 'AAAA'),
      ),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-omemo',
      forwardedMessage,
    })

    // Use a local runner variant that also surfaces unsupportedEncryption.
    const resultPromise = harness.mam.queryArchive({ with: PEER, max: 10 })
    await harness.iqPending()
    const entries = [...harness.collectors.entries()]
    if (entries.length === 0) throw new Error('No collector registered')
    const [queryId, collector] = entries[0]
    archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
    collector(archiveEntry)
    harness.resolveNextIQ(
      xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
    )
    const result = await resultPromise

    expect(result.messages).toHaveLength(1)
    const msg = result.messages[0]
    expect(msg.unsupportedEncryption).toBeDefined()
    expect(msg.unsupportedEncryption!.namespace).toBe('eu.siacs.conversations.axolotl')
    expect(msg.unsupportedEncryption!.name).toBe('OMEMO')
    // Fallback body from the sender must be preserved.
    expect(msg.body).toBe('I sent you an OMEMO-encrypted message but your client does not seem to support that.')
    // encryptedPayload should NOT be set — OMEMO was recognised as unsupported,
    // not stashed for retry (that only happens when hasPlugins() is false).
    expect((msg as { encryptedPayload?: unknown }).encryptedPayload).toBeUndefined()
  })

  it('surfaces a self-outgoing OMEMO archive entry that has NO fallback body (issue #135)', async () => {
    // Regression for issue #135: "messages sent while Fluux was closed are not
    // shown". The reporter sends from Gajim, which (unlike Conversations) omits
    // the optional XEP-0380 fallback <body> on OMEMO messages. The own-sent copy
    // is replayed from MAM (self-outgoing, from === ownBareJid). Fluux has no
    // OMEMO plugin, so it cannot decrypt and there is NO fallback body to show.
    //
    // parseArchiveMessage's "no body, no attachment → drop" gate then silently
    // discards the entry — so the user never sees their own sent message. The
    // incoming direction survives only because the *peer's* client included a
    // fallback body. This makes the drop look direction-specific when it is
    // really "any encrypted entry that arrives without a fallback body".
    //
    // The entry MUST surface as an outgoing, unsupported-encryption placeholder.
    const forwardedMessage = xml(
      'message',
      { from: ME + '/gajim', to: PEER, type: 'chat', id: 'mam-omemo-self-nobody' },
      // No <body> — Gajim omitted the OMEMO fallback.
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' },
        xml('header', { sid: '654321' }),
        xml('payload', {}, 'BBBB'),
      ),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-omemo-self-nobody',
      forwardedMessage,
    })

    const resultPromise = harness.mam.queryArchive({ with: PEER, max: 10 })
    await harness.iqPending()
    const entries = [...harness.collectors.entries()]
    if (entries.length === 0) throw new Error('No collector registered')
    const [queryId, collector] = entries[0]
    archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
    collector(archiveEntry)
    harness.resolveNextIQ(
      xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
    )
    const result = await resultPromise

    // BUG (#135): the entry is currently dropped at the "no body" gate, so
    // result.messages is empty. It must instead surface so the user sees it.
    expect(result.messages).toHaveLength(1)
    const msg = result.messages[0]
    expect(msg.isOutgoing).toBe(true)
    expect(msg.unsupportedEncryption).toBeDefined()
    expect(msg.unsupportedEncryption!.namespace).toBe('eu.siacs.conversations.axolotl')
    // No fallback body: the entry surfaces with an empty body and the UI
    // renders a placeholder from `unsupportedEncryption` (MessageBubble's
    // render precedence), so the user still sees that an encrypted message
    // exists rather than the entry being silently dropped.
    expect(msg.body).toBe('')
  })

  it('surfaces a bodiless OMEMO MUC archive entry instead of dropping it (issue #135, rooms)', async () => {
    // parseRoomArchiveMessage has the same "no body, no attachment → drop" gate
    // as the 1:1 path. An OMEMO room message whose sender omitted the optional
    // XEP-0380 fallback <body> must still surface as an unsupported-encryption
    // placeholder, not be silently discarded.
    const ROOM = 'room@conference.example.com'
    const forwardedMessage = xml(
      'message',
      { from: ROOM + '/alice', to: ME, type: 'groupchat', id: 'mam-room-omemo-nobody' },
      // No <body> — sender omitted the OMEMO fallback.
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' },
        xml('header', { sid: '777' }),
        xml('payload', {}, 'CCCC'),
      ),
    )
    const archiveEntry = buildMAMResult({
      archiveId: 'arch-room-omemo-nobody',
      forwardedMessage,
    })

    const resultPromise = harness.mam.queryRoomArchive({ roomJid: ROOM, max: 10 })
    await harness.iqPending()
    const entries = [...harness.collectors.entries()]
    if (entries.length === 0) throw new Error('No collector registered')
    const [queryId, collector] = entries[0]
    archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
    collector(archiveEntry)
    harness.resolveNextIQ(
      xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
    )
    const result = await resultPromise

    expect(result.messages).toHaveLength(1)
    const msg = result.messages[0]
    expect(msg.unsupportedEncryption).toBeDefined()
    expect(msg.unsupportedEncryption!.namespace).toBe('eu.siacs.conversations.axolotl')
    expect(msg.body).toBe('')
  })

  it('drops a room archive message whose body is entirely a fallback (no renderable content)', async () => {
    // The mirror of the bodiless-OMEMO case above: a message that carries a
    // non-empty raw <body> but whose body is ENTIRELY a XEP-0428 fallback
    // (here a XEP-0461 reply quote with no new text) strips to processedBody=''.
    // The raw-<body> gate let it through and stored a blank bubble — the
    // "empty Cynthia row" reported from the XSF room. With no attachment, poll
    // or encrypted content, it has nothing to render and must be dropped.
    const ROOM = 'room@conference.example.com'
    const forwardedMessage = xml(
      'message',
      { from: ROOM + '/cynthia', to: ME, type: 'groupchat', id: 'mam-room-empty-fallback' },
      xml('body', {}, '> a quote with no new text'),
      xml('reply', { xmlns: 'urn:xmpp:reply:0', id: 'orig-1', to: ROOM + '/bob' }),
      // <body/> with no start/end → the entire body is fallback for the reply.
      xml('fallback', { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
        xml('body', {}),
      ),
    )
    const archiveEntry = buildMAMResult({ archiveId: 'arch-room-empty-fallback', forwardedMessage })

    const resultPromise = harness.mam.queryRoomArchive({ roomJid: ROOM, max: 10 })
    await harness.iqPending()
    const entries = [...harness.collectors.entries()]
    if (entries.length === 0) throw new Error('No collector registered')
    const [queryId, collector] = entries[0]
    archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
    collector(archiveEntry)
    harness.resolveNextIQ(
      xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
    )
    const result = await resultPromise

    expect(result.messages).toHaveLength(0)
  })

  it('keeps a room archive reply that has real text after the fallback quote', async () => {
    // Positive control for the guard above: a normal reply (quote fallback +
    // new text) must still surface, with only the quoted prefix stripped.
    const ROOM = 'room@conference.example.com'
    const fullBody = '> earlier message\nthanks, that works!'
    const quoteEnd = fullBody.indexOf('thanks')
    const forwardedMessage = xml(
      'message',
      { from: ROOM + '/cynthia', to: ME, type: 'groupchat', id: 'mam-room-reply-with-text' },
      xml('body', {}, fullBody),
      xml('reply', { xmlns: 'urn:xmpp:reply:0', id: 'orig-2', to: ROOM + '/bob' }),
      xml('fallback', { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
        xml('body', { start: '0', end: String(quoteEnd) }),
      ),
    )
    const archiveEntry = buildMAMResult({ archiveId: 'arch-room-reply-with-text', forwardedMessage })

    const resultPromise = harness.mam.queryRoomArchive({ roomJid: ROOM, max: 10 })
    await harness.iqPending()
    const entries = [...harness.collectors.entries()]
    if (entries.length === 0) throw new Error('No collector registered')
    const [queryId, collector] = entries[0]
    archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
    collector(archiveEntry)
    harness.resolveNextIQ(
      xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
    )
    const result = await resultPromise

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].body).toBe('thanks, that works!')
    expect(result.messages[0].replyTo).toBeDefined()
  })

  it('drops a 1:1 archive message whose body is entirely a fallback (no renderable content)', async () => {
    // Same gate as the room path, for 1:1 archive: a reply whose body is ALL
    // fallback strips to processedBody='' and must not surface as a blank row.
    const forwardedMessage = xml(
      'message',
      { from: PEER + '/res', to: ME, type: 'chat', id: 'mam-chat-empty-fallback' },
      xml('body', {}, '> a quote with no new text'),
      xml('reply', { xmlns: 'urn:xmpp:reply:0', id: 'orig-c1', to: PEER }),
      xml('fallback', { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
        xml('body', {}),
      ),
    )
    const archiveEntry = buildMAMResult({ archiveId: 'arch-chat-empty-fallback', forwardedMessage })

    const messages = await runQueryWithEntry(harness, PEER, archiveEntry)

    expect(messages).toHaveLength(0)
  })

  describe('no E2EE manager (archive replayed before E2EE init)', () => {
    let noMgrHarness: TestHarness

    beforeEach(() => {
      noMgrHarness = makeHarnessNoManager(ME)
    })

    it('stashes encryptedPayload for retry when manager is absent on an OMEMO archive entry', async () => {
      // No manager → decryptArchiveEntryIfNeeded must NOT early-return silently.
      // It must call recordUnclaimedEME(stanza, false) which stashes the
      // encrypted child as encryptedPayload so retryPendingDecrypts can
      // self-heal once the manager + plugin come online.
      const forwardedMessage = xml(
        'message',
        { from: PEER + '/mobile', to: ME, type: 'chat', id: 'mam-no-mgr-omemo' },
        xml('body', {}, 'I sent you an OMEMO-encrypted message but your client does not seem to support that.'),
        xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' },
          xml('header', { sid: '123456' }),
          xml('payload', {}, 'AAAA'),
        ),
      )
      const archiveEntry = buildMAMResult({
        archiveId: 'arch-no-mgr-omemo',
        forwardedMessage,
      })

      const resultPromise = noMgrHarness.mam.queryArchive({ with: PEER, max: 10 })
      await noMgrHarness.iqPending()
      const entries = [...noMgrHarness.collectors.entries()]
      if (entries.length === 0) throw new Error('No collector registered')
      const [queryId, collector] = entries[0]
      archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
      collector(archiveEntry)
      noMgrHarness.resolveNextIQ(
        xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
      )
      const result = await resultPromise

      expect(result.messages).toHaveLength(1)
      const msg = result.messages[0]
      // Must be stashed for deferred retry — contains the OMEMO namespace.
      expect(msg.encryptedPayload).toBeDefined()
      expect(msg.encryptedPayload).toContain('eu.siacs.conversations.axolotl')
      // Not yet tagged unsupported — we don't know that until a plugin exists.
      expect(msg.unsupportedEncryption).toBeUndefined()
      // Fallback body must be preserved.
      expect(msg.body).toBe('I sent you an OMEMO-encrypted message but your client does not seem to support that.')
    })

    it('does NOT stash encryptedPayload for a cleartext archive entry when manager is absent', async () => {
      // recordUnclaimedEME returns 'none' for cleartext; we must not over-stash.
      const forwardedMessage = xml(
        'message',
        { from: PEER + '/r', to: ME, type: 'chat', id: 'mam-no-mgr-plain' },
        xml('body', {}, 'just a plain message'),
      )
      const archiveEntry = buildMAMResult({
        archiveId: 'arch-no-mgr-plain',
        forwardedMessage,
      })

      const resultPromise = noMgrHarness.mam.queryArchive({ with: PEER, max: 10 })
      await noMgrHarness.iqPending()
      const entries = [...noMgrHarness.collectors.entries()]
      if (entries.length === 0) throw new Error('No collector registered')
      const [queryId, collector] = entries[0]
      archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
      collector(archiveEntry)
      noMgrHarness.resolveNextIQ(
        xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
      )
      const result = await resultPromise

      expect(result.messages).toHaveLength(1)
      const msg = result.messages[0]
      expect(msg.body).toBe('just a plain message')
      expect(msg.encryptedPayload).toBeUndefined()
      expect(msg.unsupportedEncryption).toBeUndefined()
    })
  })

  describe('deferred-decrypt of encrypted corrections (XEP-0308)', () => {
    // Regression guard for the production bug (lost encrypted correction):
    //
    // A correction whose <replace> rides in CLEARTEXT but whose new body is
    // encrypted arrives via MAM before the OpenPGP plugin is registered (or
    // while the key is locked). decrypt is deferred, so collectModification
    // captures the sender's hint body and applyModifications stamps it onto
    // the target. Historically the correction stanza's stashed ciphertext was
    // dropped, so retryPendingDecrypts — which only re-decrypts a stored
    // message's OWN encryptedPayload — had nothing to recover: the corrected
    // bubble stayed frozen on "[OpenPGP-encrypted message]" forever.
    //
    // The fix: the applied correction must carry the CORRECTION stanza's
    // encryptedPayload onto the target (overwriting the original's), so the
    // deferred retry decrypts the corrected text — not the stale original.
    it("propagates the correction's encrypted payload onto the target so retry recovers the corrected text", async () => {
      // Decrypt is unavailable at archive time (key locked / plugin late).
      vi.spyOn(manager, 'decryptArchive').mockRejectedValue(new Error('key locked'))

      const ORIGINAL_CT = Buffer.from('the original secret').toString('base64')
      const CORRECTED_CT = Buffer.from('the corrected secret').toString('base64')

      // Original encrypted message, archived first.
      const original = xml(
        'message',
        { from: PEER + '/res', to: ME, type: 'chat', id: 'orig-1' },
        xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: 'orig-1' }),
        xml('body', {}, '[OpenPGP-encrypted message]'),
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, ORIGINAL_CT),
      )
      // XEP-0308 correction of orig-1 — cleartext <replace>, encrypted body.
      const correction = xml(
        'message',
        { from: PEER + '/res', to: ME, type: 'chat', id: 'corr-1' },
        xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: 'orig-1' }),
        xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: 'corr-1' }),
        xml('body', {}, '[OpenPGP-encrypted message]'),
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, CORRECTED_CT),
      )

      const resultPromise = harness.mam.queryArchive({ with: PEER, max: 10 })
      await harness.iqPending()
      const [queryId, collector] = [...harness.collectors.entries()][0]
      for (const [archiveId, forwardedMessage] of [
        ['arch-orig', original],
        ['arch-corr', correction],
      ] as const) {
        const entry = buildMAMResult({ archiveId, forwardedMessage })
        entry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
        collector(entry)
      }
      harness.resolveNextIQ(
        xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
      )
      const result = await resultPromise

      // The correction is consumed (not its own message); only the target remains.
      expect(result.messages).toHaveLength(1)
      const target = result.messages[0]
      expect(target.id).toBe('orig-1')
      // Correction was applied: hint body + edited marker.
      expect(target.isEdited).toBe(true)
      expect(target.body).toBe('[OpenPGP-encrypted message]')
      // The retained ciphertext must be the CORRECTION's, so the deferred
      // retry decrypts the corrected text — never the stale original.
      expect(target.encryptedPayload).toBeDefined()
      expect(target.encryptedPayload).toContain(CORRECTED_CT)
      expect(target.encryptedPayload).not.toContain(ORIGINAL_CT)
    })

    it('carries the correction payload on the emitted 1:1 update when the target is not in the page', async () => {
      // The exact production scenario: the corrected message was synced in an
      // earlier page (or lives only in the durable cache), so the correction
      // resolves to nothing in this batch and rides out on the
      // emitUnresolvedChatModifications update instead of applyModifications.
      vi.spyOn(manager, 'decryptArchive').mockRejectedValue(new Error('key locked'))
      const ORPHAN_CT = Buffer.from('the corrected secret').toString('base64')

      const correction = xml(
        'message',
        { from: PEER + '/res', to: ME, type: 'chat', id: 'orphan-corr-1' },
        xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: 'cached-orig-1' }),
        xml('body', {}, '[OpenPGP-encrypted message]'),
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, ORPHAN_CT),
      )

      const resultPromise = harness.mam.queryArchive({ with: PEER, max: 10 })
      await harness.iqPending()
      const [queryId, collector] = [...harness.collectors.entries()][0]
      const entry = buildMAMResult({ archiveId: 'arch-orphan', forwardedMessage: correction })
      entry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
      collector(entry)
      harness.resolveNextIQ(
        xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
      )
      await resultPromise

      const update = harness.emitted.find(
        (e) => e.event === 'chat:message-updated' && e.payload.messageId === 'cached-orig-1',
      )
      expect(update).toBeDefined()
      const updates = update!.payload.updates as Record<string, unknown>
      expect(updates.isEdited).toBe(true)
      expect(updates.encryptedPayload).toContain(ORPHAN_CT)
    })

    it('carries the correction payload on the emitted MUC update when the target is not in the page', async () => {
      // Room counterpart, unresolved path: the correction's target was synced
      // in an earlier page, so applyModifications can't find it and the fix
      // must ride out on the emitUnresolvedRoomModifications update instead.
      vi.spyOn(manager, 'decryptArchive').mockRejectedValue(new Error('key locked'))
      const ROOM = 'room@conference.example.com'
      const ROOM_CT = Buffer.from('room corrected secret').toString('base64')

      const correction = xml(
        'message',
        { from: ROOM + '/Bob', type: 'groupchat', id: 'rcorr-1' },
        xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: 'room-orig-1' }),
        xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' }),
        xml('body', {}, '[OpenPGP-encrypted message]'),
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, ROOM_CT),
      )

      const resultPromise = harness.mam.queryRoomArchive({ roomJid: ROOM, max: 10 })
      await harness.iqPending()
      const [queryId, collector] = [...harness.collectors.entries()][0]
      const entry = buildMAMResult({ archiveId: 'rarch-corr', forwardedMessage: correction })
      entry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
      collector(entry)
      harness.resolveNextIQ(
        xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
      )
      await resultPromise

      const update = harness.emitted.find(
        (e) => e.event === 'room:message-updated' && e.payload.messageId === 'room-orig-1',
      )
      expect(update).toBeDefined()
      const updates = update!.payload.updates as Record<string, unknown>
      expect(updates.isEdited).toBe(true)
      expect(updates.encryptedPayload).toContain(ROOM_CT)
    })
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
    expect(lastCall[2]!.archiveTimestamp).toBeInstanceOf(Date)
  })
})

describe('MAM forward catch-up — cross-page modification resolution (1:1)', () => {
  const ME = 'me@example.com'
  const PEER = 'bob@example.com'

  // Multi-page harness: sendIQ resolves one page at a time so the test can feed
  // a different archive entry into each page's collector. Reproduces a reaction
  // in page 2 that targets a message delivered in page 1 — the cross-page case
  // the room path already handles by emitting per page.
  function makeMultiPageHarness(jid: string) {
    const collectors = new Map<string, (stanza: Element) => void>()
    const emitted: { event: string; payload: Record<string, unknown> }[] = []
    let pendingResolve: ((value: Element) => void) | null = null
    const waiters: (() => void)[] = []
    const signals: true[] = []
    const signalPage = () => {
      const w = waiters.shift()
      if (w) w()
      else signals.push(true)
    }
    const deps: ModuleDependencies = {
      stores: null,
      sendStanza: async () => {},
      sendIQ: () =>
        new Promise<Element>((resolve) => {
          pendingResolve = resolve
          signalPage()
        }),
      getCurrentJid: () => jid,
      emit: () => {},
      emitSDK: ((event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload })
      }) as ModuleDependencies['emitSDK'],
      getXmpp: () => null,
      getE2EEManager: () => null,
      registerMAMCollector: (queryId, collector) => {
        collectors.set(queryId, collector)
        return () => collectors.delete(queryId)
      },
    }
    return {
      mam: new MAM(deps),
      emitted,
      // Resolves once the next sendIQ (the next page) has been issued.
      waitForPage: () =>
        new Promise<void>((r) => {
          if (signals.length) {
            signals.shift()
            r()
          } else {
            waiters.push(r)
          }
        }),
      // Inject an archive entry into the currently-registered page collector.
      feedEntry: (entry: Element) => {
        const all = [...collectors.entries()]
        if (all.length === 0) throw new Error('No collector registered')
        const [queryId, collector] = all[all.length - 1]
        entry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
        collector(entry)
      },
      resolveIQ: (finEl: Element) => {
        if (!pendingResolve) throw new Error('No pending sendIQ')
        const r = pendingResolve
        pendingResolve = null
        r(finEl)
      },
    }
  }

  const fin = (opts: { complete: boolean; last?: string }): Element =>
    xml(
      'iq',
      {},
      xml(
        'fin',
        { xmlns: 'urn:xmpp:mam:2', complete: opts.complete ? 'true' : 'false' },
        ...(opts.last
          ? [xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('last', {}, opts.last))]
          : []),
      ),
    )

  it('applies a page-2 reaction to a message delivered in page 1', async () => {
    const h = makeMultiPageHarness(ME)

    const queryPromise = h.mam.queryArchive({
      with: PEER,
      start: '2026-05-01T00:00:00.000Z',
      max: 10,
      maxAutoPages: 3, // opt into forward auto-pagination
    })

    // Page 1: the reaction target message.
    await h.waitForPage()
    h.feedEntry(
      buildMAMResult({
        archiveId: 'arch-1',
        forwardedMessage: xml(
          'message',
          { from: PEER + '/res', to: ME, type: 'chat', id: 'm1' },
          xml('body', {}, 'hello'),
        ),
      }),
    )
    h.resolveIQ(fin({ complete: false, last: 'm1' }))

    // Page 2: a reaction targeting the page-1 message.
    await h.waitForPage()
    h.feedEntry(
      buildMAMResult({
        archiveId: 'arch-2',
        forwardedMessage: xml(
          'message',
          { from: PEER + '/res', to: ME, type: 'chat', id: 'r1' },
          xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'm1' }, xml('reaction', {}, '👍')),
        ),
      }),
    )
    h.resolveIQ(fin({ complete: true }))

    await queryPromise

    const mamEvent = h.emitted.find((e) => e.event === 'chat:mam-messages')
    expect(mamEvent).toBeDefined()
    const messages = mamEvent!.payload.messages as Array<{
      id: string
      reactions?: Record<string, string[]>
    }>
    const target = messages.find((m) => m.id === 'm1')
    expect(target).toBeDefined()
    // The page-2 reaction must be applied to the page-1 message in the single
    // emitted batch — not dropped because the target wasn't in the store yet.
    expect(target!.reactions).toBeDefined()
    expect(target!.reactions!['👍']).toContain(PEER)
  })
})

describe('MAM preview refresh E2EE (sidebar preview)', () => {
  const ME = 'me@example.com'
  const PEER = 'bob@example.com'

  /**
   * Drive {@link MAM.refreshConversationPreviews} for a single conversation,
   * feed it one archive entry, and return the message handed to
   * `updateLastMessagePreview` (the sidebar preview), or null if none was set.
   */
  async function runPreviewWithEntry(
    manager: E2EEManager,
    conversationId: string,
    archiveEntry: Element,
  ): Promise<{ body: string; from: string; encryptedPayload?: string } | null> {
    const collectors = new Map<string, (stanza: Element) => void>()
    let pendingResolve: ((v: Element) => void) | null = null
    let pendingReady: (() => void) | null = null
    const ready = new Promise<void>((r) => {
      pendingReady = r
    })
    let captured: { body: string; from: string; encryptedPayload?: string } | null = null

    const deps: ModuleDependencies = {
      stores: {
        chat: {
          getAllConversations: () => [{ id: conversationId }],
          updateLastMessagePreview: (_id: string, message: { body: string; from: string; encryptedPayload?: string }) => {
            captured = {
              body: message.body,
              from: message.from,
              ...(message.encryptedPayload && { encryptedPayload: message.encryptedPayload }),
            }
          },
        },
      } as unknown as ModuleDependencies['stores'],
      sendStanza: async () => {},
      sendIQ: () =>
        new Promise<Element>((resolve) => {
          pendingResolve = resolve
          pendingReady?.()
        }),
      getCurrentJid: () => ME,
      emit: () => {},
      emitSDK: (() => {}) as ModuleDependencies['emitSDK'],
      getXmpp: () => null,
      getE2EEManager: () => manager,
      registerMAMCollector: (queryId, collector) => {
        collectors.set(queryId, collector)
        return () => collectors.delete(queryId)
      },
    }

    const mam = new MAM(deps)
    const done = mam.refreshConversationPreviews()
    await ready
    const [queryId, collector] = [...collectors.entries()][0]
    archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
    collector(archiveEntry)
    pendingResolve!(xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })))
    await done
    return captured
  }

  it('decrypts a self-outgoing encrypted entry before setting the sidebar preview', async () => {
    // Regression: the sidebar preview for our OWN sent message showed the
    // sender's cleartext fallback ("[OpenPGP-encrypted message]") until the
    // conversation was opened, because the preview-refresh path parsed the
    // archive entry WITHOUT decrypting it (unlike the catch-up path).
    const manager = await makeManagerWithDummyPlugin(ME)
    const payload = await manager.encryptOutbound(
      { kind: 'direct', peer: PEER },
      new TextEncoder().encode('my own secret message'),
    )
    if (!payload) throw new Error('Test setup: encryptOutbound returned null')

    const forwardedMessage = xml(
      'message',
      { from: ME + '/res', to: PEER, type: 'chat', id: 'mam-self-preview' },
      xml('body', {}, payload.payload.fallbackBody ?? '[encrypted]'),
      xml(
        payload.payload.stanzaElement.name,
        payload.payload.stanzaElement.attrs,
        ...(payload.payload.stanzaElement.children as (string | Element)[]),
      ),
    )
    const archiveEntry = buildMAMResult({ archiveId: 'arch-self-preview', forwardedMessage })

    const preview = await runPreviewWithEntry(manager, PEER, archiveEntry)

    expect(preview).not.toBeNull()
    // The sidebar preview text is derived from the message body, so it must be
    // the decrypted plaintext — never the sender's cleartext fallback.
    expect(preview!.body).toBe('my own secret message')
    expect(preview!.body).not.toContain('payload')
  })
})

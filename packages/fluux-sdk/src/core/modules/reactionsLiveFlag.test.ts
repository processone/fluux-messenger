/**
 * TDD tests for the isLive field on reaction events (chat:reactions / room:reactions).
 *
 * - Chat module (live delivery + own-echo) must emit isLive: true
 * - MAM module (history replay) must emit isLive: false
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { Chat } from './Chat'
import { MAM } from './MAM'
import type { MAM as MAMType } from './MAM'
import type { ModuleDependencies } from './BaseModule'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function stubMAM(): MAMType {
  return {} as unknown as MAMType
}

/** Minimal deps that capture emitSDK calls. */
function makeDeps(jid: string): {
  deps: ModuleDependencies
  emitted: { event: string; payload: Record<string, unknown> }[]
} {
  const emitted: { event: string; payload: Record<string, unknown> }[] = []
  const deps: ModuleDependencies = {
    stores: null,
    sendStanza: async () => {},
    sendIQ: async () => xml('iq', {}) as Element,
    getCurrentJid: () => jid,
    emit: () => {},
    emitSDK: ((event: string, payload: Record<string, unknown>) => {
      emitted.push({ event, payload })
    }) as ModuleDependencies['emitSDK'],
    getXmpp: () => null,
    getE2EEManager: () => null,
  }
  return { deps, emitted }
}

/** Build a MAM result stanza wrapping a forwarded <message> (mirrors MAM.e2ee.test.ts). */
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
        xml('delay', { xmlns: 'urn:xmpp:delay', stamp: options.delayStamp ?? '2024-01-15T10:00:00.000Z' }),
        options.forwardedMessage,
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// MAM harness (mirrors MAM.e2ee.test.ts makeHarness)
// ---------------------------------------------------------------------------

interface MAMHarness {
  mam: MAM
  collectors: Map<string, (stanza: Element) => void>
  emitted: { event: string; payload: Record<string, unknown> }[]
  iqPending: () => Promise<void>
  resolveNextIQ: (fin: Element) => void
}

function makeMAMHarness(jid: string): MAMHarness {
  const collectors = new Map<string, (stanza: Element) => void>()
  const emitted: { event: string; payload: Record<string, unknown> }[] = []
  let pendingResolve: ((value: Element) => void) | null = null
  let pendingReady: (() => void) | null = null
  const readyPromise = new Promise<void>((r) => { pendingReady = r })

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

  return {
    mam: new MAM(deps),
    collectors,
    emitted,
    iqPending: () => readyPromise,
    resolveNextIQ: (fin) => {
      if (!pendingResolve) throw new Error('No pending sendIQ')
      const r = pendingResolve
      pendingResolve = null
      r(fin)
    },
  }
}

/** Run a MAM archive query with a single reaction entry and wait for resolution. */
async function runMAMQueryWithEntry(
  harness: MAMHarness,
  peer: string,
  archiveEntry: Element,
): Promise<void> {
  const resultPromise = harness.mam.queryArchive({ with: peer, max: 10 })
  await harness.iqPending()
  const entries = [...harness.collectors.entries()]
  if (entries.length === 0) throw new Error('No collector registered')
  const [queryId, collector] = entries[0]
  archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
  collector(archiveEntry)
  harness.resolveNextIQ(
    xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
  )
  await resultPromise
}

/** Run a MAM room archive query with a single reaction entry. */
async function runMAMRoomQueryWithEntry(
  harness: MAMHarness,
  roomJid: string,
  archiveEntry: Element,
): Promise<void> {
  const resultPromise = harness.mam.queryRoomArchive({ roomJid, max: 10 })
  await harness.iqPending()
  const entries = [...harness.collectors.entries()]
  if (entries.length === 0) throw new Error('No collector registered')
  const [queryId, collector] = entries[0]
  archiveEntry.getChild('result', 'urn:xmpp:mam:2')!.attrs.queryid = queryId
  collector(archiveEntry)
  harness.resolveNextIQ(
    xml('iq', {}, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })),
  )
  await resultPromise
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reaction event isLive flag', () => {
  const ME = 'me@example.com'
  const PEER = 'alice@example.com'
  const ROOM = 'room@conference.example.com'
  const TARGET_MSG_ID = 'msg-original-1'

  // -------------------------------------------------------------------------
  // Chat module — live 1:1 reaction
  // -------------------------------------------------------------------------
  describe('Chat module (live delivery)', () => {
    let chat: Chat
    let emitted: { event: string; payload: Record<string, unknown> }[]

    beforeEach(() => {
      const built = makeDeps(ME)
      emitted = built.emitted
      chat = new Chat(built.deps, stubMAM())
    })

    it('emits chat:reactions with isLive: true for an incoming live reaction', () => {
      const stanza = xml(
        'message',
        { from: `${PEER}/resource`, to: ME, type: 'chat', id: 'reaction-stanza-1' },
        xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: TARGET_MSG_ID },
          xml('reaction', {}, '👍'),
        ),
      )

      chat.handle(stanza)

      const hit = emitted.find(e => e.event === 'chat:reactions')
      expect(hit).toBeDefined()
      expect(hit!.payload).toMatchObject({
        conversationId: PEER,
        messageId: TARGET_MSG_ID,
        reactorJid: PEER,
        emojis: ['👍'],
        isLive: true,
      })
    })

    it('emits room:reactions with isLive: true for an incoming live room reaction', () => {
      const stanza = xml(
        'message',
        { from: `${ROOM}/alice`, to: ME, type: 'groupchat', id: 'room-reaction-live-1' },
        xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: TARGET_MSG_ID },
          xml('reaction', {}, '🎉'),
        ),
      )

      chat.handle(stanza)

      const hit = emitted.find(e => e.event === 'room:reactions')
      expect(hit).toBeDefined()
      expect(hit!.payload).toMatchObject({
        roomJid: ROOM,
        messageId: TARGET_MSG_ID,
        reactorNick: 'alice',
        emojis: ['🎉'],
        isLive: true,
      })
    })

    it('emits chat:reactions with isLive: false for a delay-stamped (offline-queued) reaction', () => {
      const stanza = xml(
        'message',
        { from: `${PEER}/resource`, to: ME, type: 'chat', id: 'reaction-delayed-1' },
        xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: TARGET_MSG_ID },
          xml('reaction', {}, '👍'),
        ),
        xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-06-30T09:00:00Z' }),
      )

      chat.handle(stanza)

      const hit = emitted.find(e => e.event === 'chat:reactions')
      expect(hit).toBeDefined()
      expect(hit!.payload).toMatchObject({ conversationId: PEER, messageId: TARGET_MSG_ID, isLive: false })
    })

    it('emits room:reactions with isLive: false for a delay-stamped (MUC history replay) reaction', () => {
      const stanza = xml(
        'message',
        { from: `${ROOM}/alice`, to: ME, type: 'groupchat', id: 'room-reaction-delayed-1' },
        xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: TARGET_MSG_ID },
          xml('reaction', {}, '🎉'),
        ),
        xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-06-30T09:00:00Z' }),
      )

      chat.handle(stanza)

      const hit = emitted.find(e => e.event === 'room:reactions')
      expect(hit).toBeDefined()
      expect(hit!.payload).toMatchObject({ roomJid: ROOM, messageId: TARGET_MSG_ID, isLive: false })
    })
  })

  // -------------------------------------------------------------------------
  // MAM module — replayed 1:1 reaction (unresolved → emitUnresolvedChatModifications)
  // -------------------------------------------------------------------------
  describe('MAM module (history replay)', () => {
    it('emits chat:reactions with isLive: false for a MAM-replayed reaction targeting an already-stored message', async () => {
      // The "unresolved" path fires when the reaction's target is NOT in the
      // current MAM page. We achieve this by wrapping only the reaction stanza
      // in the MAM result (no regular messages), so applyModifications finds
      // no match and routes the reaction to emitUnresolvedChatModifications.
      const harness = makeMAMHarness(ME)

      const forwardedReaction = xml(
        'message',
        { from: `${PEER}/resource`, to: ME, type: 'chat', id: 'reaction-mam-1' },
        xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: TARGET_MSG_ID },
          xml('reaction', {}, '👍'),
        ),
      )
      const archiveEntry = buildMAMResult({ archiveId: 'arc-1', forwardedMessage: forwardedReaction })

      await runMAMQueryWithEntry(harness, PEER, archiveEntry)

      const hit = harness.emitted.find(e => e.event === 'chat:reactions')
      expect(hit).toBeDefined()
      expect(hit!.payload).toMatchObject({
        conversationId: PEER,
        messageId: TARGET_MSG_ID,
        isLive: false,
      })
    })

    it('emits room:reactions with isLive: false for a MAM-replayed room reaction', async () => {
      const harness = makeMAMHarness(ME)

      const forwardedReaction = xml(
        'message',
        { from: `${ROOM}/alice`, to: ME, type: 'groupchat', id: 'room-reaction-mam-1' },
        xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: TARGET_MSG_ID },
          xml('reaction', {}, '🎉'),
        ),
      )
      const archiveEntry = buildMAMResult({ archiveId: 'arc-2', forwardedMessage: forwardedReaction })

      await runMAMRoomQueryWithEntry(harness, ROOM, archiveEntry)

      const hit = harness.emitted.find(e => e.event === 'room:reactions')
      expect(hit).toBeDefined()
      expect(hit!.payload).toMatchObject({
        roomJid: ROOM,
        messageId: TARGET_MSG_ID,
        isLive: false,
      })
    })
  })
})

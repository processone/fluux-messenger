import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { Chat } from './Chat'
import { NS_MENTION_ALL } from '../namespaces'
import { MAM } from './MAM'
import { E2EEManager, InMemoryStorageBackend, parsePayloadEnvelope } from '../e2ee'
import { DummyPlaintextPlugin } from '../e2ee/DummyPlaintextPlugin'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader, createMockStores } from '../test-utils'
import { applyCorrection, parseMessageContent } from './messagingUtils'
import { buildRoomMessageLink, findRoomMessageLink } from '../../utils/roomMessageLink'

const room = 'team@conference.example.org'
// The numeric and UUID archive ids are the documented ejabberd/Prosody shapes.
const link = buildRoomMessageLink(room, '1731490000123456')
const other = buildRoomMessageLink(room, '550e8400-e29b-41d4-a716-446655440000')
const NS = 'urn:xmpp:reference:0'
function harness() {
  const stores = createMockStores()
  const deps: ModuleDependencies = { stores, presence: createMockPresenceReader(),
    getCurrentJid: () => 'alice@example.org/web', getXmpp: () => null,
    sendStanza: vi.fn(), sendIQ: vi.fn(), emit: vi.fn(), emitSDK: vi.fn() }
  return { chat: new Chat(deps, new MAM(deps)), deps, stores }
}

// Approved room-link plan: share a link, never a forwarded copy; preserve data
// references on receiving and keep mention behavior independent of resource links.
describe('shared room message references', () => {
  it('sends a pasted link as body plus data reference, without mention-all or embedded content', async () => {
    const h = harness()
    const body = `🔗 See ${link}`
    await h.chat.sendMessage('bob@example.org', body)
    const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
    expect(stanza.getChildText('body')).toBe(body)
    expect(stanza.getChildren('reference', NS).map(ref => ref.attrs)).toEqual([
      { xmlns: NS, type: 'data', uri: link, begin: String(Array.from('🔗 See ').length), end: String(Array.from(body).length) },
    ])
    expect(stanza.getChild('mention-all', NS_MENTION_ALL)).toBeUndefined()
    expect(stanza.getChild('forwarded', 'urn:xmpp:forward:0')).toBeUndefined()
    const parsed = parseMessageContent({ messageEl: stanza, body })
    expect(parsed.references).toEqual([{ type: 'data', uri: link, begin: '🔗 See '.length, end: body.length }])
    expect(findRoomMessageLink(body, parsed.references)).toEqual({ roomJid: room, stanzaId: '1731490000123456' })
  })

  it('keeps the link reference inside the encrypted payload rather than cleartext metadata', async () => {
    const h = harness()
    const manager = new E2EEManager({ account: { jid: 'alice@example.org' }, storage: new InMemoryStorageBackend(),
      xmpp: { sendStanza: vi.fn(), queryDisco: async () => ({ features: [], identities: [] }),
        publishPEP: vi.fn(), retractPEP: vi.fn(), deletePEP: vi.fn(), queryPEP: async () => [],
        subscribePEP: () => ({ unsubscribe() {} }) } })
    await manager.register(new DummyPlaintextPlugin())
    h.deps.getE2EEManager = () => manager
    try {
      await h.chat.sendMessage('bob@example.org', link)
      const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
      expect(stanza.getChildren('reference', NS)).toEqual([])
      expect(stanza.getChildText('body')).not.toContain(link)
      // The SDK-owned plaintext plugin proves envelope placement, not cryptography.
      const decoded = Buffer.from(stanza.getChild('plain', 'urn:fluux:e2ee-dummy:0')!.text(), 'base64').toString('utf8')
      const payload = parsePayloadEnvelope(decoded)!
      expect(payload.find(child => child.name === 'reference')?.attrs).toMatchObject({ type: 'data', uri: link })
    } finally { await manager.shutdown() }
  })

  it('retains valid ranges after an encrypted reply quote is stripped from a plaintext send', async () => {
    const h = harness()
    await h.chat.sendMessage('bob@example.org', link, { replyTo: { id: 'release-note', fallback: { author: 'Bob', body: 'Private release discussion', fromEncrypted: true } } })
    const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
    expect(stanza.getChildText('body')).toBe(link)
    expect(stanza.getChild('reference', NS)?.attrs).toMatchObject({ begin: '0', end: String(link.length), uri: link })
  })

  it('retains explicit offset-free data references and prefers them over body links', async () => {
    const h = harness()
    await h.chat.sendMessage('bob@example.org', link, { references: [{ type: 'data', uri: other }] })
    const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
    const parsed = parseMessageContent({ messageEl: stanza, body: link, forceDelayed: true })
    expect(parsed.references?.[0]).toEqual({ type: 'data', uri: other })
    expect(findRoomMessageLink(link, parsed.references)?.stanzaId).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it.each(['chat', 'groupchat'])('keeps incoming %s data references outside the mention list', type => {
    const h = harness()
    h.stores.room.getRoom = vi.fn(jid => jid === room ? { jid: room, nickname: 'Alice', joined: true } : undefined) as typeof h.stores.room.getRoom
    const stanza = xml('message', { type, id: 'shared-link', from: type === 'chat' ? 'bob@example.org/web' : `${room}/Bob` },
      xml('body', {}, link), xml('reference', { xmlns: NS, type: 'data', uri: other }))
    h.chat.handle(stanza)
    const event = vi.mocked(h.deps.emitSDK).mock.calls.find(([name]) => name === (type === 'chat' ? 'chat:message' : 'room:message'))
    expect(event?.[1]).toMatchObject({ message: { references: [{ type: 'data', uri: other }] } })
    expect((event?.[1] as { message: { isMentionAll?: boolean; mentions?: unknown[] } }).message.isMentionAll).not.toBe(true)
  })

  it('replaces or clears references when a shared link is edited', () => {
    const edited = xml('message', {}, xml('body', {}, other), xml('reference', { xmlns: NS, type: 'data', uri: other }))
    expect(applyCorrection(edited, other, link).references).toEqual([{ type: 'data', uri: other }])
    const plain = xml('message', {}, xml('body', {}, 'Please disregard that link.'))
    expect(applyCorrection(plain, 'Please disregard that link.', link).references).toBeUndefined()
  })

  it('retains a body link reference when retrying delivery', async () => {
    const h = harness()
    await h.chat.resendMessage('bob@example.org', link, 'shared-link')
    const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
    expect(stanza.getChild('reference', NS)?.attrs.uri).toBe(link)
  })

  it('falls back to body text after invalid references and rejects malformed ranges', () => {
    const stanza: Element = xml('message', {}, xml('body', {}, link),
      xml('reference', { xmlns: NS, type: 'data', uri: 'https://example.org' }),
      xml('reference', { xmlns: NS, type: 'mention', uri: 'xmpp:team@example.org/Bob', begin: '-1', end: '4' }),
      xml('reference', { xmlns: NS, type: 'data', uri: other, begin: '0garbage', end: '4' }))
    const parsed = parseMessageContent({ messageEl: stanza, body: link })
    expect(parsed.references).toEqual([{ type: 'data', uri: 'https://example.org' }])
    expect(findRoomMessageLink(link, parsed.references)).toEqual({ roomJid: room, stanzaId: '1731490000123456' })
  })

  // Approved forward plan: the generated quote and link carry an XEP-0428 marker so
  // a reader hides them only when it can show the source itself.
  describe('forward quote fallback', () => {
    const FB = 'urn:xmpp:fallback:0'
    const FQ = 'urn:fluux:forward-quote:0'
    const comment = 'Look 🔗\n'
    const quote = '> Bob wrote:\n> Ship it\n'
    const body = comment + quote + link
    const forwardRef = { type: 'data' as const, uri: link, begin: (comment + quote).length, end: body.length,
      forwardFallback: { begin: comment.length, end: body.length } }

    function manager() {
      return new E2EEManager({ account: { jid: 'alice@example.org' }, storage: new InMemoryStorageBackend(),
        xmpp: { sendStanza: vi.fn(), queryDisco: async () => ({ features: [], identities: [] }),
          publishPEP: vi.fn(), retractPEP: vi.fn(), deletePEP: vi.fn(), queryPEP: async () => [],
          subscribePEP: () => ({ unsubscribe() {} }) } })
    }

    it('marks only the quote and link range, in code points, and a reader recovers it', async () => {
      const h = harness()
      await h.chat.sendMessage('bob@example.org', body, { references: [forwardRef] })
      const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
      const fallback = stanza.getChildren('fallback', FB).find(el => el.attrs.for === FQ)!
      expect(fallback.getChild('body', FB)!.attrs).toEqual({
        start: String(Array.from(comment).length), end: String(Array.from(body).length) })
      const parsed = parseMessageContent({ messageEl: stanza, body })
      // The body is kept whole: only a reader that shows the source may hide the range.
      expect(parsed.processedBody).toBe(body)
      expect(parsed.references).toEqual([{ type: 'data', uri: link, begin: forwardRef.begin, end: body.length,
        forwardFallback: { begin: comment.length, end: body.length } }])
    })

    it('sends the same marker in a room and when delivery is retried', async () => {
      const h = harness()
      await h.chat.resendMessage('bob@example.org', body, 'fwd-1', undefined, [forwardRef])
      const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
      expect(stanza.getChildren('fallback', FB).filter(el => el.attrs.for === FQ)).toHaveLength(1)
      h.stores.room.getRoom = vi.fn(() => ({ jid: room, nickname: 'Alice', joined: true })) as unknown as typeof h.stores.room.getRoom
      await h.chat.sendMessage(room, body, { references: [forwardRef] })
      const roomStanza = vi.mocked(h.deps.sendStanza).mock.calls[1][0]
      expect(roomStanza.attrs.type).toBe('groupchat')
      expect(roomStanza.getChildren('fallback', FB).filter(el => el.attrs.for === FQ)).toHaveLength(1)
    })

    it('ignores a marker that does not contain a room message link', () => {
      const stanza = xml('message', {}, xml('body', {}, 'hello there'),
        xml('fallback', { xmlns: FB, for: FQ }, xml('body', { start: '0', end: '5' })))
      expect(parseMessageContent({ messageEl: stanza, body: 'hello there' }).references).toBeUndefined()
    })

    it('keeps the quote, link and marker inside the encrypted payload only', async () => {
      const h = harness()
      const m = manager()
      await m.register(new DummyPlaintextPlugin())
      h.deps.getE2EEManager = () => m
      try {
        await h.chat.sendMessage('bob@example.org', body, { references: [forwardRef] })
        const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
        expect(stanza.getChildren('fallback', FB)).toEqual([])
        expect(stanza.getChildText('body')).not.toContain('Ship it')
        expect(stanza.getChildText('body')).not.toContain(link)
        const decoded = Buffer.from(stanza.getChild('plain', 'urn:fluux:e2ee-dummy:0')!.text(), 'base64').toString('utf8')
        const payload = parsePayloadEnvelope(decoded)!
        const marker = payload.find(child => child.name === 'fallback' && child.attrs.for === FQ)
        expect(marker).toBeDefined()
        expect(payload.find(child => child.name === 'body')?.children?.join('')).toContain('Ship it')
      } finally { await m.shutdown() }
    })

    it('never sends the quote in plaintext when encryption fails', async () => {
      const h = harness()
      const m = manager()
      await m.register(new DummyPlaintextPlugin())
      vi.spyOn(m, 'encryptOutbound').mockRejectedValue(new Error('key locked'))
      h.deps.getE2EEManager = () => m
      try {
        await expect(h.chat.sendMessage('bob@example.org', body, { references: [forwardRef] })).rejects.toThrow('key locked')
        expect(h.deps.sendStanza).not.toHaveBeenCalled()
      } finally { await m.shutdown() }
    })
  })
})

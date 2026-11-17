import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { Chat } from './Chat'
import { NS_MENTION_ALL } from '../namespaces'
import { MAM } from './MAM'
import { E2EEManager, InMemoryStorageBackend, parsePayloadEnvelope } from '../e2ee'
import { decryptStanzaInPlace } from '../e2ee/stanzaDecrypt'
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

    it('rebases the link and marker when a reply quote is removed on receipt', async () => {
      const h = harness()
      await h.chat.sendMessage('bob@example.org', body, { references: [forwardRef],
        replyTo: { id: 'earlier', fallback: { author: 'Carol', body: 'Question?' } } })
      const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
      const wire = stanza.getChildText('body')!
      const parsed = parseMessageContent({ messageEl: stanza, body: wire })
      expect(parsed.processedBody).toBe(body)
      const ref = parsed.references![0] as { begin: number; end: number; forwardFallback: { begin: number; end: number } }
      expect(parsed.processedBody.slice(ref.begin, ref.end)).toBe(link)
      expect(parsed.processedBody.slice(ref.forwardFallback.begin, ref.forwardFallback.end)).toBe(quote + link)
    })

    it('shifts the marker with the references when an encrypted reply quote is stripped from a plaintext send', async () => {
      const h = harness()
      await h.chat.sendMessage('bob@example.org', body, { references: [forwardRef],
        replyTo: { id: 'earlier', fallback: { author: 'Carol', body: 'Private', fromEncrypted: true } } })
      const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
      const parsed = parseMessageContent({ messageEl: stanza, body: stanza.getChildText('body')! })
      const ref = parsed.references![0] as { forwardFallback: { begin: number; end: number } }
      expect(parsed.processedBody).toBe(body)
      expect(parsed.processedBody.slice(ref.forwardFallback.begin, ref.forwardFallback.end)).toBe(quote + link)
    })

    it('resolves the marked source, not an earlier link in the comment, after a retry', async () => {
      const h = harness()
      const text = `Also ${other}\n> Bob wrote:\n> Ship it\n${link}`
      const begin = text.length - link.length
      const stored = [{ type: 'data' as const, uri: link, begin, end: text.length,
        forwardFallback: { begin: text.indexOf('> Bob'), end: text.length } }]
      await h.chat.resendMessage('bob@example.org', text, 'fwd-2', undefined, stored)
      const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
      const parsed = parseMessageContent({ messageEl: stanza, body: text })
      // Body order puts the comment's link first; the marked one still wins.
      expect(parsed.references!.map(ref => ref.uri)).toEqual([other, link])
      expect(findRoomMessageLink(text, parsed.references)).toEqual({ roomJid: room, stanzaId: '1731490000123456' })
    })

    it('binds the marker to the terminal source link, not a link quoted above it, after a retry', async () => {
      const h = harness()
      const text = `Look\n> Bob wrote:\n> see ${other}\n${link}`
      const stored = [{ type: 'data' as const, uri: link, begin: text.length - link.length, end: text.length,
        forwardFallback: { begin: text.indexOf('> Bob'), end: text.length } }]
      await h.chat.resendMessage('bob@example.org', text, 'fwd-3', undefined, stored)
      const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
      // Body order puts the quoted link's reference first.
      const parsed = parseMessageContent({ messageEl: stanza, body: text })
      expect(parsed.references!.map(ref => ref.uri)).toEqual([other, link])
      expect(parsed.references![0]).not.toHaveProperty('forwardFallback')
      expect(findRoomMessageLink(text, parsed.references)).toEqual({ roomJid: room, stanzaId: '1731490000123456' })
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

  // Piece 2 of the forward plan: a structured XEP-0297 copy, one-to-one only, kept inside the payload when encrypted.
  describe('standalone forwarded copy', () => {
    const NSF = 'urn:xmpp:forward:0'
    const copy = { from: `${room}/Bob`, text: 'Ship it 🚀', timestamp: Date.UTC(2026, 10, 17, 9, 30) }
    const body = `Look\n${link}`
    const refs = [{ type: 'data' as const, uri: link, begin: 'Look\n'.length, end: body.length }]
    function manager() {
      return new E2EEManager({ account: { jid: 'alice@example.org' }, storage: new InMemoryStorageBackend(),
        xmpp: { sendStanza: vi.fn(), queryDisco: async () => ({ features: [], identities: [] }),
          publishPEP: vi.fn(), retractPEP: vi.fn(), deletePEP: vi.fn(), queryPEP: async () => [],
          subscribePEP: () => ({ unsubscribe() {} }) } })
    }

    it('sends the copy beside a comment-and-link body with no duplicated quote, and a reader parses it', async () => {
      const h = harness()
      await h.chat.sendMessage('bob@example.org', body, { references: refs, forwarded: copy })
      const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
      expect(stanza.getChildText('body')).toBe(body)
      const forwarded = stanza.getChild('forwarded', NSF)!
      expect(forwarded.getChild('delay', 'urn:xmpp:delay')!.attrs.stamp).toBe('2026-11-17T09:30:00.000Z')
      expect(forwarded.getChild('message')!.attrs.from).toBe(`${room}/Bob`)
      expect(forwarded.getChild('message')!.getChildText('body')).toBe('Ship it 🚀')
      expect(parseMessageContent({ messageEl: stanza, body }).forwarded).toEqual({ author: 'Bob', from: `${room}/Bob`, text: 'Ship it 🚀', timestamp: copy.timestamp })
      const event = vi.mocked(h.deps.emitSDK).mock.calls.find(([name]) => name === 'chat:message')
      expect(event?.[1]).toMatchObject({ message: { forwarded: { author: 'Bob', text: 'Ship it 🚀' } } })
    })

    it('refuses a copy for a room, which gets the quoted fallback instead', async () => {
      const h = harness()
      h.stores.room.getRoom = vi.fn(jid => jid === room ? { jid: room, nickname: 'Alice', joined: true } : undefined) as typeof h.stores.room.getRoom
      await expect(h.chat.sendMessage(room, body, { forwarded: copy })).rejects.toThrow('one-to-one')
      expect(h.deps.sendStanza).not.toHaveBeenCalled()
    })

    it('keeps the copy inside the encrypted payload only, and never sends it in plaintext when encryption fails', async () => {
      const h = harness()
      const m = manager()
      await m.register(new DummyPlaintextPlugin())
      h.deps.getE2EEManager = () => m
      try {
        await h.chat.sendMessage('bob@example.org', body, { references: refs, forwarded: copy })
        const stanza = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
        expect(stanza.getChild('forwarded', NSF)).toBeUndefined()
        expect(stanza.toString()).not.toContain('Ship it')
        const decoded = Buffer.from(stanza.getChild('plain', 'urn:fluux:e2ee-dummy:0')!.text(), 'base64').toString('utf8')
        expect(parsePayloadEnvelope(decoded)!.find(child => child.name === 'forwarded')).toBeDefined()
        vi.spyOn(m, 'encryptOutbound').mockRejectedValue(new Error('key locked'))
        vi.mocked(h.deps.sendStanza).mockClear()
        await expect(h.chat.sendMessage('bob@example.org', body, { references: refs, forwarded: copy })).rejects.toThrow('key locked')
        expect(h.deps.sendStanza).not.toHaveBeenCalled()
      } finally { await m.shutdown() }
    })

    it('reads the copy back out of a decrypted payload', async () => {
      const h = harness()
      const m = manager()
      await m.register(new DummyPlaintextPlugin())
      h.deps.getE2EEManager = () => m
      try {
        await h.chat.sendMessage('bob@example.org', body, { references: refs, forwarded: copy })
        const sent = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
        const received = xml('message', { type: 'chat', from: 'alice@example.org/web', to: 'bob@example.org' }, ...sent.children as Element[])
        const result = await decryptStanzaInPlace(received, m, 'alice@example.org')
        expect(result.securityContext).toBeDefined()
        expect(parseMessageContent({ messageEl: received, body: received.getChildText('body') ?? '' }).forwarded)
          .toMatchObject({ author: 'Bob', text: 'Ship it 🚀' })
      } finally { await m.shutdown() }
    })

    // Review: only the copy inside the authenticated payload counts on an encrypted message.
    it('drops a copy an intermediary added outside the encrypted payload, on success and on failure', async () => {
      const h = harness()
      const m = manager()
      await m.register(new DummyPlaintextPlugin())
      h.deps.getE2EEManager = () => m
      const forged = () => xml('forwarded', { xmlns: NSF }, xml('message', { from: `${room}/Mallory` }, xml('body', {}, 'forged text')))
      try {
        await h.chat.sendMessage('bob@example.org', link)
        const sent = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
        const received = () => xml('message', { type: 'chat', from: 'alice@example.org/web', to: 'bob@example.org' }, ...(sent.children as Element[]), forged())
        const ok = received()
        await decryptStanzaInPlace(ok, m, 'alice@example.org')
        expect(parseMessageContent({ messageEl: ok, body: ok.getChildText('body') ?? '' }).forwarded).toBeUndefined()

        vi.spyOn(m, 'decryptInbound').mockRejectedValue(new Error('key locked'))
        const failed = received()
        await decryptStanzaInPlace(failed, m, 'alice@example.org')
        expect(parseMessageContent({ messageEl: failed, body: failed.getChildText('body') ?? '' }).forwarded).toBeUndefined()
      } finally { await m.shutdown() }
    })

    it('keeps the copy and its original sender address on a retry, inside the payload when encrypted', async () => {
      const h = harness()
      // A nickname that holds a slash must not lose its leading part on the next parse.
      const stored = parseMessageContent({ messageEl: xml('message', {}, xml('forwarded', { xmlns: NSF },
        xml('message', { from: `${room}/Bob/Builder` }, xml('body', {}, 'Ship it')))), body: '' }).forwarded!
      expect(stored.from).toBe(`${room}/Bob/Builder`)
      await h.chat.resendMessage('bob@example.org', body, 'm1', undefined, refs, stored)
      const plain = vi.mocked(h.deps.sendStanza).mock.calls[0][0].getChild('forwarded', NSF)!
      expect(plain.getChild('message')!.attrs.from).toBe(`${room}/Bob/Builder`)
      expect(plain.getChild('message')!.getChildText('body')).toBe('Ship it')

      const m = manager()
      await m.register(new DummyPlaintextPlugin())
      h.deps.getE2EEManager = () => m
      try {
        vi.mocked(h.deps.sendStanza).mockClear()
        await h.chat.resendMessage('bob@example.org', body, 'm1', undefined, refs, stored)
        const sent = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
        expect(sent.getChild('forwarded', NSF)).toBeUndefined()
        expect(sent.toString()).not.toContain('Ship it')
        const decoded = Buffer.from(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')!.text(), 'base64').toString('utf8')
        expect(parsePayloadEnvelope(decoded)!.find(child => child.name === 'forwarded')).toBeDefined()
      } finally { await m.shutdown() }
    })

    it('replays a copy that has no outer body from the archive', () => {
      const h = harness()
      const mam = new MAM(h.deps) as unknown as { parseArchiveMessage(f: Element, conversation: string, archiveId?: string): { body: string; forwarded?: unknown } | null }
      const forwarded = xml('forwarded', { xmlns: NSF }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-11-17T09:30:00Z' }),
        xml('message', { type: 'chat', from: 'bob@example.org/web', to: 'alice@example.org', id: 'nobody-archived' },
          xml('forwarded', { xmlns: NSF }, xml('message', { from: `${room}/Bob` }, xml('body', {}, 'Ship it')))))
      expect(mam.parseArchiveMessage(forwarded, 'bob@example.org', 'arch1')).toMatchObject({ body: '', forwarded: { author: 'Bob', text: 'Ship it' } })
    })

    // Review: a carbon wraps the whole message, so the copy inside it is read once, from the unwrapped message.
    it.each([['received', 'bob@example.org/web', 'alice@example.org/phone', false], ['sent', 'alice@example.org/phone', 'bob@example.org', true]])(
      'keeps the copy of a %s carbon', (kind, from, to, outgoing) => {
        const h = harness()
        h.chat.handle(xml('message', { from: 'alice@example.org', to: 'alice@example.org/web' },
          xml(kind, { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: NSF },
            xml('message', { type: 'chat', id: `carbon-${kind}`, from, to },
              xml('body', {}, 'Look'),
              xml('forwarded', { xmlns: NSF }, xml('message', { from: `${room}/Bob` }, xml('body', {}, 'Ship it'))))))))
        const events = vi.mocked(h.deps.emitSDK).mock.calls.filter(([name]) => name === 'chat:message')
        expect(events).toHaveLength(1)
        expect(events[0][1]).toMatchObject({ message: { id: `carbon-${kind}`, body: 'Look', isOutgoing: outgoing, forwarded: { author: 'Bob', text: 'Ship it' } } })
      })

    // Review: a copy may arrive without an outer body and must still be delivered.
    it('delivers a copy that has no outer body', () => {
      const h = harness()
      h.chat.handle(xml('message', { type: 'chat', id: 'nobody', from: 'bob@example.org/web', to: 'alice@example.org' },
        xml('forwarded', { xmlns: NSF }, xml('message', { from: `${room}/Bob` }, xml('body', {}, 'Ship it')))))
      const event = vi.mocked(h.deps.emitSDK).mock.calls.find(([name]) => name === 'chat:message')
      expect(event?.[1]).toMatchObject({ message: { body: '', forwarded: { author: 'Bob', text: 'Ship it' } } })
    })
  })
})

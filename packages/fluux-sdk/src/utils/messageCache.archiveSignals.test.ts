import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore, IDBIndex } from 'fake-indexeddb'
import { openDB } from 'idb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../core/types'
import type { ArchiveSignal } from './archiveSignal'
import * as cache from './messageCache'
import { setStorageScopeJid } from './storageScope'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'
import { retractChatMessageInStorage, retractUnresidentChatTarget } from '../stores/shared/retractionStorage'

const OWN = 'self@example.test'
const PEER = 'peer@example.test'
const timestamp = new Date('2026-10-16T10:00:00Z')
function row(id: string, stanzaId = `archive-${id}`): Message {
  return { type: 'chat', conversationId: PEER, id, stanzaId, ownArchiveId: stanzaId, ownArchiveBy: OWN, originId: undefined,
    from: PEER, isOutgoing: false, body: 'fixture', timestamp }
}
function signal(overrides: Partial<ArchiveSignal> = {}): ArchiveSignal {
  return { conversationId: PEER, archiveId: 'archive-signal', id: 'signal', from: PEER,
    timestamp: timestamp.getTime(), stanza: '<message/>',
    effect: { type: 'reactions', targetId: 'target', emojis: ['👍'] }, ...overrides }
}

describe('authenticated archive signal journal', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    cache._resetDBForTesting()
    _clearRetractedIdentitiesForTesting()
    setStorageScopeJid(OWN)
  })

  it('atomically retains the placeholder and old target when completion aborts after applying the effect', async () => {
    const target = row('target')
    const placeholder = { ...row('signal'), encryptedPayload: '<encrypted/>' }
    await cache.saveMessages([target, placeholder])
    const put = IDBObjectStore.prototype.put
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'archive-signals' && value.applied === 1) throw new Error('fixture crash after target write')
      return put.call(this, value, key)
    })
    await expect(cache.rememberArchiveSignal(signal())).rejects.toThrow('fixture crash')
    fault.mockRestore()
    cache._resetDBForTesting()
    expect(await cache.getArchiveSignal(PEER, 'archive-signal', PEER)).toBeUndefined()
    expect((await cache.getMessages(PEER)).find(m => m.id === 'target')?.reactions).toBeUndefined()
    expect((await cache.getMessages(PEER)).find(m => m.id === 'signal')?.encryptedPayload).toBeTruthy()
    await cache.rememberArchiveSignal(signal())
    cache._resetDBForTesting()
    expect((await cache.getMessages(PEER)).map(m => m.id)).toEqual(['target'])
    expect((await cache.getMessages(PEER))[0].reactions).toEqual({ '👍': [PEER] })
    expect(await cache.getArchiveSignal(PEER, 'archive-signal', PEER)).toBeDefined()
  })

  it('retains a signal across reload until a target arrives, without storing a readable row', async () => {
    await cache.rememberArchiveSignal(signal())
    cache._resetDBForTesting()
    expect(await cache.getMessages(PEER)).toEqual([])
    const reconciled = await cache.reconcileChatHistoryMessages([row('target')], () => [])
    expect(reconciled[0].reactions).toEqual({ '👍': [PEER] })
    await cache.saveMessage(reconciled[0])
    expect((await cache.getMessages(PEER))[0].reactions).toEqual({ '👍': [PEER] })
    // A delayed write of the encrypted page cannot resurrect the signal.
    await cache.saveMessages([{ ...row('signal'), encryptedPayload: '<encrypted/>' }])
    expect((await cache.getMessages(PEER)).map(m => m.id)).toEqual(['target'])
  })

  it('keeps archive, conversation, sender and account identities separate', async () => {
    await cache.rememberArchiveSignal(signal())
    expect(await cache.getArchiveSignal('other@example.test', 'archive-signal', PEER)).toBeUndefined()
    expect(await cache.getArchiveSignal(PEER, 'archive-other', PEER)).toBeUndefined()
    expect(await cache.getArchiveSignal(PEER, 'archive-signal', OWN)).toBeUndefined()
    setStorageScopeJid('other@example.test')
    expect(await cache.getArchiveSignal(PEER, 'archive-signal', PEER)).toBeUndefined()
    await cache.saveMessages([row('target'), row('signal', 'distinct-archive-entry')])
    expect((await cache.getMessages(PEER)).map(m => m.id).sort()).toEqual(['signal', 'target'])
  })

  it.each([false, true])('keeps the latest reaction when an older signal arrives after it (reload: %s)', async reload => {
    await cache.saveMessage(row('target'))
    await cache.rememberArchiveSignal(signal({ archiveId: 'new', id: 'new', timestamp: timestamp.getTime() + 2000,
      effect: { type: 'reactions', targetId: 'target', emojis: ['❤️'] } }))
    if (reload) cache._resetDBForTesting()
    await cache.rememberArchiveSignal(signal({ archiveId: 'old', id: 'old', timestamp: timestamp.getTime() + 1000,
      effect: { type: 'reactions', targetId: 'target', emojis: ['👍'] } }))
    expect((await cache.getMessage(PEER, 'target'))?.reactions).toEqual({ '❤️': [PEER] })
    expect(await cache.getArchiveSignal(PEER, 'old', PEER)).toBeDefined()
  })

  it.each([{ emojis: ['❤️'] }, { emojis: [] }])('preserves newer non-journal reactions $emojis after restart and late encrypted signals', async ({ emojis }) => {
    const target = row('target')
    await cache.saveMessage(target)
    await cache.rememberArchiveSignal(signal())
    await cache.updateMessageReactions(PEER, 'target', PEER, emojis, undefined, timestamp.getTime() + 2000)
    cache._resetDBForTesting()
    await cache.rememberArchiveSignal(signal({ archiveId: 'late', id: 'late', timestamp: timestamp.getTime() + 1000 }))
    const expected = emojis.length ? { '❤️': [PEER] } : undefined
    expect((await cache.getMessage(PEER, 'target'))?.reactions).toEqual(expected)
    const history = await cache.reconcileChatHistoryMessages([target], () => [])
    expect(history[0].reactions).toEqual(expected)
    await cache.saveMessage(target)
    expect((await cache.getMessage(PEER, 'target'))?.reactions).toEqual(expected)
  })

  it('does not resurrect a removed reaction when an older signal uses another alias of the same target', async () => {
    await cache.saveMessage({ ...row('target'), originId: 'origin-target' })
    await cache.rememberArchiveSignal(signal({ archiveId: 'removed', id: 'removed', timestamp: timestamp.getTime() + 2000,
      effect: { type: 'reactions', targetId: 'origin-target', emojis: [] } }))
    cache._resetDBForTesting()
    await cache.rememberArchiveSignal(signal({ timestamp: timestamp.getTime() + 1000 }))
    expect((await cache.getMessage(PEER, 'target'))?.reactions).toBeUndefined()
  })

  it('orders reactions separately for each author and target, including equal archive timestamps', async () => {
    await cache.saveMessages([row('target'), row('other')])
    await cache.rememberArchiveSignal(signal({ archiveId: 'first', id: 'first' }))
    await cache.rememberArchiveSignal(signal({ archiveId: 'second', id: 'second',
      effect: { type: 'reactions', targetId: 'target', emojis: ['❤️'] } }))
    await cache.rememberArchiveSignal(signal({ archiveId: 'other-author', id: 'other-author', from: OWN,
      timestamp: timestamp.getTime() - 1000, effect: { type: 'reactions', targetId: 'target', emojis: ['🎉'] } }))
    await cache.rememberArchiveSignal(signal({ archiveId: 'other-target', id: 'other-target',
      timestamp: timestamp.getTime() - 1000, effect: { type: 'reactions', targetId: 'other', emojis: ['👍'] } }))
    expect((await cache.getMessage(PEER, 'target'))?.reactions).toEqual({ '❤️': [PEER], '🎉': [OWN] })
    expect((await cache.getMessage(PEER, 'other'))?.reactions).toEqual({ '👍': [PEER] })
  })

  it('does not remove a different archive entry sharing a client id', async () => {
    await cache.saveMessages([
      { ...row('signal'), encryptedPayload: '<encrypted/>' },
      row('signal', 'another-archive-entry'),
    ])
    await cache.rememberArchiveSignal(signal())
    expect((await cache.getMessages(PEER)).map(message => message.stanzaId)).toEqual(['another-archive-entry'])
  })

  it('uses the qualified own archive identity even when the message carries a foreign stanza id', async () => {
    await cache.saveMessage({ ...row('signal'), stanzaId: 'foreign-id', encryptedPayload: '<encrypted/>' })
    await cache.rememberArchiveSignal(signal())
    expect(await cache.getMessages(PEER)).toEqual([])
    await cache.saveMessage({ ...row('signal'), stanzaId: 'archive-signal', ownArchiveBy: PEER,
      ownArchiveId: 'foreign-authority-entry', encryptedPayload: '<encrypted/>' })
    expect(await cache.getMessages(PEER)).toHaveLength(1)
  })

  it('uses the client-id tier for reactions and author-gates destructive signals', async () => {
    const clientMatch = row('reference', 'archive-one')
    const archiveMatch = row('other', 'reference')
    await cache.saveMessages([clientMatch, archiveMatch])
    await cache.rememberArchiveSignal(signal({ effect: { type: 'reactions', targetId: 'reference', emojis: ['👍'] } }))
    expect((await cache.getMessage(PEER, 'reference'))?.reactions).toEqual({ '👍': [PEER] })
    expect((await cache.getMessage(PEER, 'other'))?.reactions).toBeUndefined()
    await cache.rememberArchiveSignal(signal({ archiveId: 'retraction', id: 'retract', from: OWN,
      effect: { type: 'retract', targetId: 'reference' } }))
    expect((await cache.getMessage(PEER, 'other'))?.isRetracted).toBeUndefined()
    await cache.rememberArchiveSignal(signal({ archiveId: 'valid-retraction', id: 'retract',
      effect: { type: 'retract', targetId: 'reference' } }))
    expect((await cache.getMessage(PEER, 'other'))?.isRetracted).toBe(true)
    expect((await cache.getMessage(PEER, 'other'))?.body).toBe('')
  })

  const secret = 'private correction fixture'
  function correction(archiveId = 'correction', targetId = 'archive-target', authorOnly = true): ArchiveSignal {
    return signal({ archiveId, id: archiveId, stanza: `<message><body>${secret}</body></message>`,
      effect: { type: 'update', targetId, authorOnly, updates: {
        body: secret, originalBody: secret, linkPreview: { url: `https://example.test/${secret}` },
      } } })
  }

  async function expectErased(archiveId = 'correction') {
    cache._resetDBForTesting()
    const remembered = await cache.getArchiveSignal(PEER, archiveId, PEER)
    expect(remembered).toMatchObject({ archiveId, id: archiveId, from: PEER, conversationId: PEER })
    expect(JSON.stringify(remembered)).not.toContain(secret)
    const db = await openDB(`fluux-message-cache:${OWN}`)
    const stored = await db.getAll('archive-signals')
    expect(JSON.stringify(stored)).not.toContain(secret)
    db.close()
    expect((await cache.getMessage(PEER, 'target'))?.body).toBe('')
  }

  it.each(['update', 'save', 'batch', 'signal'] as const)('erases existing correction and preview records on %s retraction', async mode => {
    await cache.saveMessage(row('target'))
    await cache.rememberArchiveSignal(correction())
    await cache.rememberArchiveSignal(correction('preview', 'target', false))
    if (mode === 'update') {
      await cache.updateMessage(PEER, 'target', { isRetracted: true, retractedAt: timestamp }, PEER)
    } else if (mode === 'signal') {
      await cache.rememberArchiveSignal(signal({ archiveId: 'retract', id: 'retract',
        effect: { type: 'retract', targetId: 'archive-target' } }))
    } else {
      const tombstone = { ...row('target'), isRetracted: true, retractedAt: timestamp }
      if (mode === 'save') await cache.saveMessage(tombstone)
      else await cache.saveMessages([tombstone])
    }
    await expectErased()
    await cache.rememberArchiveSignal(correction())
    await expectErased()
    expect((await cache.getMessages(PEER)).map(message => message.id)).toEqual(['target'])
  })

  it('erases late correction and preview writes without losing processed identity', async () => {
    await cache.saveMessage({ ...row('target'), isRetracted: true, retractedAt: timestamp })
    await cache.rememberArchiveSignal(correction())
    await cache.rememberArchiveSignal(correction('preview', 'target', false))
    await expectErased()
    await cache.saveMessage({ ...row('correction', 'correction'), encryptedPayload: '<encrypted/>' })
    expect((await cache.getMessages(PEER)).map(message => message.id)).toEqual(['target'])
  })

  it('erases pending content when its target first arrives already retracted', async () => {
    await cache.rememberArchiveSignal(correction())
    await cache.saveMessage({ ...row('target'), isRetracted: true, retractedAt: timestamp })
    await expectErased()
  })

  it('keeps unrelated journal content when an archive-authoritative target has another author', async () => {
    await cache.saveMessages([row('target'), { ...row('other', 'target'), from: OWN, isRetracted: true }])
    const incoming = correction('correction', 'target')
    await cache.rememberArchiveSignal(incoming)
    expect((await cache.getArchiveSignal(PEER, 'correction', PEER))?.stanza).toBe(incoming.stanza)
    expect((await cache.getMessage(PEER, 'target'))?.body).toBe('fixture')
  })

  it('rolls back the tombstone when journal erasure aborts', async () => {
    await cache.saveMessage(row('target'))
    await cache.rememberArchiveSignal(correction())
    const put = IDBObjectStore.prototype.put
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'archive-signals' && value.archiveId === 'correction' && value.stanza === '<message/>') throw new Error('fixture erasure failure')
      return put.call(this, value, key)
    })
    await expect(cache.rememberArchiveSignal(signal({ archiveId: 'retract', id: 'retract',
      effect: { type: 'retract', targetId: 'archive-target' } }))).rejects.toThrow('fixture erasure failure')
    fault.mockRestore()
    cache._resetDBForTesting()
    expect((await cache.getMessage(PEER, 'target'))?.body).toBe(secret)
    expect((await cache.getArchiveSignal(PEER, 'correction', PEER))?.stanza).toContain(secret)
    expect(await cache.getArchiveSignal(PEER, 'retract', PEER)).toBeUndefined()
  })

  it.each(['pending', 'verified', 'journal'] as const)('erases existing and late corrections with an absent target through %s retraction', async mode => {
    await cache.rememberArchiveSignal(correction())
    await cache.rememberArchiveSignal({ ...correction('other-author'), from: OWN })
    expect(await cache.getMessages(PEER)).toEqual([])
    if (mode === 'pending') {
      expect(await retractUnresidentChatTarget(PEER, {
        targetId: 'archive-target', actorJid: PEER, retractedAt: timestamp.getTime(),
      })).toBe('pending')
    } else if (mode === 'verified') {
      await retractChatMessageInStorage(PEER, { ...row('target'), isRetracted: true, retractedAt: timestamp })
    } else {
      await cache.rememberArchiveSignal(signal({ archiveId: 'retract', id: 'retract',
        effect: { type: 'retract', targetId: 'archive-target' } }))
      cache._resetDBForTesting()
      _clearRetractedIdentitiesForTesting()
    }
    expect(JSON.stringify(await cache.getArchiveSignal(PEER, 'correction', PEER))).not.toContain(secret)
    expect((await cache.getArchiveSignal(PEER, 'other-author', OWN))?.stanza).toContain(secret)
    await cache.rememberArchiveSignal(correction('late'))
    await cache.rememberArchiveSignal(correction('late-preview', 'archive-target', false))
    for (const archiveId of ['correction', 'late', 'late-preview']) {
      const remembered = await cache.getArchiveSignal(PEER, archiveId, PEER)
      expect(remembered).toMatchObject({ archiveId, id: archiveId, from: PEER, conversationId: PEER })
      expect(JSON.stringify(remembered)).not.toContain(secret)
    }
    expect(await cache.getMessages(PEER)).toEqual([])
    await cache.saveMessage({ ...row('late', 'late'), encryptedPayload: '<encrypted/>' })
    expect(await cache.getMessages(PEER)).toEqual([])
    cache._resetDBForTesting()
    const db = await openDB(`fluux-message-cache:${OWN}`)
    const erased = (await db.getAll('archive-signals')).filter(record => record.from === PEER)
    expect(erased).toHaveLength(mode === 'journal' ? 4 : 3)
    expect(JSON.stringify(erased)).not.toContain(secret)
    db.close()
  })

  it('does not scan unrelated journal records or rewrite erased entries on ordinary saves', async () => {
    await cache.saveMessages([row('target'), row('unrelated')])
    await cache.rememberArchiveSignal(correction())
    await cache.rememberArchiveSignal(correction('unrelated-correction', 'archive-unrelated'))
    await cache.updateMessage(PEER, 'target', { isRetracted: true, retractedAt: timestamp }, PEER)
    const reads: { index: string; key: unknown }[] = []
    const getAll = IDBIndex.prototype.getAll
    const read = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
      if (this.objectStore.name === 'archive-signals') reads.push({ index: this.name, key: args[0] })
      return getAll.apply(this, args)
    })
    const writes = vi.spyOn(IDBObjectStore.prototype, 'put')
    try {
      await cache.saveMessage(row('fresh-one'))
      await cache.saveMessages([row('fresh-two'), row('fresh-three')])
      await cache.applyChatCorrection(PEER, 'fresh-one', { body: 'ordinary correction' }, { actorJid: PEER })
      await cache.updateMessageReactions(PEER, 'fresh-two', PEER, ['👍'])
      await cache.updateMessage(PEER, 'target', { isRetracted: true }, PEER)
      expect(reads.some(read => read.index === 'conversationId')).toBe(false)
      expect(reads.filter(read => read.index === 'target').every(read =>
        Array.isArray(read.key) && ['target', 'archive-target'].includes(read.key[1]))).toBe(true)
      expect(writes.mock.calls.filter(([value]) => 'archiveId' in value)).toHaveLength(0)
    } finally {
      read.mockRestore()
      writes.mockRestore()
    }
    expect((await cache.getArchiveSignal(PEER, 'unrelated-correction', PEER))?.stanza).toContain(secret)
    expect((await cache.getMessage(PEER, 'fresh-one'))?.body).toBe('ordinary correction')
    expect((await cache.getMessage(PEER, 'fresh-two'))?.reactions).toEqual({ '👍': [PEER] })
  })

  it('indexes existing v8 journal records without discarding processed identity', async () => {
    const old = await openDB(`fluux-message-cache:${OWN}`, 8, { upgrade(db) {
      const messages = db.createObjectStore('messages-canonical', { keyPath: 'cacheKey' })
      messages.createIndex('conversationId', 'conversationId')
      messages.createIndex('ids', 'ids', { multiEntry: true })
      messages.createIndex('identityKeys', 'identityKeys', { multiEntry: true })
      messages.createIndex('conv_timestamp', ['conversationId', 'timestamp'])
      db.createObjectStore('room-messages-canonical', { keyPath: 'cacheKey' })
      const signals = db.createObjectStore('archive-signals', { keyPath: 'key' })
      signals.createIndex('conversationId', 'conversationId')
      signals.createIndex('pendingConversation', ['conversationId', 'applied'])
      signals.createIndex('sequence', 'sequence')
    } })
    await old.put('archive-signals', { ...correction(), key: JSON.stringify([PEER, 'correction']), applied: 0, sequence: 1 })
    old.close()
    expect((await cache.getArchiveSignal(PEER, 'correction', PEER))?.stanza).toContain(secret)
    await cache.rememberArchiveSignal(signal({ archiveId: 'retract', id: 'retract',
      effect: { type: 'retract', targetId: 'archive-target' } }))
    expect(JSON.stringify(await cache.getArchiveSignal(PEER, 'correction', PEER))).not.toContain(secret)
    expect(await cache.getMessages(PEER)).toEqual([])
  })

  it('preserves v7 cached messages on upgrade and clears the journal with its conversation', async () => {
    const db = await openDB(`fluux-message-cache:${OWN}`, 7, { upgrade(db) {
      const messages = db.createObjectStore('messages-canonical', { keyPath: 'cacheKey' })
      messages.createIndex('conversationId', 'conversationId')
      messages.createIndex('ids', 'ids', { multiEntry: true })
      messages.createIndex('identityKeys', 'identityKeys', { multiEntry: true })
      messages.createIndex('conv_timestamp', ['conversationId', 'timestamp'])
      db.createObjectStore('room-messages-canonical', { keyPath: 'cacheKey' })
    } })
    await db.put('messages-canonical', { ...row('target'), timestamp: timestamp.getTime(), cacheKey: 'legacy-key',
      ids: ['target'], identityKeys: [] })
    db.close()
    expect((await cache.getMessages(PEER))[0].body).toBe('fixture')
    await cache.rememberArchiveSignal(signal())
    await cache.deleteConversationMessages(PEER)
    expect(await cache.getMessages(PEER)).toEqual([])
    expect(await cache.getArchiveSignal(PEER, 'archive-signal', PEER)).toBeUndefined()
  })
})

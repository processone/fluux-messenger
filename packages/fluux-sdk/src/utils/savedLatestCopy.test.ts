import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'
import { cachedDeletions } from './savedLatestCopy'
import { savedStore } from '../stores/savedStore'
import type { SavedMessage } from '../core/types/saved'

const cached = vi.hoisted(() => ({ room: null as unknown, chat: null as unknown }))
vi.mock('./messageCache', () => ({
  getMessageByStanzaId: async (kind: 'chat' | 'room') => kind === 'room' ? cached.room : cached.chat,
  getMessageByReference: async () => null,
}))

const ROOM = 'team@conference.example'
const OWN = 'romeo@montague.example'
const roomEntry: SavedMessage = {
  id: 'a', conversationJid: ROOM, type: 'groupchat', from: `${ROOM}/Alice`, text: 'secret', savedAt: 1,
  stanzaId: 's-a', stanzaIdBy: ROOM, occupantId: 'occ',
}
const chatEntry: SavedMessage = {
  id: 'c', conversationJid: 'juliet@capulet.example', type: 'chat', from: 'juliet@capulet.example', to: OWN, text: 'secret', savedAt: 1,
  messageId: 'm', stanzaId: 'own-1', stanzaIdBy: OWN,
}

// Intent: a saved copy of a deleted original loses its text even when the in-memory
// retraction ledger no longer (or not yet) holds the record but the durable cache does.
describe('cachedDeletions', () => {
  beforeEach(() => { _clearRetractedIdentitiesForTesting(); savedStore.getState().reset() })

  it('lets a later fetched room copy be cleared from a retracted cached copy', async () => {
    cached.room = { type: 'groupchat', roomJid: ROOM, id: 'm', stanzaId: 's-a', from: `${ROOM}/Alice`, nick: 'Alice', occupantId: 'occ',
      body: '', timestamp: new Date(5), isOutgoing: false, isRetracted: true, retractedAt: new Date(9) }
    const deleted = await cachedDeletions([roomEntry], OWN)
    savedStore.getState().reconcileFetch([roomEntry], undefined, deleted)
    expect(savedStore.getState().entries.a).toMatchObject({ deleted: true, text: '' })
    expect(savedStore.getState().pending.a).toBe('publish')
  })

  it('clears a chat copy whose cached message carries a foreign archive id beside the account archive id', async () => {
    cached.chat = { type: 'chat', conversationId: chatEntry.conversationJid, id: 'm', from: chatEntry.conversationJid, body: '',
      stanzaId: 'foreign-9', ownArchiveId: 'own-1', ownArchiveBy: OWN, timestamp: new Date(5), isOutgoing: false, isRetracted: true }
    const deleted = await cachedDeletions([chatEntry], OWN)
    expect([...deleted]).toEqual(['c'])
    savedStore.getState().applyNotify({ upserts: [chatEntry], removedIds: [] }, deleted)
    expect(savedStore.getState().entries.c).toMatchObject({ deleted: true, text: '' })
  })

  it('leaves a live copy alone', async () => {
    cached.room = { type: 'groupchat', roomJid: ROOM, id: 'm', stanzaId: 's-a', from: `${ROOM}/Alice`, nick: 'Alice', occupantId: 'occ',
      body: 'secret', timestamp: new Date(5), isOutgoing: false }
    const deleted = await cachedDeletions([roomEntry], OWN)
    savedStore.getState().reconcileFetch([roomEntry], undefined, deleted)
    expect(savedStore.getState().entries.a.deleted).toBeUndefined()
  })
})

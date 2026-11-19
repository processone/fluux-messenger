import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'
import { noteCachedDeletions } from './savedLatestCopy'
import { savedStore } from '../stores/savedStore'
import type { SavedMessage } from '../core/types/saved'

const cached = vi.hoisted(() => ({ copy: null as unknown }))
vi.mock('./messageCache', () => ({
  getRoomMessageByStanzaId: async () => cached.copy,
  getRoomMessageByReference: async () => null,
  getMessageByStanzaId: async () => null,
  getMessageByReference: async () => null,
}))

const ROOM = 'team@conference.example'
const entry: SavedMessage = {
  id: 'a', conversationJid: ROOM, type: 'groupchat', from: `${ROOM}/Alice`, text: 'secret', savedAt: 1,
  stanzaId: 's-a', stanzaIdBy: ROOM, occupantId: 'occ',
}

// Intent: a saved copy of a deleted original loses its text even when the in-memory
// retraction ledger no longer (or not yet) holds the record but the durable cache does.
describe('noteCachedDeletions', () => {
  beforeEach(() => { _clearRetractedIdentitiesForTesting(); savedStore.getState().reset() })

  it('lets a later fetched copy be cleared from a retracted cached copy', async () => {
    cached.copy = { type: 'groupchat', roomJid: ROOM, id: 'm', stanzaId: 's-a', from: `${ROOM}/Alice`, nick: 'Alice', occupantId: 'occ',
      body: '', timestamp: new Date(5), isOutgoing: false, isRetracted: true, retractedAt: new Date(9) }
    await noteCachedDeletions([entry], 'romeo@montague.example')
    savedStore.getState().reconcileFetch([entry])
    expect(savedStore.getState().entries.a).toMatchObject({ deleted: true, text: '' })
    expect(savedStore.getState().pending.a).toBe('publish')
  })

  it('leaves a live copy alone', async () => {
    cached.copy = { type: 'groupchat', roomJid: ROOM, id: 'm', stanzaId: 's-a', from: `${ROOM}/Alice`, nick: 'Alice', occupantId: 'occ',
      body: 'secret', timestamp: new Date(5), isOutgoing: false }
    await noteCachedDeletions([entry], 'romeo@montague.example')
    savedStore.getState().reconcileFetch([entry])
    expect(savedStore.getState().entries.a.deleted).toBeUndefined()
  })
})

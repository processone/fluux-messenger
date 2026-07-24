import { describe, it, expect } from 'vitest'
import type { Conversation, ConversationEntity, ConversationMetadata, Message } from '../../core/types/chat'
import { draftConversationMaps, rebuildCompatEntry, type ConversationMaps } from './conversationMaps'

function makeMessage(id: string, body = 'hi'): Message {
  return {
    type: 'chat',
    id,
    conversationId: 'alice@example.com',
    from: 'alice@example.com',
    body,
    timestamp: new Date('2026-07-24T10:00:00Z'),
    isOutgoing: false,
  }
}

function makeMaps(
  entries: Array<[string, ConversationEntity, ConversationMetadata]>
): ConversationMaps {
  const conversationEntities = new Map<string, ConversationEntity>()
  const conversationMeta = new Map<string, ConversationMetadata>()
  const conversations = new Map<string, Conversation>()
  for (const [id, entity, meta] of entries) {
    conversationEntities.set(id, entity)
    conversationMeta.set(id, meta)
    conversations.set(id, { ...entity, ...meta })
  }
  return { conversationEntities, conversationMeta, conversations }
}

const ALICE_ENTITY: ConversationEntity = { id: 'alice@example.com', name: 'Alice', type: 'chat' }
const ALICE_META: ConversationMetadata = { unreadCount: 0 }

/**
 * The invariant that licenses dropping `conversations` from the persisted blob:
 * every compat entry must equal what `deserializeState` would rebuild for it.
 */
function expectRebuildFidelity(maps: ConversationMaps): void {
  const expected = new Map<string, Conversation>()
  for (const [id, entity] of maps.conversationEntities) {
    const meta = maps.conversationMeta.get(id)
    if (meta) expected.set(id, { ...entity, ...meta })
  }
  expect(Object.fromEntries(maps.conversations)).toEqual(Object.fromEntries(expected))
}

describe('conversationMaps', () => {
  describe('rebuildCompatEntry', () => {
    it('merges entity and metadata fields', () => {
      const message = makeMessage('m1')
      expect(
        rebuildCompatEntry(ALICE_ENTITY, { unreadCount: 3, lastMessage: message })
      ).toEqual({
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        unreadCount: 3,
        lastMessage: message,
      })
    })
  })

  describe('patchMeta', () => {
    it('writes the metadata map and derives the compat entry from it', () => {
      const draft = draftConversationMaps(makeMaps([['alice@example.com', ALICE_ENTITY, ALICE_META]]))
      const message = makeMessage('m1')

      expect(draft.patchMeta('alice@example.com', { lastMessage: message })).toBe(true)
      const committed = draft.commit()

      expect(committed.conversationMeta?.get('alice@example.com')).toEqual({
        unreadCount: 0,
        lastMessage: message,
      })
      expect(committed.conversations?.get('alice@example.com')).toEqual({
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        unreadCount: 0,
        lastMessage: message,
      })
    })

    it('returns false and writes nothing when the conversation has no metadata', () => {
      const draft = draftConversationMaps({
        conversationEntities: new Map([['alice@example.com', ALICE_ENTITY]]),
        conversationMeta: new Map(),
        conversations: new Map(),
      })

      expect(draft.patchMeta('alice@example.com', { unreadCount: 5 })).toBe(false)
      expect(draft.dirty).toBe(false)
      expect(draft.commit()).toEqual({})
    })

    /**
     * The drift the compat-map removal exists to make impossible: a field
     * written into `conversations` alone vanishes on the next reload, because
     * the rebuild only ever emits `{ ...entity, ...meta }`.
     */
    it('heals a pre-existing compat entry that drifted from its metadata', () => {
      const maps = makeMaps([['alice@example.com', ALICE_ENTITY, ALICE_META]])
      // Simulate a legacy write site that patched only the compat map.
      maps.conversations.set('alice@example.com', {
        ...maps.conversations.get('alice@example.com')!,
        pendingRemoteDisplayedStanzaId: 'orphaned',
      })

      const draft = draftConversationMaps(maps)
      draft.patchMeta('alice@example.com', { unreadCount: 2 })
      const committed = draft.commit()

      expect(committed.conversations?.get('alice@example.com')).toEqual({
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        unreadCount: 2,
      })
      expectRebuildFidelity({ ...maps, ...committed })
    })
  })

  describe('setMeta', () => {
    it('replaces metadata wholesale and re-derives the compat entry', () => {
      const draft = draftConversationMaps(
        makeMaps([['alice@example.com', ALICE_ENTITY, { unreadCount: 7, lastMessage: makeMessage('old') }]])
      )

      draft.setMeta('alice@example.com', { unreadCount: 0 })
      const committed = draft.commit()

      expect(committed.conversations?.get('alice@example.com')).toEqual({
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        unreadCount: 0,
      })
      expect(committed.conversations?.get('alice@example.com')).not.toHaveProperty('lastMessage')
    })

    it('creates no compat entry when the conversation has no entity', () => {
      const draft = draftConversationMaps({
        conversationEntities: new Map(),
        conversationMeta: new Map(),
        conversations: new Map(),
      })

      draft.setMeta('ghost@example.com', { unreadCount: 1 })
      const committed = draft.commit()

      expect(committed.conversationMeta?.get('ghost@example.com')).toEqual({ unreadCount: 1 })
      expect(committed.conversations?.has('ghost@example.com')).toBe(false)
    })
  })

  describe('setEntity / patchEntity', () => {
    it('re-derives the compat entry when an entity field changes', () => {
      const draft = draftConversationMaps(
        makeMaps([['alice@example.com', ALICE_ENTITY, { unreadCount: 4 }]])
      )

      expect(draft.patchEntity('alice@example.com', { name: 'Alice Smith' })).toBe(true)
      const committed = draft.commit()

      expect(committed.conversationEntities?.get('alice@example.com')?.name).toBe('Alice Smith')
      expect(committed.conversations?.get('alice@example.com')).toEqual({
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 4,
      })
    })

    it('does not hand back a new metadata map when only the entity changed', () => {
      const maps = makeMaps([['alice@example.com', ALICE_ENTITY, ALICE_META]])
      const draft = draftConversationMaps(maps)

      draft.patchEntity('alice@example.com', { name: 'Renamed' })
      const committed = draft.commit()

      expect(committed.conversationMeta).toBeUndefined()
      expect(committed.conversationEntities).toBeDefined()
      expect(committed.conversations).toBeDefined()
    })

    it('returns false when the entity is absent', () => {
      const draft = draftConversationMaps(makeMaps([]))
      expect(draft.patchEntity('nobody@example.com', { name: 'X' })).toBe(false)
      expect(draft.dirty).toBe(false)
    })
  })

  describe('upsert', () => {
    it('writes all three maps for a new conversation', () => {
      const draft = draftConversationMaps(makeMaps([]))

      draft.upsert('bob@example.com', { id: 'bob@example.com', name: 'Bob', type: 'chat' }, { unreadCount: 0 })
      const committed = draft.commit()

      expect(committed.conversationEntities?.get('bob@example.com')).toBeDefined()
      expect(committed.conversationMeta?.get('bob@example.com')).toBeDefined()
      expect(committed.conversations?.get('bob@example.com')).toEqual({
        id: 'bob@example.com',
        name: 'Bob',
        type: 'chat',
        unreadCount: 0,
      })
    })
  })

  describe('remove', () => {
    it('deletes from all three maps', () => {
      const draft = draftConversationMaps(makeMaps([['alice@example.com', ALICE_ENTITY, ALICE_META]]))

      draft.remove('alice@example.com')
      const committed = draft.commit()

      expect(committed.conversationEntities?.has('alice@example.com')).toBe(false)
      expect(committed.conversationMeta?.has('alice@example.com')).toBe(false)
      expect(committed.conversations?.has('alice@example.com')).toBe(false)
    })

    it('is a no-op for an unknown id', () => {
      const draft = draftConversationMaps(makeMaps([['alice@example.com', ALICE_ENTITY, ALICE_META]]))
      draft.remove('nobody@example.com')
      expect(draft.dirty).toBe(false)
      expect(draft.commit()).toEqual({})
    })
  })

  describe('copy-on-write', () => {
    it('never mutates the source maps', () => {
      const maps = makeMaps([['alice@example.com', ALICE_ENTITY, ALICE_META]])
      const draft = draftConversationMaps(maps)

      draft.patchMeta('alice@example.com', { unreadCount: 9 })
      draft.commit()

      expect(maps.conversationMeta.get('alice@example.com')?.unreadCount).toBe(0)
      expect(maps.conversations.get('alice@example.com')?.unreadCount).toBe(0)
    })

    it('returns an empty patch when nothing was written', () => {
      const draft = draftConversationMaps(makeMaps([['alice@example.com', ALICE_ENTITY, ALICE_META]]))
      expect(draft.commit()).toEqual({})
      expect(draft.dirty).toBe(false)
    })

    it('reads back its own uncommitted writes', () => {
      const draft = draftConversationMaps(makeMaps([['alice@example.com', ALICE_ENTITY, ALICE_META]]))

      draft.patchMeta('alice@example.com', { unreadCount: 1 })
      expect(draft.getMeta('alice@example.com')?.unreadCount).toBe(1)

      draft.patchMeta('alice@example.com', { unreadCount: 2 })
      expect(draft.commit().conversationMeta?.get('alice@example.com')?.unreadCount).toBe(2)
    })

    it('keeps other conversations untouched', () => {
      const maps = makeMaps([
        ['alice@example.com', ALICE_ENTITY, ALICE_META],
        ['bob@example.com', { id: 'bob@example.com', name: 'Bob', type: 'chat' }, { unreadCount: 3 }],
      ])
      const draft = draftConversationMaps(maps)

      draft.patchMeta('alice@example.com', { unreadCount: 1 })
      const committed = draft.commit()

      expect(committed.conversations?.get('bob@example.com')).toBe(maps.conversations.get('bob@example.com'))
      expectRebuildFidelity({ ...maps, ...committed })
    })
  })
})

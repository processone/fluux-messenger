/**
 * Rebuild fidelity for the `conversations` compat map.
 *
 * The map is no longer persisted: `deserializeState` rebuilds it from
 * `conversationEntities` + `conversationMeta` on every new-format load. That is
 * only safe while the LIVE map is nothing more than that same rebuild. A
 * conversation whose compat entry carries a field its metadata does not —
 * updated in one map and left stale in the other — keeps working until the next
 * launch, then silently loses the field.
 *
 * `shared/conversationMaps` makes that structural by deriving the compat entry
 * rather than patching it, and its own suite tests the derivation. What THIS
 * suite tests is that every write path actually goes through it: the matrix
 * below drives real store actions and asserts the invariant after each one, so
 * a future write site that reaches around the draft fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatStore } from './chatStore'
import type { Message, Conversation } from '../core/types/chat'
import { _resetStorageScopeForTesting } from '../utils/storageScope'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
    deleteConversationMessagesBefore: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesAround: vi.fn().mockResolvedValue([]),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    updateMessageReactions: vi.fn().mockResolvedValue(true),
  }
})

const CONV = 'alice@example.com'
const OTHER = 'bob@example.com'

const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime()

// Monotonic ids and timestamps, so preview-replacement rules ("is this newer?")
// resolve deterministically rather than on same-millisecond ties.
let clock = 0
function msg(conversationId: string, body: string, overrides: Partial<Message> = {}): Message {
  clock += 1000
  return {
    type: 'chat',
    id: `m${clock}`,
    conversationId,
    from: conversationId,
    body,
    timestamp: new Date(BASE_TIME + clock),
    isOutgoing: false,
    ...overrides,
  }
}

function conversation(id: string, name?: string): Conversation {
  return { id, name: name ?? id, type: 'chat', unreadCount: 0 }
}

/**
 * The invariant, stated exactly as `deserializeState` would apply it: the compat
 * map must equal the entity/meta merge for EVERY conversation, in both
 * directions. Containment is not enough — a field present in `conversations` and
 * stale in `conversationMeta` satisfies a subset check and still loses data on
 * the next reload.
 */
function expectRebuildFidelity(label: string): void {
  const { conversationEntities, conversationMeta, conversations } = chatStore.getState()

  const expected = new Map<string, Conversation>()
  for (const [id, entity] of conversationEntities) {
    const meta = conversationMeta.get(id)
    if (meta) expected.set(id, { ...entity, ...meta })
  }

  expect(
    { at: label, entries: Object.fromEntries(conversations) },
    `compat map drifted from entities+meta after: ${label}`
  ).toEqual({ at: label, entries: Object.fromEntries(expected) })
}

/** Fidelity must hold after the round-trip too, not only in memory. */
async function expectSurvivesReload(label: string): Promise<void> {
  const before = new Map(chatStore.getState().conversations)

  const persisted = localStorageMock._store['xmpp-chat-storage']
  expect(persisted, `nothing persisted at: ${label}`).toBeDefined()
  chatStore.setState({
    conversations: new Map(),
    conversationMeta: new Map(),
    conversationEntities: new Map(),
  })
  localStorageMock._store['xmpp-chat-storage'] = persisted
  await chatStore.persist.rehydrate()

  const after = chatStore.getState().conversations
  expect(after.size, `conversation count changed across reload at: ${label}`).toBe(before.size)
  for (const [id, conv] of before) {
    // Dates round-trip through JSON as ISO strings; compare the JSON shape.
    expect(JSON.parse(JSON.stringify(after.get(id))), `lost data across reload for ${id} at: ${label}`)
      .toEqual(JSON.parse(JSON.stringify(conv)))
  }
}

describe('conversations compat map stays a pure rebuild of entities + meta', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    chatStore.getState().reset()
    clock = 0
  })

  /**
   * Every mutating path that used to hand-mirror a `conversations` write. Each
   * case leaves the store in a state the invariant must hold over; they run in
   * sequence against one store so later cases also see earlier state.
   */
  const matrix: Array<{ name: string; run: () => void | Promise<void> }> = [
    {
      name: 'addConversation',
      run: () => {
        chatStore.getState().addConversation(conversation(CONV, 'Alice'))
        chatStore.getState().addConversation(conversation(OTHER, 'Bob'))
      },
    },
    {
      name: 'addConversation carrying a pending remote-displayed marker',
      run: () => {
        chatStore.getState().addConversation({
          ...conversation(CONV, 'Alice'),
          pendingRemoteDisplayedStanzaId: 'stanza-1',
        })
      },
    },
    {
      name: 'addMessage (incoming, updates preview + unread)',
      run: () => {
        chatStore.getState().addMessage(msg(CONV, 'first'))
        chatStore.getState().addMessage(msg(CONV, 'second'))
      },
    },
    {
      name: 'updateConversationName (entity-side write)',
      run: () => chatStore.getState().updateConversationName(CONV, 'Alice Renamed'),
    },
    {
      name: 'setActiveConversation (activation zeroes the count)',
      run: () => chatStore.getState().setActiveConversation(CONV),
    },
    {
      name: 'markAsRead',
      run: () => chatStore.getState().markAsRead(CONV),
    },
    {
      name: 'markReadToNewest',
      run: () => chatStore.getState().markReadToNewest(CONV),
    },
    {
      name: 'advanceReadPointer / markMessageSeen',
      run: () => {
        const messages = chatStore.getState().messages.get(CONV) ?? []
        if (messages.length > 0) chatStore.getState().advanceReadPointer(CONV, messages[messages.length - 1].id)
      },
    },
    {
      name: 'applyRemoteDisplayed with an unknown stanza-id (stashes pending)',
      run: () => chatStore.getState().applyRemoteDisplayed(CONV, 'not-loaded-yet'),
    },
    {
      name: 'applyRemoteDisplayed resolving a known stanza-id',
      run: () => {
        const stamped = msg(CONV, 'stamped', { stanzaId: 'srv-9' })
        chatStore.getState().addMessage(stamped)
        chatStore.getState().applyRemoteDisplayed(CONV, 'srv-9')
      },
    },
    {
      name: 'updateLastMessagePreview',
      run: () => chatStore.getState().updateLastMessagePreview(CONV, msg(CONV, 'newest preview')),
    },
    {
      name: 'refreshLastMessageContent (deferred-decrypt heal)',
      run: () => {
        const preview = chatStore.getState().conversationMeta.get(CONV)?.lastMessage
        if (preview) chatStore.getState().refreshLastMessageContent(CONV, preview.id, { body: 'decrypted' })
      },
    },
    {
      name: 'updateMessage on the preview message',
      run: () => {
        const preview = chatStore.getState().conversationMeta.get(CONV)?.lastMessage
        if (preview) chatStore.getState().updateMessage(CONV, preview.id, { body: 'edited' })
      },
    },
    {
      name: 'clearMessageStanzaId on the preview message',
      run: () => chatStore.getState().clearMessageStanzaId(CONV, 'srv-9'),
    },
    {
      name: 'removeMessage dropping the current preview',
      run: () => {
        const preview = chatStore.getState().conversationMeta.get(CONV)?.lastMessage
        if (preview) chatStore.getState().removeMessage(CONV, preview.id)
      },
    },
    {
      name: 'mergeMAMMessages (active conversation)',
      run: () => {
        chatStore.getState().mergeMAMMessages(
          CONV,
          [msg(CONV, 'archived-1'), msg(CONV, 'archived-2')],
          { first: 'a1', last: 'a2', count: 2 },
          true,
          'backward'
        )
      },
    },
    {
      name: 'mergeMAMMessages (backgrounded conversation)',
      run: () => {
        chatStore.getState().mergeMAMMessages(
          OTHER,
          [msg(OTHER, 'bg-1'), msg(OTHER, 'bg-2')],
          { first: 'b1', last: 'b2', count: 2 },
          true,
          'backward'
        )
      },
    },
    {
      name: 'mergeServerConversations (adds new, syncs archived)',
      run: () => {
        chatStore.getState().mergeServerConversations([
          { id: CONV, name: 'Alice', type: 'chat', archived: true },
          { id: 'carol@example.com', name: 'Carol', type: 'chat', archived: false },
        ])
      },
    },
    {
      name: 'recomputeUnreadForConversation',
      run: async () => {
        await chatStore.getState().recomputeUnreadForConversation(OTHER)
      },
    },
    {
      name: 'recordPendingRetraction',
      run: () => chatStore.getState().recordPendingRetraction(CONV, 'absent-target', CONV),
    },
    {
      name: 'setConversationHistoryFloor via re-add',
      run: () => chatStore.getState().addConversation(conversation(CONV, 'Alice Renamed')),
    },
    {
      name: 'deleteConversation',
      run: () => chatStore.getState().deleteConversation('carol@example.com'),
    },
  ]

  for (const { name, run } of matrix) {
    it(`holds after ${name}`, async () => {
      // Every case starts from a populated store so the write paths that
      // require an existing conversation actually execute.
      chatStore.getState().addConversation(conversation(CONV, 'Alice'))
      chatStore.getState().addConversation(conversation(OTHER, 'Bob'))
      chatStore.getState().addMessage(msg(CONV, 'seed'))
      chatStore.getState().addMessage(msg(OTHER, 'seed'))
      expectRebuildFidelity('setup')

      await run()

      expectRebuildFidelity(name)
    })
  }

  it('holds after the whole matrix runs in sequence, and survives a reload', async () => {
    for (const { name, run } of matrix) {
      await run()
      expectRebuildFidelity(name)
    }
    await expectSurvivesReload('full matrix')
  })

  /**
   * The invariant has a second half the merge check alone cannot see: an entry
   * present in `conversations` for a conversation with no entity (or no meta)
   * is dropped entirely by the rebuild. Asserting only over ids the rebuild
   * emits would never notice one.
   */
  it('never holds a compat entry the rebuild would not emit', () => {
    chatStore.getState().addConversation(conversation(CONV, 'Alice'))
    chatStore.getState().addMessage(msg(CONV, 'hello'))
    chatStore.getState().markAsRead(CONV)

    const { conversationEntities, conversationMeta, conversations } = chatStore.getState()
    for (const id of conversations.keys()) {
      expect(conversationEntities.has(id), `compat entry ${id} has no entity`).toBe(true)
      expect(conversationMeta.has(id), `compat entry ${id} has no metadata`).toBe(true)
    }
  })
})

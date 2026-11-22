import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { chatStore } from './chatStore'
import type { Message } from '../core/types'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import * as cache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { UNCONFIRMED_DELIVERY_ERROR } from '../utils/xmppError'
import { createMockClientWithSDKEvents, createMockStoreRefs } from '../core/test-utils'
import { createStoreBindings, type StoreRefs } from '../bindings/storeBindings'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const forward = <F extends (...args: never[]) => unknown>(fn: F) => fn as unknown as (...args: unknown[]) => ReturnType<F>

let holdSnapshot: (() => Promise<void>) | undefined
vi.mock('../utils/messageCache', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    getMessages: async (...args: Parameters<typeof actual.getMessages>) => {
      const rows = await forward(actual.getMessages)(...args)
      await holdSnapshot?.()
      return rows
    },
    getMessagesAround: async (...args: Parameters<typeof actual.getMessagesAround>) => {
      const rows = await forward(actual.getMessagesAround)(...args)
      await holdSnapshot?.()
      return rows
    },
  }
})

const CHAT = 'bob@example.com'
const lost = (overrides: Partial<Message> = {}): Message => ({
  type: 'chat', id: 'lost-1', stanzaId: undefined, originId: 'lost-1', conversationId: CHAT, from: 'alice@example.com',
  body: 'Private words', timestamp: new Date(1000), isOutgoing: true, ...overrides,
})
const serverError = { type: 'cancel' as const, condition: 'service-unavailable' }
const mark = () => chatStore.getState().markUnconfirmedDelivery(CHAT, 'lost-1')
const saved = () => cache.getMessage('chat', CHAT, 'lost-1')
const shown = () => chatStore.getState().messages.get(CHAT)?.find(row => row.id === 'lost-1')
/** Pause the next history read after it took its snapshot, until `release` runs. */
const pauseHydration = () => {
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let reachedSnapshot!: () => void
  const reached = new Promise<void>(resolve => { reachedSnapshot = resolve })
  holdSnapshot = async () => {
    holdSnapshot = undefined
    reachedSnapshot()
    await released
  }
  return { reached, release }
}

beforeEach(() => {
  holdSnapshot = undefined
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  _resetStorageScopeForTesting()
  setStorageScopeJid('alice@example.com')
  chatStore.getState().reset()
  chatStore.getState().addConversation({ id: CHAT, name: 'Bob', type: 'chat', unreadCount: 0 })
})
afterEach(() => { vi.restoreAllMocks(); holdSnapshot = undefined; cache._resetDBForTesting() })

describe('marking a message the server never confirmed', () => {
  it('marks a row that is only in the saved history, durably', async () => {
    await cache.saveMessages('chat', [lost()])

    await expect(mark()).resolves.toBe(true)

    expect((await saved())?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
    await chatStore.getState().loadMessagesFromCache(CHAT)
    expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
  })

  it('shows the mark on a row whose latest history load was already running', async () => {
    await cache.saveMessages('chat', [lost()])
    const { reached, release } = pauseHydration()
    const loading = chatStore.getState().loadMessagesFromCache(CHAT)
    await reached

    const marking = mark()
    release()
    await loading

    await expect(marking).resolves.toBe(true)
    expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
    expect((await saved())?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
  })

  it('shows the mark on a row whose load around a message was already running', async () => {
    await cache.saveMessages('chat', [lost()])
    const { reached, release } = pauseHydration()
    const loading = chatStore.getState().loadMessagesAroundFromCache(CHAT, { id: 'lost-1', originId: 'lost-1' })
    await reached

    const marking = mark()
    release()
    await loading

    await expect(marking).resolves.toBe(true)
    expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
  })

  it('leaves a saved row that has its archive id, and settles', async () => {
    await cache.saveMessages('chat', [lost({ stanzaId: 'archive-1' })])

    await expect(mark()).resolves.toBe(true)

    expect((await saved())?.deliveryError).toBeUndefined()
  })

  it('keeps an error the server returned on a saved row, and settles', async () => {
    await cache.saveMessages('chat', [lost({ deliveryError: serverError })])

    await expect(mark()).resolves.toBe(true)

    expect((await saved())?.deliveryError).toEqual(serverError)
  })

  it('does not overwrite a sidebar preview that already has its archive id', async () => {
    await cache.saveMessages('chat', [lost()])
    const meta = new Map(chatStore.getState().conversationMeta)
    meta.set(CHAT, { ...meta.get(CHAT)!, lastMessage: lost({ stanzaId: 'archive-1' }) })
    chatStore.setState({ conversationMeta: meta })

    await expect(mark()).resolves.toBe(true)

    expect((await saved())?.deliveryError).toBeUndefined()
    expect(chatStore.getState().conversationMeta.get(CHAT)?.lastMessage?.deliveryError).toBeUndefined()
  })

  it('reports false when the saved row could not be updated, so the mark is tried again', async () => {
    await cache.saveMessages('chat', [lost()])
    vi.spyOn(cache, 'updateChatMessageIf').mockResolvedValue('failed')

    await expect(mark()).resolves.toBe(false)

    expect((await saved())?.deliveryError).toBeUndefined()
  })

  it('settles when no copy of the message exists', async () => {
    await expect(mark()).resolves.toBe(true)
  })

  it('saves a resident row that was never written, with its mark', async () => {
    chatStore.setState({ messages: new Map([[CHAT, [lost()]]]) })

    await expect(mark()).resolves.toBe(true)

    expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
    expect((await saved())?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
    chatStore.setState({ messages: new Map() })
    await chatStore.getState().loadMessagesFromCache(CHAT)
    expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
  })

  it('saves a sidebar preview that is the only copy, with its mark', async () => {
    const meta = new Map(chatStore.getState().conversationMeta)
    meta.set(CHAT, { ...meta.get(CHAT)!, lastMessage: lost() })
    chatStore.setState({ conversationMeta: meta })

    await expect(mark()).resolves.toBe(true)

    expect((await saved())?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
  })

  it('keeps the record when the only copy cannot be saved, and still shows the mark', async () => {
    chatStore.setState({ messages: new Map([[CHAT, [lost()]]]) })
    vi.spyOn(cache, 'updateChatMessageIf').mockResolvedValue('failed')

    await expect(mark()).resolves.toBe(false)

    expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
  })

  it('does not write a message meant to stay out of history', async () => {
    chatStore.setState({ messages: new Map([[CHAT, [{ ...lost(), noLocalStore: true } as Message]]]) })

    await expect(mark()).resolves.toBe(true)

    expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
    expect(await saved()).toBeNull()
  })

  /** Run `arrive` after the store has checked its copies and just before the guarded history write. */
  const justBeforeWrite = (arrive: () => Promise<unknown>) => {
    const write = cache.updateChatMessageIf
    vi.spyOn(cache, 'updateChatMessageIf').mockImplementation(async (...args) => {
      await arrive()
      return write(...args)
    })
  }

  it('does not replace a server error committed just before the write', async () => {
    await cache.saveMessages('chat', [lost()])
    justBeforeWrite(() => cache.updateMessage('chat', CHAT, 'lost-1', { deliveryError: serverError }, lost().from))

    await expect(mark()).resolves.toBe(true)

    expect((await saved())?.deliveryError).toEqual(serverError)
  })

  it('does not mark an archived copy committed just before the write', async () => {
    await cache.saveMessages('chat', [lost()])
    justBeforeWrite(() => cache.saveMessages('chat', [lost({ stanzaId: 'archive-1' })]))

    await expect(mark()).resolves.toBe(true)

    const row = await saved()
    expect(row?.stanzaId).toBe('archive-1')
    expect(row?.deliveryError).toBeUndefined()
  })

  it('a Retry pressed while the mark is being written wins, in the row and in history', async () => {
    await cache.saveMessages('chat', [lost({ deliveryError: UNCONFIRMED_DELIVERY_ERROR })])
    await chatStore.getState().loadMessagesFromCache(CHAT)
    const write = cache.updateChatMessageIf
    vi.spyOn(cache, 'updateChatMessageIf').mockImplementation(async (...args) => {
      const written = await write(...args)
      chatStore.getState().updateMessage(CHAT, 'lost-1', { deliveryError: undefined })
      return written
    })

    await mark()

    await vi.waitFor(async () => expect((await saved())?.deliveryError).toBeUndefined())
    expect(shown()?.deliveryError).toBeUndefined()
  })

  describe('through the SDK error binding', () => {
    let unbind: () => void
    let client: ReturnType<typeof createMockClientWithSDKEvents>
    beforeEach(() => {
      client = createMockClientWithSDKEvents()
      unbind = createStoreBindings(client, () => ({
        ...createMockStoreRefs(), chat: chatStore.getState(),
      }) as unknown as StoreRefs)
    })
    afterEach(() => unbind())
    const report = (onSettled: (settled: boolean) => void) =>
      client.emit('chat:message-unconfirmed', { conversationId: CHAT, messageId: 'lost-1', onSettled })
    const serverRejects = () =>
      client.emit('chat:message-error', { conversationId: CHAT, messageId: 'lost-1', error: serverError })

    it('keeps a queued mark when the error cannot reach a row that is only in saved history', async () => {
      await cache.saveMessages('chat', [lost()])
      const { reached, release } = pauseHydration()
      const loading = chatStore.getState().loadMessagesFromCache(CHAT)
      await reached
      const onSettled = vi.fn()

      report(onSettled)
      serverRejects()
      release()
      await loading

      await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(true))
      expect((await saved())?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
      expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
    })

    it('lets the error replace a queued mark when it reaches the displayed row', async () => {
      await cache.saveMessages('chat', [lost()])
      await chatStore.getState().loadMessagesFromCache(CHAT)
      const { reached, release } = pauseHydration()
      const loading = chatStore.getState().loadMessagesFromCache(CHAT)
      await reached
      const onSettled = vi.fn()

      report(onSettled)
      serverRejects()
      release()
      await loading

      await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(true))
      await vi.waitFor(async () => expect((await saved())?.deliveryError).toEqual(serverError))
      expect(shown()?.deliveryError).toEqual(serverError)
    })
  })

  it('a Retry cancels a mark queued behind a history load', async () => {
    await cache.saveMessages('chat', [lost({ deliveryError: UNCONFIRMED_DELIVERY_ERROR })])
    await chatStore.getState().loadMessagesFromCache(CHAT)
    const { reached, release } = pauseHydration()
    const loading = chatStore.getState().loadMessagesFromCache(CHAT)
    await reached
    const marking = mark()

    chatStore.getState().updateMessage(CHAT, 'lost-1', { deliveryError: undefined })
    release()
    await loading

    await expect(marking).resolves.toBe(true)
    await vi.waitFor(async () => expect((await saved())?.deliveryError).toBeUndefined())
    expect(shown()?.deliveryError).toBeUndefined()
    await chatStore.getState().loadMessagesFromCache(CHAT)
    expect(shown()?.deliveryError).toBeUndefined()
  })
})

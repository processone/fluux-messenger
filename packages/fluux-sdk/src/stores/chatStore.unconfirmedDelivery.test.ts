import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { chatStore } from './chatStore'
import type { Message } from '../core/types'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import * as cache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { UNCONFIRMED_DELIVERY_ERROR } from '../utils/xmppError'

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

  it('reports false when the saved row was not updated, so the mark is tried again', async () => {
    await cache.saveMessages('chat', [lost()])
    vi.spyOn(cache, 'updateMessage').mockResolvedValue(undefined)

    await expect(mark()).resolves.toBe(false)

    expect((await saved())?.deliveryError).toBeUndefined()
  })

  it('settles when no copy of the message exists', async () => {
    await expect(mark()).resolves.toBe(true)
  })

  it('reports false when the history cannot be read', async () => {
    vi.spyOn(cache, 'getMessage').mockResolvedValue(null)
    vi.spyOn(cache, 'readMessages').mockResolvedValue({ status: 'unavailable' })

    await expect(mark()).resolves.toBe(false)
  })

  it('marks a resident row that was not saved yet', async () => {
    chatStore.getState().addMessage(lost())
    vi.spyOn(cache, 'getMessage').mockResolvedValue(null)

    await expect(mark()).resolves.toBe(true)

    expect(shown()?.deliveryError).toEqual(UNCONFIRMED_DELIVERY_ERROR)
  })
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../core/types'
import * as cache from './messageCache'
import { _resetStorageScopeForTesting } from './storageScope'

// Intent: search backfill and rebuild read the archive a page at a time instead of
// loading every cached message at once, without skipping or repeating a row.

const ROOM = 'busy@conference.example.test'
const CHAT = 'friend@example.test'

const room = (i: number): RoomMessage => ({
  type: 'groupchat', roomJid: ROOM, from: `${ROOM}/n${i % 7}`, nick: `n${i % 7}`, id: `r-${i}`, originId: undefined,
  stanzaId: `rs-${i}`, occupantId: `o${i % 7}`, timestamp: new Date(1700000000000 + i * 1000),
  isOutgoing: false, body: `room message ${i}`,
})
const chat = (i: number): Message => ({
  type: 'chat', id: `c-${i}`, originId: undefined, conversationId: CHAT, from: CHAT, stanzaId: `cs-${i}`,
  timestamp: new Date(1700000000000 + i * 1000), isOutgoing: false, body: `chat message ${i}`,
})

beforeEach(() => {
  _resetStorageScopeForTesting()
  cache._resetDBForTesting()
  globalThis.indexedDB = new IDBFactory()
})
afterEach(() => vi.restoreAllMocks())

it('visits every cached room message once, in pages no larger than the batch size', async () => {
  await cache.saveMessages('room', Array.from({ length: 23 }, (_, i) => room(i)))
  const pages: string[][] = []
  await cache.iterateAllMessages('room', 10, async (batch) => { pages.push(batch.map(m => m.id)) })
  expect(pages.map(p => p.length)).toEqual([10, 10, 3])
  const seen = pages.flat()
  expect(new Set(seen).size).toBe(23)
  expect(seen.sort()).toEqual(Array.from({ length: 23 }, (_, i) => `r-${i}`).sort())
})

it('visits every cached chat message once and handles an exact multiple of the page size', async () => {
  await cache.saveMessages('chat', Array.from({ length: 20 }, (_, i) => chat(i)))
  const sizes: number[] = []
  const seen: string[] = []
  await cache.iterateAllMessages('chat', 10, async (batch) => { sizes.push(batch.length); seen.push(...batch.map(m => m.id)) })
  expect(sizes).toEqual([10, 10])
  expect(new Set(seen).size).toBe(20)
})

it('calls back nothing for an empty archive, and asks the store for one page per read', async () => {
  const onBatch = vi.fn(async () => {})
  await cache.iterateAllMessages('chat', 10, onBatch)
  await cache.iterateAllMessages('room', 10, onBatch)
  expect(onBatch).not.toHaveBeenCalled()

  await cache.saveMessages('room', Array.from({ length: 25 }, (_, i) => room(i)))
  const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll')
  await cache.iterateAllMessages('room', 10, async () => {})
  expect(getAll.mock.calls.length).toBeGreaterThan(0)
  expect(getAll.mock.calls.every(([, count]) => count === 10)).toBe(true)
})

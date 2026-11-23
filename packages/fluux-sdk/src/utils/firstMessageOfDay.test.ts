import { describe, it, expect, vi, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../core/types'
import { _resetStorageScopeForTesting } from './storageScope'
// Must import after fake-indexeddb/auto
import * as messageCache from './messageCache'
import { findFirstMessageOfDay, type DayArchive } from './firstMessageOfDay'

const PEER = 'alice@example.com'
const ROOM = 'team@conference.example.com'
// A local day as the dialog builds it: midnight to midnight in the reader's time zone
const START = new Date(2024, 2, 10)
const END = new Date(2024, 2, 11)
const at = (day: number, hour: number) => new Date(2024, 2, day, hour)

const chat = (id: string, timestamp: Date): Message => ({
  type: 'chat', id, stanzaId: undefined, originId: undefined, conversationId: PEER, from: PEER, body: id, timestamp, isOutgoing: false,
})
const room = (id: string, timestamp: Date): RoomMessage => ({
  type: 'groupchat', id, stanzaId: undefined, originId: undefined, occupantId: undefined, roomJid: ROOM, from: `${ROOM}/bob`, nick: 'bob', body: id, timestamp, isOutgoing: false,
})

function archiveWith(messages: Array<Message | RoomMessage>, complete = false) {
  const page = { messages, complete, page: {} }
  return {
    queryMAM: vi.fn(async () => page as never),
    queryRoomMAM: vi.fn(async () => page as never),
  } satisfies DayArchive
}

// Intent: jumping to a date lands on the day's first message, from the cache when it
// covers the start of that day, otherwise from the archive page that starts there.
describe('findFirstMessageOfDay', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    messageCache._resetDBForTesting()
  })

  it('checks the archive before a cached day even when an older cache block exists', async () => {
    await messageCache.saveMessage('chat', chat('older-block', at(9, 22)))
    await messageCache.saveMessage('chat', chat('cached-later', at(10, 9)))
    const archive = archiveWith([chat('midnight', START)])

    const result = await findFirstMessageOfDay(archive, 'chat', PEER, START, END)

    expect(result).toMatchObject({ kind: 'found', source: 'archive', message: { id: 'midnight' } })
    expect(archive.queryMAM).toHaveBeenCalledTimes(1)
  })

  it('asks the archive forward from the day start when the cache does not reach before it', async () => {
    await messageCache.saveMessage('chat', chat('cached-later', at(10, 15)))
    const archive = archiveWith([chat('archived-first', at(10, 8)), chat('archived-next', at(10, 9))])

    const result = await findFirstMessageOfDay(archive, 'chat', PEER, START, END)

    expect(result).toMatchObject({ kind: 'found', source: 'archive', message: { id: 'archived-first' } })
    expect(archive.queryMAM).toHaveBeenCalledWith(expect.objectContaining({
      with: PEER, start: START.toISOString(), end: END.toISOString(), dateLookup: true,
    }))
  })

  it('asks the room archive for a room', async () => {
    const archive = archiveWith([room('r1', at(10, 11))])

    const result = await findFirstMessageOfDay(archive, 'room', ROOM, START, END)

    expect(result).toMatchObject({ kind: 'found', source: 'archive', message: { id: 'r1' } })
    expect(archive.queryRoomMAM).toHaveBeenCalledWith(expect.objectContaining({ roomJid: ROOM, start: START.toISOString(), end: END.toISOString(), dateLookup: true }))
  })

  it('returns the first later message when the day is empty', async () => {
    await messageCache.saveMessage('chat', chat('before', at(9, 22)))
    const archive = archiveWith([chat('two-days-later', at(12, 10))])
    archive.queryMAM.mockResolvedValueOnce({ messages: [], complete: true, page: {} } as never)

    const result = await findFirstMessageOfDay(archive, 'chat', PEER, START, END)

    expect(result).toMatchObject({ kind: 'found', message: { id: 'two-days-later' } })
    expect(archive.queryMAM).toHaveBeenCalledTimes(2)
    expect(archive.queryMAM).toHaveBeenLastCalledWith(expect.objectContaining({ start: END.toISOString() }))
    expect(archive.queryMAM.mock.lastCall).toEqual([expect.not.objectContaining({ end: expect.anything() })])
  })

  it('uses the next midnight returned by the bounded request without a second query', async () => {
    const archive = archiveWith([chat('next-midnight', END)])
    expect(await findFirstMessageOfDay(archive, 'chat', PEER, START, END))
      .toMatchObject({ kind: 'found', message: { id: 'next-midnight' } })
    expect(archive.queryMAM).toHaveBeenCalledTimes(1)
  })

  it('does not look past an incomplete day page with no displayable messages', async () => {
    const archive = archiveWith([])
    expect(await findFirstMessageOfDay(archive, 'chat', PEER, START, END)).toEqual({ kind: 'unknown' })
    expect(archive.queryMAM).toHaveBeenCalledTimes(1)
  })

  it.each(['failure', 'incomplete'])('does not claim the selected day empty after an archive %s', async (outcome) => {
    await messageCache.saveMessage('chat', chat('later-cached', at(12, 10)))
    const archive = archiveWith([])
    if (outcome === 'failure') archive.queryMAM.mockRejectedValueOnce(new Error('timeout'))
    expect(await findFirstMessageOfDay(archive, 'chat', PEER, START, END)).toEqual({ kind: 'unknown' })
    expect(archive.queryMAM).toHaveBeenCalledTimes(1)
  })

  it('uses local history for a room with no archive', async () => {
    await messageCache.saveMessage('room', room('same-day', START))
    expect(await findFirstMessageOfDay(undefined, 'room', ROOM, START, END))
      .toMatchObject({ kind: 'found', source: 'cache', message: { id: 'same-day' } })
  })

  it('checks the archive when the loaded and cached rows straddle a recorded gap', async () => {
    const loaded = [chat('before', at(9, 22)), chat('held', at(10, 12))]
    for (const message of loaded) await messageCache.saveMessage('chat', message)
    const gaps = [{ start: at(9, 22).getTime(), end: at(10, 12).getTime() }]
    const archive = archiveWith([chat('inside-gap', at(10, 8))])
    expect(await findFirstMessageOfDay(archive, 'chat', PEER, START, END, loaded, gaps))
      .toMatchObject({ kind: 'found', source: 'archive', message: { id: 'inside-gap' } })
    archive.queryMAM.mockRejectedValueOnce(new Error('timeout'))
    expect(await findFirstMessageOfDay(archive, 'chat', PEER, START, END, loaded, gaps)).toEqual({ kind: 'unknown' })
  })

  it('keeps a cached message the archive does not hold when it comes first', async () => {
    await messageCache.saveMessage('chat', chat('local-only', at(10, 7)))
    const archive = archiveWith([chat('archived', at(10, 8))])

    const result = await findFirstMessageOfDay(archive, 'chat', PEER, START, END)

    expect(result).toMatchObject({ kind: 'found', source: 'cache', message: { id: 'local-only' } })
  })

  it('says none when the archive is complete and holds nothing after the start', async () => {
    const result = await findFirstMessageOfDay(archiveWith([], true), 'chat', PEER, START, END)

    expect(result).toEqual({ kind: 'none' })
  })

  it('says unknown when the archive fails and the cache has nothing', async () => {
    const archive = archiveWith([])
    archive.queryMAM.mockRejectedValueOnce(new Error('timeout'))

    expect(await findFirstMessageOfDay(archive, 'chat', PEER, START, END)).toEqual({ kind: 'unknown' })
  })

  it('falls back to the cache when the archive fails', async () => {
    await messageCache.saveMessage('chat', chat('cached', at(10, 15)))
    const archive = archiveWith([])
    archive.queryMAM.mockRejectedValueOnce(new Error('timeout'))

    const result = await findFirstMessageOfDay(archive, 'chat', PEER, START, END)

    expect(result).toMatchObject({ kind: 'found', source: 'cache', message: { id: 'cached' } })
  })

  // Captain's bug: Today and A week ago said "no messages" while the conversation showed
  // today's messages. The loaded window now answers before the cache and the archive.
  describe('with the window loaded on screen', () => {
    const TODAY = new Date(2026, 10, 23)
    const TOMORROW = new Date(2026, 10, 24)
    const WEEK_AGO = new Date(2026, 10, 16)
    const loaded = [chat('last-week', new Date(2026, 10, 16, 9)), chat('yesterday', new Date(2026, 10, 22, 18)),
      chat('today-1', new Date(2026, 10, 23, 8)), chat('today-2', new Date(2026, 10, 23, 9))]

    it('lands on the first message of today from the loaded window, without the cache or the archive', async () => {
      const archive = archiveWith([], true)
      const result = await findFirstMessageOfDay(archive, 'chat', PEER, TODAY, TOMORROW, loaded)
      expect(result).toMatchObject({ kind: 'found', source: 'resident', message: { id: 'today-1' } })
      expect(archive.queryMAM).not.toHaveBeenCalled()
    })

    it('finds today in the window even when the cache and the archive return nothing', async () => {
      const result = await findFirstMessageOfDay(archiveWith([], true), 'chat', PEER, TODAY, TOMORROW, loaded.slice(2))
      expect(result).toMatchObject({ kind: 'found', message: { id: 'today-1' } })
    })

    it('says none for today when nothing was sent today', async () => {
      const result = await findFirstMessageOfDay(archiveWith([], true), 'chat', PEER, TODAY, TOMORROW, loaded.slice(0, 2))
      expect(result).toEqual({ kind: 'none' })
    })

    it('lands a week ago on that day when it has messages, and on the next day when it has none', async () => {
      expect(await findFirstMessageOfDay(archiveWith([], true), 'chat', PEER, WEEK_AGO, new Date(2026, 10, 17), [chat('older', new Date(2026, 10, 1)), ...loaded]))
        .toMatchObject({ kind: 'found', source: 'resident', message: { id: 'last-week' } })
      expect(await findFirstMessageOfDay(archiveWith([], true), 'chat', PEER, new Date(2026, 10, 18), new Date(2026, 10, 19), loaded))
        .toMatchObject({ kind: 'found', message: { id: 'yesterday' } })
    })

    it('asks the archive when the day starts before the loaded window, and keeps the earlier answer', async () => {
      const archive = archiveWith([chat('server-only', new Date(2026, 10, 16, 7))])
      const result = await findFirstMessageOfDay(archive, 'chat', PEER, WEEK_AGO, new Date(2026, 10, 17), loaded)
      expect(result).toMatchObject({ kind: 'found', source: 'archive', message: { id: 'server-only' } })
    })

    it('uses the loaded window of a room the same way', async () => {
      const roomLoaded = [room('r-old', new Date(2026, 10, 22, 10)), room('r-today', new Date(2026, 10, 23, 11))]
      const archive = archiveWith([], true)
      expect(await findFirstMessageOfDay(archive, 'room', ROOM, TODAY, TOMORROW, roomLoaded))
        .toMatchObject({ kind: 'found', source: 'resident', message: { id: 'r-today' } })
      expect(archive.queryRoomMAM).not.toHaveBeenCalled()
    })
  })
})

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RoomMessage } from '../core/types'
import * as cache from './messageCache'
import { messageRowRef } from './messageIdentity'
import { backfillRoomStanzaId } from './roomStanzaId'
import { setStorageScopeJid } from './storageScope'
import { sortMessagesByTimestamp } from '../stores/shared/messageArrayUtils'
const ROOM = 'window@conference.example.com'
const ACCOUNT = 'reader@example.com'
function row(index: number, fields: Partial<RoomMessage> = {}): RoomMessage {
  const message: RoomMessage = { type: 'groupchat', roomJid: ROOM, from: ROOM + '/Peer', nick: 'Peer', occupantId: 'peer',
    id: 'shared', stanzaId: `archive-${String(index).padStart(3, '0')}`, body: `Body ${index}`, timestamp: new Date(1000), isOutgoing: false, ...fields }
  return { ...message }
}
beforeEach(() => { cache._resetDBForTesting(); globalThis.indexedDB = new IDBFactory(); setStorageScopeJid(ACCOUNT) })
afterEach(() => { vi.restoreAllMocks(); cache._resetDBForTesting(); setStorageScopeJid(null) })
it.each([false, true])('returns only the exact anchor for a zero-sized window (uncertain=%s)', async uncertain => {
  const a = uncertain ? { ...row(0) } : row(0)
  const b = uncertain ? row(0, { stanzaId: 'other-archive', body: 'Distinct B' }) : row(1)
  await cache.saveRoomMessages([b, a])
  for (const target of [a,b]) expect(await cache.getRoomMessagesAround(ROOM, messageRowRef(target), { before: 0, after: 0 })).toMatchObject([target])
})
it('orders full tied boundary groups without scanning unrelated room history', async () => {
  const sameTime = Array.from({ length: 125 }, (_, index) => row(index))
  const older = Array.from({ length: 5 }, (_, index) => row(index + 200, { timestamp: new Date(500) }))
  const newer = Array.from({ length: 5 }, (_, index) => row(index + 300, { timestamp: new Date(1500) }))
  await cache.saveRoomMessages([...sameTime].reverse().concat(older,newer))
  await cache.saveRoomMessages([row(1, {roomJid:'other@conference.example.com',from:'other@conference.example.com/Peer'})])
  const scans = vi.spyOn(IDBObjectStore.prototype, 'getAll')
  const sorted = sortMessagesByTimestamp([...older,...sameTime,...newer], 'room')
  const anchor = sameTime[2]
  const index = sorted.findIndex(message => message.stanzaId === anchor.stanzaId)
  expect(await cache.getRoomMessagesAround(ROOM, messageRowRef(anchor))).toMatchObject(sorted.slice(Math.max(0,index-50)))
  for (const [target,before,after] of [[sameTime[2],4,3],[sameTime[122],3,4],[older[3],2,3],[newer[1],3,2]] as const) {
    const i = sorted.findIndex(message => message.stanzaId === target.stanzaId)
    expect(await cache.getRoomMessagesAround(ROOM, messageRowRef(target), {before,after})).toMatchObject(sorted.slice(Math.max(0,i-before),i+after+1))
  }
  expect(scans).not.toHaveBeenCalled()
  setStorageScopeJid('other@example.com')
  expect(await cache.getRoomMessagesAround(ROOM, messageRowRef(anchor))).toMatchObject([])
})
it('keeps old and flagged validated aliases as exact window anchors', async () => {
  const legacy = {...row(0),stanzaId:'foreign',}
  const confirmed = backfillRoomStanzaId(legacy,row(1,{body:legacy.body}))
  await cache.saveRoomMessages([confirmed,row(2)])
  for (const ref of [messageRowRef(legacy),{id:legacy.id,occupantId:legacy.occupantId,stanzaId:legacy.stanzaId}]) {
    expect(await cache.getRoomMessagesAround(ROOM,ref,{before:0,after:0})).toMatchObject([confirmed])
  }
})

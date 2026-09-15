import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { RoomMessage } from '../core/types/room'
import { getRoomModerationId, roomStanzaIdsMergeable } from './roomStanzaId'
import { roomRetractionAuthorized } from './moderation'
import { findMessageRowIndex, messageRowRef, sameMessageRow } from './messageIdentity'
import { makeReadPointer, pointerRowRef } from '../stores/shared/readPointer'
import { getRoomMessage, saveRoomMessage, clearAllMessages, _resetDBForTesting } from './messageCache'
import { setStorageScopeJid } from './storageScope'

const roomJid = 'room@conference.example.com'
const message: RoomMessage = {
  type: 'groupchat', roomJid, from: `${roomJid}/Peer `, nick: 'Peer ',
  id: 'client-id', stanzaId: 'room-id', occupantId: 'peer',
  body: 'Cached message', timestamp: new Date(1000), isOutgoing: false,
}

beforeEach(async () => { setStorageScopeJid(null); await clearAllMessages() })
afterEach(() => { _resetDBForTesting(); setStorageScopeJid(null) })

it('moderates an existing cached room message without additional identity metadata', async () => {
  await saveRoomMessage(message)
  const cached = (await getRoomMessage(roomJid, message.id, message.from))!
  expect(getRoomModerationId(cached)).toBe('room-id')
  expect(roomRetractionAuthorized(cached, {
    actorJid: roomJid, targetId: 'room-id', moderation: { isModerated: true, moderationReason: 'Spam' },
  })).toBe(true)
  expect(roomRetractionAuthorized(cached, {
    actorJid: 'other@conference.example.com', targetId: 'room-id', moderation: { isModerated: true },
  })).toBe(false)
})

it('does not substitute a client ID or accept a different room as the sender', () => {
  expect(getRoomModerationId({ ...message, stanzaId: undefined })).toBeUndefined()
  expect(getRoomModerationId({ ...message, from: 'other@conference.example.com/Peer' })).toBeUndefined()
})

it('does not merge different room-assigned IDs even when sender and client ID agree', () => {
  expect(roomStanzaIdsMergeable(message, { ...message, stanzaId: 'other-room-id' })).toBe(false)
  expect(roomStanzaIdsMergeable(message, { ...message, roomJid: 'other@example.com' })).toBe(false)
})

it.each([true, false])('restores an old reference with unconfirmed=%s to the same room message', unconfirmed => {
  const current = messageRowRef(message)
  const old = { ...current, unconfirmed }
  expect(findMessageRowIndex([message], old)).toBe(0)
  expect(sameMessageRow(current, old)).toBe(true)
  expect(findMessageRowIndex([{ ...message, stanzaId: 'different' }], old)).toBe(-1)
  const pointer = makeReadPointer(message, 'room')
  expect(findMessageRowIndex([message], pointerRowRef(pointer))).toBe(0)
})

it('ignores obsolete metadata when reading and writing room messages', async () => {
  const old = { ...message, stanzaIdAuthority: { stanzaId: 'stale', roomJid: 'old@example.com' } }
  await saveRoomMessage(old)
  const cached = (await getRoomMessage(roomJid, message.id, message.from))!
  expect(cached).not.toHaveProperty('stanzaIdAuthority')
  expect(getRoomModerationId(cached)).toBe(message.stanzaId)
})

it('reads an old raw cache record without trusting or exposing its obsolete metadata', async () => {
  await saveRoomMessage(message)
  const db = await openDB('fluux-message-cache')
  const [record] = await db.getAll('room-messages-canonical')
  await db.put('room-messages-canonical', { ...record,
    stanzaIdAuthority: { stanzaId: 'stale', roomJid: 'other@example.com', accountJid: 'old@example.com' } })
  const cached = (await getRoomMessage(roomJid, message.id, message.from))!
  expect(cached).not.toHaveProperty('stanzaIdAuthority')
  expect(getRoomModerationId(cached)).toBe(message.stanzaId)
  await saveRoomMessage(cached)
  expect((await db.getAll('room-messages-canonical'))[0]).not.toHaveProperty('stanzaIdAuthority')
  db.close()
})

it('preserves a cached occurrence with no room ID when its client ID is reused', () => {
  const legacy = { ...message, stanzaId: undefined }
  expect(roomStanzaIdsMergeable(legacy, { ...message, timestamp: new Date(2000) })).toBe(false)
  expect(roomStanzaIdsMergeable(legacy, { ...message, body: 'Different message' })).toBe(false)
  expect(getRoomModerationId(legacy)).toBeUndefined()
})

import { describe, expect, it } from 'vitest'
import { findMessageRowIndex, isMessageRow, messageRowRef, sameMessageRow } from './messageIdentity'
import { roomStanzaIdAuthority, backfillRoomStanzaId, type RowIdentityFields } from './roomStanzaId'
import { makeReadPointer, pointerRowRef } from '../stores/shared/readPointer'

describe('archive-qualified row references', () => {
  it.each([undefined, 'same-occupant'])('distinguishes reused client IDs with occupant %s', occupantId => {
    const first = { id: 'reused', occupantId, stanzaId: 'archive-first' }
    const second = { ...first, stanzaId: 'archive-second' }
    const ref = messageRowRef(second)
    expect(ref.stanzaId).toBe(second.stanzaId)
    expect(findMessageRowIndex([first, second], ref)).toBe(1)
    expect(findMessageRowIndex([first], ref)).toBe(-1)
    expect(findMessageRowIndex([{ id: first.id, occupantId }], ref)).toBe(-1)
    expect(isMessageRow(first, ref)).toBe(false)
    expect(isMessageRow(second, ref)).toBe(true)
    expect(sameMessageRow(messageRowRef(first), ref)).toBe(false)
    expect(sameMessageRow(messageRowRef(second), ref)).toBe(true)
    expect(findMessageRowIndex([first, second], { id: 'reused', occupantId })).toBe(0)
    expect(findMessageRowIndex([second], { ...ref, id: second.stanzaId })).toBe(-1)
  })

  it('resolves an addressable read pointer to its exact row after a client ID is reused', () => {
    const first = { type: 'groupchat' as const, roomJid: 'room@example.com', from: 'room@example.com/Peer',
      nick: 'Peer', id: 'reused', occupantId: 'peer', stanzaId: 'first', body: 'First',
      timestamp: new Date(1000), isOutgoing: false }
    const second = { ...first, stanzaId: 'second', body: 'Second', timestamp: new Date(2000) }
    const pointer = makeReadPointer(second, 'room')
    expect(findMessageRowIndex([first, second], pointerRowRef(pointer))).toBe(1)
  })
})

describe('uncertain room row references', () => {
  it.each(['body', 'timestamp'])('separates the same raw IDs when %s differs', difference => {
    const legacy: RowIdentityFields & { from: string; roomJid: string; body: string; timestamp: Date } = { roomJid: 'room@example.com',
      from: 'room@example.com/Peer',
      id: 'reused', occupantId: 'peer', stanzaId: 'same', body: 'First', timestamp: new Date(1000) }
    const later = { ...legacy, ...(difference === 'body' ? { body: 'Second' } : { timestamp: new Date(2000) }) }
    const confirmed = { ...later, stanzaIdAuthority: roomStanzaIdAuthority(later, null) }
    const a = messageRowRef(legacy)
    const b = messageRowRef(confirmed)
    expect(sameMessageRow(a, b)).toBe(false)
    expect(findMessageRowIndex([legacy, confirmed], a)).toBe(0)
    expect(findMessageRowIndex([legacy, confirmed], b)).toBe(1)
    expect(findMessageRowIndex([confirmed], a)).toBe(-1)
    expect(findMessageRowIndex([legacy], b)).toBe(-1)
    expect(isMessageRow(confirmed, a)).toBe(false)
    expect(isMessageRow(legacy, b)).toBe(false)
    expect(findMessageRowIndex([legacy, confirmed], { id: legacy.id, stanzaId: legacy.stanzaId })).toBe(0)
    const replay = { ...legacy, stanzaIdAuthority: roomStanzaIdAuthority(legacy, null) }
    const merged = backfillRoomStanzaId(legacy, replay)
    expect(findMessageRowIndex([merged], a)).toBe(0)
    expect(merged.localRowRef).toEqual(a)
  })
})

it('restores pre-discriminator references only through a validated local alias', () => {
  const legacy: RowIdentityFields & { from: string; roomJid: string; timestamp: Date; body: string } = {
    id: 'client', from: 'room@example.com/Peer', roomJid: 'room@example.com', occupantId: 'peer',
    stanzaId: 'foreign', timestamp: new Date(1000), body: 'Same original content' }
  const saved = { id: legacy.id, occupantId: legacy.occupantId, stanzaId: legacy.stanzaId }
  const replay = { ...legacy, stanzaId: 'actual' }
  const merged = backfillRoomStanzaId(legacy, { ...replay, stanzaIdAuthority: roomStanzaIdAuthority(replay, null) })
  expect(findMessageRowIndex([legacy], saved)).toBe(0)
  expect(findMessageRowIndex([merged], saved)).toBe(0)
  expect(isMessageRow(merged, saved)).toBe(true)
  expect(findMessageRowIndex([merged], { ...saved, unconfirmed: true })).toBe(0)
  expect(findMessageRowIndex([merged], { ...saved, unconfirmed: false })).toBe(-1)
  expect(isMessageRow(merged, { ...saved, unconfirmed: false })).toBe(false)
  expect(sameMessageRow({ ...saved, unconfirmed: true }, { ...saved, unconfirmed: false })).toBe(false)
  expect(findMessageRowIndex([{ ...replay, stanzaId: 'survivor' }], saved)).toBe(-1)
})

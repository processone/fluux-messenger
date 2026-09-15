import { describe, expect, it } from 'vitest'
import { findMessageRowIndex, isMessageRow, messageRowRef, sameMessageRow } from './messageIdentity'
import { backfillRoomStanzaId, type RowIdentityFields } from './roomStanzaId'
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

describe('legacy room row references', () => {
  it.each([true, false])('ignores the obsolete unconfirmed=%s discriminator', unconfirmed => {
    const message: RowIdentityFields = { roomJid: 'room@example.com', from: 'room@example.com/Peer',
      id: 'client', occupantId: 'peer', stanzaId: 'archive' }
    const saved = { ...messageRowRef(message), unconfirmed }
    expect(findMessageRowIndex([message], saved)).toBe(0)
    expect(isMessageRow(message, saved)).toBe(true)
    expect(sameMessageRow(messageRowRef(message), saved)).toBe(true)
    expect(findMessageRowIndex([{ ...message, stanzaId: 'different' }], saved)).toBe(-1)
  })

  it('keeps a local reference when its missing archive ID is backfilled', () => {
    const local = { stanzaId: undefined as string | undefined, roomJid: 'room@example.com', from: 'room@example.com/Peer', id: 'client',
      occupantId: 'peer', timestamp: new Date(1000), body: 'Message' }
    const saved = messageRowRef(local)
    const merged = backfillRoomStanzaId(local, { ...local, stanzaId: 'archive' })
    expect(merged).toMatchObject({ stanzaId: 'archive', localRowRef: saved })
    expect(findMessageRowIndex([merged], saved)).toBe(0)
  })
})

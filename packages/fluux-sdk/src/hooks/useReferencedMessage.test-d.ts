import { expectTypeOf } from 'vitest'
import { useReferencedMessage, type Message, type RoomMessage } from '../index'

function checkPublicReferenceTypes(cache: boolean) {
  const room = { type: 'groupchat' as const, roomJid: 'room@example.com', id: 'archive' }
  expectTypeOf(useReferencedMessage(room)).toEqualTypeOf<RoomMessage | undefined>()
  expectTypeOf(useReferencedMessage({ ...room, cache: false })).toEqualTypeOf<RoomMessage | undefined>()
  expectTypeOf(useReferencedMessage({ ...room, cache: true })).toEqualTypeOf<RoomMessage | null | undefined>()
  expectTypeOf(useReferencedMessage({ ...room, cache })).toEqualTypeOf<RoomMessage | null | undefined>()
  expectTypeOf(useReferencedMessage({ type: 'chat', conversationId: 'person@example.com', id: 'client' }))
    .toEqualTypeOf<Message | undefined>()
}

void checkPublicReferenceTypes

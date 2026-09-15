import type { RoomMessage } from '@fluux/sdk'

/** Type-check a room fixture without adding protocol metadata. */
export function roomMessageFixture<T extends RoomMessage>(message: T): T {
  return message
}

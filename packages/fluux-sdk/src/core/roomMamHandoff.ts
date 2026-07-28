import type { XMPPClient } from './XMPPClient'

type RoomMamHandoffHandler = (roomJid: string) => void

const roomMamHandoffHandlers = new WeakMap<
  XMPPClient,
  Set<RoomMamHandoffHandler>
>()

export function requestRoomMamHandoff(
  client: XMPPClient,
  roomJid: string,
): void {
  roomMamHandoffHandlers.get(client)?.forEach((handler) => handler(roomJid))
}

export function subscribeRoomMamHandoff(
  client: XMPPClient,
  handler: RoomMamHandoffHandler,
): () => void {
  let handlers = roomMamHandoffHandlers.get(client)
  if (!handlers) {
    handlers = new Set()
    roomMamHandoffHandlers.set(client, handlers)
  }
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) {
      roomMamHandoffHandlers.delete(client)
    }
  }
}

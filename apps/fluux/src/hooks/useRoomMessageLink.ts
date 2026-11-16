import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { connectionStore, roomStore, getLocalPart, getBareJid, messageRowRef, useXMPPContext, type RoomMessageLink } from '@fluux/sdk'
import { useNavigateToTarget } from './useNavigateToTarget'
import { useToastStore } from '@/stores/toastStore'

/** One pending link survives a deliberate room join, but never an account change. */
export function useRoomMessageLink() {
  const { client } = useXMPPContext()
  const { navigateToRoom } = useNavigateToTarget()
  const { t } = useTranslation()
  const addToast = useToastStore(state => state.addToast)
  const pending = useRef<(RoomMessageLink & { account: string; running: boolean }) | null>(null)
  const mounted = useRef(false)
  const bridges = useRef(new Map<string, Promise<void>>())
  const live = useRef({ client, navigateToRoom, t, addToast })
  live.current = { client, navigateToRoom, t, addToast }

  const resolve = useCallback(async () => {
    const target = pending.current
    if (!target || target.running || !roomStore.getState().rooms.get(target.roomJid)?.joined) return
    const account = () => getBareJid(connectionStore.getState().jid ?? '')
    if (account() !== target.account) { pending.current = null; return }
    target.running = true
    const current = () => mounted.current && pending.current === target && account() === target.account
    const bridgeKey = JSON.stringify([target.account, target.roomJid])
    try {
      // An earlier archive link may still be filling this room. Position the
      // next target only after those pages, rather than letting them displace it.
      const earlierBridge = bridges.current.get(bridgeKey)
      if (earlierBridge) await earlierBridge
      if (!current()) return
      const result = await live.current.client.messages.locateRoomMessage(target.roomJid, target.stanzaId)
      if (!current()) return
      if (result.kind === 'found') {
        pending.current = null
        live.current.navigateToRoom(target.roomJid, messageRowRef(result.message))
        // Only freshly fetched archive context needs a seam walk. A held gap
        // must not make resident/cache hits download the same history again.
        if (result.source === 'archive' && roomStore.getState().roomGaps.get(target.roomJid)?.length) {
          const bridge = live.current.client.messages.catchUpTo(target.roomJid, result.message.timestamp.toISOString())
            .catch(error => console.warn('Could not bridge room message history', error))
          bridges.current.set(bridgeKey, bridge)
          void bridge.finally(() => {
            if (bridges.current.get(bridgeKey) === bridge) bridges.current.delete(bridgeKey)
          })
        }
      } else {
        roomStore.getState().setTargetMessageId(null)
        await roomStore.getState().recenterToLatest(target.roomJid)
        if (!current()) return
        pending.current = null
        live.current.navigateToRoom(target.roomJid)
        live.current.addToast('error', result.kind === 'absent'
          ? live.current.t('chat.linkedMessageUnavailable', 'This message is no longer available')
          : live.current.t('chat.linkedMessageLoadFailed', 'Could not load this message'))
      }
    } catch (error) {
      if (!current()) return
      pending.current = null
      roomStore.getState().setTargetMessageId(null)
      live.current.navigateToRoom(target.roomJid)
      live.current.addToast('error', live.current.t('chat.linkedMessageLoadFailed', 'Could not load this message'))
      console.warn('Could not resolve room message link', error)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    // Losing membership can be a network reset, not a cancelled request. Let an
    // in-flight lookup settle so it can report failure once instead of vanishing.
    const unsubscribeRoom = roomStore.subscribe(() => { void resolve() })
    const unsubscribeAccount = connectionStore.subscribe(state => {
      if (pending.current && getBareJid(state.jid ?? '') !== pending.current.account) pending.current = null
    })
    void resolve()
    // Keep the target through StrictMode's effect replay. Actual unmounts lose
    // authority via mounted; a later mount owns a different ref.
    return () => { mounted.current = false; unsubscribeRoom(); unsubscribeAccount() }
  }, [resolve])

  return useCallback((link: RoomMessageLink) => {
    const account = getBareJid(connectionStore.getState().jid ?? '')
    if (!account) return
    pending.current = { ...link, account, running: false }
    const rooms = roomStore.getState()
    let room = rooms.rooms.get(link.roomJid)
    if (!room) {
      room = { jid: link.roomJid, name: getLocalPart(link.roomJid), nickname: getLocalPart(account),
        joined: false, isBookmarked: false, occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
      rooms.addRoom(room)
    }
    if (!room.joined) live.current.navigateToRoom(link.roomJid)
    void resolve()
  }, [resolve])
}

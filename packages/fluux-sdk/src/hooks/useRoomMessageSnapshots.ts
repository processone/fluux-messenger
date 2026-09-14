import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { RoomMessage } from '../core/types'
import { useConnectionStore, useRoomStore } from '../react/storeHooks'
import { createRoomMessageSnapshotSelector, reconcileRoomMessageSnapshots, resolveRoomMessageSnapshot } from '../utils/roomMessageSnapshots'
import { captureStorageScope } from '../utils/storageScope'

export function useRoomMessageSnapshots(roomJid: string | undefined, messages: RoomMessage[]): RoomMessage[] {
  const account = useConnectionStore(state => state.jid)
  const lookup = useMemo(() => ({ roomJid, messages, account }), [roomJid, messages, account])
  const selector = useMemo(() => createRoomMessageSnapshotSelector(lookup.messages, lookup.roomJid), [lookup])
  const observed = useRoomStore(useShallow(selector))
  const [cached, setCached] = useState<{
    lookup: typeof lookup
    scope: ReturnType<typeof captureStorageScope>
    messages: RoomMessage[]
  }>()
  const source = cached?.lookup === lookup && cached.scope.isCurrent() ? cached.messages : messages
  const resolved = useMemo(() => reconcileRoomMessageSnapshots(source, observed), [source, observed])

  useEffect(() => {
    if (messages.length === 0) return
    const scope = captureStorageScope()
    setCached(previous => {
      const current = previous?.lookup === lookup && previous.scope.isCurrent() ? previous.messages : messages
      const next = reconcileRoomMessageSnapshots(current, observed)
      return next === current && previous?.lookup === lookup ? previous : { lookup, scope, messages: next }
    })
  }, [lookup, messages, observed])

  useEffect(() => {
    if (messages.length === 0) return
    const scope = captureStorageScope()
    let cancelled = false
    void Promise.all(messages.map(message => !roomJid || message.roomJid === roomJid
      ? resolveRoomMessageSnapshot(message) : message)).then(next => {
      if (!cancelled && scope.isCurrent()) setCached(previous => ({ lookup, scope,
        messages: reconcileRoomMessageSnapshots(previous?.lookup === lookup ? previous.messages : messages, next),
      }))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [roomJid, messages, lookup])

  return resolved
}

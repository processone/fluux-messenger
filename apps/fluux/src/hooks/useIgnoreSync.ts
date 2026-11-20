import { useEffect, useRef } from 'react'
import { useXMPP } from '@fluux/sdk'
import { useConnectionStore, useRoomStore } from '@fluux/sdk/react'
import { ignoreStore } from '@fluux/sdk/stores'

const PUBLISH_DEBOUNCE_MS = 1000

function serializeRoom(roomJid: string): string {
  return JSON.stringify(ignoreStore.getState().ignoredUsers[roomJid] || [])
}

type IgnoreClient = ReturnType<typeof useXMPP>['client']

/**
 * Publish a room's list when it differs from the last list known to match the
 * server. `serverState` has no entry for a room whose fetch has not settled.
 */
function publishIfChanged(client: IgnoreClient, serverState: Record<string, string>, roomJid: string): void {
  const previousJson = serverState[roomJid]
  if (previousJson === undefined) return
  const currentJson = serializeRoom(roomJid)
  if (currentJson === previousJson) return

  const users = ignoreStore.getState().ignoredUsers[roomJid]
  const request = !users || users.length === 0
    ? client.ignore.removeIgnoredUsers(roomJid)
    : client.ignore.setIgnoredUsers(roomJid, users)
  serverState[roomJid] = currentJson
  request.catch((err: unknown) => {
    // Restore the baseline so the next change retries the publish.
    if (serverState[roomJid] === currentJson) serverState[roomJid] = previousJson
    console.warn('[Fluux] Failed to publish ignored users for room', roomJid, err)
  })
}

/**
 * Syncs ignored users with PEP (XEP-0223) when connected.
 *
 * Lazy strategy: fetches from server only on first room activation per session.
 * Saves per-room changes to PEP when ignoreStore mutates (debounced).
 */
export function useIgnoreSync() {
  const status = useConnectionStore((s) => s.status)
  const activeRoomJid = useRoomStore((s) => s.activeRoomJid)
  const { client } = useXMPP()

  // Rooms whose fetch has started this session (settled or not)
  const fetchedRoomsRef = useRef<Set<string>>(new Set())
  // Last list known to match the server, per room, once its fetch settled
  const serverStateRef = useRef<Record<string, string>>({})
  // Bumped on disconnect so a fetch from an earlier session is discarded
  const sessionRef = useRef(0)

  // Lazy fetch: load ignored users from PEP on first room activation
  useEffect(() => {
    if (status !== 'online' || !activeRoomJid) return
    if (fetchedRoomsRef.current.has(activeRoomJid)) return
    fetchedRoomsRef.current.add(activeRoomJid)

    const roomJid = activeRoomJid
    const session = sessionRef.current
    const localAtFetch = serializeRoom(roomJid)

    client.ignore.fetchIgnoredUsersForRoom(roomJid).then((serverUsers) => {
      if (session !== sessionRef.current) return
      const changedDuringFetch = serializeRoom(roomJid) !== localAtFetch
      if (serverUsers.length > 0 && !changedDuringFetch) {
        // Server wins over data that only came from localStorage.
        ignoreStore.getState().setIgnoredForRoom(roomJid, serverUsers)
      }
      // A local list the server does not have stays local until it changes;
      // an edit made while the fetch was in flight is newer than both.
      serverStateRef.current[roomJid] = serverUsers.length > 0
        ? JSON.stringify(serverUsers)
        : localAtFetch
      publishIfChanged(client, serverStateRef.current, roomJid)
    }).catch(() => {
      if (session !== sessionRef.current) return
      // Server fetch failed: keep local data as the baseline.
      serverStateRef.current[roomJid] = localAtFetch
      publishIfChanged(client, serverStateRef.current, roomJid)
    })
  }, [status, activeRoomJid, client])

  // Save on change (debounced)
  useEffect(() => {
    if (status !== 'online') return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const unsubscribe = ignoreStore.subscribe(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        for (const roomJid of Object.keys(serverStateRef.current)) {
          publishIfChanged(client, serverStateRef.current, roomJid)
        }
      }, PUBLISH_DEBOUNCE_MS)
    })

    return () => {
      unsubscribe()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [status, client])

  // Reset on disconnect
  useEffect(() => {
    if (status === 'disconnected') {
      sessionRef.current++
      fetchedRoomsRef.current = new Set()
      serverStateRef.current = {}
    }
  }, [status])
}

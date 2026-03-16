import { useEffect, useRef } from 'react'
import { useXMPP } from '@fluux/sdk'
import { useConnectionStore, useRoomStore } from '@fluux/sdk/react'
import { ignoreStore } from '@fluux/sdk/stores'

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

  // Track which rooms we've already fetched this session
  const fetchedRoomsRef = useRef<Set<string>>(new Set())
  // Track what's been saved to server to detect local changes
  const serverStateRef = useRef<Record<string, string>>({})

  // Lazy fetch: load ignored users from PEP on first room activation
  useEffect(() => {
    if (status !== 'online' || !activeRoomJid) return
    if (fetchedRoomsRef.current.has(activeRoomJid)) return

    // Mark as fetched immediately to avoid duplicate requests
    fetchedRoomsRef.current.add(activeRoomJid)

    const roomJid = activeRoomJid
    client.ignore.fetchIgnoredUsersForRoom(roomJid).then((serverUsers) => {
      if (serverUsers.length > 0) {
        // Server has data — replace local state for this room (server wins)
        ignoreStore.getState().setIgnoredForRoom(roomJid, serverUsers)
      }
      // Snapshot current state for this room so save-on-change doesn't re-publish
      const currentUsers = ignoreStore.getState().ignoredUsers[roomJid]
      serverStateRef.current[roomJid] = JSON.stringify(currentUsers || [])
    }).catch(() => {
      // Server fetch failed — keep local data, snapshot it
      const currentUsers = ignoreStore.getState().ignoredUsers[roomJid]
      serverStateRef.current[roomJid] = JSON.stringify(currentUsers || [])
    })
  }, [status, activeRoomJid, client])

  // Save on change (debounced)
  useEffect(() => {
    if (status !== 'online') return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const unsubscribe = ignoreStore.subscribe((state) => {
      if (debounceTimer) clearTimeout(debounceTimer)

      debounceTimer = setTimeout(() => {
        const current = state.ignoredUsers

        // Only publish rooms we've already fetched (avoid pushing stale localStorage data)
        for (const roomJid of fetchedRoomsRef.current) {
          const currentJson = JSON.stringify(current[roomJid] || [])
          const previousJson = serverStateRef.current[roomJid]
          if (currentJson === previousJson) continue

          // Room changed — publish or retract
          const users = current[roomJid]
          if (!users || users.length === 0) {
            client.ignore.removeIgnoredUsers(roomJid).catch(() => {})
          } else {
            client.ignore.setIgnoredUsers(roomJid, users).catch(() => {})
          }

          // Update snapshot
          serverStateRef.current[roomJid] = currentJson
        }
      }, 1000)
    })

    return () => {
      unsubscribe()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [status, client])

  // Reset on disconnect
  useEffect(() => {
    if (status === 'disconnected') {
      fetchedRoomsRef.current = new Set()
      serverStateRef.current = {}
    }
  }, [status])
}

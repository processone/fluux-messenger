import { useEffect, useRef } from 'react'
import { useXMPPContext } from '../provider'
import { useRosterStore } from '../react/storeHooks'

/**
 * Hook that lazily queries a contact's last activity (XEP-0012) when viewing
 * an offline contact without a known `lastSeen` timestamp.
 *
 * This is a fire-and-forget hook: it triggers the query, and the result is
 * written directly into the roster store's `lastSeen` field. Existing UI
 * code that reads `lastSeen` (via `getLastSeenInfo` / `getStatusText`)
 * will re-render automatically.
 *
 * Pass `null` to skip querying (e.g., for group chats or online contacts).
 *
 * @param bareJid - The contact's bare JID, or null to skip
 *
 * @example
 * ```tsx
 * function ChatHeader({ jid, type }: { jid: string; type: 'chat' | 'groupchat' }) {
 *   useLastActivity(type === 'chat' ? jid : null)
 *   // ... existing UI reads lastSeen from roster store automatically
 * }
 * ```
 */
export function useLastActivity(bareJid: string | null): void {
  const { client } = useXMPPContext()
  const queriedJidRef = useRef<string | null>(null)
  const contact = useRosterStore((s) => bareJid ? s.contacts.get(bareJid) : undefined)

  useEffect(() => {
    if (!bareJid) {
      queriedJidRef.current = null
      return
    }

    // Already queried this JID in this mount cycle
    if (queriedJidRef.current === bareJid) return

    // Check cache — already queried this session
    const cached = client.internal.lastActivity?.getCached(bareJid)
    if (cached) {
      queriedJidRef.current = bareJid
      return
    }

    // Only query for offline contacts without a lastSeen timestamp
    if (!contact || contact.presence !== 'offline') return
    if (contact.lastSeen) return

    queriedJidRef.current = bareJid
    client.internal.lastActivity?.queryLastActivity(bareJid)
  }, [bareJid, client, contact?.presence, contact?.lastSeen])
}

import { useState, useEffect, useRef } from 'react'
import { useXMPPContext } from '../provider'

/**
 * Hook that queries a contact's entity time (XEP-0202) and returns their
 * local time, updated every minute.
 *
 * Only queries for 1:1 contacts (pass null to skip for group chats).
 * Results are cached per session — switching back to a conversation
 * won't re-query. Contacts that don't support XEP-0202 are negatively
 * cached to avoid repeated failed queries.
 *
 * When the contact's best resource changes (e.g., they travel and connect
 * from a different timezone), the cache is invalidated and a fresh query
 * is sent automatically.
 *
 * @param bareJid - The contact's bare JID, or null to skip
 * @returns The contact's formatted local time, or null if unavailable
 *
 * @example
 * ```tsx
 * function ChatHeader({ jid, type }: { jid: string; type: 'chat' | 'groupchat' }) {
 *   const localTime = useContactTime(type === 'chat' ? jid : null)
 *   return localTime ? <span>{localTime}</span> : null
 * }
 * ```
 */
export function useContactTime(bareJid: string | null): string | null {
  const { client } = useXMPPContext()
  const [offsetMinutes, setOffsetMinutes] = useState<number | null>(null)
  const [time, setTime] = useState<string | null>(null)
  const queriedJidRef = useRef<string | null>(null)

  // Query entity time when bareJid changes
  useEffect(() => {
    if (!bareJid) {
      setOffsetMinutes(null)
      setTime(null)
      queriedJidRef.current = null
      return
    }

    // Check cache first — queryTime handles cache + resource change detection
    const cached = client.entityTime?.getCached(bareJid)
    if (cached) {
      if (cached.supported) {
        setOffsetMinutes(cached.offsetMinutes)
      } else {
        // Negatively cached — don't show anything
        setOffsetMinutes(null)
        setTime(null)
      }
      queriedJidRef.current = bareJid
      return
    }

    // Reset display while querying (no stale data from previous contact)
    setOffsetMinutes(null)
    setTime(null)
    queriedJidRef.current = bareJid

    client.entityTime?.queryTime(bareJid).then((result) => {
      // Only update if we're still looking at the same contact
      if (queriedJidRef.current !== bareJid) return
      if (result?.supported) {
        setOffsetMinutes(result.offsetMinutes)
      }
    })
  }, [bareJid, client])

  // Compute and tick the displayed time
  useEffect(() => {
    if (offsetMinutes === null) {
      setTime(null)
      return
    }

    const computeTime = () => {
      const now = new Date()
      // Compute the contact's local time using their UTC offset
      // Date.now() is UTC epoch, contact's local time = UTC + their offset
      const contactUtcMs = now.getTime() + now.getTimezoneOffset() * 60000
      const contactLocalMs = contactUtcMs + offsetMinutes * 60000
      const contactDate = new Date(contactLocalMs)

      setTime(
        contactDate.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: undefined, // Use locale default
        })
      )
    }

    computeTime()
    const interval = setInterval(computeTime, 60000)
    return () => clearInterval(interval)
  }, [offsetMinutes])

  return time
}

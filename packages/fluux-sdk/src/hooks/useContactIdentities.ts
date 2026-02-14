import { useRef } from 'react'
import { useRosterStore } from '../react/storeHooks'

/**
 * Identity-only contact data for display purposes.
 * Does NOT include presence fields (show, status, resources).
 */
export interface ContactIdentity {
  jid: string
  name: string
  avatar?: string
  /** XEP-0392: Consistent color for light theme UI */
  colorLight?: string
  /** XEP-0392: Consistent color for dark theme UI */
  colorDark?: string
}

/**
 * Stable empty map returned when roster is empty.
 */
const EMPTY_MAP: Map<string, ContactIdentity> = new Map()

/**
 * Lightweight hook that provides contact identity data (jid, name, avatar)
 * without subscribing to presence changes.
 *
 * Unlike `useRoster()`, this hook does NOT re-render when contact presence
 * updates arrive (which happen frequently during connection). Use this in
 * components like ChatView that only need contact names and avatars for
 * message display.
 *
 * For components that need live presence data (contact list, status indicators),
 * use `useRoster()` instead.
 *
 * @returns A Map from bare JID to ContactIdentity (name + avatar)
 *
 * @example
 * ```tsx
 * function ChatView() {
 *   const contactIdentities = useContactIdentities()
 *   const senderName = contactIdentities.get(message.from)?.name ?? message.from
 * }
 * ```
 *
 * @category Hooks
 */
export function useContactIdentities(): Map<string, ContactIdentity> {
  const prevRef = useRef<Map<string, ContactIdentity>>(EMPTY_MAP)

  const result = useRosterStore((s) => {
    if (s.contacts.size === 0) return EMPTY_MAP

    // Check if any identity fields changed compared to previous result
    const prev = prevRef.current
    let changed = s.contacts.size !== prev.size

    if (!changed) {
      for (const [jid, contact] of s.contacts) {
        const prevEntry = prev.get(jid)
        if (!prevEntry || prevEntry.name !== contact.name || prevEntry.avatar !== contact.avatar
          || prevEntry.colorLight !== contact.colorLight || prevEntry.colorDark !== contact.colorDark) {
          changed = true
          break
        }
      }
    }

    if (!changed) return prev

    // Build new map with identity-only data
    const map = new Map<string, ContactIdentity>()
    for (const [jid, contact] of s.contacts) {
      map.set(jid, { jid, name: contact.name, avatar: contact.avatar, colorLight: contact.colorLight, colorDark: contact.colorDark })
    }
    prevRef.current = map
    return map
  })

  return result
}

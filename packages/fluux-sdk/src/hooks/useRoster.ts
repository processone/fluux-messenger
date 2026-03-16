import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { rosterStore } from '../stores'
import { useRosterStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { Contact } from '../core'

/**
 * Hook for managing the contact roster (buddy list).
 *
 * Provides state and actions for contact management including adding/removing
 * contacts, fetching presence information, and handling subscription requests.
 *
 * @returns An object containing roster state and actions
 *
 * @example Displaying contacts
 * ```tsx
 * function ContactList() {
 *   const { sortedContacts } = useRoster()
 *
 *   return (
 *     <ul>
 *       {sortedContacts.map(contact => (
 *         <li key={contact.jid}>
 *           {contact.name || contact.jid}
 *           <span>{contact.show || 'offline'}</span>
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * @example Adding a contact
 * ```tsx
 * function AddContact() {
 *   const { addContact } = useRoster()
 *   const [jid, setJid] = useState('')
 *
 *   const handleAdd = async () => {
 *     await addContact(jid, 'Friend Name')
 *     setJid('')
 *   }
 *
 *   return (
 *     <form onSubmit={handleAdd}>
 *       <input value={jid} onChange={e => setJid(e.target.value)} />
 *       <button type="submit">Add Contact</button>
 *     </form>
 *   )
 * }
 * ```
 *
 * @example Handling subscription requests
 * ```tsx
 * function SubscriptionRequests() {
 *   const { acceptSubscription, rejectSubscription } = useRoster()
 *   const { pendingSubscriptions } = useEvents()
 *
 *   return (
 *     <ul>
 *       {pendingSubscriptions.map(req => (
 *         <li key={req.from}>
 *           {req.from} wants to add you
 *           <button onClick={() => acceptSubscription(req.from)}>Accept</button>
 *           <button onClick={() => rejectSubscription(req.from)}>Reject</button>
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * @category Hooks
 */
export function useRoster() {
  const { client } = useXMPPContext()
  // Use useShallow to compare array elements by reference, preventing re-renders
  // when the array contents haven't actually changed
  const contacts = useRosterStore(useShallow((s) => Array.from(s.contacts.values())))
  const sortedContacts = useRosterStore(useShallow((s) => s.sortedContacts()))
  const onlineContacts = useRosterStore(useShallow((s) => s.onlineContacts()))

  const removeContact = useCallback(
    async (jid: string) => {
      await client.roster.removeContact(jid)
    },
    [client]
  )

  const addContact = useCallback(
    async (jid: string, nick?: string) => {
      await client.roster.addContact(jid, nick)
    },
    [client]
  )

  const renameContact = useCallback(
    async (jid: string, name: string) => {
      await client.roster.renameContact(jid, name)
    },
    [client]
  )

  const getContact = useCallback((jid: string): Contact | undefined => {
    return rosterStore.getState().getContact(jid)
  }, [])

  const fetchContactNickname = useCallback(
    async (jid: string) => {
      return client.profile.fetchContactNickname(jid)
    },
    [client]
  )

  const fetchVCard = useCallback(
    async (jid: string) => {
      return client.profile.fetchVCard(jid)
    },
    [client]
  )

  const restoreContactAvatarFromCache = useCallback(
    async (jid: string, avatarHash: string) => {
      return client.profile.restoreContactAvatarFromCache(jid, avatarHash)
    },
    [client]
  )

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      addContact,
      removeContact,
      renameContact,
      getContact,
      restoreContactAvatarFromCache,
      fetchContactNickname,
      fetchVCard,
    }),
    [addContact, removeContact, renameContact, getContact, restoreContactAvatarFromCache, fetchContactNickname, fetchVCard]
  )

  // Memoize the entire return value to prevent render loops
  return useMemo(
    () => ({
      // State
      contacts,
      sortedContacts,
      onlineContacts,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [contacts, sortedContacts, onlineContacts, actions]
  )
}

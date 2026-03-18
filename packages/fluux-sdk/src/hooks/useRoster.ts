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

  const removeContact = async (jid: string) => {
    await client.roster.removeContact(jid)
  }

  const addContact = async (jid: string, nick?: string) => {
    await client.roster.addContact(jid, nick)
  }

  const renameContact = async (jid: string, name: string) => {
    await client.roster.renameContact(jid, name)
  }

  const getContact = (jid: string): Contact | undefined => {
    return rosterStore.getState().getContact(jid)
  }

  const fetchContactNickname = async (jid: string) => {
    return client.profile.fetchContactNickname(jid)
  }

  const fetchVCard = async (jid: string) => {
    return client.profile.fetchVCard(jid)
  }

  const restoreContactAvatarFromCache = async (jid: string, avatarHash: string) => {
    return client.profile.restoreContactAvatarFromCache(jid, avatarHash)
  }

  return {
    // State
    contacts,
    sortedContacts,
    onlineContacts,

    // Actions
    addContact,
    removeContact,
    renameContact,
    getContact,
    restoreContactAvatarFromCache,
    fetchContactNickname,
    fetchVCard,
  }
}

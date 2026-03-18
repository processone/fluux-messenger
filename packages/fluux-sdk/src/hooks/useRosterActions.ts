import { rosterStore } from '../stores'
import { useXMPPContext } from '../provider'
import type { Contact } from '../core'

/**
 * Hook for roster actions without state subscriptions.
 *
 * This hook provides contact management actions (add, remove, rename) without
 * subscribing to roster state. Use this in components that need to perform
 * roster operations but don't need to render the contact list.
 *
 * For components that need both actions AND state (contact list rendering),
 * use {@link useRoster} instead.
 *
 * @returns An object containing roster action functions
 *
 * @example Removing a contact from a modal
 * ```tsx
 * function ContactProfileModal({ jid }: { jid: string }) {
 *   const { removeContact, renameContact } = useRosterActions()
 *
 *   const handleDelete = async () => {
 *     await removeContact(jid)
 *     onClose()
 *   }
 *
 *   return (
 *     <button onClick={handleDelete}>Remove Contact</button>
 *   )
 * }
 * ```
 *
 * @example Fetching a contact's published nickname
 * ```tsx
 * function ContactNickname({ jid }: { jid: string }) {
 *   const { fetchContactNickname } = useRosterActions()
 *   const [nickname, setNickname] = useState<string | null>(null)
 *
 *   useEffect(() => {
 *     fetchContactNickname(jid).then(setNickname)
 *   }, [jid, fetchContactNickname])
 *
 *   return <span>{nickname || 'No nickname'}</span>
 * }
 * ```
 *
 * @category Hooks
 */
export function useRosterActions() {
  const { client } = useXMPPContext()

  const removeContact = async (jid: string) => {
    await client.roster.removeContact(jid)
  }

  const addContact = async (jid: string, nick?: string) => {
    await client.roster.addContact(jid, nick)
  }

  const renameContact = async (jid: string, name: string) => {
    await client.roster.renameContact(jid, name)
  }

  /**
   * Get a contact by JID from the store.
   * This is a direct store read, not a subscription.
   */
  const getContact = (jid: string): Contact | undefined => {
    return rosterStore.getState().getContact(jid)
  }

  /**
   * Fetch the contact's published nickname (XEP-0172 User Nickname).
   * Note: This is the nickname the contact publishes for themselves,
   * NOT the name you've given them in your roster.
   */
  const fetchContactNickname = async (jid: string) => {
    return client.profile.fetchContactNickname(jid)
  }

  /**
   * Fetch a contact's vCard (XEP-0054 vcard-temp).
   */
  const fetchVCard = async (jid: string) => {
    return client.profile.fetchVCard(jid)
  }

  /**
   * Restore a contact's avatar from cache.
   * Useful when contacts have avatarHash but no blob URL (e.g., after app restart).
   */
  const restoreContactAvatarFromCache = async (jid: string, avatarHash: string) => {
    return client.profile.restoreContactAvatarFromCache(jid, avatarHash)
  }

  /**
   * Accept a subscription request from another user.
   * This allows them to see your presence.
   */
  const acceptSubscription = async (jid: string) => {
    await client.roster.acceptSubscription(jid)
  }

  /**
   * Reject a subscription request from another user.
   */
  const rejectSubscription = async (jid: string) => {
    await client.roster.rejectSubscription(jid)
  }

  return {
    addContact,
    removeContact,
    renameContact,
    getContact,
    fetchContactNickname,
    fetchVCard,
    restoreContactAvatarFromCache,
    acceptSubscription,
    rejectSubscription,
  }
}

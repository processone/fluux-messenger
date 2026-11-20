/**
 * Deep Link Handler for XMPP URIs
 *
 * Listens for xmpp: URI scheme events in Tauri and navigates
 * to the appropriate conversation or room.
 *
 * Uses React Router for navigation instead of callback handlers.
 */
import { useEffect, useRef, useCallback } from 'react'
import { useChat, useRoom, useRoster, chatStore, roomStore, connectionStore, rosterStore, type Conversation, parseXmppUri, parseRoomMessageLink, isMucJid, getBareJid, getLocalPart, boundedPlainText } from '@fluux/sdk'
import { addDraftText, type DraftOperations } from './useConversationDraft'
import { useModalStore } from '@/stores/modalStore'
import { useConnectionStore, useRosterStore, useRoomStore } from '@fluux/sdk/react'
import { useNavigateToTarget } from './useNavigateToTarget'
import { useTranslation } from 'react-i18next'
import { useToastStore } from '@/stores/toastStore'
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
import { useRoomMessageLink } from './useRoomMessageLink'
import { isRoomShortcutURL, isShortcutURL, resolveShortcutURL } from '@/utils/shortcutConversation'
import { deferDeepLink, ensureDeepLinkRouter, setNavigationHandler, takeQueuedDeepLinks } from '@/utils/deepLinkRouter'
import { useNavigate } from 'react-router'

/**
 * Whether the stores hold the live account's conversations: its roster has
 * loaded. A cold launch is online before that, while the roster is fetched.
 */
function rosterLoadedFor(liveJid: string | null, roster: { isLoaded: boolean; accountJid: string | null }): boolean {
  return !!liveJid && roster.isLoaded && roster.accountJid === liveJid.split('/')[0]
}

/** Longest text a link may put in a composer, as for forwarded copies. */
const MAX_LINK_BODY_CODE_POINTS = 4000

const chatDrafts: DraftOperations = {
  owner: chatStore,
  getDraft: (id) => chatStore.getState().getDraft(id),
  setDraft: (id, text) => chatStore.getState().setDraft(id, text),
  clearDraft: (id) => chatStore.getState().clearDraft(id),
}
const roomDrafts: DraftOperations = {
  owner: roomStore,
  getDraft: (id) => roomStore.getState().getDraft(id),
  setDraft: (id, text) => roomStore.getState().setDraft(id, text),
  clearDraft: (id) => roomStore.getState().clearDraft(id),
}

/** Whether each server name hosts rooms, for the session; only real answers are kept. */
const roomServiceByDomain = new Map<string, boolean>()

/**
 * Hook that listens for XMPP deep links and navigates accordingly.
 * Shared by in-chat clicks on every platform and native system-link events.
 * Uses React Router for URL-based navigation.
 */
export function useDeepLink() {
  const navigate = useNavigate()
  const openRoomMessageLink = useRoomMessageLink()
  const { addConversation } = useChat()
  const { joinRoom, joinResult, getRoomInfo, isNonAnonymousRoomAcknowledged, domainHostsRooms } = useRoom()
  const { navigateToConversation, navigateToRoom, navigateToContactRequests } = useNavigateToTarget()
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const { contacts } = useRoster()
  // Use focused selectors to only subscribe to jid and status
  const jid = useConnectionStore((s) => s.jid)
  const status = useConnectionStore((s) => s.status)
  const rosterReady = useRosterStore((s) => rosterLoadedFor(jid, s))
  const bookmarksLoaded = useRoomStore((s) => s.bookmarksLoaded)
  const contactsRef = useRef(contacts)
  const jidRef = useRef(jid)

  // Keep refs updated
  useEffect(() => {
    contactsRef.current = contacts
    jidRef.current = jid
  }, [contacts, jid])

  /**
   * Whether an address is a room, from the first step that knows it: rooms
   * Fluux holds, then contacts and chats, then its server's own answer about
   * hosting rooms (once per server name), and only without an answer the
   * name guess.
   */
  const isRoomAddress = async (bareJid: string): Promise<boolean> => {
    if (roomStore.getState().rooms.has(bareJid)) return true
    if (contactsRef.current.some(c => c.jid === bareJid) || chatStore.getState().hasConversation(bareJid)) return false
    const domain = bareJid.slice(bareJid.indexOf('@') + 1)
    let hostsRooms = roomServiceByDomain.get(domain)
    if (hostsRooms === undefined) {
      const answer = await domainHostsRooms(domain)
      if (answer === null) return isMucJid(bareJid)
      hostsRooms = answer
      roomServiceByDomain.set(domain, answer)
    }
    return hostsRooms
  }

  /** Show a room's view (with its Join button when not joined) without joining it. */
  const openRoomWithoutJoining = (roomJid: string) => {
    const rooms = roomStore.getState()
    if (!rooms.rooms.has(roomJid)) {
      const account = getBareJid(jidRef.current ?? '')
      rooms.addRoom({ jid: roomJid, name: getLocalPart(roomJid), nickname: getLocalPart(account) || 'guest',
        joined: false, isBookmarked: false, occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() })
    }
    navigateToRoom(roomJid)
  }

  // Handle an XMPP URI
  const handleXmppUri = async (uri: string) => {
    if (isShortcutURL(uri)) {
      const liveAccount = connectionStore.getState().jid ?? null
      // A shortcut is checked against the live account's conversations, so it
      // waits for that account's roster, and a room's for the bookmarks, which
      // a cold launch loads after the roster (replayed below once loaded).
      if (!rosterLoadedFor(liveAccount, rosterStore.getState())
        || (isRoomShortcutURL(uri) && !roomStore.getState().bookmarksLoaded)) {
        deferDeepLink(uri)
        return
      }
      const shortcut = resolveShortcutURL(uri, liveAccount, chatStore.getState().conversations, roomStore.getState().rooms)
      if (!shortcut) void navigate('/messages')
      else if (shortcut.kind === 'chat') navigateToConversation(shortcut.id)
      else navigateToRoom(shortcut.id)
      return
    }
    // Other app-scheme links only bring the app to the foreground.
    if (!uri.startsWith('xmpp:')) return
    console.log('[DeepLink] Received URI:', uri)

    const parsed = parseXmppUri(uri)
    if (!parsed) {
      console.warn('[DeepLink] Failed to parse XMPP URI:', uri)
      return
    }

    console.log('[DeepLink] Parsed:', parsed)

    // A message link never falls through to the legacy room auto-join path,
    // including malformed/empty targets. Membership and deliberate join are
    // owned by the message-link resolver.
    if (parsed.action === 'join' && Object.hasOwn(parsed.params, 'msg')) {
      if (status !== 'online') { deferDeepLink(uri); return }
      const target = parseRoomMessageLink(uri)
      if (target) openRoomMessageLink(target)
      return
    }

    // Every action waits for the app to be online: the room-or-person check
    // asks the address's server and a subscribe link needs the roster.
    if (status !== 'online' || (parsed.action === 'subscribe' && !rosterLoadedFor(jidRef.current, rosterStore.getState()))) {
      deferDeepLink(uri)
      return
    }

    const bareJid = getBareJid(parsed.jid)
    const isOwnAddress = bareJid === getBareJid(jidRef.current ?? '')

    if (parsed.action === 'subscribe') {
      if (isOwnAddress) return
      if (await isRoomAddress(bareJid)) { openRoomWithoutJoining(bareJid); return }
      const contact = contactsRef.current.find(c => c.jid === bareJid)
      if (contact && (contact.subscription === 'to' || contact.subscription === 'both')) {
        navigateToConversation(bareJid)
        return
      }
      // Leave the open conversation first, as the command palette does: on a narrow
      // layout the dialog lives in the sidebar, hidden while a conversation is open.
      // Nothing is sent until the person presses Add contact.
      navigateToContactRequests()
      useModalStore.getState().openAddContact(bareJid)
      return
    }

    const body = parsed.action === 'message' && parsed.params.body
      ? boundedPlainText(parsed.params.body, MAX_LINK_BODY_CODE_POINTS)
      : ''

    // A message link to a room never joins it: the room opens with its Join
    // button and the text waits as the room's draft.
    if (parsed.action === 'message' && await isRoomAddress(bareJid)) {
      if (body) addDraftText(roomDrafts, bareJid, body)
      openRoomWithoutJoining(bareJid)
      return
    }

    // A join link, or an address with no action that is a room, joins it.
    const isRoom = parsed.action === 'join' || (parsed.action !== 'message' && await isRoomAddress(bareJid))

    if (isRoom) {
      // Handle room/MUC URI
      const roomJid = bareJid
      const nick = parsed.params.nick
      const password = parsed.params.password

      // Use provided nick, or fallback to local part of user's JID
      const defaultNick = getLocalPart(jidRef.current ?? '') || 'guest'
      const nickname = nick || defaultNick

      console.log('[DeepLink] Joining room:', roomJid, { nickname, password: password ? '***' : undefined })

      // Issue #37: a deep link must not silently auto-join a room that would expose
      // the user's real JID (non-anonymous, non-private) unless already acknowledged.
      // Inspect first; if it exposes the JID and isn't acknowledged, navigate to the
      // room without joining so the user joins it deliberately (and sees the warning)
      // from the room view's Join button.
      const features = await getRoomInfo(roomJid).catch(() => null)
      const exposesRealJid = features ? features.isNonAnonymous && !features.isPrivate : false
      if (exposesRealJid && !isNonAnonymousRoomAcknowledged(roomJid)) {
        console.warn('[DeepLink] Not auto-joining non-anonymous room (real-JID exposure not acknowledged):', roomJid)
        navigateToRoom(roomJid)
        return
      }

      // Join the room (reuse the inspection to avoid a second disco query)
      const joinOptions = { ...(password ? { password } : {}), ...(features ? { knownFeatures: features } : {}) }
      try {
        await joinRoom(roomJid, nickname, Object.keys(joinOptions).length > 0 ? joinOptions : undefined)
        await joinResult(roomJid)
      } catch (err) {
        addToast('error', getRoomJoinErrorMessage(t, err))
      }

      // Navigate to the room regardless of outcome: on failure the user lands on
      // the room view with a Join button, and the toast carries the reason. Matches
      // the issue-#37 "navigate without joining" branch above.
      navigateToRoom(roomJid)
    } else {
      // Handle 1:1 chat URI
      const contactJid = bareJid

      console.log('[DeepLink] Opening chat with:', contactJid)

      // Check if conversation exists
      const chatState = chatStore.getState()
      if (!chatState.hasConversation(contactJid)) {
        // Find contact name from roster, or use JID
        const contact = contactsRef.current.find(c => c.jid === contactJid)
        const name = contact?.name || getLocalPart(contactJid)

        // Create new conversation
        const conversation: Conversation = {
          id: contactJid,
          name,
          type: 'chat',
          unreadCount: 0,
        }
        addConversation(conversation)
      }

      // The link's text waits in the composer, below any draft; it is never sent.
      if (body) addDraftText(chatDrafts, contactJid, body)
      navigateToConversation(contactJid)
    }
  }

  const handleXmppUriRef = useRef(handleXmppUri)
  handleXmppUriRef.current = handleXmppUri

  const handleXmppUriSafely = useCallback((uri: string) => {
    void handleXmppUriRef.current(uri).catch((error) => {
      console.error('[DeepLink] Failed to process URI:', uri, error)
    })
  }, [])

  // While the chat view is up, the router hands every link to it. The router
  // owns the listener and the launch URL for the whole app (see deepLinkRouter).
  useEffect(() => {
    const dispose = setNavigationHandler(handleXmppUriSafely)
    void ensureDeepLinkRouter()
    return dispose
  }, [handleXmppUriSafely])

  // Links that arrived before the app was online (during the startup reconnect
  // or on the login form) are replayed once it is, and again once the
  // account's roster and then its bookmarks have loaded, for the shortcuts
  // that wait for them.
  useEffect(() => {
    if (status !== 'online') return
    for (const uri of takeQueuedDeepLinks()) handleXmppUriSafely(uri)
  }, [status, rosterReady, bookmarksLoaded, handleXmppUriSafely])
}

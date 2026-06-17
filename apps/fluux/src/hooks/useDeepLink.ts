/**
 * Deep Link Handler for XMPP URIs
 *
 * Listens for xmpp: URI scheme events in Tauri and navigates
 * to the appropriate conversation or room.
 *
 * Phase 2.4: Uses React Router for navigation instead of callback handlers.
 */
import { useEffect, useRef, useCallback } from 'react'
import { useChat, useRoom, useRoster, chatStore, type Conversation, parseXmppUri, isMucJid, getBareJid } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { useNavigateToTarget } from './useNavigateToTarget'
import { useTranslation } from 'react-i18next'
import { useToastStore } from '@/stores/toastStore'
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'

// Tauri detection
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Hook that listens for XMPP deep links and navigates accordingly.
 * Only active in Tauri desktop environment.
 *
 * Uses React Router for URL-based navigation.
 */
export function useDeepLink() {
  const { addConversation } = useChat()
  const { joinRoom, joinResult, getRoomInfo, isNonAnonymousRoomAcknowledged } = useRoom()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const { contacts } = useRoster()
  // Use focused selector to only subscribe to jid
  const jid = useConnectionStore((s) => s.jid)
  const contactsRef = useRef(contacts)
  const jidRef = useRef(jid)

  // Keep refs updated
  useEffect(() => {
    contactsRef.current = contacts
    jidRef.current = jid
  }, [contacts, jid])

  // Handle an XMPP URI
  const handleXmppUri = async (uri: string) => {
    console.log('[DeepLink] Received URI:', uri)

    const parsed = parseXmppUri(uri)
    if (!parsed) {
      console.warn('[DeepLink] Failed to parse XMPP URI:', uri)
      return
    }

    console.log('[DeepLink] Parsed:', parsed)

    const bareJid = getBareJid(parsed.jid)

    // Determine if this is a MUC room based on action or JID pattern
    const isRoom = parsed.action === 'join' || isMucJid(bareJid)

    if (isRoom) {
      // Handle room/MUC URI
      const roomJid = bareJid
      const nick = parsed.params.nick
      const password = parsed.params.password

      // Use provided nick, or fallback to local part of user's JID
      const defaultNick = jidRef.current?.split('@')[0] || 'guest'
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
        // A deep link can carry a password, so distinguish "incorrect password"
        // from "password required" when the server rejects with not-authorized.
        addToast('error', getRoomJoinErrorMessage(t, err, { passwordWasSent: !!password }))
      }

      // Navigate to the room regardless of outcome: on failure the user lands on
      // the room view with a Join button, and the toast carries the reason. Matches
      // the issue-#37 "navigate without joining" branch above.
      navigateToRoom(roomJid)
    } else {
      // Handle 1:1 chat URI
      const contactJid = bareJid
      const messageBody = parsed.params.body

      console.log('[DeepLink] Opening chat with:', contactJid, { messageBody })

      // Check if conversation exists
      const chatState = chatStore.getState()
      if (!chatState.hasConversation(contactJid)) {
        // Find contact name from roster, or use JID
        const contact = contactsRef.current.find(c => c.jid === contactJid)
        const name = contact?.name || contactJid.split('@')[0]

        // Create new conversation
        const conversation: Conversation = {
          id: contactJid,
          name,
          type: 'chat',
          unreadCount: 0,
        }
        addConversation(conversation)
      }

      // Navigate to messages view and activate the conversation
      navigateToConversation(contactJid)

      // If a message body was provided, we could pre-fill the composer
      // For now we just log it - pre-filling would require more plumbing
      if (messageBody) {
        console.log('[DeepLink] Message body provided (not implemented):', messageBody)
      }
    }
  }

  const handleXmppUriRef = useRef(handleXmppUri)
  handleXmppUriRef.current = handleXmppUri

  const handleXmppUriSafely = useCallback((uri: string) => {
    void handleXmppUriRef.current(uri).catch((error) => {
      console.error('[DeepLink] Failed to process URI:', uri, error)
    })
  }, [])

  // Set up deep link listener
  useEffect(() => {
    if (!isTauri) return

    let cleanup: (() => void) | undefined
    let cleanedUp = false

    const setupDeepLink = async () => {
      try {
        // Dynamic import to avoid issues in non-Tauri environments
        const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link')

        // Handle URIs that were passed while the app was running
        const unlisten = await onOpenUrl((urls) => {
          console.log('[DeepLink] onOpenUrl received:', urls)
          for (const url of urls) {
            handleXmppUriSafely(url)
          }
        })

        // If cleanup already ran, unlisten immediately
        if (cleanedUp) {
          unlisten()
          return
        }

        // Check if app was opened with a URI (cold start)
        const initialUrls = await getCurrent()
        if (initialUrls && initialUrls.length > 0) {
          console.log('[DeepLink] Initial URIs:', initialUrls)
          for (const url of initialUrls) {
            handleXmppUriSafely(url)
          }
        }

        cleanup = unlisten
      } catch (error) {
        console.error('[DeepLink] Failed to set up deep link handler:', error)
      }
    }

    void setupDeepLink()

    return () => {
      cleanedUp = true
      cleanup?.()
    }
  }, [handleXmppUriSafely])
}

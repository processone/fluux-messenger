import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { connectionStore, rosterStore, roomStore, useXMPPContext, getBareJid } from '@fluux/sdk'
import { useRosterStore, useConnectionStore, useRoomStore } from '@fluux/sdk/react'
import type { Contact, Room, RoomOccupant, ServerInfo, HttpUploadService, RoomMessage, ResourcePresence } from '@fluux/sdk'
import { getResource } from '@/utils/xmppResource'
import { isTauri } from '@/utils/tauri'

const SESSION_KEY = 'xmpp-session'
const ROSTER_KEY = 'xmpp-roster'
const ROOMS_KEY = 'xmpp-rooms'
const SERVER_INFO_KEY = 'xmpp-server-info'
const VIEW_STATE_KEY = 'xmpp-view-state'
const PROFILE_KEY = 'xmpp-profile'
const OWN_RESOURCES_KEY = 'xmpp-own-resources'
const ACTIVE_SESSION_JID_KEY = 'xmpp-active-session-jid'

const SCOPED_SESSION_KEYS = [
  SESSION_KEY,
  ROSTER_KEY,
  ROOMS_KEY,
  SERVER_INFO_KEY,
  VIEW_STATE_KEY,
  PROFILE_KEY,
  OWN_RESOURCES_KEY,
]

function normalizeSessionJid(jid: string | null | undefined): string | null {
  if (!jid) return null
  const bareJid = getBareJid(jid).trim()
  return bareJid.length > 0 ? bareJid : null
}

function setActiveSessionJid(jid: string | null | undefined): string | null {
  const normalized = normalizeSessionJid(jid)
  if (normalized) {
    sessionStorage.setItem(ACTIVE_SESSION_JID_KEY, normalized)
    return normalized
  }
  sessionStorage.removeItem(ACTIVE_SESSION_JID_KEY)
  return null
}

function resolveSessionScopeJid(jid?: string | null): string | null {
  const explicit = normalizeSessionJid(jid)
  if (explicit) return explicit

  const connectedJid = normalizeSessionJid(connectionStore.getState().jid)
  if (connectedJid) return connectedJid

  return normalizeSessionJid(sessionStorage.getItem(ACTIVE_SESSION_JID_KEY))
}

function getScopedSessionKey(baseKey: string, jid?: string | null): string {
  const scopeJid = resolveSessionScopeJid(jid)
  return scopeJid ? `${baseKey}:${scopeJid}` : baseKey
}

function setScopedSessionItem(baseKey: string, value: string, jid?: string | null): void {
  sessionStorage.setItem(getScopedSessionKey(baseKey, jid), value)
}

function getScopedSessionItem(baseKey: string, jid?: string | null): string | null {
  const scopedKey = getScopedSessionKey(baseKey, jid)
  const scopedValue = sessionStorage.getItem(scopedKey)
  if (scopedValue !== null) return scopedValue

  const hasExplicitJid = normalizeSessionJid(jid) !== null
  if (hasExplicitJid || scopedKey !== baseKey) {
    return null
  }

  // Legacy fallback: read old unscoped keys only when no account scope is known.
  return sessionStorage.getItem(baseKey)
}

function clearScopedSessionItems(jid?: string | null): void {
  const scopeJid = resolveSessionScopeJid(jid)

  SCOPED_SESSION_KEYS.forEach((baseKey) => {
    if (scopeJid) {
      sessionStorage.removeItem(`${baseKey}:${scopeJid}`)
    } else {
      sessionStorage.removeItem(baseKey)
    }
    sessionStorage.removeItem(baseKey)
  })
}

function clearAllScopedSessionItems(): void {
  const keysToRemove: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)
    if (!key) continue
    if (key === ACTIVE_SESSION_JID_KEY) {
      keysToRemove.push(key)
      continue
    }
    if (SCOPED_SESSION_KEYS.some((baseKey) => key === baseKey || key.startsWith(`${baseKey}:`))) {
      keysToRemove.push(key)
    }
  }
  keysToRemove.forEach((key) => sessionStorage.removeItem(key))
}

interface SessionData {
  jid: string
  password: string
  server: string
  // Note: SM state is now managed by SDK's storage adapter
}

interface ProfileData {
  ownAvatarHash: string | null
  ownNickname: string | null
}

/**
 * View state for restoring UI on page reload.
 */
export interface ViewStateData {
  sidebarView: 'messages' | 'rooms' | 'directory' | 'archive' | 'events' | 'admin' | 'settings'
  activeConversationId: string | null
  activeRoomJid: string | null
  selectedContactJid: string | null
  showRoomOccupants?: boolean  // Whether members sidebar is expanded in room view
}

/**
 * Saves session credentials to sessionStorage.
 * Called after successful login.
 */
export function saveSession(jid: string, password: string, server: string): void {
  const data: SessionData = { jid, password, server }
  const scopeJid = setActiveSessionJid(jid)
  setScopedSessionItem(SESSION_KEY, JSON.stringify(data), scopeJid)
}

// Note: SM state persistence is now handled by SDK's storage adapter.
// The SDK automatically persists SM state on enable/resume and loads it on connect.

/**
 * Clears session credentials from sessionStorage.
 * Called on manual disconnect.
 */
interface ClearSessionOptions {
  allAccounts?: boolean
}

export function clearSession(options: ClearSessionOptions = {}): void {
  if (options.allAccounts) {
    clearAllScopedSessionItems()
    return
  }

  clearScopedSessionItems()
  setActiveSessionJid(null)
  // Note: Presence is now managed by XState machine with its own persistence
  // in XMPPProvider (key: 'fluux:presence-machine')
}

/**
 * Saves profile data (avatar hash, nickname) to sessionStorage.
 */
export function saveProfile(ownAvatarHash: string | null, ownNickname: string | null, jid?: string | null): void {
  const data: ProfileData = { ownAvatarHash, ownNickname }
  setScopedSessionItem(PROFILE_KEY, JSON.stringify(data), jid)
}

/**
 * Gets stored profile data.
 */
export function getSavedProfile(jid?: string | null): ProfileData | null {
  try {
    const stored = getScopedSessionItem(PROFILE_KEY, jid)
    if (!stored) return null
    return JSON.parse(stored) as ProfileData
  } catch {
    return null
  }
}

/**
 * Saves own resources (other connected devices) to sessionStorage.
 * Map is converted to array of entries for JSON serialization.
 */
export function saveOwnResources(ownResources: Map<string, ResourcePresence>, jid?: string | null): void {
  // Convert Map to array of entries, and Date to ISO string
  const serializable = Array.from(ownResources.entries()).map(([key, resource]) => [
    key,
    {
      ...resource,
      lastInteraction: resource.lastInteraction?.toISOString(),
    },
  ])
  setScopedSessionItem(OWN_RESOURCES_KEY, JSON.stringify(serializable), jid)
}

/**
 * Gets stored own resources.
 */
export function getSavedOwnResources(jid?: string | null): Map<string, ResourcePresence> | null {
  try {
    const stored = getScopedSessionItem(OWN_RESOURCES_KEY, jid)
    if (!stored) return null
     
    const parsed = JSON.parse(stored) as Array<[string, any]>
    // Convert array back to Map, and ISO strings back to Date
    return new Map(
      parsed.map(([key, resource]) => [
        key,
        {
          ...resource,
          lastInteraction: resource.lastInteraction ? new Date(resource.lastInteraction) : undefined,
        },
      ])
    )
  } catch {
    return null
  }
}

/**
 * Saves view state to sessionStorage.
 * Called when view state changes to restore UI on page reload.
 */
export function saveViewState(viewState: ViewStateData, jid?: string | null): void {
  setScopedSessionItem(VIEW_STATE_KEY, JSON.stringify(viewState), jid)
}

/**
 * Gets stored view state.
 */
export function getSavedViewState(jid?: string | null): ViewStateData | null {
  try {
    const stored = getScopedSessionItem(VIEW_STATE_KEY, jid)
    if (!stored) return null
    return JSON.parse(stored) as ViewStateData
  } catch {
    return null
  }
}

/**
 * Saves roster state to sessionStorage.
 * Called when contacts change to preserve presence across page reloads.
 * Note: Map objects need to be converted to arrays for JSON serialization.
 */
export function saveRoster(contacts: Contact[], jid?: string | null): void {
  // Convert Map to array of entries for JSON serialization
  const serializable = contacts.map((contact) => ({
    ...contact,
    resources: contact.resources ? Array.from(contact.resources.entries()) : undefined,
  }))
  setScopedSessionItem(ROSTER_KEY, JSON.stringify(serializable), jid)
}

/**
 * Gets stored roster state.
 */
export function getSavedRoster(jid?: string | null): Contact[] | null {
  try {
    const stored = getScopedSessionItem(ROSTER_KEY, jid)
    if (!stored) return null
     
    const parsed = JSON.parse(stored) as Array<Contact & { resources?: [string, any][] }>
    // Convert array of entries back to Map, and ISO strings back to Date objects
    // Also convert Date objects inside nested resources (for lastInteraction in ResourcePresence)
    return parsed.map((contact) => ({
      ...contact,
      resources: contact.resources
        ? new Map(
            contact.resources.map(([key, resource]) => [
              key,
              {
                ...resource,
                lastInteraction: resource.lastInteraction ? new Date(resource.lastInteraction) : undefined,
              },
            ])
          )
        : undefined,
      lastInteraction: contact.lastInteraction ? new Date(contact.lastInteraction) : undefined,
      lastSeen: contact.lastSeen ? new Date(contact.lastSeen) : undefined,
    })) as Contact[]
  } catch {
    return null
  }
}

/**
 * Serializable room message for sessionStorage.
 * Date fields are converted to ISO strings.
 */
interface SerializableRoomMessage extends Omit<RoomMessage, 'timestamp' | 'retractedAt'> {
  timestamp: string
  retractedAt?: string
}

/**
 * Maximum number of messages to persist per room.
 * Matches ejabberd default history on join.
 */
const MAX_MESSAGES_PER_ROOM = 50

/**
 * Serializable room state for sessionStorage.
 * Includes last N messages and excludes transient state like typingUsers.
 */
interface SerializableRoom {
  jid: string
  name: string
  nickname: string
  joined: boolean
  subject?: string
  avatarHash?: string
  occupants: [string, RoomOccupant][]
  selfOccupant?: RoomOccupant
  unreadCount: number
  mentionsCount: number
  isBookmarked: boolean
  autojoin?: boolean
  password?: string
  notifyAll?: boolean
  notifyAllPersistent?: boolean
  lastReadAt?: string
  isQuickChat?: boolean
  messages: SerializableRoomMessage[]
}

/**
 * Serialize a room message for storage, converting Date objects to ISO strings.
 */
function serializeRoomMessage(message: RoomMessage): SerializableRoomMessage {
  return {
    ...message,
    timestamp: message.timestamp.toISOString(),
    retractedAt: message.retractedAt?.toISOString(),
  }
}

/**
 * Saves room state to sessionStorage.
 * Called when room state changes to preserve it across page reloads.
 * Includes the last 50 messages per room to restore context on reload.
 */
export function saveRooms(rooms: Map<string, Room>, jid?: string | null): void {
  const serializable: SerializableRoom[] = Array.from(rooms.values()).map((room) => ({
    jid: room.jid,
    name: room.name,
    nickname: room.nickname,
    joined: room.joined,
    subject: room.subject,
    avatarHash: room.avatarHash,
    occupants: Array.from(room.occupants.entries()),
    selfOccupant: room.selfOccupant,
    unreadCount: room.unreadCount,
    mentionsCount: room.mentionsCount,
    isBookmarked: room.isBookmarked,
    autojoin: room.autojoin,
    password: room.password,
    notifyAll: room.notifyAll,
    notifyAllPersistent: room.notifyAllPersistent,
    lastReadAt: room.lastReadAt?.toISOString(),
    isQuickChat: room.isQuickChat,
    // Persist last N messages for context on reload (like history on fresh join)
    messages: room.messages.slice(-MAX_MESSAGES_PER_ROOM).map(serializeRoomMessage),
  }))
  setScopedSessionItem(ROOMS_KEY, JSON.stringify(serializable), jid)
}

/**
 * Deserialize a room message from storage, converting ISO strings back to Date objects.
 */
function deserializeRoomMessage(message: SerializableRoomMessage): RoomMessage {
  return {
    ...message,
    timestamp: new Date(message.timestamp),
    retractedAt: message.retractedAt ? new Date(message.retractedAt) : undefined,
  }
}

/**
 * Gets stored room state.
 */
export function getSavedRooms(jid?: string | null): Room[] | null {
  try {
    const stored = getScopedSessionItem(ROOMS_KEY, jid)
    if (!stored) return null
    const parsed = JSON.parse(stored) as SerializableRoom[]
    return parsed.map((room) => ({
      ...room,
      occupants: new Map(room.occupants),
      typingUsers: new Set<string>(),
      // Restore messages with Date objects
      messages: (room.messages || []).map(deserializeRoomMessage),
      avatar: undefined, // Will be restored from cache via avatarHash
      lastReadAt: room.lastReadAt ? new Date(room.lastReadAt) : undefined,
    })) as Room[]
  } catch {
    return null
  }
}

/**
 * Server discovery state for sessionStorage.
 */
interface ServerDiscoveryData {
  serverInfo: ServerInfo | null
  httpUploadService: HttpUploadService | null
}

/**
 * Saves server discovery state to sessionStorage.
 */
export function saveServerInfo(serverInfo: ServerInfo | null, httpUploadService: HttpUploadService | null, jid?: string | null): void {
  const data: ServerDiscoveryData = { serverInfo, httpUploadService }
  setScopedSessionItem(SERVER_INFO_KEY, JSON.stringify(data), jid)
}

/**
 * Gets stored server discovery state.
 */
export function getSavedServerInfo(jid?: string | null): ServerDiscoveryData | null {
  try {
    const stored = getScopedSessionItem(SERVER_INFO_KEY, jid)
    if (!stored) return null
    return JSON.parse(stored) as ServerDiscoveryData
  } catch {
    return null
  }
}

/**
 * Gets stored session credentials.
 */
export function getSession(jid?: string | null): SessionData | null {
  try {
    const stored = getScopedSessionItem(SESSION_KEY, jid)
    if (!stored) return null
    const parsed = JSON.parse(stored) as SessionData
    setActiveSessionJid(parsed.jid)
    return parsed
  } catch {
    return null
  }
}

/**
 * Hook to auto-reconnect on page reload if session exists.
 * Uses sessionStorage which persists across reload but clears when tab closes.
 * Supports XEP-0198 Stream Management for faster session resumption.
 */
export function useSessionPersistence(): void {
  const { i18n } = useTranslation()
  const { client } = useXMPPContext()
  // NOTE: Only subscribe to status - we need this to gate effects.
  // All other values are read via getState() to avoid render loops during connection
  // when serverInfo, httpUploadService, ownAvatarHash, etc. update frequently.
  const status = useConnectionStore((s) => s.status)
  // NOTE: We intentionally do NOT subscribe to contacts or rooms Maps here.
  // Subscribing to entire Maps causes render loops during connection when many
  // contacts/rooms are loaded. Instead, we access them via .getState() when
  // needed (in beforeunload handler) and save periodically with an interval.
  const setContacts = useRosterStore((s) => s.setContacts)
  const setServerInfo = useConnectionStore((s) => s.setServerInfo)
  const setHttpUploadService = useConnectionStore((s) => s.setHttpUploadService)
  const setOwnNickname = useConnectionStore((s) => s.setOwnNickname)
  const updateOwnResource = useConnectionStore((s) => s.updateOwnResource)
  const addRoom = useRoomStore((s) => s.addRoom)
  const attemptedRef = useRef(false)
  const isResumptionRef = useRef(false)

  // Wrap connect in useCallback for stability
  const connect = useCallback(
    async (
      jid: string,
      password: string,
      server: string,
      smState?: { id: string; inbound: number },
      resource?: string,
      lang?: string,
      disableSmKeepalive?: boolean
    ) => {
      connectionStore.getState().setStatus('connecting')
      connectionStore.getState().setError(null)
      try {
        await client.connect({ jid, password, server, resource, smState, lang, disableSmKeepalive })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Connection failed'
        connectionStore.getState().setStatus('error')
        connectionStore.getState().setError(message)
        throw err
      }
    },
    [client]
  )

  // Note: SM state is now managed by SDK's storage adapter.
  // The SDK automatically loads SM state on connect and persists it on enable/resume.

  // Restore avatar from cache without subscribing to store
  const restoreOwnAvatarFromCache = useCallback(
    async (avatarHash: string) => {
      return client.profile.restoreOwnAvatarFromCache(avatarHash)
    },
    [client]
  )

  // Auto-reconnect on page reload
  useEffect(() => {
    // Only attempt once, and only if disconnected
    if (attemptedRef.current || status !== 'disconnected') return

    const session = getSession()
    if (session) {
      attemptedRef.current = true
      isResumptionRef.current = true

      // Note: SM state is now managed by SDK's storage adapter.
      // The SDK will automatically load SM state and attempt resumption.
      // We restore cached state here in case SM resumption succeeds (server sends deltas only).

      // Restore roster (for SM resumption case where server sends deltas)
      const savedRoster = getSavedRoster(session.jid)
      if (savedRoster && savedRoster.length > 0) {
        setContacts(savedRoster)
      }

      // Restore rooms (bookmarks, join status, occupants)
      const savedRooms = getSavedRooms(session.jid)
      if (savedRooms && savedRooms.length > 0) {
        savedRooms.forEach((room) => addRoom(room))
      }

      // Restore server discovery info
      const savedServerInfo = getSavedServerInfo(session.jid)
      if (savedServerInfo) {
        if (savedServerInfo.serverInfo) {
          setServerInfo(savedServerInfo.serverInfo)
        }
        if (savedServerInfo.httpUploadService) {
          setHttpUploadService(savedServerInfo.httpUploadService)
        }
      }

      // Note: Presence state is now restored by XState machine's native persistence
      // in XMPPProvider (key: 'fluux:presence-machine')

      // Restore profile data (nickname, avatar from cache)
      const savedProfile = getSavedProfile(session.jid)
      if (savedProfile) {
        if (savedProfile.ownNickname) {
          setOwnNickname(savedProfile.ownNickname)
        }
        if (savedProfile.ownAvatarHash) {
          // Restore avatar blob URL from IndexedDB cache
          restoreOwnAvatarFromCache(savedProfile.ownAvatarHash).catch(() => {
            // Avatar not in cache, will be fetched on next fresh connect
          })
        }
      }

      // Restore own resources (other connected devices)
      const savedOwnResources = getSavedOwnResources(session.jid)
      if (savedOwnResources && savedOwnResources.size > 0) {
        savedOwnResources.forEach((resource, resourceKey) => {
          updateOwnResource(resourceKey, resource.show, resource.priority, resource.status, resource.lastInteraction, resource.client)
        })
      }

      // Auto-reconnect with stored credentials
      // Note: SDK automatically loads SM state from storage and attempts resumption
      const resource = getResource()
      const disableSmKeepalive = isTauri()
      console.log('[SM] Reconnecting on page reload, SDK will handle SM resumption')
      connect(session.jid, session.password, session.server, undefined, resource, i18n.language, disableSmKeepalive).catch((err) => {
        console.log('[SM] Reconnection failed:', err?.message || err)
        // If auto-reconnect fails, clear session
        clearSession()
        isResumptionRef.current = false
      })
    }
  }, [status, connect, setContacts, i18n.language])

  // Note: Presence sync is now handled automatically by XState's native persistence
  // in XMPPProvider. The machine state is restored from sessionStorage on init.

  // Reset isResumptionRef when disconnected
  useEffect(() => {
    if (status === 'disconnected') {
      isResumptionRef.current = false
    }
  }, [status])

  // Note: SM state persistence is now handled by SDK's storage adapter.
  // The SDK automatically persists SM state on enable/resume and before page unload.

  // Save roster and rooms periodically while online
  // We use an interval instead of subscribing to contacts/rooms Maps to avoid
  // render loops during connection when many contacts/rooms are loaded.
  useEffect(() => {
    if (status !== 'online') return

    // Helper to save current state
    const saveCurrentState = () => {
      const state = connectionStore.getState()
      const scopeJid = state.jid

      const contacts = rosterStore.getState().contacts
      const contactsArray = Array.from(contacts.values())
      if (contactsArray.length > 0) {
        saveRoster(contactsArray, scopeJid)
      }

      const rooms = roomStore.getState().rooms
      if (rooms.size > 0) {
        saveRooms(rooms, scopeJid)
      }
    }

    // Save immediately on connect
    saveCurrentState()

    // Save periodically (every 30 seconds)
    const interval = setInterval(saveCurrentState, 30000)

    // Also save on beforeunload for immediate state capture
    const handleUnload = () => saveCurrentState()
    window.addEventListener('beforeunload', handleUnload)
    window.addEventListener('pagehide', handleUnload)

    return () => {
      clearInterval(interval)
      window.removeEventListener('beforeunload', handleUnload)
      window.removeEventListener('pagehide', handleUnload)
    }
  }, [status])

  // Note: Presence state is now saved automatically by XState's native persistence
  // in XMPPProvider, so we don't need to save it here manually.

  // Save profile, own resources, and server info periodically while online
  // NOTE: We use an interval instead of reactive effects because subscribing to
  // ownAvatarHash, ownNickname, ownResources, serverInfo, httpUploadService
  // causes App to re-render on every change, which cascades to ChatLayout and
  // causes render loops during connection when these values update frequently.
  useEffect(() => {
    if (status !== 'online') return

    // Save immediately on becoming online
    const saveAll = () => {
      const connectionState = connectionStore.getState()
      saveProfile(connectionState.ownAvatarHash, connectionState.ownNickname, connectionState.jid)
      if (connectionState.ownResources.size > 0) {
        saveOwnResources(connectionState.ownResources, connectionState.jid)
      }
      if (connectionState.serverInfo || connectionState.httpUploadService) {
        saveServerInfo(connectionState.serverInfo, connectionState.httpUploadService, connectionState.jid)
      }
    }

    saveAll()

    // Save periodically (every 30 seconds) to catch updates
    const interval = setInterval(saveAll, 30000)

    return () => clearInterval(interval)
  }, [status])
}

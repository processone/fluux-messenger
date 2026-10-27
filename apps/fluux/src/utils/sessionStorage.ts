import { connectionStore, getBareJid } from '@fluux/sdk'
import type { Contact, ServerInfo, HttpUploadService, ResourcePresence } from '@fluux/sdk'

const SESSION_KEY = 'xmpp-session'
const ROSTER_KEY = 'xmpp-roster'
const SERVER_INFO_KEY = 'xmpp-server-info'
const VIEW_STATE_KEY = 'xmpp-view-state'
const PROFILE_KEY = 'xmpp-profile'
const OWN_RESOURCES_KEY = 'xmpp-own-resources'
const ACTIVE_SESSION_JID_KEY = 'xmpp-active-session-jid'

const SCOPED_SESSION_KEYS = [
  SESSION_KEY,
  ROSTER_KEY,
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

export interface SessionData {
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
  sidebarView: 'messages' | 'rooms' | 'contacts' | 'admin' | 'settings' | 'search'
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
 * Normalizes legacy/removed view names to valid current views on read,
 * so stale sessionStorage values never surface a removed view type.
 */
export function getSavedViewState(jid?: string | null): ViewStateData | null {
  try {
    const stored = getScopedSessionItem(VIEW_STATE_KEY, jid)
    if (!stored) return null
    const parsed = JSON.parse(stored) as { sidebarView: string } & Omit<ViewStateData, 'sidebarView'>
    // Normalize removed view names to 'messages' (forward compat)
    if (parsed.sidebarView === 'archive' || parsed.sidebarView === 'events') {
      parsed.sidebarView = 'messages'
    }
    // Normalize the old 'directory' view key to its current name 'contacts'
    if (parsed.sidebarView === 'directory') {
      parsed.sidebarView = 'contacts'
    }
    return parsed as ViewStateData
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

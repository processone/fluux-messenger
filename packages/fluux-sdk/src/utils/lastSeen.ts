import type { Contact, PresenceStatus } from '../core'

/**
 * Format a duration in milliseconds to a human-readable string
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

/**
 * Format idle duration (how long since last interaction)
 */
function formatIdleDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)

  if (minutes < 1) return 'active'
  if (minutes < 60) return `idle ${minutes}m`
  if (hours < 24) return `idle ${hours}h`
  return `idle ${Math.floor(hours / 24)}d`
}

export interface LastSeenInfo {
  /** Short text for display (e.g., "Active now", "Idle 15m", "Last seen 2h ago") */
  text: string
  /** Whether the contact is currently active (online and not idle) */
  isActive: boolean
  /** The idle duration in milliseconds (if idle) */
  idleDuration?: number
  /** The last seen duration in milliseconds (if offline) */
  lastSeenDuration?: number
}

/**
 * Get last seen information for a contact
 */
export function getLastSeenInfo(contact: Contact): LastSeenInfo {
  const now = Date.now()

  // Online contacts
  if (contact.presence !== 'offline') {
    if (contact.lastInteraction) {
      const idleDuration = now - contact.lastInteraction.getTime()
      // Consider "active" if idle less than 1 minute
      if (idleDuration < 60000) {
        return { text: 'Active now', isActive: true }
      }
      return {
        text: formatIdleDuration(idleDuration),
        isActive: false,
        idleDuration,
      }
    }
    // No idle info means actively using device
    return { text: 'Active now', isActive: true }
  }

  // Offline contacts
  if (contact.lastSeen) {
    const lastSeenDuration = now - contact.lastSeen.getTime()
    return {
      text: `Last seen ${formatDuration(lastSeenDuration)}`,
      isActive: false,
      lastSeenDuration,
    }
  }

  return { text: 'Offline', isActive: false }
}

/**
 * Get a simple presence label with optional activity info
 */
export function getPresenceLabel(presence: PresenceStatus): string {
  switch (presence) {
    case 'online': return 'Online'
    case 'away': return 'Away'
    case 'dnd': return 'Do not disturb'
    case 'offline': return 'Offline'
  }
}

/**
 * Get a combined status string for display in tooltips
 * Format: "Online · Active now" or "Away · idle 15m" or "Offline · Last seen 2h ago"
 */
export function getStatusText(contact: Contact): string {
  const presenceLabel = getPresenceLabel(contact.presence)
  const lastSeenInfo = getLastSeenInfo(contact)

  if (contact.presence === 'offline') {
    return lastSeenInfo.text
  }

  if (lastSeenInfo.isActive) {
    return presenceLabel
  }

  return `${presenceLabel} · ${lastSeenInfo.text}`
}

import type { MediaAutoDownload } from '@/stores/settingsStore'

/**
 * Trust level of the conversation a message belongs to. Determines, together
 * with the user's MediaAutoDownload policy, whether media auto-fetches.
 */
export type ConversationTrust =
  | 'direct-contact'   // 1:1 with a roster contact
  | 'direct-stranger'  // 1:1 with a non-contact: media NEVER auto-loads
  | 'room-private'     // members-only / hidden room
  | 'room-public'      // open / public room

/**
 * Whether media should auto-fetch on render for a conversation.
 *
 * Strangers are a hard floor: their media never auto-loads, even under the
 * 'always' policy (a direct message from an unknown JID is the strongest sign
 * of targeting). The user can always tap to load an individual item.
 */
export function computeMediaAutoload(policy: MediaAutoDownload, trust: ConversationTrust): boolean {
  if (trust === 'direct-stranger') return false
  if (policy === 'always') return true
  if (policy === 'never') return false
  // 'private-only': load everywhere except public rooms.
  return trust !== 'room-public'
}

/**
 * URLs the user explicitly tapped to load this session. Mirrors the
 * module-level `failedUrlCache` in FileAttachments: survives bubble
 * unmount/remount during scroll, but not an app restart.
 */
const approvedUrls = new Set<string>()
export function approveMediaUrl(url: string): void { approvedUrls.add(url) }
export function isMediaUrlApproved(url: string): boolean { return approvedUrls.has(url) }

/** Test-only: clear the session set between tests. */
export function __resetApprovedMediaUrlsForTest(): void { approvedUrls.clear() }

/**
 * Message archive preference type definitions (XEP-0313).
 *
 * @packageDocumentation
 * @module Types/Archive
 */

/**
 * Default archiving policy for messages to or from JIDs not listed in
 * {@link ArchivingPreferences.always} or {@link ArchivingPreferences.never}
 * (XEP-0313 §6).
 *
 * - `always`: archive every message
 * - `never`: archive no message
 * - `roster`: archive only messages exchanged with roster contacts
 *
 * @category MAM
 */
export type ArchivingDefault = 'always' | 'never' | 'roster'

/**
 * The account's server-side archiving preferences (XEP-0313 §6).
 *
 * @category MAM
 */
export interface ArchivingPreferences {
  /** Policy for JIDs listed in neither `always` nor `never` */
  default: ArchivingDefault
  /** Bare JIDs whose messages are always archived */
  always: string[]
  /** Bare JIDs whose messages are never archived */
  never: string[]
}

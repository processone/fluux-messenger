/**
 * Decides where the admin header back button should step to.
 *
 * The admin area is a stack: overview (home) → list → detail/session.
 * On mobile the single header back arrow must step back exactly one level.
 * From a section list it returns to the overview; only the overview (or no
 * category) exits admin. This keeps that decision in one place.
 */
import type { AdminCategory } from '@fluux/sdk'

export type AdminBackTarget = 'session' | 'user' | 'room' | 'overview' | 'exit'

export function getAdminBackTarget(state: {
  hasSession: boolean
  hasSelectedUser: boolean
  hasSelectedRoom: boolean
  activeCategory: AdminCategory | null
}): AdminBackTarget {
  if (state.hasSession) return 'session'
  if (state.hasSelectedUser) return 'user'
  if (state.hasSelectedRoom) return 'room'
  if (state.activeCategory === 'users' || state.activeCategory === 'rooms') return 'overview'
  return 'exit'
}

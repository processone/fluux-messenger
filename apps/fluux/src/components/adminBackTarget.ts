/**
 * Decides where the admin header back button should step to.
 *
 * The admin area is a stack: root (category sidebar) → list → detail/session.
 * On mobile the single header back arrow must step back exactly one level,
 * not collapse straight to the root. This keeps that decision in one place.
 */
export type AdminBackTarget = 'session' | 'user' | 'room' | 'exit'

export function getAdminBackTarget(state: {
  hasSession: boolean
  hasSelectedUser: boolean
  hasSelectedRoom: boolean
}): AdminBackTarget {
  if (state.hasSession) return 'session'
  if (state.hasSelectedUser) return 'user'
  if (state.hasSelectedRoom) return 'room'
  return 'exit'
}

import { create } from 'zustand'

/**
 * A request to open a contact's Security details when their profile shows.
 *
 * The held-keys notice in a conversation asks for it, then opens the
 * contact's profile; the profile opens Security details for that contact and
 * clears the request.
 */
interface ContactSecurityRequestState {
  /** The contact whose Security details should open, if any. */
  jid: string | null
  requestContactSecurity: (jid: string) => void
  clearContactSecurityRequest: () => void
}

export const useContactSecurityRequestStore = create<ContactSecurityRequestState>((set) => ({
  jid: null,
  requestContactSecurity: (jid) => set({ jid }),
  clearContactSecurityRequest: () => set({ jid: null }),
}))

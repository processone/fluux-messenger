/**
 * In-memory session passphrase store for the web E2EE plugin.
 *
 * The passphrase lives exclusively in module memory — it is never written
 * to localStorage, IndexedDB, or any other persistent storage. A page
 * reload or tab close clears it, and the user must re-enter it on the
 * next session. This is intentional: the passphrase is the sole
 * protection for the private key stored in IndexedDB, and keeping it
 * off disk prevents a storage compromise from escalating to a key
 * compromise without user interaction.
 *
 * On web, this passphrase is used both to decrypt the private key from
 * IndexedDB at session start AND to encrypt the private key before
 * storing it (initial key generation or backup restore).
 */

let sessionPassphrase: string | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Set the session passphrase. Call after the user enters it in the unlock dialog. */
export function setSessionPassphrase(pp: string): void {
  sessionPassphrase = pp
  notify()
}

/** Get the current session passphrase, or `null` if not yet unlocked. */
export function getSessionPassphrase(): string | null {
  return sessionPassphrase
}

/** Clear the session passphrase (e.g. on logout). */
export function clearSessionPassphrase(): void {
  sessionPassphrase = null
  notify()
}

/** Returns true when the session passphrase has not been set this session. */
export function isKeyLocked(): boolean {
  return sessionPassphrase === null
}

/**
 * Subscribe to lock-state changes. Listener fires whenever the session
 * passphrase is set or cleared. Returns an unsubscribe function.
 *
 * Intended for {@link useSyncExternalStore}-based React hooks: callers
 * read the current state via {@link isKeyLocked} and rely on this
 * subscription to trigger re-renders when the state flips.
 */
export function subscribeKeyLockState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

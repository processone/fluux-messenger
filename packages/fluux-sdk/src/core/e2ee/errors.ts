/**
 * Typed errors raised by E2EE plugins across the Tauri/WASM/native boundary.
 *
 * Plugins sit on top of external runtimes (OS keychain, KDF, IPC) whose
 * failures fall into two buckets that the host and the UI treat very
 * differently:
 *
 * - **transient** — a retry has a reasonable chance of succeeding. Examples:
 *   keychain briefly locked behind a biometric prompt, an IPC timeout, a
 *   network hiccup while fetching a peer's PEP node, a server that hasn't
 *   finished starting up.
 * - **permanent** — retrying won't help. Examples: the key file was deleted
 *   outside the app, a supplied backup passphrase doesn't decrypt the TSK,
 *   the server genuinely doesn't support PEP (XEP-0163).
 *
 * The host itself never inspects the `kind` — plugins classify so the app
 * layer can pick the right UX: re-unlock prompt vs "key lost" recovery flow
 * vs silent retry. The typing is advisory: a plugin that can't tell may
 * throw a plain `Error` and the caller must treat it as transient.
 */
export type E2EEErrorKind = 'transient' | 'permanent'

/**
 * Error thrown by a plugin when a Tauri/IPC/keychain/network operation
 * fails. `kind` lets the UI decide between "retry" and "recover"; `code` is
 * a short machine-readable slug (`'keychain-locked'`, `'key-missing'`,
 * `'wrong-passphrase'`, `'network'`, `'pep-unsupported'`, …) that the app
 * layer can switch on. The slug set is not enumerated here on purpose —
 * plugins define their own so new classifications don't need SDK releases.
 */
export class E2EEPluginError extends Error {
  readonly kind: E2EEErrorKind
  readonly code: string
  override readonly cause?: unknown

  constructor(kind: E2EEErrorKind, code: string, message: string, cause?: unknown) {
    super(message)
    this.name = 'E2EEPluginError'
    this.kind = kind
    this.code = code
    if (cause !== undefined) this.cause = cause
  }

  /** True when a retry of the failing operation could plausibly succeed. */
  isTransient(): boolean {
    return this.kind === 'transient'
  }
}

/**
 * Type guard so call sites can discriminate without `instanceof` leaking
 * the class across bundle boundaries (important for apps that load the
 * SDK twice by accident, e.g. in tests).
 */
export function isE2EEPluginError(err: unknown): err is E2EEPluginError {
  return (
    err instanceof Error &&
    err.name === 'E2EEPluginError' &&
    typeof (err as { kind?: unknown }).kind === 'string' &&
    typeof (err as { code?: unknown }).code === 'string'
  )
}

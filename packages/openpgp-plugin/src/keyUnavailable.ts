import { E2EEPluginError } from '@fluux/sdk'

/**
 * True when an error means the local secret key was not usable (locked, or
 * unrecoverable / recovering) — as opposed to a genuine cryptographic failure.
 * Used to avoid mistaking "the key could not run" for "trust data was tampered".
 */
export function isSecretKeyUnavailableError(err: unknown): boolean {
  return (
    err instanceof E2EEPluginError &&
    (err.code === 'key-unrecoverable' || err.code === 'key-locked')
  )
}

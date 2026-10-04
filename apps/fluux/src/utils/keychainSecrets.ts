/**
 * Per-account secrets in the OS keychain, through the native host's
 * `get_secret` / `set_secret` / `delete_secret` commands.
 */

export type SecretKind = 'fast-token'

export interface SecretStore {
  get(kind: SecretKind, jid: string): Promise<string | null>
  set(kind: SecretKind, jid: string, secret: string): Promise<void>
  delete(kind: SecretKind, jid: string): Promise<void>
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export const keychainSecrets: SecretStore = {
  get: (kind, jid) => invoke<string | null>('get_secret', { kind, jid }),
  set: (kind, jid, secret) => invoke<void>('set_secret', { kind, jid, secret }),
  delete: (kind, jid) => invoke<void>('delete_secret', { kind, jid }),
}

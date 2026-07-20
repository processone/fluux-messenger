import type { StorageBackend } from '@fluux/sdk'

type InvokeFn = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>

function toB64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * StorageBackend that seals E2EE plugin bytes at rest via the Rust
 * keychain-backed store (Tauri commands). Values cross IPC as base64.
 *
 * Tauri v2 auto-converts camelCase JS argument keys to the Rust
 * command's snake_case params, so the `put` payload is sent as
 * `valueB64` (which the Rust side receives as `value_b64`).
 */
export class TauriKeychainStorageBackend implements StorageBackend {
  private invokePromise: Promise<InvokeFn> | null = null
  constructor(
    private readonly accountJid: string,
    private readonly injectedInvoke?: InvokeFn,
    private readonly storeName?: string,
  ) {}

  private async invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    if (this.injectedInvoke) return this.injectedInvoke<T>(cmd, args)
    if (!this.invokePromise) this.invokePromise = import('@tauri-apps/api/core').then((m) => m.invoke as InvokeFn)
    const invoke = await this.invokePromise
    return invoke<T>(cmd, args)
  }

  /** Command args shared by every call: account, plus `store` when this
   *  backend owns a dedicated sealed file. Omitting `store` resolves to the
   *  legacy `<jid>.json` on the Rust side. */
  private baseArgs(): Record<string, unknown> {
    return this.storeName === undefined
      ? { account: this.accountJid }
      : { account: this.accountJid, store: this.storeName }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const b64 = await this.invoke<string | null>('e2ee_store_get', { ...this.baseArgs(), key })
    return b64 == null ? null : fromB64(b64)
  }
  async put(key: string, value: Uint8Array): Promise<void> {
    await this.invoke<void>('e2ee_store_put', { ...this.baseArgs(), key, valueB64: toB64(value) })
  }
  async delete(key: string): Promise<void> {
    await this.invoke<void>('e2ee_store_delete', { ...this.baseArgs(), key })
  }
  async list(prefix: string): Promise<string[]> {
    return this.invoke<string[]>('e2ee_store_list', { ...this.baseArgs(), prefix })
  }
}

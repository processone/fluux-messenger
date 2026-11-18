/**
 * `localStorage`-backed implementation of the SDK's {@link StorageBackend},
 * for the OpenPGP plugin on desktop and iOS.
 *
 * There the secret key lives in the OS keychain, so the plugin keeps only its
 * trust decisions and their seal in plugin storage. Without a persistent
 * backend those would live in memory and be lost at every restart. The app
 * already keeps its other settings in `localStorage` on these platforms.
 *
 * One key range per account JID: `fluux-e2ee-store:<jid>:<key>`, so two
 * accounts never read each other's data. Keys are URI-encoded (plugin storage
 * keys carry a NUL separator) and values are base64.
 */

import type { StorageBackend } from '@fluux/sdk'

const KEY_BASE = 'fluux-e2ee-store'

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

export class LocalStorageStorageBackend implements StorageBackend {
  private readonly prefix: string

  constructor(accountJid: string) {
    this.prefix = `${KEY_BASE}:${accountJid}:`
  }

  private itemKey(key: string): string {
    return this.prefix + encodeURIComponent(key)
  }

  async get(key: string): Promise<Uint8Array | null> {
    const raw = localStorage.getItem(this.itemKey(key))
    return raw === null ? null : fromBase64(raw)
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    localStorage.setItem(this.itemKey(key), toBase64(value))
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(this.itemKey(key))
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const item = localStorage.key(i)
      if (!item?.startsWith(this.prefix)) continue
      let key: string
      try {
        key = decodeURIComponent(item.slice(this.prefix.length))
      } catch {
        continue
      }
      if (key.startsWith(prefix)) out.push(key)
    }
    return out
  }
}

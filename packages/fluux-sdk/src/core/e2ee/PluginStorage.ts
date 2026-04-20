import type { PluginStorage } from './types'

/**
 * Backing storage the host uses to persist plugin state. Designed so the
 * host can swap implementations (in-memory for tests, IndexedDB for web,
 * native secure storage for desktop) without plugins noticing.
 */
export interface StorageBackend {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

/**
 * Minimal in-memory backend. Used for tests and for host bootstrapping
 * before a real storage adapter is wired in. Not safe for key material
 * in production — callers must provide a persistent/secure backend.
 */
export class InMemoryStorageBackend implements StorageBackend {
  private readonly data = new Map<string, Uint8Array>()

  async get(key: string): Promise<Uint8Array | null> {
    const value = this.data.get(key)
    return value ? new Uint8Array(value) : null
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.data.set(key, new Uint8Array(value))
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) out.push(key)
    }
    return out
  }
}

/**
 * Creates a namespaced {@link PluginStorage} view over a shared backend.
 * The namespace is prefixed to every key so plugins cannot read or overwrite
 * each other's data, even by accident.
 */
export function createPluginStorage(
  backend: StorageBackend,
  namespace: string,
): PluginStorage {
  if (!namespace || namespace.includes('\0')) {
    throw new Error(`Invalid plugin storage namespace: ${JSON.stringify(namespace)}`)
  }
  const prefix = `${namespace}\u0000`

  return {
    get: (key) => backend.get(prefix + key),
    put: (key, value) => backend.put(prefix + key, value),
    delete: (key) => backend.delete(prefix + key),
    list: async (keyPrefix) => {
      const full = await backend.list(prefix + keyPrefix)
      return full.map((k) => k.slice(prefix.length))
    },
  }
}

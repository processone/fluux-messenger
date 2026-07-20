import type { PluginStorage } from '@fluux/sdk'

export function memStorage(seed?: Record<string, Uint8Array>): PluginStorage {
  const m = new Map<string, Uint8Array>(Object.entries(seed ?? {}))
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
  }
}

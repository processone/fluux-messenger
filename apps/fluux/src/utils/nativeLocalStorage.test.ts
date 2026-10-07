import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootNativeLocalStorage,
  installNativeLocalStorage,
  isWebviewOnlyKey,
  type InstalledNativeStorage,
  type NativeStorageBackend,
  type StorageChange,
} from './nativeLocalStorage'

/**
 * A Storage whose methods live on its prototype, as the browser's do. The
 * suite's global localStorage is a plain-object mock, so each test builds a
 * pair sharing one prototype: the webview's localStorage and sessionStorage.
 */
function storagePair(): [Storage, Storage] {
  class MemoryStorage {
    private items = new Map<string, string>()
    get length() { return this.items.size }
    getItem(key: string) { return this.items.get(key) ?? null }
    setItem(key: string, value: string) { this.items.set(key, String(value)) }
    removeItem(key: string) { this.items.delete(key) }
    clear() { this.items.clear() }
    key(index: number) { return [...this.items.keys()][index] ?? null }
  }
  return [new MemoryStorage() as unknown as Storage, new MemoryStorage() as unknown as Storage]
}

/** Native storage as the Rust side keeps it. */
function fakeBackend(initial: Record<string, string> = {}) {
  const stored = { ...initial }
  const changes: StorageChange[] = []
  const backend: NativeStorageBackend = {
    load: vi.fn(async () => ({ ...stored })),
    apply: vi.fn(async (change: StorageChange) => {
      changes.push(change)
      if (change.clear) for (const key of Object.keys(stored)) delete stored[key]
      for (const key of change.remove) delete stored[key]
      Object.assign(stored, change.set)
    }),
  }
  return { backend, stored, changes }
}

function keys(storage: Storage): string[] {
  const result: string[] = []
  for (let i = 0; i < storage.length; i++) result.push(storage.key(i)!)
  return result.sort()
}

let localStorage: Storage
let sessionStorage: Storage
let installed: InstalledNativeStorage | null = null
const install = (initial: Record<string, string>, backend: NativeStorageBackend) => {
  installed = installNativeLocalStorage(localStorage, initial, backend)
  return installed
}

beforeEach(() => {
  ;[localStorage, sessionStorage] = storagePair()
})
afterEach(() => {
  installed?.uninstall()
  installed = null
})

describe('isWebviewOnlyKey', () => {
  it.each([
    'xmpp-chat-storage',
    'xmpp-chat-storage:alice@example.com',
    'fluux-room-gaps:alice@example.com',
    'fluux-room-coverage',
    'fluux:cache-marker:alice@example.com',
    'fluux:lastArchivedPreviewCheck:alice@example.com',
    'fluux:lastRosterDiscovery',
    'fluux:msg-heights',
  ])('keeps %s with the IndexedDB cache', (key) => {
    expect(isWebviewOnlyKey(key)).toBe(true)
  })

  it.each([
    'xmpp-last-jid',
    'fluux-e2ee-pinned-primary-fingerprints:alice@example.com',
    'fluux-e2ee-trust-state-seal:alice@example.com',
    'fluux-room-drafts:alice@example.com',
    'fluux-theme',
    'fluux:user-agent-id',
    'xmpp-chat-storage-legacy',
  ])('moves %s to native storage', (key) => {
    expect(isWebviewOnlyKey(key)).toBe(false)
  })
})

describe('installNativeLocalStorage', () => {
  it('reads native entries and writes native keys to native storage only', async () => {
    const { backend, stored } = fakeBackend({ 'xmpp-last-jid': 'alice@example.com' })
    const native = install({ ...stored }, backend)

    expect(localStorage.getItem('xmpp-last-jid')).toBe('alice@example.com')
    localStorage.setItem('fluux-theme', 'dark')
    localStorage.setItem('fluux:cache-marker:alice@example.com', '1')
    await native.flush()

    expect(stored).toEqual({ 'xmpp-last-jid': 'alice@example.com', 'fluux-theme': 'dark' })
    native.uninstall()
    installed = null
    expect(localStorage.getItem('fluux-theme')).toBeNull()
    expect(localStorage.getItem('fluux:cache-marker:alice@example.com')).toBe('1')
  })

  it('sends the writes of one task as a single batch in their final state', async () => {
    const { backend, changes } = fakeBackend({ a: '0' })
    const native = install({ a: '0' }, backend)

    localStorage.setItem('b', '1')
    localStorage.setItem('b', '2')
    localStorage.removeItem('a')
    localStorage.setItem('c', '3')
    localStorage.removeItem('c')
    await native.flush()

    expect(changes).toEqual([{ clear: false, set: { b: '2' }, remove: ['a', 'c'] }])
  })

  it('moves keys written to the webview into native storage, the webview copy winning', async () => {
    localStorage.setItem('xmpp-last-jid', 'new@example.com')
    localStorage.setItem('fluux-room-gaps', '[]')
    const { backend, stored } = fakeBackend({ 'xmpp-last-jid': 'old@example.com', 'fluux-theme': 'dark' })

    const native = install({ ...stored }, backend)
    expect(localStorage.getItem('xmpp-last-jid')).toBe('new@example.com')
    await native.flush()
    await Promise.resolve()

    expect(stored).toEqual({ 'xmpp-last-jid': 'new@example.com', 'fluux-theme': 'dark' })
    native.uninstall()
    installed = null
    expect(localStorage.getItem('xmpp-last-jid')).toBeNull()
    expect(localStorage.getItem('fluux-room-gaps')).toBe('[]')
  })

  it('keeps the webview copy when the move to native storage fails', async () => {
    localStorage.setItem('xmpp-last-jid', 'alice@example.com')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const backend: NativeStorageBackend = { load: async () => ({}), apply: vi.fn(async () => { throw new Error('disk full') }) }

    const native = install({}, backend)
    await native.flush()
    await Promise.resolve()
    native.uninstall()
    installed = null

    expect(localStorage.getItem('xmpp-last-jid')).toBe('alice@example.com')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('enumerates native and webview keys once each, and clears both', async () => {
    localStorage.setItem('fluux:msg-heights', '{}')
    const { backend, stored } = fakeBackend({ 'fluux-theme': 'dark' })
    const native = install({ ...stored }, backend)
    localStorage.setItem('xmpp-last-jid', 'alice@example.com')

    expect(keys(localStorage)).toEqual(['fluux-theme', 'fluux:msg-heights', 'xmpp-last-jid'])
    expect(localStorage.key(99)).toBeNull()

    localStorage.clear()
    await native.flush()
    expect(localStorage.length).toBe(0)
    expect(stored).toEqual({})
  })

  it('leaves sessionStorage alone', () => {
    const { backend } = fakeBackend()
    install({}, backend)

    sessionStorage.setItem('xmpp-session', 'x')
    expect(sessionStorage.getItem('xmpp-session')).toBe('x')
    expect(keys(sessionStorage)).toEqual(['xmpp-session'])
    expect(backend.apply).not.toHaveBeenCalled()
    expect(localStorage.getItem('xmpp-session')).toBeNull()
  })
})

describe('bootNativeLocalStorage', () => {
  it('keeps webview storage when native storage cannot load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const apply = vi.fn()
    await bootNativeLocalStorage({ load: async () => { throw new Error('no data dir') }, apply })

    window.localStorage.setItem('xmpp-last-jid', 'alice@example.com')
    await Promise.resolve()
    expect(window.localStorage.getItem('xmpp-last-jid')).toBe('alice@example.com')
    expect(apply).not.toHaveBeenCalled()
    window.localStorage.removeItem('xmpp-last-jid')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

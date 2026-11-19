/**
 * Vitest setup: in-memory localStorage and sessionStorage, equivalent to the
 * localStorage mock in apps/fluux/src/test-setup.ts, so the moved tests see
 * the same storage behaviour in the package as in the app; and the Web Locks
 * every platform the app runs on has, which happy-dom lacks.
 */
import { vi } from 'vitest'

function createStorageMock() {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
    get length() {
      return Object.keys(store).length
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const mock = createStorageMock() as unknown as Storage
  if (typeof window === 'undefined') {
    ;(globalThis as Record<string, unknown>)[name] = mock
  } else {
    Object.defineProperty(window, name, { value: mock, configurable: true })
  }
}

/**
 * Web Locks as a browser shares them between windows of one origin: one
 * holder per name, the others wait in turn. A test stands in for another
 * window by requesting the same lock.
 */
function createLockManager() {
  const queues = new Map<string, Promise<unknown>>()
  return {
    request<T>(name: string, callback: (lock: { name: string; mode: 'exclusive' }) => T | Promise<T>): Promise<T> {
      const run = (queues.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }))
      queues.set(name, run.catch(() => {}))
      return run
    },
  }
}

if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'locks', { value: createLockManager(), configurable: true })
}

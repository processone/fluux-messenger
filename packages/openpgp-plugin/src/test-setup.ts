/**
 * Vitest setup: in-memory localStorage and sessionStorage, equivalent to the
 * localStorage mock in apps/fluux/src/test-setup.ts, so the moved tests see
 * the same storage behaviour in the package as in the app.
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

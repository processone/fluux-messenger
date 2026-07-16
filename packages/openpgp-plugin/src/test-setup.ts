/**
 * Global test setup for @fluux/openpgp-plugin.
 *
 * Node (22+) ships a built-in global `localStorage` that is inert until
 * backed by a `--localstorage-file` path, shadowing happy-dom's working
 * implementation. Replace it with a minimal in-memory `Storage` so tests
 * that persist markers/preferences via `localStorage` behave as expected.
 */

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
    get length() {
      return Object.keys(store).length
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
  writable: true,
})

import { describe, it, expect } from 'vitest'
import {
  connectionBindingMethodKeys,
  chatBindingMethodKeys,
  rosterBindingMethodKeys,
  consoleBindingMethodKeys,
  eventsBindingMethodKeys,
  roomBindingMethodKeys,
  adminBindingMethodKeys,
  blockingBindingMethodKeys,
} from './storeBindingKeys'
import { createDefaultStoreBindings } from './defaultStoreBindings'
import { createMockStores } from './test-utils'
import {
  connectionStore,
  chatStore,
  rosterStore,
  consoleStore,
  eventsStore,
  roomStore,
  adminStore,
  blockingStore,
} from '../stores'

/**
 * Guards for the derived store-bindings seam.
 *
 * The key lists in storeBindingKeys.ts are the single source of truth from
 * which the StoreBindings interface (Pick), createDefaultStoreBindings, and
 * createMockStores are all derived. These tests keep the three in lockstep —
 * previously a new store method had to be hand-added in all three places and
 * regularly wasn't.
 */
describe('store binding key lists', () => {
  const namespaces = [
    { name: 'connection', keys: connectionBindingMethodKeys, store: connectionStore },
    { name: 'chat', keys: chatBindingMethodKeys, store: chatStore },
    { name: 'roster', keys: rosterBindingMethodKeys, store: rosterStore },
    { name: 'console', keys: consoleBindingMethodKeys, store: consoleStore },
    { name: 'events', keys: eventsBindingMethodKeys, store: eventsStore },
    { name: 'room', keys: roomBindingMethodKeys, store: roomStore },
    { name: 'admin', keys: adminBindingMethodKeys, store: adminStore },
    { name: 'blocking', keys: blockingBindingMethodKeys, store: blockingStore },
  ] as const

  it.each(namespaces)('every $name key is a method on the real store', ({ keys, store }) => {
    const state = store.getState() as unknown as Record<string, unknown>
    const nonMethods = keys.filter((key) => typeof state[key] !== 'function')
    expect(nonMethods).toEqual([])
  })

  it('createDefaultStoreBindings exposes every listed method as a function', () => {
    const bindings = createDefaultStoreBindings() as unknown as Record<string, Record<string, unknown>>
    const missing: string[] = []
    for (const { name, keys } of namespaces) {
      for (const key of keys) {
        if (typeof bindings[name][key] !== 'function') missing.push(`${name}.${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('createMockStores mirrors every member of the default bindings', () => {
    const defaults = createDefaultStoreBindings() as unknown as Record<string, Record<string, unknown>>
    const mocks = createMockStores() as unknown as Record<string, Record<string, unknown>>
    const missing: string[] = []
    for (const ns of Object.keys(defaults)) {
      for (const key of Object.keys(defaults[ns])) {
        // Same membership; functions must be mocked as functions (data
        // properties like admin.selectedVhost just have to exist).
        const present = mocks[ns] && key in mocks[ns]
        const isFn = typeof defaults[ns][key] === 'function'
        if (!present || (isFn && typeof mocks[ns][key] !== 'function')) missing.push(`${ns}.${key}`)
      }
    }
    expect(missing).toEqual([])
  })
})

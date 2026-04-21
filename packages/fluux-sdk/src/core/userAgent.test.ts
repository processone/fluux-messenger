import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getOrCreateUserAgentId,
  getUserAgentId,
  clearUserAgentIdentity,
  getUserAgentDeviceName,
  setUserAgentDeviceName,
  getEffectiveDeviceName,
  buildUserAgentElement,
} from './userAgent'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STORAGE_KEY_ID = 'fluux:user-agent-id'
const STORAGE_KEY_DEVICE = 'fluux:user-agent-device'

function installLocalStorageMock(): Record<string, string> {
  const store: Record<string, string> = {}
  const mock = {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { store[k] = v }),
    removeItem: vi.fn((k: string) => { delete store[k] }),
    clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k] }),
    get length() { return Object.keys(store).length },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: mock,
    writable: true,
    configurable: true,
  })
  return store
}

function installThrowingLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
      clear: () => {},
      length: 0,
      key: () => null,
    },
    writable: true,
    configurable: true,
  })
}

describe('userAgent', () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = installLocalStorageMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------------------
  // getOrCreateUserAgentId
  // ----------------------------------------------------------------------
  describe('getOrCreateUserAgentId', () => {
    it('creates a new UUIDv4 when none is stored', () => {
      const id = getOrCreateUserAgentId()
      expect(id).toMatch(UUID_V4_RE)
      expect(store[STORAGE_KEY_ID]).toBe(id)
    })

    it('returns the same id across repeated calls (stable across sessions)', () => {
      const id1 = getOrCreateUserAgentId()
      const id2 = getOrCreateUserAgentId()
      expect(id2).toBe(id1)
    })

    it('reuses a pre-existing id from localStorage', () => {
      const existing = '11111111-2222-4333-8444-555555555555'
      store[STORAGE_KEY_ID] = existing
      expect(getOrCreateUserAgentId()).toBe(existing)
    })

    it('returns a valid UUID without throwing when localStorage throws', () => {
      installThrowingLocalStorage()
      const id = getOrCreateUserAgentId()
      expect(id).toMatch(UUID_V4_RE)
    })

    it('returns different ids on each call when localStorage throws (not persisted)', () => {
      installThrowingLocalStorage()
      const id1 = getOrCreateUserAgentId()
      const id2 = getOrCreateUserAgentId()
      expect(id1).not.toBe(id2)
    })
  })

  // ----------------------------------------------------------------------
  // getUserAgentId (non-creating read)
  // ----------------------------------------------------------------------
  describe('getUserAgentId', () => {
    it('returns null when no id is stored', () => {
      expect(getUserAgentId()).toBeNull()
    })

    it('does NOT generate an id when none exists', () => {
      getUserAgentId()
      expect(store[STORAGE_KEY_ID]).toBeUndefined()
    })

    it('returns the stored id when present', () => {
      store[STORAGE_KEY_ID] = '11111111-2222-4333-8444-555555555555'
      expect(getUserAgentId()).toBe('11111111-2222-4333-8444-555555555555')
    })

    it('returns null when localStorage throws', () => {
      installThrowingLocalStorage()
      expect(getUserAgentId()).toBeNull()
    })
  })

  // ----------------------------------------------------------------------
  // clearUserAgentIdentity
  // ----------------------------------------------------------------------
  describe('clearUserAgentIdentity', () => {
    it('removes the stored id', () => {
      store[STORAGE_KEY_ID] = 'some-uuid'
      clearUserAgentIdentity()
      expect(store[STORAGE_KEY_ID]).toBeUndefined()
    })

    it('removes the stored device name', () => {
      store[STORAGE_KEY_DEVICE] = "Mickaël's laptop"
      clearUserAgentIdentity()
      expect(store[STORAGE_KEY_DEVICE]).toBeUndefined()
    })

    it('is idempotent when nothing is stored', () => {
      expect(() => clearUserAgentIdentity()).not.toThrow()
    })

    it('causes the next getOrCreateUserAgentId to produce a fresh id', () => {
      const original = getOrCreateUserAgentId()
      clearUserAgentIdentity()
      const next = getOrCreateUserAgentId()
      expect(next).toMatch(UUID_V4_RE)
      expect(next).not.toBe(original)
    })

    it('does not throw when localStorage throws', () => {
      installThrowingLocalStorage()
      expect(() => clearUserAgentIdentity()).not.toThrow()
    })
  })

  // ----------------------------------------------------------------------
  // getUserAgentDeviceName
  // ----------------------------------------------------------------------
  describe('getUserAgentDeviceName', () => {
    it('returns null when no override is set', () => {
      expect(getUserAgentDeviceName()).toBeNull()
    })

    it('returns the stored value', () => {
      store[STORAGE_KEY_DEVICE] = 'Work Laptop'
      expect(getUserAgentDeviceName()).toBe('Work Laptop')
    })

    it('trims whitespace on read', () => {
      store[STORAGE_KEY_DEVICE] = '  Work Laptop  '
      expect(getUserAgentDeviceName()).toBe('Work Laptop')
    })

    it('returns null when the stored value is whitespace only', () => {
      store[STORAGE_KEY_DEVICE] = '    '
      expect(getUserAgentDeviceName()).toBeNull()
    })

    it('returns null when the stored value is an empty string', () => {
      store[STORAGE_KEY_DEVICE] = ''
      expect(getUserAgentDeviceName()).toBeNull()
    })

    it('returns null when localStorage throws', () => {
      installThrowingLocalStorage()
      expect(getUserAgentDeviceName()).toBeNull()
    })
  })

  // ----------------------------------------------------------------------
  // setUserAgentDeviceName
  // ----------------------------------------------------------------------
  describe('setUserAgentDeviceName', () => {
    it('stores a non-empty name', () => {
      setUserAgentDeviceName('Kitchen Tablet')
      expect(store[STORAGE_KEY_DEVICE]).toBe('Kitchen Tablet')
    })

    it('trims whitespace before storing', () => {
      setUserAgentDeviceName('  Kitchen Tablet  ')
      expect(store[STORAGE_KEY_DEVICE]).toBe('Kitchen Tablet')
    })

    it('clears the override when given null', () => {
      store[STORAGE_KEY_DEVICE] = 'Old Name'
      setUserAgentDeviceName(null)
      expect(store[STORAGE_KEY_DEVICE]).toBeUndefined()
    })

    it('clears the override when given an empty string', () => {
      store[STORAGE_KEY_DEVICE] = 'Old Name'
      setUserAgentDeviceName('')
      expect(store[STORAGE_KEY_DEVICE]).toBeUndefined()
    })

    it('clears the override when given whitespace only', () => {
      store[STORAGE_KEY_DEVICE] = 'Old Name'
      setUserAgentDeviceName('   ')
      expect(store[STORAGE_KEY_DEVICE]).toBeUndefined()
    })

    it('overwrites a previous override', () => {
      setUserAgentDeviceName('First')
      setUserAgentDeviceName('Second')
      expect(store[STORAGE_KEY_DEVICE]).toBe('Second')
    })

    it('does not throw when localStorage throws', () => {
      installThrowingLocalStorage()
      expect(() => setUserAgentDeviceName('Anything')).not.toThrow()
    })
  })

  // ----------------------------------------------------------------------
  // getEffectiveDeviceName
  // ----------------------------------------------------------------------
  describe('getEffectiveDeviceName', () => {
    it('returns the user override when set', () => {
      setUserAgentDeviceName("Mickaël's MacBook")
      expect(getEffectiveDeviceName()).toBe("Mickaël's MacBook")
    })

    it('falls back to a platform default when no override is set', () => {
      expect(getEffectiveDeviceName()).toMatch(/^Fluux /)
    })

    it('falls back to platform default after clearing an override', () => {
      setUserAgentDeviceName('Custom')
      setUserAgentDeviceName(null)
      expect(getEffectiveDeviceName()).toMatch(/^Fluux /)
    })
  })

  // ----------------------------------------------------------------------
  // buildUserAgentElement
  // ----------------------------------------------------------------------
  describe('buildUserAgentElement', () => {
    it('has name "user-agent" with an id attribute matching UUIDv4', () => {
      const el = buildUserAgentElement()
      expect(el.name).toBe('user-agent')
      expect(el.attrs.id).toMatch(UUID_V4_RE)
    })

    it('has <software>Fluux</software> and a <device> child', () => {
      const el = buildUserAgentElement()
      const software = el.getChild('software')
      const device = el.getChild('device')
      expect(software?.text()).toBe('Fluux')
      expect(device?.text()).toBeTruthy()
    })

    it('reuses the persisted id across calls (FAST binding stability)', () => {
      const a = buildUserAgentElement()
      const b = buildUserAgentElement()
      expect(b.attrs.id).toBe(a.attrs.id)
    })

    it('regenerates the id after clearUserAgentIdentity()', () => {
      const before = buildUserAgentElement().attrs.id
      clearUserAgentIdentity()
      const after = buildUserAgentElement().attrs.id
      expect(after).toMatch(UUID_V4_RE)
      expect(after).not.toBe(before)
    })

    it('uses the user device-name override when one is set', () => {
      setUserAgentDeviceName("Kim's Phone")
      const el = buildUserAgentElement()
      expect(el.getChild('device')?.text()).toBe("Kim's Phone")
    })

    it('uses the platform default when no override is set', () => {
      const el = buildUserAgentElement()
      expect(el.getChild('device')?.text()).toMatch(/^Fluux /)
    })

    it('serializes to XEP-0388 form', () => {
      setUserAgentDeviceName('Work Laptop')
      const xmlStr = buildUserAgentElement().toString()
      expect(xmlStr).toContain('<user-agent id="')
      expect(xmlStr).toContain('<software>Fluux</software>')
      expect(xmlStr).toContain('<device>Work Laptop</device>')
      expect(xmlStr).toContain('</user-agent>')
    })
  })

  // ----------------------------------------------------------------------
  // Interaction: setters, readers, and element-building together
  // ----------------------------------------------------------------------
  describe('full lifecycle', () => {
    it('supports a set → read → clear → default cycle', () => {
      expect(getUserAgentDeviceName()).toBeNull()

      setUserAgentDeviceName('Home Desktop')
      expect(getUserAgentDeviceName()).toBe('Home Desktop')
      expect(getEffectiveDeviceName()).toBe('Home Desktop')

      setUserAgentDeviceName(null)
      expect(getUserAgentDeviceName()).toBeNull()
      expect(getEffectiveDeviceName()).toMatch(/^Fluux /)
    })

    it('clearing identity also clears the device override', () => {
      setUserAgentDeviceName('Custom')
      getOrCreateUserAgentId()
      clearUserAgentIdentity()
      expect(getUserAgentId()).toBeNull()
      expect(getUserAgentDeviceName()).toBeNull()
    })

    it('user-agent element reflects post-clear state', () => {
      setUserAgentDeviceName('Old Device')
      const idBefore = buildUserAgentElement().attrs.id
      clearUserAgentIdentity()
      const el = buildUserAgentElement()
      expect(el.attrs.id).not.toBe(idBefore)
      expect(el.getChild('device')?.text()).toMatch(/^Fluux /)
    })
  })
})

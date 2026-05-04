import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  clearKeyChangeAlert,
  getKeyChangeAlert,
  recordKeyChangeAlert,
  useKeyChangeAlertsStore,
} from './keyChangeAlertsStore'

const STORAGE_KEY = 'fluux-e2ee-key-change-alerts'

describe('keyChangeAlertsStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useKeyChangeAlertsStore.setState({ alertsByJid: {} })
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('records an alert with previous and current fingerprints', () => {
    recordKeyChangeAlert('alice@example.com', 'OLDFP', 'NEWFP')
    const alert = getKeyChangeAlert('alice@example.com')
    expect(alert).not.toBeNull()
    expect(alert!.previousFingerprint).toBe('OLDFP')
    expect(alert!.currentFingerprint).toBe('NEWFP')
    // Timestamp should be a parseable ISO string.
    expect(Number.isFinite(Date.parse(alert!.observedAt))).toBe(true)
  })

  it('clearKeyChangeAlert removes the entry', () => {
    recordKeyChangeAlert('alice@example.com', 'OLDFP', 'NEWFP')
    expect(getKeyChangeAlert('alice@example.com')).not.toBeNull()
    clearKeyChangeAlert('alice@example.com')
    expect(getKeyChangeAlert('alice@example.com')).toBeNull()
    // No-op for an already-cleared entry.
    clearKeyChangeAlert('alice@example.com')
  })

  it('persists to localStorage and rehydrates the same shape', () => {
    recordKeyChangeAlert('alice@example.com', 'OLDFP', 'NEWFP')
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed['alice@example.com']).toMatchObject({
      previousFingerprint: 'OLDFP',
      currentFingerprint: 'NEWFP',
    })
    expect(typeof parsed['alice@example.com'].observedAt).toBe('string')
  })

  it('repeated record with same prev/curr is idempotent — store reference does not change', () => {
    // We don't want spurious banner re-renders from a re-probe that
    // re-detects the same already-known rotation.
    recordKeyChangeAlert('alice@example.com', 'OLDFP', 'NEWFP')
    const before = useKeyChangeAlertsStore.getState().alertsByJid
    recordKeyChangeAlert('alice@example.com', 'OLDFP', 'NEWFP')
    const after = useKeyChangeAlertsStore.getState().alertsByJid
    expect(before).toBe(after)
  })

  it('record with a different curr fingerprint replaces the alert (rotation in flight)', () => {
    recordKeyChangeAlert('alice@example.com', 'OLDFP', 'MIDFP')
    recordKeyChangeAlert('alice@example.com', 'OLDFP', 'NEWFP')
    const alert = getKeyChangeAlert('alice@example.com')
    expect(alert!.currentFingerprint).toBe('NEWFP')
  })

  it('different peers are isolated', () => {
    recordKeyChangeAlert('alice@example.com', 'A1', 'A2')
    recordKeyChangeAlert('bob@example.com', 'B1', 'B2')
    expect(getKeyChangeAlert('alice@example.com')!.currentFingerprint).toBe('A2')
    expect(getKeyChangeAlert('bob@example.com')!.currentFingerprint).toBe('B2')
    clearKeyChangeAlert('alice@example.com')
    expect(getKeyChangeAlert('alice@example.com')).toBeNull()
    expect(getKeyChangeAlert('bob@example.com')).not.toBeNull()
  })
})

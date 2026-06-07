import { describe, it, expect, beforeEach } from 'vitest'
import {
  getReconnectIntent,
  markLoggedOut,
  markConnectActive,
  RECONNECT_INTENT_KEY,
} from './reconnectIntent'

describe('reconnectIntent', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to "active" when nothing is stored (backward compat with existing sessions)', () => {
    expect(getReconnectIntent()).toBe('active')
  })

  it('markLoggedOut() makes the intent "logged-out"', () => {
    markLoggedOut()
    expect(getReconnectIntent()).toBe('logged-out')
  })

  it('markConnectActive() re-arms the intent to "active"', () => {
    markLoggedOut()
    expect(getReconnectIntent()).toBe('logged-out')

    markConnectActive()
    expect(getReconnectIntent()).toBe('active')
  })

  it('persists "logged-out" across a simulated reload (value lives in localStorage)', () => {
    markLoggedOut()
    // A reload destroys in-memory state but not localStorage. Re-reading the
    // intent (as the post-reload auto-reconnect engine does) still sees it.
    expect(localStorage.getItem(RECONNECT_INTENT_KEY)).toBe('logged-out')
    expect(getReconnectIntent()).toBe('logged-out')
  })

  it('treats an unknown/garbage stored value as "active" (fail-open, never strands a remembered user)', () => {
    localStorage.setItem(RECONNECT_INTENT_KEY, 'something-else')
    expect(getReconnectIntent()).toBe('active')
  })
})

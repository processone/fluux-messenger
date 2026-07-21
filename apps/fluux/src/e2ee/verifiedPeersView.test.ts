/**
 * `verifiedPeersView` is the app-side holder for the plugin-owned
 * `VerifiedKeysView` (Task 2). It exists so `useVerifiedFingerprint` keeps
 * working across the real lifecycle: mounted before OpenPGP registers,
 * across a later registration, and across an unregister — WITHOUT the
 * caller ever needing to know whether a plugin is present.
 *
 * The render-loop guard test is the load-bearing one: `useVerifiedFingerprint`
 * must return a stable PRIMITIVE. Task 4 puts this value straight into React
 * dependency arrays; an object/handle return would re-fire a network-probing
 * effect on every render.
 *
 * No JSX here on purpose (`.ts`, not `.tsx`) — uses `React.createElement`.
 * Probe components render the hook's value as text so assertions read the
 * DOM rather than mutate an outer closure variable from render (which the
 * react-compiler lint flags as an impure render).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, act } from '@testing-library/react'
import type { VerifiedKeysView } from '@fluux/openpgp-plugin'
import { setVerifiedKeysView, useVerifiedFingerprint, getVerifiedFingerprintNow, subscribe } from './verifiedPeersView'

/** Minimal fake `VerifiedKeysView` with a controllable notify. */
function createFakeView(initial: Record<string, string> = {}): VerifiedKeysView & {
  set(jid: string, fp: string): void
  notify(): void
} {
  let map = { ...initial }
  const listeners = new Set<() => void>()
  return {
    isVerified: (jid, fp) => map[jid] === fp,
    getVerifiedFingerprint: (jid) => map[jid] ?? null,
    getSnapshot: () => map,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(jid, fp) {
      map = { ...map, [jid]: fp }
      this.notify()
    },
    notify() {
      for (const l of listeners) l()
    },
  }
}

let renderCount = 0

/** Renders the hook's value as text and increments the module-level render counter. */
function Probe({ jid }: { jid: string | null }) {
  renderCount++
  const value = useVerifiedFingerprint(jid)
  return createElement('span', {}, value === null ? 'null' : value)
}

describe('verifiedPeersView', () => {
  afterEach(() => {
    // Reset module-level holder state between tests.
    setVerifiedKeysView(null)
    renderCount = 0
  })

  it('returns null for every JID when no view is set', () => {
    expect(getVerifiedFingerprintNow('alice@example.com')).toBeNull()
  })

  it('subscribe is a safe no-op when no view is set', () => {
    const { container, unmount } = render(createElement(Probe, { jid: 'alice@example.com' }))
    expect(renderCount).toBe(1)
    expect(container.textContent).toBe('null')
    // No throw on unmount (unsubscribe must be callable even without a view).
    expect(() => unmount()).not.toThrow()
  })

  it('notifies subscribers when a view is later set (mounted components re-render)', () => {
    const { container } = render(createElement(Probe, { jid: 'alice@example.com' }))
    expect(renderCount).toBe(1)
    expect(container.textContent).toBe('null')

    const view = createFakeView({ 'alice@example.com': 'AAAA1111' })
    act(() => {
      setVerifiedKeysView(view)
    })

    expect(renderCount).toBe(2)
    expect(container.textContent).toBe('AAAA1111')
  })

  it('returns the fingerprint and updates when the underlying cache changes', () => {
    const view = createFakeView({ 'bob@example.com': 'BBBB2222' })
    setVerifiedKeysView(view)

    const { container } = render(createElement(Probe, { jid: 'bob@example.com' }))
    expect(container.textContent).toBe('BBBB2222')

    act(() => {
      view.set('bob@example.com', 'CCCC3333')
    })
    expect(container.textContent).toBe('CCCC3333')
  })

  it('returns null for a null JID even with a view set', () => {
    const view = createFakeView({ 'carol@example.com': 'DDDD4444' })
    setVerifiedKeysView(view)

    const { container } = render(createElement(Probe, { jid: null }))
    expect(container.textContent).toBe('null')
  })

  it('does not re-render or resubscribe on unrelated parent re-renders (render-loop guard)', () => {
    const view = createFakeView({ 'dave@example.com': 'EEEE5555' })
    setVerifiedKeysView(view)

    const subscribeSpy = vi.spyOn(view, 'subscribe')
    function Parent({ tick }: { tick: number }) {
      return createElement('div', { 'data-tick': tick }, createElement(Probe, { jid: 'dave@example.com' }))
    }

    const { rerender } = render(createElement(Parent, { tick: 0 }))
    expect(renderCount).toBe(1)
    const subscribeCallsAfterMount = subscribeSpy.mock.calls.length

    // Re-render the parent several times with no state change relevant to
    // the hook. A looping hook would blow this test up; a hook that merely
    // resubscribes every render would still pass a bare render-count check,
    // so also assert `subscribe` identity stayed put (no new calls).
    for (let i = 1; i <= 5; i++) {
      rerender(createElement(Parent, { tick: i }))
    }

    expect(renderCount).toBe(6)
    expect(subscribeSpy.mock.calls.length).toBe(subscribeCallsAfterMount)
  })

  it('clearing the view (unregister) reverts to null and notifies', () => {
    const view = createFakeView({ 'erin@example.com': 'FFFF6666' })
    setVerifiedKeysView(view)

    const { container } = render(createElement(Probe, { jid: 'erin@example.com' }))
    expect(container.textContent).toBe('FFFF6666')
    const rendersAfterMount = renderCount

    act(() => {
      setVerifiedKeysView(null)
    })

    expect(renderCount).toBe(rendersAfterMount + 1)
    expect(container.textContent).toBe('null')
    expect(getVerifiedFingerprintNow('erin@example.com')).toBeNull()
  })

  // Finding 3 (B2 Task 3 review): `setVerifiedKeysView` runs inside
  // `registerE2EEPlugins`'s try block. A throwing holder listener must not
  // propagate out of `setVerifiedKeysView` (that would be mistaken for a
  // registration failure on a registration that actually succeeded), and
  // must not stop other listeners from firing — mirroring the plugin-side
  // precedent, `VerifiedKeysCache.notify`. Attaches raw listeners via the
  // exported `subscribe` directly (bypassing React) so the assertion targets
  // `notifyHolder`'s own try/catch rather than React's independent
  // error-boundary/scheduling behavior.
  it('isolates a throwing listener: other listeners still fire and the throw does not propagate', () => {
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    const ok = vi.fn()
    const unsubscribeThrowing = subscribe(throwing)
    const unsubscribeOk = subscribe(ok)

    const view = createFakeView({ 'frank@example.com': 'GGGG7777' })

    expect(() => setVerifiedKeysView(view)).not.toThrow()

    expect(throwing).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
    expect(getVerifiedFingerprintNow('frank@example.com')).toBe('GGGG7777')

    // A second notification (view->view relay, e.g. the view's own
    // `subscribe(notifyHolder)` firing) must keep isolating the same way.
    // No React component is mounted here, so no `act()` wrapper is needed.
    view.set('frank@example.com', 'HHHH8888')
    expect(throwing).toHaveBeenCalledTimes(2)
    expect(ok).toHaveBeenCalledTimes(2)

    unsubscribeThrowing()
    unsubscribeOk()
  })
})

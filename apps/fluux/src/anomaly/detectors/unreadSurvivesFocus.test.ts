import { describe, it, expect } from 'vitest'
import {
  createUnreadSurvivesFocusDetector,
  type UnreadFocusSample,
} from './unreadSurvivesFocus'

const ACTIVE = { kind: 'conversation' as const, id: 'bob@x.tld' }

/** The failing condition: active, focused, at the live edge, still unread. */
function bad(overrides: Partial<UnreadFocusSample> = {}): UnreadFocusSample {
  return {
    active: ACTIVE,
    focused: true,
    viewportAtBottom: true,
    unreadCount: 3,
    scopeKey: 'acct-1',
    ...overrides,
  }
}

describe('unreadSurvivesFocus — fires', () => {
  it('reports once the condition has held for the full window', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    expect(d.observe(bad(), 0)).toBeNull() // first sample only starts the clock
    expect(d.observe(bad(), 1999)).toBeNull() // one ms short
    const v = d.observe(bad(), 2000)

    expect(v).not.toBeNull()
    expect(v!.unreadCount).toBe(3)
    expect(v!.heldMs).toBe(2000)
    expect(v!.active).toEqual(ACTIVE)
  })

  it('reports once per episode, not once per tick', () => {
    // A stuck badge is sampled every second. Without a latch it would produce a
    // record per tick and the suppression count would carry no information.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    const verdicts = [3000, 4000, 5000, 6000].map((t) => d.observe(bad(), t))

    expect(verdicts.filter(Boolean)).toHaveLength(1)
  })

  it('reports again after the condition breaks and recurs', () => {
    // The latch must not be permanent: a recurrence is a separate event, and the
    // recorder's per-id cooldown is what bounds frequency.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    expect(d.observe(bad(), 2000)).not.toBeNull()

    d.observe(bad({ unreadCount: 0 }), 3000) // read at last — condition breaks

    d.observe(bad(), 4000)
    expect(d.observe(bad(), 6000)).not.toBeNull()
  })
})

describe('unreadSurvivesFocus — stays silent', () => {
  // The control cases. A detector that fires on everything passes a firing test,
  // so each precondition gets its own proof of silence.

  it('while the window is not focused', () => {
    // The whole premise is that the user is looking at it.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad({ focused: false }), 0)
    expect(d.observe(bad({ focused: false }), 5000)).toBeNull()
  })

  it('while the viewport is not at the live edge', () => {
    // Scrolled up in history with unread below is the normal, correct state.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad({ viewportAtBottom: false }), 0)
    expect(d.observe(bad({ viewportAtBottom: false }), 5000)).toBeNull()
  })

  it('when there is nothing unread', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad({ unreadCount: 0 }), 0)
    expect(d.observe(bad({ unreadCount: 0 }), 5000)).toBeNull()
  })

  it('when no conversation is open', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad({ active: null }), 0)
    expect(d.observe(bad({ active: null }), 5000)).toBeNull()
  })

  it('when the count clears inside the window', () => {
    // The ordinary success path: focus regain marks it read a beat later.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 500)
    expect(d.observe(bad({ unreadCount: 0 }), 1000)).toBeNull()
    expect(d.observe(bad(), 3000)).toBeNull() // clock restarted, not resumed
  })
})

describe('unreadSurvivesFocus — resets', () => {
  it('restarts the clock when the active conversation changes', () => {
    // Elapsed time on one conversation says nothing about the next. Without this,
    // opening a second unread conversation would inherit the first one's timer and
    // report immediately.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad({ active: { kind: 'conversation', id: 'carol@x.tld' } }), 1900)
    expect(
      d.observe(bad({ active: { kind: 'conversation', id: 'carol@x.tld' } }), 2100),
    ).toBeNull()
  })

  it('treats the same id in the other namespace as a different conversation', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad({ active: { kind: 'room', id: 'bob@x.tld' } }), 1900)
    expect(d.observe(bad({ active: { kind: 'room', id: 'bob@x.tld' } }), 2100)).toBeNull()
  })

  it('discards a pending observation when the account scope changes', () => {
    // The one generation-ish signal available before stage 5. An observation
    // spanning a store rebuild describes two different worlds.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad({ scopeKey: 'acct-2' }), 1900)
    expect(d.observe(bad({ scopeKey: 'acct-2' }), 2100)).toBeNull()
  })

  it('still reports after a scope change once the window elapses again', () => {
    // Control for the reset: it must delay a verdict, not disable the detector.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad({ scopeKey: 'acct-2' }), 0)
    d.observe(bad({ scopeKey: 'acct-2' }), 100)
    expect(d.observe(bad({ scopeKey: 'acct-2' }), 2200)).not.toBeNull()
  })
})

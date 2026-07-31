import { describe, it, expect } from 'vitest'
import {
  createUnreadSurvivesFocusDetector,
  type UnreadFocusSample,
  type UnreadFocusVerdict,
} from './unreadSurvivesFocus'

const ACTIVE = { kind: 'conversation' as const, id: 'bob@x.tld' }

/** The failing condition: active, focused, at the live edge, still unread. */
function bad(overrides: Partial<UnreadFocusSample> = {}): UnreadFocusSample {
  return {
    active: ACTIVE,
    focused: true,
    viewportAtBottom: true,
    windowAtLiveEdge: true,
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
    expect(v!.kind).toBe('held')
    expect(v!.kind === 'held' && v!.unreadCount).toBe(3)
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
    expect(verdicts.find(Boolean)!.kind).toBe('held')
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

  it('while the loaded message window has slid away from the live edge', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad({ windowAtLiveEdge: false }), 0)
    expect(d.observe(bad({ windowAtLiveEdge: false }), 5000)).toBeNull()
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


describe('unreadSurvivesFocus — episode duration', () => {
  // The threshold record is emitted the moment 2s is crossed, so its heldMs is always
  // ~2000 and says nothing about how long the badge actually stayed wrong. Real logs
  // showed exactly that: seven records, every one of them heldMs 2007-2009. Pairing a
  // closing measurement with each episode is what makes the duration knowable.

  it('reports the true duration when the condition finally clears', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    expect(d.observe(bad(), 2000)!.kind).toBe('held')

    // ...still wrong for another eight seconds, then read.
    d.observe(bad(), 6000)
    const cleared = d.observe(bad({ unreadCount: 0 }), 10_000)

    expect(cleared).not.toBeNull()
    expect(cleared!.kind).toBe('cleared')
    expect(cleared!.heldMs, 'the full episode, not the threshold').toBe(10_000)
    expect(cleared!.active).toEqual(ACTIVE)
  })

  it('carries the worst count seen, not the count at the end', () => {
    // A badge that climbed to 21 while being watched is a different story from one
    // that sat at 1, and by the time it clears the count is 0 either way.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad({ unreadCount: 3 }), 0)
    d.observe(bad({ unreadCount: 21 }), 2000)
    d.observe(bad({ unreadCount: 5 }), 3000)
    const cleared = d.observe(bad({ unreadCount: 0 }), 4000)

    expect(cleared!.kind === 'cleared' && cleared!.peakUnread).toBe(21)
  })

  it('says nothing about an episode that never crossed the threshold', () => {
    // Nothing was claimed, so there is nothing to close. A closing record here would
    // invent an episode the log never reported.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 500)
    expect(d.observe(bad({ unreadCount: 0 }), 1000)).toBeNull()
  })

  it('says NOTHING when the conversation is switched away from', () => {
    // The badge was still wrong when we stopped watching. Reporting a duration here
    // would measure how long the detector could look, and name a recovery that may
    // never have happened.
    const other = { kind: 'conversation' as const, id: 'carol@x.tld' }
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    expect(d.observe(bad({ active: other }), 5000)).toBeNull()
  })

  it('says NOTHING when the window loses focus with the count still up', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    expect(d.observe(bad({ focused: false }), 7000)).toBeNull()
  })

  it('says NOTHING when the viewport leaves the live edge', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    expect(d.observe(bad({ viewportAtBottom: false }), 7000)).toBeNull()
  })

  it('says NOTHING when the store scope changes under it', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    expect(d.observe(bad({ scopeKey: 'acct-2' }), 7000)).toBeNull()
  })

  it('does not call it a clear when focus and the count drop on the same tick', () => {
    // Ambiguous: the count may have cleared BECAUSE the user left. Conservative.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    expect(d.observe(bad({ unreadCount: 0, focused: false }), 5000)).toBeNull()
  })

  it('emits nothing further once an episode has been closed', () => {
    // The pair is one held + one cleared. A second closing record would double-count
    // the episode in any review that folds them together.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    expect(d.observe(bad({ unreadCount: 0 }), 5000)!.kind).toBe('cleared')
    expect(d.observe(bad({ unreadCount: 0 }), 6000)).toBeNull()
    expect(d.observe(bad({ unreadCount: 0 }), 7000)).toBeNull()
  })

  it('reports a fresh pair when the condition recurs', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    d.observe(bad({ unreadCount: 0 }), 3000)

    d.observe(bad(), 4000)
    expect(d.observe(bad(), 6000)!.kind).toBe('held')
    expect(d.observe(bad({ unreadCount: 0 }), 9000)!.kind).toBe('cleared')
  })
})


describe('unreadSurvivesFocus — persistence', () => {
  // Answers "brief lag or actually stuck" WITHOUT needing to witness the recovery.
  // The app marks read on focus change and tab switch, so a badge may routinely clear
  // only once the user has navigated away — precisely when nothing is watching.

  it('reports again once the condition has held far past the threshold', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000, persistMs: 30_000 })
    d.observe(bad(), 0)
    expect(d.observe(bad(), 2000)!.kind).toBe('held')
    for (let now = 3000; now <= 20_000; now += 1000) {
      expect(d.observe(bad(), now)).toBeNull()
    }

    let persisted: UnreadFocusVerdict | null = null
    for (let now = 21_000; now <= 30_000; now += 1000) {
      persisted = d.observe(bad(), now)
    }
    expect(persisted!.kind).toBe('persisted')
    expect(persisted!.heldMs).toBe(30_000)
    expect(persisted!.kind === 'persisted' && persisted!.peakUnread).toBe(3)
  })

  it('reports persistence once, not on every later tick', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000, persistMs: 30_000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    const after: (UnreadFocusVerdict | null)[] = []
    for (let now = 3000; now <= 90_000; now += 1000) {
      after.push(d.observe(bad(), now))
    }
    expect(after.filter(Boolean)).toHaveLength(1)
  })

  it('restarts after an unobserved sampling gap', () => {
    const d = createUnreadSurvivesFocusDetector({
      holdMs: 2000,
      persistMs: 30_000,
      maxSampleGapMs: 5000,
    })
    d.observe(bad(), 0)
    expect(d.observe(bad(), 2000)!.kind).toBe('held')

    expect(d.observe(bad(), 40_000)).toBeNull()
    expect(d.observe(bad(), 42_000)!.kind).toBe('held')
  })

  it('stays silent for an episode that ends before the persistence window', () => {
    // The control: a badge that lagged two seconds and recovered must not be filed
    // as one that stayed wrong.
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000, persistMs: 30_000 })
    d.observe(bad(), 0)
    expect(d.observe(bad(), 2000)!.kind).toBe('held')
    const cleared = d.observe(bad({ unreadCount: 0 }), 5000)
    expect(cleared!.kind).toBe('cleared')
    expect(cleared!.heldMs).toBe(5000)
  })

  it('still reports the true duration when a persistent episode finally clears', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000, persistMs: 30_000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    let persisted: UnreadFocusVerdict | null = null
    for (let now = 3000; now <= 30_000; now += 1000) {
      persisted = d.observe(bad(), now)
    }
    expect(persisted!.kind).toBe('persisted')

    for (let now = 31_000; now < 100_000; now += 1000) {
      d.observe(bad(), now)
    }
    const cleared = d.observe(bad({ unreadCount: 0 }), 100_000)
    expect(cleared!.kind).toBe('cleared')
    expect(cleared!.heldMs).toBe(100_000)
  })

  it('starts a fresh persistence clock for a new episode', () => {
    const d = createUnreadSurvivesFocusDetector({ holdMs: 2000, persistMs: 30_000 })
    d.observe(bad(), 0)
    d.observe(bad(), 2000)
    for (let now = 3000; now <= 30_000; now += 1000) d.observe(bad(), now)
    d.observe(bad({ unreadCount: 0 }), 31_000) // cleared

    d.observe(bad(), 32_000)
    expect(d.observe(bad(), 34_000)!.kind).toBe('held')
    expect(d.observe(bad(), 40_000), 'only 8s into the new episode').toBeNull()
  })
})

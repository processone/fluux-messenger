import { describe, it, expect } from 'vitest'
import { createArrivalBaseline } from './arrivalBaseline'
import { decideOnNewMessage } from './newMessageDecision'

describe('arrival baseline', () => {
  it('starts at the entered conversation bottom row, counting nothing', () => {
    expect(createArrivalBaseline('m-9').read()).toEqual({ count: 0, lastMessageId: 'm-9' })
  })

  it('moves both fields when rows changed without anyone sending', () => {
    const baseline = createArrivalBaseline('m-9')
    baseline.rebase({ count: 40, lastMessageId: 'm-40' })
    expect(baseline.read()).toEqual({ count: 40, lastMessageId: 'm-40' })
  })

  it('leaves the bottom row alone when older history lands above the reader', () => {
    // A prepend grows the count and moves nothing at the bottom. If this also re-based the bottom
    // row it would swallow a message that arrived while the prepend was landing: the arrival check
    // would see no change, and a reader at the live edge would never be taken to it.
    const baseline = createArrivalBaseline('m-9')
    baseline.rebase({ count: 40, lastMessageId: 'm-40' })

    baseline.rebaseCountOnly(90)

    expect(baseline.read()).toEqual({ count: 90, lastMessageId: 'm-40' })
  })

  it('still reports an arrival that landed while a prepend was in flight', () => {
    // The rule's whole point, read through the decision that consumes it — which is where a
    // widened rebase actually does its damage, and the only place the damage is visible.
    const baseline = createArrivalBaseline('m-9')
    baseline.rebase({ count: 40, lastMessageId: 'm-40' })

    // 'm-41' arrives, and the prepend completes before the arrival effect has run. The prepend
    // brought 50 older rows, so the count alone can no longer tell anyone a message landed.
    baseline.rebaseCountOnly(91)

    expect(decideOnNewMessage({
      messageCount: 91,
      baselineMessageCount: baseline.read().count,
      lastMessageId: 'm-41',
      baselineLastMessageId: baseline.read().lastMessageId,
      lastMessageIsOutgoing: false,
      atBottom: true,
      savedPositionPending: false,
      directionalHistoryPending: false,
    })).toBe('follow-incoming')
  })

  it('hands back a value that cannot be mutated into the baseline from outside', () => {
    const baseline = createArrivalBaseline('m-9')
    const seen = baseline.read()
    baseline.rebase({ count: 5, lastMessageId: 'm-5' })
    // The earlier reading is still the earlier reading: a caller holding one is not silently
    // carried forward, which is what makes a stale comparison possible.
    expect(seen).toEqual({ count: 0, lastMessageId: 'm-9' })
  })
})

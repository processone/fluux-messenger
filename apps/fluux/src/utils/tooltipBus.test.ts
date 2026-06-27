import { describe, it, expect, vi } from 'vitest'
import { dismissAllTooltips, onDismissAllTooltips } from './tooltipBus'

describe('tooltipBus', () => {
  it('notifies subscribers when dismissAllTooltips() is called', () => {
    const handler = vi.fn()
    const unsubscribe = onDismissAllTooltips(handler)

    dismissAllTooltips()
    expect(handler).toHaveBeenCalledTimes(1)

    dismissAllTooltips()
    expect(handler).toHaveBeenCalledTimes(2)

    unsubscribe()
  })

  it('stops notifying after unsubscribe', () => {
    const handler = vi.fn()
    const unsubscribe = onDismissAllTooltips(handler)
    unsubscribe()

    dismissAllTooltips()
    expect(handler).not.toHaveBeenCalled()
  })

  it('fans out to every subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unA = onDismissAllTooltips(a)
    const unB = onDismissAllTooltips(b)

    dismissAllTooltips()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    unA()
    unB()
  })
})

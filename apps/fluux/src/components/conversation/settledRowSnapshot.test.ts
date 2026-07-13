// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { collectSettledRowHeights } from './settledRowSnapshot'

/** Build a scroller containing a virtualizer spacer with the given rows. */
function scrollerWith(rows: Array<{ index: string; height: number }>): HTMLElement {
  const scroller = document.createElement('div')
  const spacer = document.createElement('div')
  spacer.setAttribute('data-virtualizer-spacer', '')
  for (const { index, height } of rows) {
    const el = document.createElement('div')
    el.setAttribute('data-index', index)
    Object.defineProperty(el, 'offsetHeight', { get: () => height, configurable: true })
    spacer.appendChild(el)
  }
  scroller.appendChild(spacer)
  return scroller
}

const items = [{ key: 'm1' }, { key: 'm2' }, { key: 'date:2026-07-13' }]

describe('collectSettledRowHeights', () => {
  it('maps each mounted row to its height-cache key at the given bucket/scale', () => {
    const scroller = scrollerWith([
      { index: '0', height: 84 },
      { index: '2', height: 48 },
    ])
    const result = collectSettledRowHeights(scroller, items, 880, 100)
    expect(result.get('m1@880@100')).toBe(84)
    expect(result.get('date:2026-07-13@880@100')).toBe(48)
    expect(result.size).toBe(2)
  })

  it('skips rows with zero height, out-of-range or non-numeric indices', () => {
    const scroller = scrollerWith([
      { index: '0', height: 0 }, // unsettled / detached
      { index: '9', height: 40 }, // stale index beyond items
      { index: 'x', height: 40 }, // malformed
      { index: '1', height: 116 },
    ])
    const result = collectSettledRowHeights(scroller, items, 880, 100)
    expect(result.size).toBe(1)
    expect(result.get('m2@880@100')).toBe(116)
  })

  it('returns an empty map when no spacer rows are mounted', () => {
    const scroller = document.createElement('div')
    expect(collectSettledRowHeights(scroller, items, 880, 100).size).toBe(0)
  })
})

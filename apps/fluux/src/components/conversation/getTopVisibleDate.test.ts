// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getTopVisibleDate } from './getTopVisibleDate'
import type { RenderItem } from './messageListItems'
import type { VirtualWindowItem } from './messageVirtualizer'

type Msg = { id: string }

// Build a flat item list: each entry is either a date or a message row.
function items(spec: Array<{ date: string } | { msg: string }>): RenderItem<Msg>[] {
  return spec.map((s) =>
    'date' in s
      ? ({ kind: 'date', key: `date:${s.date}`, date: s.date } as RenderItem<Msg>)
      : ({
          kind: 'message',
          key: s.msg,
          message: { id: s.msg },
          showAvatar: false,
          isFirstNew: false,
          indexInGroup: 0,
          groupMessages: [{ id: s.msg }],
        } as RenderItem<Msg>),
  )
}

// Window items with uniform 100px rows starting at 0.
function windowOf(all: RenderItem<Msg>[]): VirtualWindowItem[] {
  return all.map((it, index) => ({ index, start: index * 100, size: 100, key: it.key }))
}

describe('getTopVisibleDate', () => {
  it('returns the date of the topmost visible message', () => {
    const all = items([{ date: '2026-06-28' }, { msg: 'a' }, { msg: 'b' }, { msg: 'c' }])
    // scrollTop 250 → rows 0,1 fully above; topmost visible is index 2 (msg 'b')
    expect(getTopVisibleDate(windowOf(all), all, 250)).toBe('2026-06-28')
  })

  it('returns null when the topmost visible row is a date separator', () => {
    const all = items([{ date: '2026-06-28' }, { msg: 'a' }, { msg: 'b' }])
    // scrollTop 0 → topmost visible is the date item itself → suppress
    expect(getTopVisibleDate(windowOf(all), all, 0)).toBeNull()
  })

  it('uses the nearest preceding date across a day boundary', () => {
    const all = items([
      { date: '2026-06-28' },
      { msg: 'a' },
      { date: '2026-06-29' },
      { msg: 'b' },
      { msg: 'c' },
    ])
    // scrollTop 350 → topmost visible is index 3 (msg 'b'), under 2026-06-29
    expect(getTopVisibleDate(windowOf(all), all, 350)).toBe('2026-06-29')
  })

  it('returns null when there is no date above the topmost row', () => {
    const all: RenderItem<Msg>[] = [
      { kind: 'header', key: '__header' },
      ...items([{ msg: 'a' }]),
    ]
    // scrollTop 0 → topmost visible is the header → no date above
    expect(getTopVisibleDate(windowOf(all), all, 0)).toBeNull()
  })

  it('returns null when the window is empty', () => {
    expect(getTopVisibleDate([], [], 0)).toBeNull()
  })
})

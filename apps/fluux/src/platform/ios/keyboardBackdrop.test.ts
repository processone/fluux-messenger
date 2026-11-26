import { describe, expect, it } from 'vitest'
import { visibleColor } from './keyboardBackdrop'

const read = (css: string): [number, number, number, number] => {
  const m = css.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/)
  return m ? [+m[1], +m[2], +m[3], Math.round((m[4] === undefined ? 1 : +m[4]) * 255)] : [0, 0, 0, 0]
}

describe('visibleColor', () => {
  it('ignores transparent layers and stops at the first opaque one', () => {
    expect(visibleColor(['rgba(0, 0, 0, 0)', 'rgb(33, 37, 53)', 'rgb(24, 27, 39)'], read)).toEqual([33, 37, 53])
  })
  it('blends a translucent layer over the opaque one below it', () => {
    // Half white over #212535 is what the screen shows, not either color alone.
    expect(visibleColor(['rgba(255, 255, 255, 0.5)', 'rgb(33, 37, 53)'], read)).toEqual([144, 146, 154])
  })
  it('never reads layers below the first opaque one', () => {
    const seen: string[] = []
    visibleColor((function* () { yield 'rgba(0, 0, 0, 0)'; yield 'rgb(33, 37, 53)'; yield 'rgb(1, 2, 3)' })(), css => { seen.push(css); return read(css) })
    expect(seen).toEqual(['rgba(0, 0, 0, 0)', 'rgb(33, 37, 53)'])
  })
  it('returns null when nothing is opaque', () => {
    expect(visibleColor(['rgba(0, 0, 0, 0)'], read)).toBeNull()
  })
})

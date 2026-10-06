import { describe, it, expect } from 'vitest'
import { gapMarkerPositions } from './gapMarkerPositions'

const m = (iso: string) => ({ timestamp: new Date(iso) })
const t = (iso: string) => new Date(iso).getTime()

describe('gapMarkerPositions', () => {
  const aug27 = m('2026-08-27T11:17:00Z')
  const aug31 = m('2026-08-31T06:08:00Z')
  const sept1 = m('2026-09-01T22:30:00Z')
  const oct6 = m('2026-10-06T20:03:00Z')
  const groups = [{ messages: [aug27] }, { messages: [aug31] }, { messages: [sept1] }, { messages: [oct6] }]

  it('puts one marker on the first message past each gap start, across day groups', () => {
    const positions = gapMarkerPositions(groups, [
      { start: t('2026-08-27T11:17:00Z'), end: t('2026-08-31T06:08:00Z') },
      { start: t('2026-09-01T22:30:00Z'), end: t('2026-10-06T20:03:00Z') },
    ])

    expect(Array.from(positions.entries())).toEqual([
      [aug31, t('2026-08-27T11:17:00Z')],
      [oct6, t('2026-09-01T22:30:00Z')],
    ])
  })

  it('marks an open gap reaching the live edge', () => {
    const positions = gapMarkerPositions(groups, [{ start: t('2026-09-01T22:30:00Z') }])

    expect(Array.from(positions.entries())).toEqual([[oct6, t('2026-09-01T22:30:00Z')]])
  })

  it('marks a gap just below the window on its first message', () => {
    const positions = gapMarkerPositions(groups, [{ start: t('2026-08-01T00:00:00Z'), end: t('2026-08-27T11:17:00Z') }])

    expect(Array.from(positions.entries())).toEqual([[aug27, t('2026-08-01T00:00:00Z')]])
  })

  it('places no marker for gaps lying entirely below the window', () => {
    const positions = gapMarkerPositions(groups, [
      { start: t('2026-01-01T00:00:00Z'), end: t('2026-01-02T00:00:00Z') },
      { start: t('2026-02-01T00:00:00Z'), end: t('2026-02-03T00:00:00Z') },
      { start: t('2026-09-01T22:30:00Z'), end: t('2026-10-06T20:03:00Z') },
    ])

    expect(Array.from(positions.entries())).toEqual([[oct6, t('2026-09-01T22:30:00Z')]])
  })

  it('places nothing for a gap with no newer message in the window', () => {
    expect(gapMarkerPositions(groups, [{ start: t('2026-10-07T00:00:00Z') }]).size).toBe(0)
    expect(gapMarkerPositions(groups, undefined).size).toBe(0)
  })
})

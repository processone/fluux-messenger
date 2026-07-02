import { describe, it, expect } from 'vitest'
import { parseAdminLastLoginTimestamp } from './parseLastLoginTimestamp'

describe('parseAdminLastLoginTimestamp', () => {
  it('parses the confirmed ejabberd "YYYY-MM-DD HH:MM:SS" shape', () => {
    const ms = parseAdminLastLoginTimestamp('2026-06-30 11:45:28')
    expect(ms).toBe(new Date(2026, 5, 30, 11, 45, 28).getTime())
  })

  it('returns null for a localized online phrase', () => {
    expect(parseAdminLastLoginTimestamp('En ligne')).toBeNull()
    expect(parseAdminLastLoginTimestamp('Online')).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(parseAdminLastLoginTimestamp('')).toBeNull()
    expect(parseAdminLastLoginTimestamp('not a date')).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    const ms = parseAdminLastLoginTimestamp('  2026-06-30 11:45:28  ')
    expect(ms).toBe(new Date(2026, 5, 30, 11, 45, 28).getTime())
  })
})

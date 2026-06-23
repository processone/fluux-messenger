import { describe, it, expect } from 'vitest'
import { formatDuration, formatCount, formatBytes, formatBoolean, formatDateTime, formatTime, formatRelativeTime } from './format'

describe('formatDuration', () => {
  it('formats multi-unit durations, largest two units', () => {
    expect(formatDuration(90061)).toBe('1d 1h')          // 1d 1h 1m 1s -> top 2
    expect(formatDuration(3661)).toBe('1h 1m')
    expect(formatDuration(59)).toBe('59s')
    expect(formatDuration(0)).toBe('0s')
  })
  it('honours custom unit labels', () => {
    expect(formatDuration(3661, { d: 'j', h: 'h', m: 'min', s: 's' })).toBe('1h 1min')
  })
})

describe('formatCount', () => {
  it('localizes thousands', () => {
    expect(formatCount(1234567)).toBe((1234567).toLocaleString())
    expect(formatCount(0)).toBe('0')
  })
})

describe('formatBytes', () => {
  it('scales to human units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })
})

describe('formatBoolean', () => {
  it('maps to a symbol', () => {
    expect(formatBoolean(true)).toBe('✓')
    expect(formatBoolean(false)).toBe('—')
  })
})

describe('formatDateTime', () => {
  it('renders a locale string for an epoch ms', () => {
    const ts = 1718880000000
    expect(formatDateTime(ts)).toBe(new Date(ts).toLocaleString())
  })
})

describe('formatTime', () => {
  it('renders hour:minute for an epoch ms', () => {
    const ts = 1718900000000
    expect(formatTime(ts)).toBe(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  })
})

describe('formatRelativeTime', () => {
  it('returns the just-now label under a minute', () => {
    expect(formatRelativeTime(0, 'en', 'just now')).toBe('just now')
    expect(formatRelativeTime(59, 'en', 'just now')).toBe('just now')
  })
  it('picks a single coarse unit per bucket, fully localized via Intl', () => {
    expect(formatRelativeTime(60, 'en', 'just now')).toBe('1 min. ago')
    expect(formatRelativeTime(3600, 'en', 'just now')).toBe('1 hr. ago')
    expect(formatRelativeTime(2 * 86400, 'en', 'just now')).toBe('2 days ago')
    expect(formatRelativeTime(14 * 86400, 'en', 'just now')).toBe('2 wk. ago')
    expect(formatRelativeTime(60 * 86400, 'en', 'just now')).toBe('2 mo. ago')
    expect(formatRelativeTime(400 * 86400, 'en', 'just now')).toBe('1 yr. ago')
  })
  it('localizes the unit and word order per locale (not just the number)', () => {
    // Intl inserts Unicode spaces (e.g. U+202F in fr); normalize before comparing.
    const norm = (s: string) => s.replace(/\s/g, ' ')
    expect(norm(formatRelativeTime(2 * 86400, 'fr', "à l'instant"))).toBe('il y a 2 j')
    expect(norm(formatRelativeTime(2 * 86400, 'de', 'gerade eben'))).toBe('vor 2 Tagen')
  })
  it('clamps negatives to the just-now label', () => {
    expect(formatRelativeTime(-5, 'en', 'just now')).toBe('just now')
  })
})

/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { buildCopyText } from './buildCopyText'

describe('buildCopyText', () => {
  it('formats two messages on the same date under one date header', () => {
    const out = buildCopyText([
      { id: '1', from: 'Alice', time: '14:30', body: 'Hello', date: '2024-01-15' },
      { id: '2', from: 'Bob', time: '14:31', body: 'Hi there', date: '2024-01-15' },
    ])
    expect(out).toBe(['— Monday, January 15, 2024 —', 'Alice 14:30', 'Hello', 'Bob 14:31', 'Hi there'].join('\n'))
  })

  it('returns null for a single message (native browser copy handles it)', () => {
    expect(buildCopyText([{ id: '1', from: 'Alice', time: '14:30', body: 'Hello', date: '2024-01-15' }])).toBeNull()
  })

  it('returns null when fewer than two messages have a body', () => {
    expect(
      buildCopyText([
        { id: '1', from: 'Alice', time: '14:30', body: 'Hello', date: '2024-01-15' },
        { id: '2', from: 'Bob', time: '14:31', body: '', date: '2024-01-15' },
      ]),
    ).toBeNull()
  })

  it('groups across two dates, sorted ascending, with a blank line between groups', () => {
    const out = buildCopyText([
      { id: '2', from: 'Bob', time: '09:00', body: 'Second day', date: '2024-01-16' },
      { id: '1', from: 'Alice', time: '14:30', body: 'First day', date: '2024-01-15' },
    ])
    expect(out).toBe(
      [
        '— Monday, January 15, 2024 —',
        'Alice 14:30',
        'First day',
        '',
        '— Tuesday, January 16, 2024 —',
        'Bob 09:00',
        'Second day',
      ].join('\n'),
    )
  })

  it('omits the "From HH:MM" header line when from or time is missing', () => {
    const out = buildCopyText([
      { id: '1', from: '', time: '', body: 'Anon one', date: '2024-01-15' },
      { id: '2', from: 'Bob', time: '14:31', body: 'Named two', date: '2024-01-15' },
    ])
    expect(out).toBe(['— Monday, January 15, 2024 —', 'Anon one', 'Bob 14:31', 'Named two'].join('\n'))
  })

  it('falls back to the provided fallback date for messages with no date', () => {
    const out = buildCopyText(
      [
        { id: '1', from: 'Alice', time: '14:30', body: 'No date one', date: '' },
        { id: '2', from: 'Bob', time: '14:31', body: 'No date two', date: '' },
      ],
      { fallbackDate: '2024-01-15' },
    )
    expect(out).toBe(['— Monday, January 15, 2024 —', 'Alice 14:30', 'No date one', 'Bob 14:31', 'No date two'].join('\n'))
  })

  it('uses the raw date string as the header when it is not a parseable ISO date', () => {
    const out = buildCopyText([
      { id: '1', from: 'Alice', time: '14:30', body: 'One', date: 'Today' },
      { id: '2', from: 'Bob', time: '14:31', body: 'Two', date: 'Today' },
    ])
    expect(out).toBe(['— Today —', 'Alice 14:30', 'One', 'Bob 14:31', 'Two'].join('\n'))
  })
})

import { describe, it, expect } from 'vitest'
import { extractStreamErrorCondition, humanizeStreamError } from './streamErrors'

describe('extractStreamErrorCondition', () => {
  it('extracts the condition from a bridge close reason (space-separated)', () => {
    expect(
      extractStreamErrorCondition('Bridge closed: stream-error host-unknown')
    ).toBe('host-unknown')
  })

  it('extracts the condition from a colon-separated proxy error', () => {
    expect(
      extractStreamErrorCondition('STARTTLS: server stream-error: see-other-host')
    ).toBe('see-other-host')
  })

  it('extracts the condition embedded in a verbose WebSocket-close message', () => {
    expect(
      extractStreamErrorCondition(
        'Connection failed: WebSocket closed (code: 1000, Bridge closed: stream-error host-unknown)'
      )
    ).toBe('host-unknown')
  })

  it('is case-insensitive and normalizes to lower-case', () => {
    expect(extractStreamErrorCondition('Stream-Error Host-Unknown')).toBe('host-unknown')
  })

  it('returns null for a transport error with no stream-error condition', () => {
    expect(extractStreamErrorCondition('WebSocket ECONNERROR ws://127.0.0.1:60342')).toBeNull()
  })
})

describe('humanizeStreamError', () => {
  it('returns an actionable message for host-unknown that keeps the raw condition', () => {
    const msg = humanizeStreamError('Bridge closed: stream-error host-unknown')
    expect(msg).not.toBeNull()
    expect(msg).toContain('host-unknown')
    // Mentions the actionable cause (domain not served by this server).
    expect(msg!.toLowerCase()).toContain('domain')
  })

  it('falls back to a generic message for an unknown condition', () => {
    const msg = humanizeStreamError('Bridge closed: stream-error some-new-condition')
    expect(msg).toContain('some-new-condition')
  })

  it('returns null when there is no stream-error condition (caller keeps its message)', () => {
    expect(humanizeStreamError('WebSocket ECONNERROR ws://127.0.0.1:60342')).toBeNull()
  })
})

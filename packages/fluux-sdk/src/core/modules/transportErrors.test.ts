import { describe, it, expect } from 'vitest'
import {
  extractTransportErrorClass,
  humanizeTransportError,
  classifyConnectionError,
} from './transportErrors'

describe('extractTransportErrorClass', () => {
  it('extracts the class from a bridge close reason (space-separated)', () => {
    expect(extractTransportErrorClass('Bridge closed: tls-error certificate-expired'))
      .toBe('certificate-expired')
  })

  it('extracts the class from an embedded proxy error (colon-separated)', () => {
    expect(extractTransportErrorClass('TLS handshake failed with h (tls-error: certificate-untrusted): x'))
      .toBe('certificate-untrusted')
  })

  it('extracts the class from a verbose WebSocket-close message', () => {
    expect(extractTransportErrorClass(
      'Connection failed: WebSocket closed (code: 1000, Bridge closed: tls-error timeout)'
    )).toBe('timeout')
  })

  it('returns null when there is no transport-error class', () => {
    expect(extractTransportErrorClass('Bridge closed: stream-error host-unknown')).toBeNull()
    expect(extractTransportErrorClass('WebSocket ECONNERROR')).toBeNull()
  })
})

describe('humanizeTransportError', () => {
  it('returns an actionable message that keeps the raw class', () => {
    const msg = humanizeTransportError('Bridge closed: tls-error certificate-expired')
    expect(msg).not.toBeNull()
    expect(msg).toContain('certificate-expired')
    expect(msg!.toLowerCase()).toContain('expired')
  })

  it('falls back to a generic message for an unknown class', () => {
    expect(humanizeTransportError('Bridge closed: tls-error other')).toContain('other')
  })

  it('returns null when there is no transport class (caller keeps its message)', () => {
    expect(humanizeTransportError('Bridge closed: stream-error host-unknown')).toBeNull()
  })
})

describe('classifyConnectionError', () => {
  it('maps every cert sub-class to tls-certificate', () => {
    for (const c of ['certificate', 'certificate-expired', 'certificate-name-mismatch', 'certificate-untrusted']) {
      expect(classifyConnectionError(`Bridge closed: tls-error ${c}`)).toBe('tls-certificate')
    }
  })

  it('maps timeout, refused, and other tls classes', () => {
    expect(classifyConnectionError('Bridge closed: tls-error timeout')).toBe('timeout')
    expect(classifyConnectionError('Bridge closed: tls-error refused')).toBe('connection-refused')
    expect(classifyConnectionError('Bridge closed: tls-error other')).toBe('tls-other')
  })

  it('detects auth failures', () => {
    expect(classifyConnectionError('SASL: not-authorized')).toBe('auth')
    expect(classifyConnectionError('Authentication failed')).toBe('auth')
  })

  it('returns unknown for everything else and for empty input', () => {
    expect(classifyConnectionError('Bridge closed: stream-error host-unknown')).toBe('unknown')
    expect(classifyConnectionError('')).toBe('unknown')
  })
})

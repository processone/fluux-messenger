import { describe, it, expect } from 'vitest'
import { buildEnvelope, parseEnvelope } from './sce'

const rng = (n: number) => new Uint8Array(n).fill(4)

describe('sce envelope', () => {
  it('round-trips content and includes rpad', () => {
    const env = buildEnvelope({ body: 'hi', from: 'a@x', to: 'b@y', timeIso: '2026-07-13T00:00:00Z' }, rng)
    const parsed = parseEnvelope(env)
    expect(parsed.body).toBe('hi')
    expect(parsed.from).toBe('a@x')
    expect(parsed.to).toBe('b@y')
    expect(parsed.timeIso).toBe('2026-07-13T00:00:00Z')
  })

  it('two envelopes of the same content still parse back to the body', () => {
    const a = buildEnvelope({ body: 'hi' }, (n) => new Uint8Array(n).fill(1))
    const b = buildEnvelope({ body: 'hi' }, (n) => new Uint8Array(Math.max(1, n)).fill(2))
    expect(parseEnvelope(a).body).toBe('hi')
    expect(parseEnvelope(b).body).toBe('hi')
  })

  it('round-trips a body with multi-byte UTF-8 (emoji and accented text) byte-exact', () => {
    const body = '😀 Café Zürich 日本語'
    const env = buildEnvelope({ body }, rng)
    const parsed = parseEnvelope(env)
    expect(parsed.body).toBe(body)
  })

  it('round-trips an empty body string as present, not undefined', () => {
    const env = buildEnvelope({ body: '' }, rng)
    const parsed = parseEnvelope(env)
    expect(parsed.body).toBe('')
    expect(parsed.body).not.toBeUndefined()
  })

  it('parses content with no optional fields set (only rpad) without throwing', () => {
    const env = buildEnvelope({}, rng)
    let parsed: ReturnType<typeof parseEnvelope> | undefined
    expect(() => {
      parsed = parseEnvelope(env)
    }).not.toThrow()
    expect(parsed?.body).toBeUndefined()
    expect(parsed?.from).toBeUndefined()
    expect(parsed?.to).toBeUndefined()
    expect(parsed?.timeIso).toBeUndefined()
  })

  it('round-trips a body whose UTF-8 bytes contain a 0x00 byte (length-prefixed, not null-terminated)', () => {
    const body = 'a' + String.fromCharCode(0) + 'b'
    expect(new TextEncoder().encode(body)).toEqual(new Uint8Array([0x61, 0x00, 0x62]))
    const env = buildEnvelope({ body }, rng)
    const parsed = parseEnvelope(env)
    expect(parsed.body).toBe(body)
    expect(parsed.body?.length).toBe(3)
  })

  it('rpad length is always between 1 and 32 bytes', () => {
    const minRng = (n: number) => new Uint8Array(n).fill(0)
    const maxRng = (n: number) => new Uint8Array(n).fill(0xff)
    const envMin = buildEnvelope({}, minRng)
    const envMax = buildEnvelope({}, maxRng)
    // With no optional fields, the whole envelope is exactly the rpad field:
    // u32be(tagLen=4) + "rpad" + u32be(valLen) + rpad bytes
    expect(envMin.length).toBeGreaterThanOrEqual(4 + 4 + 4 + 1)
    expect(envMax.length).toBeLessThanOrEqual(4 + 4 + 4 + 32)
  })
})

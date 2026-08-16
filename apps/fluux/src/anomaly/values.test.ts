// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COUNTER,
  CTX,
  ID,
  initTokenizer,
  isKind,
  isOpaque,
  isRecordValue,
  isReservedCounter,
  localRef,
  localRefOverflowCount,
  METRIC,
  RECOUNT_METRIC,
  releaseRef,
  resetValuesForTesting,
  retainOpaque,
  retainRef,
  TAG,
  tokenKeyId,
  tokenSync,
  tokenWarmFailureCount,
  tokenUnresolvedCount,
  warmToken,
} from './values'

beforeEach(async () => {
  localStorage.clear()
  resetValuesForTesting()
  await initTokenizer()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registries', () => {
  it('recognises constants from every registry', () => {
    for (const value of [
      TAG.focus,
      ID.sessionStart,
      CTX.conv,
      COUNTER.rejectedValue,
      RECOUNT_METRIC['room:pointer-changed'],
    ]) {
      expect(isOpaque(value)).toBe(true)
    }
  })

  it('rejects primitives and forgeries that match a constant', () => {
    expect(isOpaque('focus')).toBe(false)
    expect(isOpaque({ s: 'focus' })).toBe(false)
    expect(isOpaque(Object.freeze({ s: 'recorder/session-start' }))).toBe(false)
  })

  it('freezes every registry', () => {
    for (const registry of [TAG, ID, CTX, COUNTER, METRIC]) {
      expect(Object.isFrozen(registry)).toBe(true)
    }
  })

  it('separates categories, so constants are not interchangeable', () => {
    expect(isKind(ID.sessionStart, 'id')).toBe(true)
    expect(isKind(TAG.focus, 'id')).toBe(false)
    expect(isKind(CTX.conv, 'ctx')).toBe(true)
    expect(isKind(CTX.conv, 'counter')).toBe(false)
    expect(isKind(COUNTER.rejectedValue, 'counter')).toBe(true)
    expect(isRecordValue(TAG.focus)).toBe(true)
    expect(isRecordValue(ID.sessionStart)).toBe(false)
    expect(isRecordValue(CTX.conv)).toBe(false)
  })

  it('exposes no mutable collection that a caller could widen the policy through', async () => {
    // A `readonly Kind[]` or `ReadonlySet` is a COMPILE-TIME type; both erase at
    // runtime. An exported array could be pushed to — making every invariant id
    // admissible as a record value — and an exported Set could be cleared, silently
    // dropping the counter reservation. The policy is exported as predicates, so
    // there is nothing to mutate.
    const mod = (await import('./values')) as Record<string, unknown>
    for (const [name, value] of Object.entries(mod)) {
      const isCollection =
        Array.isArray(value) || value instanceof Set || value instanceof Map
      expect(isCollection, `${name} exports a mutable collection`).toBe(false)
    }
  })

  it('keeps the reserved-counter policy intact', () => {
    expect(isReservedCounter('recorder/rejected-value')).toBe(true)
    expect(isReservedCounter('mam.queries')).toBe(false)
  })
})

describe('ID registry and the invariant registry document agree', () => {
  it('has one docs entry per ID constant and vice versa', async () => {
    // Parity is NOT "by construction": ID and docs/ANOMALY_INVARIANTS.md are two
    // independent files. An earlier draft of this design shipped ID.sessionStart
    // with no matching row in the document. Only a test closes it.
    const fs = await import('node:fs')
    const path = await import('node:path')

    // Walk up from the cwd rather than resolving against `import.meta.url`: under
    // the jsdom environment that URL is an http: one, and `fs` rejects it.
    let dir = process.cwd()
    let docPath = ''
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'docs', 'ANOMALY_INVARIANTS.md')
      if (fs.existsSync(candidate)) {
        docPath = candidate
        break
      }
      dir = path.dirname(dir)
    }
    expect(docPath, 'docs/ANOMALY_INVARIANTS.md not found').not.toBe('')

    const doc = fs.readFileSync(docPath, 'utf-8')
    const documented = new Set(
      doc.match(/`([a-z-]+\/[a-z-]+)`/g)?.map((m) => m.slice(1, -1)) ?? [],
    )
    // Both slash-form registries: invariant ids AND recorder health counters. Every
    // such name can appear in a log, so every one needs a row a reviewer can look
    // up. Dotted METRIC names are application metrics, documented per detector by
    // the stage that introduces them.
    const declared = new Set([
      ...Object.values(ID).map((c) => c.s),
      ...Object.values(COUNTER).map((c) => c.s),
    ])

    for (const name of declared) {
      expect([...documented], `${name} is declared in code but absent from the registry doc`)
        .toContain(name)
    }
    for (const name of documented) {
      expect([...declared], `${name} is documented but has no constant in values.ts`)
        .toContain(name)
    }
  })
})

describe('no export can turn caller data into an Opaque', () => {
  // The adversarial suite. Each case is a leak that existed in an earlier draft of
  // this design, so these are regression tests, not hypotheticals.
  const BODY = 'SECRET-BODY-abcdefghijklmnop'

  function assertNoLeak(s: string, label: string): void {
    const hex = Array.from(new TextEncoder().encode(BODY))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
    for (let i = 0; i + 6 <= BODY.length; i++) {
      expect(s.includes(BODY.slice(i, i + 6)), `${label} leaked body: ${s}`).toBe(false)
    }
    expect(s.includes(hex.slice(0, 12)), `${label} leaked hex-encoded body: ${s}`).toBe(false)
  }

  it('resists a targeted call of every dynamic constructor with a real body', async () => {
    // The generic sweep below cannot supply a VALID companion argument, so it never
    // reaches `tokenSync('jid', BODY)` or `localRef('m', BODY)` — the two calls that
    // matter most. Those are enumerated explicitly, and the async ones are awaited
    // so the assertion runs after the value exists.
    await warmToken('jid', BODY)
    await warmToken('room', BODY)
    await warmToken('device', BODY)

    const produced: Array<[string, string]> = [
      ['tokenSync(jid)', tokenSync('jid', BODY).s],
      ['tokenSync(room)', tokenSync('room', BODY).s],
      ['tokenSync(device)', tokenSync('device', BODY).s],
      ['localRef(m)', localRef('m', BODY)!.s],
      ['localRef(q)', localRef('q', BODY)!.s],
      ['localRef(x)', localRef('x', BODY)!.s],
    ]

    for (const [label, s] of produced) assertNoLeak(s, label)
  })

  it('resists a generic sweep of every export, awaiting any promise it returns', async () => {
    // Breadth, to catch an export added later without a targeted case. Single
    // argument only — a valid second argument cannot be guessed — and every
    // returned promise is awaited so a rejection is not mistaken for a pass.
    const mod = (await import('./values')) as Record<string, unknown>
    const encoded = new TextEncoder().encode(BODY)
    const candidates: unknown[] = [BODY, encoded, encoded.buffer, { s: BODY }, [BODY]]
    const skip = new Set(['initTokenizer', 'resetValuesForTesting'])

    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function' || skip.has(name)) continue
      for (const arg of candidates) {
        let out: unknown
        try {
          out = (fn as (a: unknown) => unknown)(arg)
          if (out instanceof Promise) out = await out
        } catch {
          continue // Rejecting is the correct behaviour.
        }
        if (!isOpaque(out)) continue
        assertNoLeak((out as { s: string }).s, `${name}()`)
      }
    }
  })

  it('rejects an invalid local-ref namespace instead of echoing it', () => {
    // `localRef(body, x)` must not produce `s:<body>1`.
    expect(() => localRef(BODY as never, 'x')).toThrow()
  })

  it('rejects an invalid token namespace instead of echoing it', () => {
    expect(() => tokenSync(BODY as never, 'x')).toThrow()
  })
})

describe('tokens', () => {
  it('produces a 64-bit opaque token after warming', async () => {
    await warmToken('jid', 'someone@example.com')
    expect(tokenSync('jid', 'someone@example.com').s).toMatch(/^c:[0-9a-f]{16}$/)
  })

  it('returns the sentinel on a cold lookup, never the raw value', () => {
    const t = tokenSync('jid', 'cold@example.com')
    expect(t.s).toBe('c:unresolved')
    expect(tokenUnresolvedCount()).toBe(1)
  })

  it('counts a rejected background warm instead of leaving it unhandled', async () => {
    vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('subtle.sign failed'))

    expect(tokenSync('jid', 'failing@example.com').s).toBe('c:unresolved')

    await vi.waitFor(() => expect(tokenWarmFailureCount()).toBe(1))
  })

  it('namespaces the preimage so one string in two roles differs', async () => {
    await warmToken('jid', 'shared')
    await warmToken('room', 'shared')
    expect(tokenSync('jid', 'shared').s).not.toBe(tokenSync('room', 'shared').s)
  })

  it('keeps a hot token alive through cache churn (LRU, not FIFO)', async () => {
    // A plain Map evicts by INSERTION order, so a token referenced on every record
    // still ages out after 500 new entities and silently starts resolving to the
    // sentinel — the evidence degrades exactly for the busiest conversation.
    await warmToken('jid', 'hot@example.com')
    const hot = tokenSync('jid', 'hot@example.com').s
    expect(hot).toMatch(/^c:[0-9a-f]{16}$/)

    for (let i = 0; i < 499; i++) await warmToken('jid', `cold-${i}@example.com`)
    // Touch it, then push the cache past its limit.
    expect(tokenSync('jid', 'hot@example.com').s).toBe(hot)
    await warmToken('jid', 'one-more@example.com')

    expect(tokenSync('jid', 'hot@example.com').s).toBe(hot)
  })

  it('exposes a non-secret key id that changes with the key', async () => {
    const first = tokenKeyId()
    expect(first).toMatch(/^[0-9a-f]{8}$/)
    localStorage.clear()
    resetValuesForTesting()
    await initTokenizer()
    expect(tokenKeyId()).not.toBe(first)
  })
})

describe('local refs', () => {
  it('is stable per namespace and value, and namespaces the key', () => {
    expect(localRef('m', 'abc')).toBe(localRef('m', 'abc'))
    expect(localRef('m', 'shared')!.s).not.toBe(localRef('q', 'shared')!.s)
    expect(localRef('m', 'first')!.s).toMatch(/^s:m[0-9]+$/)
  })

  it('only becomes evictable after every holder releases', () => {
    localRef('q', 'live')
    retainRef('q', 'live')
    retainRef('q', 'live')
    const original = localRef('q', 'live')!.s
    releaseRef('q', 'live')
    for (let i = 0; i < 2100; i++) localRef('m', `filler-${i}`)
    expect(localRef('q', 'live')!.s).toBe(original)
  })

  it('drops the reverse mapping on reset, so a stale ref cannot pin a new entry', () => {
    const stale = localRef('m', 'k')!
    resetValuesForTesting()
    const fresh = localRef('m', 'k')!

    // The stale handle predates the reset; retaining through it must be a no-op,
    // otherwise the fresh entry is pinned by something no longer alive and a later
    // eviction test passes for the wrong reason.
    retainOpaque(stale)
    for (let i = 0; i < 2100; i++) localRef('m', `f-${i}`)
    expect(localRef('m', 'k')!.s).not.toBe(fresh.s)
  })

  it('refuses new allocations rather than growing when everything is pinned', () => {
    for (let i = 0; i < 2000; i++) {
      localRef('m', `pinned-${i}`)
      retainRef('m', `pinned-${i}`)
    }
    expect(localRef('m', 'one-too-many')).toBeNull()
    expect(localRefOverflowCount()).toBe(1)
    expect(localRef('m', 'pinned-0')!.s).toBe('s:m1')
  })
})

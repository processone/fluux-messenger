import { describe, it, expect, beforeEach, vi } from 'vitest'

const handlers: Array<(event: unknown) => void> = []

vi.mock('@fluux/sdk', () => ({
  subscribeDiagnostics: (handler: (event: unknown) => void) => {
    handlers.push(handler)
    return () => {
      handlers.splice(handlers.indexOf(handler), 1)
    }
  },
}))

import {
  readRecountDeferrals,
  resetRecountDeferralTallyForTesting,
  startRecountDeferralTally,
} from './recountDeferralTally'

function defer(entityKind: 'chat' | 'room', reason: string): void {
  for (const handler of [...handlers]) {
    handler({
      kind: 'unread-recount',
      entityKind,
      entityId: 'e@example.com',
      verdict: { status: 'deferred', reason },
    })
  }
}

function counted(entityKind: 'chat' | 'room'): void {
  for (const handler of [...handlers]) {
    handler({
      kind: 'unread-recount',
      entityKind,
      entityId: 'e@example.com',
      verdict: { status: 'counted', count: 2, previousCount: 2 },
    })
  }
}

beforeEach(() => {
  resetRecountDeferralTallyForTesting()
  handlers.length = 0
})

describe('recount deferral tally', () => {
  it('accumulates by kind and reason', () => {
    startRecountDeferralTally()

    defer('room', 'coverage-missing')
    defer('room', 'coverage-missing')
    defer('chat', 'coverage-missing')

    expect(readRecountDeferrals()).toEqual({
      'room:coverage-missing': 2,
      'chat:coverage-missing': 1,
    })
  })

  it('keeps chat and room separate', () => {
    // The two stores run the same guard chain against different state. Merging them
    // would hide that a stale badge is specific to one kind — the question #1211 asks.
    startRecountDeferralTally()

    defer('room', 'input-version-changed')
    defer('chat', 'no-floor')

    expect(Object.keys(readRecountDeferrals()).sort()).toEqual([
      'chat:no-floor',
      'room:input-version-changed',
    ])
  })

  it('is cumulative for the session', () => {
    // The console export is opened AFTER the badge went wrong, so a windowed total
    // would be empty exactly when it is needed.
    startRecountDeferralTally()

    defer('room', 'history-not-caught-up')
    expect(readRecountDeferrals()['room:history-not-caught-up']).toBe(1)
    defer('room', 'history-not-caught-up')
    expect(readRecountDeferrals()['room:history-not-caught-up']).toBe(2)
  })

  it('ignores a recount that committed', () => {
    startRecountDeferralTally()

    counted('chat')

    expect(readRecountDeferrals()).toEqual({})
  })

  it('returns a copy, so a reader cannot mutate the totals', () => {
    startRecountDeferralTally()
    defer('room', 'no-meta')

    const snapshot = readRecountDeferrals()
    snapshot['room:no-meta'] = 999
    snapshot['room:injected'] = 1

    expect(readRecountDeferrals()).toEqual({ 'room:no-meta': 1 })
  })

  it('subscribes once however often it is started', () => {
    startRecountDeferralTally()
    startRecountDeferralTally()

    defer('chat', 'no-meta')

    // A second subscription would double every count in the export.
    expect(readRecountDeferrals()['chat:no-meta']).toBe(1)
  })

  it('counts nothing before it is started', () => {
    defer('chat', 'no-meta')

    expect(readRecountDeferrals()).toEqual({})
  })

  it('does not make the outbound diagnostic payload reachable', async () => {
    vi.doUnmock('@fluux/sdk')
    vi.resetModules()
    const tally = await import('./recountDeferralTally')
    const { chatStore } = await import('@fluux/sdk')
    const { XMPPClient } = await import('@fluux/sdk/core')
    let stanzaReads = 0
    const stanza = {
      get name() {
        stanzaReads++
        return 'message'
      },
      attrs: {},
      children: [],
    }
    const client = new XMPPClient({}) as unknown as {
      emitApplicationStanzaOut: (value: unknown) => void
    }

    tally.startRecountDeferralTally()
    client.emitApplicationStanzaOut(stanza)
    await chatStore.getState().recomputeUnreadForConversation('missing@example.com')

    expect(stanzaReads).toBe(0)
    expect(tally.readRecountDeferrals()).toEqual({ 'chat:no-meta': 1 })
    tally.resetRecountDeferralTallyForTesting()
  })
})

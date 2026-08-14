import { describe, it, expect, beforeEach } from 'vitest'
import {
  readRecountDeferrals,
  recordRecountDeferral,
  resetRecountDeferralsForTesting,
} from './recountDiagnostics'
import { chatStore } from '../chatStore'
import { roomStore } from '../roomStore'

beforeEach(() => {
  resetRecountDeferralsForTesting()
})

describe('recountDiagnostics', () => {
  it('tallies by kind and reason', () => {
    recordRecountDeferral('room', 'coverage-missing')
    recordRecountDeferral('room', 'coverage-missing')
    recordRecountDeferral('chat', 'coverage-missing')

    expect(readRecountDeferrals()).toEqual({
      'room:coverage-missing': 2,
      'chat:coverage-missing': 1,
    })
  })

  it('keeps chat and room separate', () => {
    // The two stores run the same guard chain against different state. Merging them
    // would hide that a stale badge is specific to one kind — which is exactly the
    // question issue #1211 asks.
    recordRecountDeferral('room', 'input-version-changed')
    recordRecountDeferral('chat', 'no-floor')

    const tallies = readRecountDeferrals()
    expect(Object.keys(tallies).sort()).toEqual([
      'chat:no-floor',
      'room:input-version-changed',
    ])
  })

  it('is cumulative, leaving windowing to the reader', () => {
    recordRecountDeferral('room', 'history-not-caught-up')
    expect(readRecountDeferrals()['room:history-not-caught-up']).toBe(1)
    recordRecountDeferral('room', 'history-not-caught-up')
    expect(readRecountDeferrals()['room:history-not-caught-up']).toBe(2)
  })

  it('returns a copy, so a reader cannot mutate the tallies', () => {
    recordRecountDeferral('room', 'no-meta')
    const snapshot = readRecountDeferrals()
    snapshot['room:no-meta'] = 999
    snapshot['room:injected'] = 1

    expect(readRecountDeferrals()).toEqual({ 'room:no-meta': 1 })
  })

  it('starts empty and resets', () => {
    expect(readRecountDeferrals()).toEqual({})
    recordRecountDeferral('chat', 'cache-unavailable')
    resetRecountDeferralsForTesting()
    expect(readRecountDeferrals()).toEqual({})
  })
})


describe('the stores actually report their deferrals', () => {
  // The tally is worthless if the guards never call it. These assert the wiring at
  // the cheapest reachable guard in each store; the remaining guards are behind
  // coverage and MAM state that a unit test cannot stage honestly.
  beforeEach(() => {
    resetRecountDeferralsForTesting()
  })

  it('records a room recount that found no metadata', async () => {
    await roomStore.getState().recomputeUnreadForRoom('never-seen@conf.example', {
      allowActive: true,
    })
    expect(readRecountDeferrals()['room:no-meta']).toBe(1)
  })

  it('records a conversation recount that found no metadata', async () => {
    await chatStore.getState().recomputeUnreadForConversation('never-seen@example', {
      allowActive: true,
    })
    expect(readRecountDeferrals()['chat:no-meta']).toBe(1)
  })

  it('records the active-room skip, which is a different reason entirely', () => {
    // Distinguishing "skipped because active" from "counted and committed" is the
    // whole point: both leave the badge unchanged.
    roomStore.setState({ activeRoomJid: 'active@conf.example' })
    void roomStore.getState().recomputeUnreadForRoom('active@conf.example')
    expect(readRecountDeferrals()['room:active-skipped']).toBe(1)
    roomStore.setState({ activeRoomJid: null })
  })
})

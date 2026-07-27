import { describe, it, expect, beforeEach } from 'vitest'
import {
  beginViewportGeneration,
  currentViewportGeneration,
  reportViewport,
  currentViewportEvidence,
  clearViewportEvidence,
  _clearAllViewportEvidenceForTesting,
  type EvidenceKey,
} from './viewportEvidence'

const chatKey = (entityId: string, accountScope = 'me@example.com'): EvidenceKey => ({
  kind: 'chat',
  entityId,
  accountScope,
})

beforeEach(() => {
  _clearAllViewportEvidenceForTesting()
})

describe('viewportEvidence', () => {
  it('a never-activated entity reports generation 0 and unknown evidence', () => {
    const key = chatKey('alice@example.com')
    expect(currentViewportGeneration(key)).toBe(0)
    expect(currentViewportEvidence(key)).toBe('unknown')
  })

  it('beginViewportGeneration starts a fresh generation at unknown', () => {
    const key = chatKey('alice@example.com')
    const gen = beginViewportGeneration(key)
    expect(gen).toBe(1)
    expect(currentViewportGeneration(key)).toBe(1)
    expect(currentViewportEvidence(key)).toBe('unknown')
  })

  it('a report carrying the current generation is reflected', () => {
    const key = chatKey('alice@example.com')
    const gen = beginViewportGeneration(key)
    reportViewport(key, gen, 'at-edge')
    expect(currentViewportEvidence(key)).toBe('at-edge')

    reportViewport(key, gen, 'away')
    expect(currentViewportEvidence(key)).toBe('away')
  })

  it('a report carrying a STALE (previous) generation is ignored', () => {
    const key = chatKey('alice@example.com')
    const staleGen = beginViewportGeneration(key) // generation 1
    // Re-activate the SAME entity: a new generation begins, distinguishing this
    // from the stale one above (seeding evidence nonzero-then-distinct, not 0->0).
    const currentGen = beginViewportGeneration(key) // generation 2
    expect(currentGen).not.toBe(staleGen)

    // A late report still carrying the OLD (generation-1) token must be rejected.
    reportViewport(key, staleGen, 'at-edge')
    expect(currentViewportEvidence(key)).toBe('unknown')
    expect(currentViewportGeneration(key)).toBe(currentGen)

    // A report on the CURRENT generation is accepted.
    reportViewport(key, currentGen, 'at-edge')
    expect(currentViewportEvidence(key)).toBe('at-edge')
  })

  it('a report against a generation that was never begun (0) is ignored', () => {
    const key = chatKey('never-activated@example.com')
    reportViewport(key, 0, 'at-edge')
    expect(currentViewportEvidence(key)).toBe('unknown')
  })

  it('re-activating the same entity resets evidence to unknown even if it was previously at-edge', () => {
    const key = chatKey('alice@example.com')
    const gen1 = beginViewportGeneration(key)
    reportViewport(key, gen1, 'at-edge')
    expect(currentViewportEvidence(key)).toBe('at-edge')

    const gen2 = beginViewportGeneration(key)
    expect(gen2).toBe(gen1 + 1)
    expect(currentViewportEvidence(key)).toBe('unknown')
  })

  it('evidence is scoped per entity — reporting for one entity does not affect another', () => {
    const alice = chatKey('alice@example.com')
    const bob = chatKey('bob@example.com')
    const aliceGen = beginViewportGeneration(alice)
    const bobGen = beginViewportGeneration(bob)

    reportViewport(alice, aliceGen, 'at-edge')
    expect(currentViewportEvidence(alice)).toBe('at-edge')
    expect(currentViewportEvidence(bob)).toBe('unknown')

    reportViewport(bob, bobGen, 'at-edge')
    expect(currentViewportEvidence(bob)).toBe('at-edge')
  })

  it('evidence is scoped per account — the same entityId under a different accountScope is independent', () => {
    const accountA = chatKey('alice@example.com', 'account-a')
    const accountB = chatKey('alice@example.com', 'account-b')
    const genA = beginViewportGeneration(accountA)
    beginViewportGeneration(accountB)

    reportViewport(accountA, genA, 'at-edge')
    expect(currentViewportEvidence(accountA)).toBe('at-edge')
    expect(currentViewportEvidence(accountB)).toBe('unknown')
  })

  it('clearViewportEvidence wipes only the given account scope', () => {
    const accountA = chatKey('alice@example.com', 'account-a')
    const accountB = chatKey('alice@example.com', 'account-b')
    const genA = beginViewportGeneration(accountA)
    const genB = beginViewportGeneration(accountB)
    reportViewport(accountA, genA, 'at-edge')
    reportViewport(accountB, genB, 'at-edge')

    clearViewportEvidence('account-a')

    // account-a wiped: back to generation 0 / unknown, as if never activated.
    expect(currentViewportGeneration(accountA)).toBe(0)
    expect(currentViewportEvidence(accountA)).toBe('unknown')
    // account-b untouched.
    expect(currentViewportGeneration(accountB)).toBe(genB)
    expect(currentViewportEvidence(accountB)).toBe('at-edge')
  })

  it('room kind is independent of chat kind for the same entityId/accountScope', () => {
    const chat = { kind: 'chat' as const, entityId: 'shared-id', accountScope: 'me@example.com' }
    const room = { kind: 'room' as const, entityId: 'shared-id', accountScope: 'me@example.com' }
    const chatGen = beginViewportGeneration(chat)
    reportViewport(chat, chatGen, 'at-edge')

    expect(currentViewportEvidence(chat)).toBe('at-edge')
    expect(currentViewportEvidence(room)).toBe('unknown')
  })
})

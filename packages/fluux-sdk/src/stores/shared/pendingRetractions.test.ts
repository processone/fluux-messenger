import { describe, it, expect } from 'vitest'
import {
  addPendingRetraction,
  applyPendingRetractions,
  PENDING_RETRACTION_CAP,
  type PendingRetraction,
} from './pendingRetractions'
import { roomMessageAuthor } from '../../utils/messageIdentity'

const AT = new Date('2026-07-22T03:53:00Z').getTime()

function entry(targetId: string, actorJid = 'contact@example.com', retractedAt = AT): PendingRetraction {
  return { targetId, actorJid, retractedAt }
}

function message(id: string, extra: Record<string, unknown> = {}) {
  return { id, from: 'contact@example.com', body: 'hello', ...extra }
}

const isAuthor = (m: { from: string }, record: PendingRetraction) => m.from === record.actorJid

describe('addPendingRetraction', () => {
  it('appends a record', () => {
    expect(addPendingRetraction([], entry('a'))).toEqual([entry('a')])
  })

  it('returns the same array when the target is already recorded', () => {
    const existing = [entry('a')]
    expect(addPendingRetraction(existing, entry('a'))).toBe(existing)
  })

  it('retains competing actors for the same unresolved target', () => {
    const attacker = entry('a', 'mallory@example.com')
    const author = entry('a', 'contact@example.com')

    expect(addPendingRetraction([attacker], author)).toEqual([attacker, author])
  })

  it('keeps the earliest delivery for the same target and actor', () => {
    const later = entry('a', 'contact@example.com', AT + 1000)
    const earlier = entry('a', 'contact@example.com', AT)

    expect(addPendingRetraction([later], earlier)).toEqual([earlier])
  })

  it('caps the list, dropping the oldest record', () => {
    let list: PendingRetraction[] = []
    for (let i = 0; i < PENDING_RETRACTION_CAP + 5; i++) {
      list = addPendingRetraction(list, entry(`t${i}`))
    }
    expect(list).toHaveLength(PENDING_RETRACTION_CAP)
    expect(list[0].targetId).toBe('t5')
  })
})

describe('applyPendingRetractions', () => {
  it('tombstones a target that is now present and reports it applied', () => {
    const messages = [message('m1'), message('m2')]

    const result = applyPendingRetractions(
      messages,
      [entry('m2')],
      isAuthor
    )

    expect(result.messages[1]).toMatchObject({ id: 'm2', isRetracted: true, retractedAt: new Date(AT) })
    expect(result.messages[0]).toBe(messages[0])
    expect(result.applied).toEqual([{ messageId: 'm2', retractedAt: new Date(AT) }])
    expect(result.resolved).toEqual([{ message: result.messages[1], retractedAt: new Date(AT) }])
    expect(result.remaining).toEqual([])
  })

  it('resolves the target through any id tier (stanza-id, origin-id)', () => {
    const messages = [message('m1', { stanzaId: 'srv-1' }), message('m2', { originId: 'org-2' })]

    const result = applyPendingRetractions(
      messages,
      [entry('srv-1'), entry('org-2')],
      isAuthor
    )

    expect(result.messages[0]).toMatchObject({ isRetracted: true })
    expect(result.messages[1]).toMatchObject({ isRetracted: true })
    expect(result.remaining).toEqual([])
  })

  it('keeps a record pending when its target is not present', () => {
    const messages = [message('m1')]

    const result = applyPendingRetractions(
      messages,
      [entry('absent')],
      isAuthor
    )

    expect(result.messages).toBe(messages)
    expect(result.applied).toEqual([])
    expect(result.resolved).toEqual([])
    expect(result.remaining).toEqual([entry('absent')])
  })

  it('retains a record whose first matching candidate has another author', () => {
    const messages = [message('m1', { from: 'someone-else@example.com' })]

    const result = applyPendingRetractions(
      messages,
      [entry('m1')],
      isAuthor
    )

    expect(result.messages).toBe(messages)
    expect(result.applied).toEqual([])
    expect(result.resolved).toEqual([])
    expect(result.remaining).toEqual([entry('m1')])
  })

  it('prefers an authorized stanza target over an unauthorized client-id collision', () => {
    const messages = [
      message('shared', { from: 'someone-else@example.com' }),
      message('author-copy', { stanzaId: 'shared' }),
    ]

    const result = applyPendingRetractions(
      messages,
      [entry('shared')],
      isAuthor
    )

    expect(result.messages[0]).not.toHaveProperty('isRetracted')
    expect(result.messages[1]).toMatchObject({ isRetracted: true })
    expect(result.resolved[0].message).toBe(result.messages[1])
    expect(result.remaining).toEqual([])
  })

  it('consumes an unauthorized authoritative match', () => {
    const messages = [message('author-copy', {
      stanzaId: 'shared',
      from: 'someone-else@example.com',
    })]

    const result = applyPendingRetractions(
      messages,
      [entry('shared')],
      isAuthor
    )

    expect(result.messages).toBe(messages)
    expect(result.remaining).toEqual([])
  })

  it('retains unmatched competing actors after a fallback target resolves', () => {
    const attacker = entry('m1', 'mallory@example.com')
    const author = entry('m1')

    const result = applyPendingRetractions(
      [message('m1')],
      [attacker, author],
      isAuthor
    )

    expect(result.messages[0]).toMatchObject({ isRetracted: true })
    expect(result.remaining).toEqual([attacker])
  })

  it('consumes every competitor after an authoritative target resolves', () => {
    const attacker = entry('shared-stanza', 'mallory@example.com')
    const author = entry('shared-stanza')

    const result = applyPendingRetractions(
      [message('m1', { stanzaId: 'shared-stanza' })],
      [attacker, author],
      isAuthor
    )

    expect(result.messages[0]).toMatchObject({ isRetracted: true })
    expect(result.remaining).toEqual([])
  })

  it('replays two legitimate room retractions sharing a client id', () => {
    const alice = {
      targetId: 'shared-id',
      actorJid: 'room@example.com/alice',
      actorOccupantId: 'occupant-alice',
      retractedAt: AT,
    }
    const bob = {
      targetId: 'shared-id',
      actorJid: 'room@example.com/bob',
      actorOccupantId: 'occupant-bob',
      retractedAt: AT + 1,
    }
    const aliceMessage = message('shared-id', {
      from: alice.actorJid,
      occupantId: alice.actorOccupantId,
    })
    const bobMessage = message('shared-id', {
      from: bob.actorJid,
      occupantId: bob.actorOccupantId,
    })

    const first = applyPendingRetractions(
      [aliceMessage],
      [alice, bob],
      roomMessageAuthor
    )
    expect(first.messages[0]).toMatchObject({ isRetracted: true })
    expect(first.remaining).toEqual([bob])

    const second = applyPendingRetractions(
      [bobMessage],
      first.remaining,
      roomMessageAuthor
    )
    expect(second.messages[0]).toMatchObject({ isRetracted: true })
    expect(second.remaining).toEqual([])
  })

  it('resolves an already-retracted target without rewriting the array', () => {
    const messages = [message('m1', { isRetracted: true })]

    const result = applyPendingRetractions(
      messages,
      [entry('m1')],
      isAuthor
    )

    expect(result.messages).toBe(messages)
    expect(result.applied).toEqual([])
    expect(result.resolved).toEqual([{ message: messages[0], retractedAt: new Date(AT) }])
    expect(result.remaining).toEqual([])
  })

  it('returns the input array untouched when there is nothing pending', () => {
    const messages = [message('m1')]

    const result = applyPendingRetractions(
      messages,
      [],
      isAuthor
    )

    expect(result.messages).toBe(messages)
    expect(result.remaining).toEqual([])
  })
})
